/** Explicit crash recovery. Never dispatches, grades, or finalizes a model run. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../tracks/core";
import type { CampaignManifest, CampaignState, CampaignJobPlan } from "./campaign";

const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const timestamp = () => new Date().toISOString();
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const active = new Set(["preparing", "prepared", "running"]);

export interface RecoveryOptions {
  root: string;
  /** An independent process check must establish no PropBench native children remain. */
  orphanClearanceConfirmed: boolean;
  /** Test seam; production checks the actual recorded lock PID. */
  processAlive?: (pid: number) => boolean;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error; // EPERM is not evidence of an exited process.
  }
}

function fileInventory(runDir: string, job: CampaignJobPlan, runId: string): Array<{job_key: string; run_id: string; path: string; bytes: number; sha256: string}> {
  if (!fs.existsSync(runDir)) return [];
  const result: Array<{job_key: string; run_id: string; path: string; bytes: number; sha256: string}> = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Owner run contains a symlink; cannot inventory safely: ${job.key}/${rel}`);
      if (stat.isDirectory()) walk(file, rel);
      else if (stat.isFile()) {
        if (stat.size > 512 * 1024 * 1024) throw new Error(`Owner run file exceeds recovery inventory bound: ${job.key}/${rel}`);
        result.push({ job_key: job.key, run_id: runId, path: rel, bytes: stat.size, sha256: hash(fs.readFileSync(file)) });
      } else throw new Error(`Owner run contains a non-file artifact: ${job.key}/${rel}`);
    }
  };
  walk(runDir, "");
  return result;
}

function crashEvidence(logBytes: Buffer): {message: string; code: string; syscall: string; source_callback: string; source_stack_line: string} {
  const log = logBytes.toString("utf8");
  const source = log.split(/\r?\n/).find(line => /at NativeRpc\.stop \(.+subscription-codex\.ts:\d+:\d+\)/.test(line));
  if (!log.includes("Error: kill EPERM") || !/code: ['"]EPERM['"]/.test(log) || !/syscall: ['"]kill['"]/.test(log) || !source) {
    throw new Error("Campaign log does not document the expected kill EPERM in NativeRpc.stop");
  }
  return { message: "Error: kill EPERM", code: "EPERM", syscall: "kill", source_callback: "NativeRpc.stop", source_stack_line: source.trim() };
}

function atomicWrite(file: string, bytes: Buffer): void {
  const tmp = file + "." + randomUUID() + ".tmp";
  try { fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export function recoverCrashedCampaign(options: RecoveryOptions): Record<string, unknown> {
  if (!options.orphanClearanceConfirmed) throw new Error("Independent PropBench orphan-process clearance is required before recovery");
  const root = path.resolve(options.root);
  const files = { manifest: path.join(root, "manifest.json"), state: path.join(root, "state.json"), lock: path.join(root, "campaign.lock"), log: path.join(root, "campaign.log") };
  for (const [label, file] of Object.entries(files)) if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Missing regular campaign ${label}: ${file}`);
  const original = Object.fromEntries(Object.entries(files).map(([label, file]) => [label, fs.readFileSync(file)])) as Record<keyof typeof files, Buffer>;
  const manifest = JSON.parse(original.manifest.toString("utf8")) as CampaignManifest;
  const state = JSON.parse(original.state.toString("utf8")) as CampaignState;
  const lock = JSON.parse(original.lock.toString("utf8")) as {pid: number; started_at: string};
  if (manifest.schema_version !== "propbench-campaign-manifest-v1" || manifest.root !== root || manifest.jobs.length !== 96 ||
      state.schema_version !== "propbench-campaign-state-v1" || state.manifest_sha256 !== hash(canonical(manifest)) ||
      Object.keys(state.jobs).length !== 96 || manifest.jobs.some(job => !state.jobs[job.key])) throw new Error("Campaign manifest/state binding is invalid");
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || (options.processAlive ?? isAlive)(lock.pid)) throw new Error(`Recorded controller PID ${lock.pid} is still active or invalid`);
  const failure = crashEvidence(original.log);
  const affected = manifest.jobs.filter(job => active.has(state.jobs[job.key].status));
  if (!affected.length) throw new Error("No started nonterminal jobs require crash recovery");
  const started = manifest.jobs.filter(job => state.jobs[job.key].status !== "queued");
  const inventory = started.flatMap(job => {
    const entry = state.jobs[job.key];
    if (!entry.run_id || !entry.run_dir) return [];
    const expected = path.join(root, "runs", job.key, entry.run_id);
    if (path.resolve(entry.run_dir) !== expected) throw new Error(`Owner run path differs from campaign plan: ${job.key}`);
    return fileInventory(expected, job, entry.run_id);
  });
  const inventoryHash = hash(canonical(inventory));
  const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2) + "\n");
  const countsBefore = Object.fromEntries(["queued", "preparing", "prepared", "running", "complete", "interrupted"].map(status =>
    [status, manifest.jobs.filter(job => state.jobs[job.key].status === status).length]));
  const recoveryId = timestamp().replace(/[:.]/g, "-") + "-" + randomUUID();
  const dir = path.join(root, "recovery", recoveryId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [label, bytes] of Object.entries(original)) fs.writeFileSync(path.join(dir, label + (label === "log" ? ".log" : ".json")), bytes, { flag: "wx", mode: 0o400 });
  fs.writeFileSync(path.join(dir, "artifact-inventory.json"), inventoryBytes, { flag: "wx", mode: 0o400 });
  const reason = `${failure.message} at ${failure.source_callback}; controller exited before run completion. Native orphans independently cleared. No redispatch, grading, or finalization.`;
  for (const job of affected) {
    const entry = state.jobs[job.key];
    entry.status = "interrupted"; entry.error = reason; entry.completed_at = timestamp();
  }
  state.dispatch_stopped = true;
  state.stop_reason = `crash recovery ${recoveryId}: ${reason}`;
  state.updated_at = timestamp();
  const newStateBytes = Buffer.from(JSON.stringify(state, null, 2) + "\n");
  const receipt = {
    schema_version: "propbench-campaign-crash-recovery-v1", recovery_id: recoveryId, created_at: timestamp(),
    campaign_id: manifest.campaign_id, source_commit: manifest.identity.source_commit, recorded_controller_pid: lock.pid,
    orphan_clearance: "independently confirmed before utility invocation", failure,
    changed_jobs: affected.map(job => ({ key: job.key, run_id: state.jobs[job.key].run_id ?? null, previous_status: JSON.parse(original.state.toString("utf8")).jobs[job.key].status,
      recovered_status: "interrupted" })),
    counts_before: countsBefore,
    counts_after: Object.fromEntries(Object.keys(countsBefore).map(status => [status, manifest.jobs.filter(job => state.jobs[job.key].status === status).length])),
    backups: Object.fromEntries(Object.entries(original).map(([label, bytes]) => [label, { file: label + (label === "log" ? ".log" : ".json"), bytes: bytes.length, sha256: hash(bytes) }])),
    artifact_inventory: { file: "artifact-inventory.json", files: inventory.length,
      file_sha256: hash(inventoryBytes), canonical_sha256: inventoryHash,
      proof_receipts: inventory.filter(item => /^(?:candidate-receipts|checkpoint-artifacts|checkpoints|submissions|archives)\//.test(item.path)).length },
    state_after_sha256: hash(newStateBytes), owner_lock_preserved_in_place: true,
    no_model_dispatch: true, no_owner_run_mutation: true, no_grade_or_final_archive: true,
  };
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o400 });
  atomicWrite(files.state, newStateBytes);
  const event = { at: timestamp(), event: "controller_crash_recovery", recovery_id: recoveryId,
    changed_jobs: affected.map(job => job.key), failure, queued_unchanged: countsBefore.queued };
  fs.appendFileSync(path.join(root, "progress.ndjson"), JSON.stringify(event) + "\n");
  const after = started.flatMap(job => {
    const entry = state.jobs[job.key];
    return entry.run_id && entry.run_dir ? fileInventory(entry.run_dir, job, entry.run_id) : [];
  });
  if (hash(canonical(after)) !== inventoryHash) throw new Error(`Owner run artifacts changed during recovery; inspect ${dir}`);
  if (!original.lock.equals(fs.readFileSync(files.lock))) throw new Error("Original campaign lock changed during recovery");
  return { recovery_dir: dir, receipt: path.join(dir, "receipt.json"), changed_jobs: affected.map(job => job.key),
    queued_unchanged: countsBefore.queued, artifact_files_unchanged: inventory.length };
}

if (require.main === module) {
  const [root, clearance, ...rest] = process.argv.slice(2);
  if (!root || clearance !== "--orphans-cleared" || rest.length) {
    process.stderr.write("Usage: recover-campaign CAMPAIGN_ROOT --orphans-cleared\n"); process.exitCode = 1;
  } else {
    try { process.stdout.write(JSON.stringify(recoverCrashedCampaign({ root, orphanClearanceConfirmed: true })) + "\n"); }
    catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
  }
}
