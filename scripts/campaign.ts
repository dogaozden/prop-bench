/** Durable, Codex-subscription-only controller for the frozen v2 census. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { canonical, loadSet, prepareRun, PROJECT_ROOT, readJson, readRegularFile, sha256, writeJson, writeJsonExclusive } from "../tracks/core";
import { prepareFrontier } from "../tracks/frontier";
import { inspectCodexRuntime } from "../tracks/codex-runtime";
import { runSubscription } from "../tracks/subscription-runner";
import type { PrepareOptions, RunContext, RunReport } from "../tracks/types";

export type Condition = "unaided-1" | "unaided-2" | "frontier-fresh" | "frontier-cumulative";
export type JobStatus = "queued" | "preparing" | "prepared" | "running" | "complete" | "interrupted";
export interface CampaignJobPlan {
  key: string;
  item_id: string;
  condition: Condition;
  dependency: string | null;
  wall_seconds: 900;
  max_tool_calls: 0 | 128;
  run_parent: string;
  bundle_dir: string | null;
}
export interface CampaignIdentity {
  set_version: string;
  set_hash: string;
  set_ids: string[];
  set_manifest_sha256: string;
  rulebook_sha256: string;
  validator_sha256: string;
  evaluator_hash: string;
  source_commit: string | null;
  runtime: { path: string; version: string; sha256: string; source: string };
}
export interface CampaignManifest {
  schema_version: "propbench-campaign-manifest-v1";
  campaign_id: string;
  created_at: string;
  model: "gpt-6-astra";
  effort: "xhigh";
  provider: "codex-subscription";
  set_dir: string;
  validator: string;
  root: string;
  bundles: string;
  identity: CampaignIdentity;
  jobs: CampaignJobPlan[];
}
export interface JobState {
  status: JobStatus;
  run_id?: string;
  run_dir?: string;
  bundle_dir?: string;
  inherited_from?: string;
  seed_run_id?: string;
  inherited_archive?: string;
  inherited_snapshot?: string;
  final_archive?: string;
  final_snapshot?: string;
  report_path?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}
export interface CampaignState {
  schema_version: "propbench-campaign-state-v1";
  manifest_sha256: string;
  created_at: string;
  updated_at: string;
  dispatch_stopped: boolean;
  stop_reason?: string;
  jobs: Record<string, JobState>;
}
export interface CampaignOptions {
  root: string;
  bundles: string;
  validator?: string;
  setDir?: string;
  maxInflight?: number;
  resume?: boolean;
  dryRun?: boolean;
  /** Test seam; production always inspects the audited native runtime. */
  inspectIdentity?: () => CampaignIdentity;
  prepare?: (options: PrepareOptions, bundleDir?: string, archiveDir?: string) => RunContext;
  run?: (ctx: RunContext) => Promise<RunReport>;
  emit?: (event: Record<string, unknown>) => void;
}

const CONDITIONS: readonly Condition[] = ["unaided-1", "frontier-fresh", "unaided-2", "frontier-cumulative"];
const now = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const quotaFailure = (value: string) => /quota|rate.limit|usage.limit|authentication|unauthorized|login|sign.in|transport|network|connection|Codex (?:session|initialization).*timeout|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(value);
const isFrontier = (condition: Condition) => condition.startsWith("frontier-");

function sourceCommit(): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

/** Same evaluator digest recipe as tracks/core.ts; checked before each dispatch. */
export function inspectCampaignIdentity(setDir: string, validator: string): CampaignIdentity {
  const set = loadSet(setDir);
  if (set.version !== "v2" || set.items.length !== 24) throw new Error("Campaign requires the complete frozen v2 24-item census");
  const tracksDir = path.join(PROJECT_ROOT, "tracks");
  const names = fs.readdirSync(tracksDir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
  const evaluator_hash = sha256(names.map(name => name + ":" + sha256(readRegularFile(path.join(tracksDir, name)))).join("\n"));
  return {
    set_version: set.version, set_hash: set.hash, set_ids: set.items.map(item => item.id),
    set_manifest_sha256: sha256(readRegularFile(path.join(setDir, "manifest.json"))),
    rulebook_sha256: sha256(readRegularFile(path.join(PROJECT_ROOT, "rules.md"))),
    validator_sha256: sha256(readRegularFile(validator, 512 * 1024 * 1024)),
    evaluator_hash, source_commit: sourceCommit(), runtime: inspectCodexRuntime(),
  };
}

export function buildManifest(root: string, bundles: string, validator: string, setDir: string, identity: CampaignIdentity,
  metadata: { campaign_id: string; created_at: string } = { campaign_id: "DRY_RUN_UNASSIGNED", created_at: "DRY_RUN_UNASSIGNED" }): CampaignManifest {
  if (identity.set_version !== "v2" || identity.set_ids.length !== 24 || new Set(identity.set_ids).size !== 24) throw new Error("Expected 24 distinct v2 item IDs");
  const jobs: CampaignJobPlan[] = [];
  const bands = ["g1", "g2", "g3"] as const;
  const idsByBand = Object.fromEntries(bands.map(band =>
    [band, identity.set_ids.filter(id => id.startsWith(band + "-"))])) as Record<typeof bands[number], string[]>;
  if (bands.some(band => idsByBand[band].length !== 8)) throw new Error("Campaign requires eight frozen v2 items in each generation band");
  // Prespecified round-robin band order; finish each item's four-arm block
  // before the next item in the manifest. The cumulative job waits for fresh.
  for (let index = 0; index < 8; index++) for (const band of bands) {
    const item_id = idsByBand[band][index];
    for (const condition of CONDITIONS) {
      const key = `${item_id}--${condition}`;
      jobs.push({ key, item_id, condition,
        dependency: condition === "frontier-cumulative" ? `${item_id}--frontier-fresh` : null,
        wall_seconds: 900, max_tool_calls: isFrontier(condition) ? 128 : 0,
        run_parent: path.join(root, "runs", key),
        bundle_dir: isFrontier(condition) ? path.join(bundles, key) : null });
    }
  }
  if (jobs.length !== 96 || CONDITIONS.some(condition => jobs.filter(job => job.condition === condition).length !== 24)) throw new Error("Incomplete campaign plan");
  return { schema_version: "propbench-campaign-manifest-v1", ...metadata,
    model: "gpt-6-astra", effort: "xhigh", provider: "codex-subscription",
    set_dir: setDir, validator, root, bundles, identity, jobs };
}

function saveState(root: string, state: CampaignState): void {
  state.updated_at = now();
  writeJson(path.join(root, "state.json"), state);
}

function readFinalArchive(runDir: string): { path: string; digest: string } {
  const archives = path.join(runDir, "archives");
  const names = fs.readdirSync(archives).filter(name => /^\d{6}$/.test(name)).sort();
  if (names.length < 2) throw new Error("Completed Frontier run lacks a final owner archive");
  const archive = path.join(archives, names[names.length - 1]);
  const receipt = readJson<{schema_version: string; trigger: string; snapshot: {digest: string}}>(path.join(archive, "RECEIPT.json"));
  if (receipt.schema_version !== "propbench-frontier-archive-v1" || receipt.trigger !== "import" || !/^[a-f0-9]{64}$/.test(receipt.snapshot.digest)) throw new Error("Invalid final Frontier archive receipt");
  return { path: archive, digest: receipt.snapshot.digest };
}

function acquireLock(root: string, resume: boolean): () => void {
  const file = path.join(root, "campaign.lock");
  if (fs.existsSync(file)) {
    if (!resume) throw new Error("Campaign lock exists; explicit --resume is required");
    const lock = readJson<{pid: number}>(file);
    if (Number.isSafeInteger(lock.pid) && lock.pid > 0) {
      try { process.kill(lock.pid, 0); throw new Error(`Campaign is already active under PID ${lock.pid}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    fs.unlinkSync(file);
  }
  writeJsonExclusive(file, { pid: process.pid, started_at: now() });
  return () => { if (fs.existsSync(file) && readJson<{pid: number}>(file).pid === process.pid) fs.unlinkSync(file); };
}

function assertManifest(actual: CampaignManifest, expected: CampaignManifest): void {
  if (canonical(actual) !== canonical(expected)) throw new Error("Campaign manifest or source identity drifted; no new dispatch permitted");
}

function recoverCompletedJob(root: string, job: CampaignJobPlan, entry: JobState): boolean {
  if (!entry.run_id || !entry.run_dir || !fs.existsSync(path.join(entry.run_dir, "report.json")) ||
      !fs.existsSync(path.join(root, "jobs", job.key + ".json"))) return false;
  const report = readJson<RunReport>(path.join(entry.run_dir, "report.json"));
  if (report.config.run_id !== entry.run_id || report.config.provider !== "codex-subscription" ||
      report.config.selected_ids.length !== 1 || report.config.selected_ids[0] !== job.item_id ||
      report.config.model !== "gpt-6-astra" || report.config.subscription?.effort !== "xhigh" ||
      report.config.subscription.max_tool_calls !== job.max_tool_calls || report.config.budget.wall_seconds !== job.wall_seconds ||
      report.evaluation_status !== "complete" || report.evidence !== "subscription" || (report.client_sessions ?? 0) < 1) return false;
  if (isFrontier(job.condition)) {
    const archive = readFinalArchive(entry.run_dir);
    entry.final_archive = archive.path; entry.final_snapshot = archive.digest;
    if (job.dependency && report.config.starting_snapshot !== entry.inherited_snapshot) return false;
  }
  entry.report_path = path.join(entry.run_dir, "report.json");
  entry.status = "complete"; entry.completed_at = now();
  return true;
}

export function summarizeCampaign(manifest: CampaignManifest, state: CampaignState): Record<string, unknown> {
  const counts = Object.fromEntries(["queued", "preparing", "prepared", "running", "complete", "interrupted"].map(status =>
    [status, manifest.jobs.filter(job => state.jobs[job.key]?.status === status).length]));
  const blocked = manifest.jobs.filter(job => job.dependency && state.jobs[job.key]?.status === "queued" && state.jobs[job.dependency]?.status !== "complete").length;
  return { planned: manifest.jobs.length, counts, blocked_dependencies: blocked,
    complete: counts.complete === manifest.jobs.length, dispatch_stopped: state.dispatch_stopped, stop_reason: state.stop_reason ?? null };
}

/** Starts once, or resumes only queued jobs. A crashed active job is interrupted forever. */
export async function executeCampaign(input: CampaignOptions): Promise<Record<string, unknown>> {
  const root = path.resolve(input.root);
  const bundles = path.resolve(input.bundles);
  const validator = path.resolve(input.validator ?? path.join(PROJECT_ROOT, "target/release/propbench"));
  const setDir = path.resolve(input.setDir ?? path.join(PROJECT_ROOT, "golf/set/v2"));
  const maxInflight = input.maxInflight ?? 6;
  if (!Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > 12) throw new Error("--max-inflight must be 1..12");
  const identity = (input.inspectIdentity ?? (() => inspectCampaignIdentity(setDir, validator)))();
  const manifestFile = path.join(root, "manifest.json");
  const prior = input.resume && !input.dryRun && fs.existsSync(manifestFile) ? readJson<CampaignManifest>(manifestFile) : null;
  const metadata = input.dryRun ? undefined : prior ? { campaign_id: prior.campaign_id, created_at: prior.created_at } : { campaign_id: randomUUID(), created_at: now() };
  const manifest = buildManifest(root, bundles, validator, setDir, identity, metadata);
  if (input.dryRun) return { dry_run: true, manifest, summary: { planned: 96, per_condition: 24, max_inflight: maxInflight, inference_dispatched: 0, bundles_created: 0 } };
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(root, !!input.resume);
  const manifestHash = sha256(canonical(manifest));
  let state: CampaignState;
  let stopping = false;
  const onSignal = () => { stopping = true; state.dispatch_stopped = true; state.stop_reason = "signal: stop new dispatch; active jobs finish"; saveState(root, state); };
  try {
    if (input.resume) {
      if (!fs.existsSync(manifestFile) || !fs.existsSync(path.join(root, "state.json"))) throw new Error("No campaign to resume");
      assertManifest(readJson<CampaignManifest>(manifestFile), manifest);
      state = readJson<CampaignState>(path.join(root, "state.json"));
      if (state.manifest_sha256 !== manifestHash || Object.keys(state.jobs).length !== 96 || manifest.jobs.some(job => !state.jobs[job.key])) throw new Error("Campaign state does not match complete manifest");
      for (const job of manifest.jobs) {
        const entry = state.jobs[job.key];
        if (["preparing", "prepared", "running"].includes(entry.status)) {
          const parent = job.run_parent;
          if (fs.existsSync(parent)) {
            const ids = fs.readdirSync(parent).filter(name => /^[a-f0-9-]{36}$/.test(name));
            if (ids.length === 1) { entry.run_id ??= ids[0]; entry.run_dir ??= path.join(parent, ids[0]); }
          }
          try {
            if (recoverCompletedJob(root, job, entry)) continue;
          } catch { /* Incomplete finalization is preserved as an interrupted run. */ }
          entry.status = "interrupted"; entry.completed_at = now(); entry.error = "Controller exited while job was active; never redispatch a started run";
        }
      }
      state.dispatch_stopped = false; delete state.stop_reason;
      saveState(root, state);
    } else {
      if (fs.existsSync(manifestFile) || fs.existsSync(path.join(root, "state.json"))) throw new Error("Campaign already exists; use --resume");
      fs.mkdirSync(path.join(root, "runs"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(root, "jobs"), { mode: 0o700 });
      fs.mkdirSync(bundles, { recursive: true, mode: 0o700 });
      writeJsonExclusive(manifestFile, manifest);
      state = { schema_version: "propbench-campaign-state-v1", manifest_sha256: manifestHash, created_at: now(), updated_at: now(), dispatch_stopped: false,
        jobs: Object.fromEntries(manifest.jobs.map(job => [job.key, { status: "queued" }])) };
      saveState(root, state);
    }
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
    const emit = (event: Record<string, unknown>) => {
      const record = { at: now(), ...event };
      fs.appendFileSync(path.join(root, "progress.ndjson"), JSON.stringify(record) + "\n");
      (input.emit ?? (value => process.stdout.write(JSON.stringify(value) + "\n")))(record);
    };
    const prepare = input.prepare ?? ((options: PrepareOptions, bundleDir?: string, archiveDir?: string) =>
      bundleDir ? prepareFrontier(options, bundleDir, archiveDir) : prepareRun(options));
    const run = input.run ?? ((ctx: RunContext) => runSubscription(ctx, { validator: path.join(ctx.dir, "referee/validator") }));
    const active = new Set<Promise<void>>();
    const launch = (job: CampaignJobPlan) => {
      const work = (async () => {
        const entry = state.jobs[job.key];
        try {
          // Source drift is checked immediately before each job and is a global stop.
          let currentIdentity: CampaignIdentity;
          try { currentIdentity = (input.inspectIdentity ?? (() => inspectCampaignIdentity(setDir, validator)))(); }
          catch (error) {
            state.dispatch_stopped = true; state.stop_reason = `source identity preflight failed: ${errorText(error)}`; saveState(root, state);
            emit({ event: "dispatch_stopped", reason: state.stop_reason }); return;
          }
          if (canonical(currentIdentity) !== canonical(manifest.identity)) {
            state.dispatch_stopped = true; state.stop_reason = "source identity drift before dispatch"; saveState(root, state);
            emit({ event: "dispatch_stopped", reason: state.stop_reason }); return;
          }
          entry.status = "preparing"; entry.started_at = now(); saveState(root, state);
          const base: PrepareOptions = { root: job.run_parent, setDir, ids: [job.item_id],
            track: isFrontier(job.condition) ? "frontier" : "unaided", mode: job.condition === "frontier-cumulative" ? "cumulative" : isFrontier(job.condition) ? "fresh" : "unaided",
            model: manifest.model, provider: manifest.provider, temperature: 0.2,
            budget: { wall_seconds: 900, max_generations: 1, max_output_tokens: 8192, max_thinking_tokens: 8192 },
            subscription: { effort: manifest.effort, max_tool_calls: job.max_tool_calls }, validator };
          let snapshot: string | undefined;
          if (job.dependency) {
            const fresh = state.jobs[job.dependency];
            if (fresh.status !== "complete" || !fresh.final_archive || !fresh.final_snapshot) throw new Error("Own fresh archive is unavailable");
            snapshot = fresh.final_archive;
            entry.inherited_from = job.dependency; entry.seed_run_id = fresh.run_id;
            entry.inherited_archive = snapshot; entry.inherited_snapshot = fresh.final_snapshot;
          }
          const ctx = prepare(base, job.bundle_dir ?? undefined, snapshot);
          if (ctx.config.selected_ids.length !== 1 || ctx.config.selected_ids[0] !== job.item_id ||
              ctx.config.provider !== "codex-subscription" || ctx.config.model !== manifest.model ||
              ctx.config.subscription?.effort !== manifest.effort || ctx.config.subscription.max_tool_calls !== job.max_tool_calls ||
              ctx.config.budget.wall_seconds !== job.wall_seconds || ctx.config.run_id !== path.basename(ctx.dir) ||
              Object.entries(state.jobs).some(([key, other]) => key !== job.key && other.run_id === ctx.config.run_id)) {
            throw new Error("Prepared run identity differs from campaign plan or duplicates another run");
          }
          entry.run_id = ctx.config.run_id; entry.run_dir = ctx.dir; if (job.bundle_dir) entry.bundle_dir = job.bundle_dir;
          entry.status = "prepared"; saveState(root, state);
          // Exclusive receipt binds the exact unique owner run before any model call.
          writeJsonExclusive(path.join(root, "jobs", job.key + ".json"), {
            schema_version: "propbench-campaign-dispatch-v1", manifest_sha256: manifestHash, key: job.key,
            item_id: job.item_id, condition: job.condition, run_id: entry.run_id, run_dir: entry.run_dir,
            bundle_dir: entry.bundle_dir ?? null, inherited_from: entry.inherited_from ?? null,
            seed_run_id: entry.seed_run_id ?? null,
            inherited_archive: entry.inherited_archive ?? null, inherited_snapshot: entry.inherited_snapshot ?? null,
            prepared_at: now(),
          });
          entry.status = "running"; saveState(root, state);
          emit({ event: "dispatched", key: job.key, run_id: entry.run_id, run_dir: entry.run_dir });
          await run(ctx);
          entry.report_path = path.join(ctx.dir, "report.json");
          if (!fs.existsSync(entry.report_path)) throw new Error("Run report was not durably written");
          const report = readJson<RunReport>(entry.report_path);
          if (report.evaluation_status !== "complete") {
            const subscription = path.join(ctx.dir, "subscription.json");
            const detail = fs.existsSync(subscription) ? readJson<{error?: string}>(subscription).error : undefined;
            throw new Error(`Interrupted subscription run${detail ? ": " + detail : ""}`);
          }
          if (canonical(report.config) !== canonical(ctx.config) || report.config.run_id !== entry.run_id || report.config.provider !== "codex-subscription" || report.config.selected_ids.length !== 1 || report.config.selected_ids[0] !== job.item_id ||
              (report.client_sessions ?? 0) < 1 || (!input.run && report.evidence !== "subscription")) throw new Error("Run report is unexecuted or mismatched");
          if (isFrontier(job.condition)) {
            const archive = readFinalArchive(ctx.dir);
            entry.final_archive = archive.path; entry.final_snapshot = archive.digest;
            if (job.dependency && ctx.config.starting_snapshot !== entry.inherited_snapshot) throw new Error("Cumulative snapshot differs from its own fresh archive");
          }
          entry.status = "complete"; entry.completed_at = now(); saveState(root, state);
          emit({ event: "complete", key: job.key, run_id: entry.run_id, report_path: entry.report_path, final_archive: entry.final_archive ?? null });
        } catch (error) {
          entry.status = "interrupted"; entry.completed_at = now(); entry.error = errorText(error); saveState(root, state);
          emit({ event: "interrupted", key: job.key, run_id: entry.run_id ?? null, error: entry.error });
          state.dispatch_stopped = true;
          state.stop_reason = `${quotaFailure(entry.error) ? "quota/auth/transport" : "run infrastructure"} failure in ${job.key}: ${entry.error}`;
          saveState(root, state);
        }
      })();
      active.add(work); work.finally(() => active.delete(work));
    };
    emit({ event: input.resume ? "resumed" : "started", planned: manifest.jobs.length, max_inflight: maxInflight });
    while (true) {
      while (!stopping && !state.dispatch_stopped && active.size < maxInflight) {
        const next = manifest.jobs.find(job => state.jobs[job.key].status === "queued" && (!job.dependency || state.jobs[job.dependency].status === "complete"));
        if (!next) break;
        launch(next);
      }
      if (!active.size) break;
      await Promise.race(active);
    }
    const summary = summarizeCampaign(manifest, state);
    emit({ event: "campaign_state", ...summary });
    return summary;
  } finally {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); releaseLock();
  }
}

function parseArgs(argv: string[]): CampaignOptions {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--root", "--bundles", "--validator", "--set", "--max-inflight", "--resume", "--dry-run"].includes(key) || opts[key]) throw new Error("Unknown or duplicate campaign option: " + key);
    if (key === "--resume" || key === "--dry-run") opts[key] = "true";
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing value for " + key); opts[key] = argv[++i]; }
  }
  return { root: opts["--root"] ?? path.join(PROJECT_ROOT, "track-runs/publication-20260926-v2"),
    bundles: opts["--bundles"] ?? path.join(PROJECT_ROOT, "../propbench-contestants/publication-20260926-v2"),
    validator: opts["--validator"], setDir: opts["--set"], maxInflight: opts["--max-inflight"] ? Number(opts["--max-inflight"]) : undefined,
    resume: !!opts["--resume"], dryRun: !!opts["--dry-run"] };
}

if (require.main === module) executeCampaign(parseArgs(process.argv.slice(2))).then(result => {
  if (!result.complete && !process.argv.includes("--dry-run")) process.exitCode = 2;
  if (process.argv.includes("--dry-run")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}).catch(error => { process.stderr.write(errorText(error) + "\n"); process.exitCode = 1; });
