/** Offline, independent replay of the public bundle. No owner run or provider imports. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Json = Record<string, any>;
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const V2_SET_HASH = "14407702fabce7978f6b5dcc3e3c86a76554bee8fd3c92b4a8a3179fde0f2715";
const V2_MANIFEST_HASH = "a25529897286192ac5291726875721e688a9b1044f1a9dd1953eac79a21e9f2c";
// The frozen campaign used Node's en-US collation. Make replay independent of
// the reader's ambient locale, especially for contestant-created tool names.
const compare = (a: string, b: string): number => a.localeCompare(b, "en-US");
const CONDITIONS: Record<string, { track: string; mode: string; protocol: string; calls: number }> = {
  "unaided-1": { track: "unaided", mode: "unaided", protocol: "unaided-subscription-v1", calls: 0 },
  "unaided-2": { track: "unaided", mode: "unaided", protocol: "unaided-subscription-v1", calls: 0 },
  "frontier-fresh": { track: "frontier", mode: "fresh", protocol: "frontier-subscription-v2", calls: 128 },
  "frontier-cumulative": { track: "frontier", mode: "cumulative", protocol: "frontier-subscription-v2", calls: 128 },
};
export const publicationSha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function publicationCanonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(publicationCanonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, item]) => JSON.stringify(key) + ":" + publicationCanonical(item)).join(",") + "}";
  return JSON.stringify(value);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, label: string): Json {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Json;
}
function array(value: unknown, label: string): any[] { check(Array.isArray(value), `${label} must be an array`); return value; }
function hash(value: unknown, label: string): string { check(typeof value === "string" && HASH.test(value), `${label} must be a SHA-256`); return value; }
function id(value: unknown, label: string): string { check(typeof value === "string" && ID.test(value), `${label} is not a safe ID`); return value; }
function integer(value: unknown, label: string, min = 0): number { check(Number.isSafeInteger(value) && Number(value) >= min, `${label} must be an integer >= ${min}`); return Number(value); }
function finite(value: unknown, label: string): number { check(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`); return value; }
function same(a: unknown, b: unknown, label: string): void { check(publicationCanonical(a) === publicationCanonical(b), `${label} mismatch`); }
function close(a: unknown, b: number, label: string): void { check(Math.abs(finite(a, label) - b) <= 1e-12, `${label} arithmetic mismatch`); }
function time(value: unknown, label: string): number { check(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} must be a timestamp`); return Date.parse(value); }
function keys(value: Json, expected: string[], label: string): void { same(Object.keys(value).sort(), expected.sort(), `${label} fields`); }

/** Refuse traversal, symlinks, special files, and unexpectedly large public assets. */
function asset(root: string, relative: string, max = 16 * 1024 * 1024): Buffer {
  check(typeof relative === "string" && !relative.includes("\\") && !relative.includes("\0") &&
    !path.isAbsolute(relative) && relative.split("/").every(part => part && part !== "." && part !== ".."), "Unsafe public asset path");
  let file = root;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    const stat = fs.lstatSync(file);
    check(!stat.isSymbolicLink(), `Public asset symlink forbidden: ${relative}`);
    if (file !== path.join(root, relative)) check(stat.isDirectory(), `Public asset ancestor is not a directory: ${relative}`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= max, `Public asset is not a bounded regular file: ${relative}`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function json(bytes: Buffer, label: string): Json {
  try { return object(JSON.parse(bytes.toString("utf8")), label); }
  catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}
function proof(value: unknown, label: string): Json[] {
  return array(value, label).map((entry, index) => {
    const line = object(entry, `${label}[${index}]`);
    keys(line, ["line_number", "formula", "justification", "depth"], label);
    integer(line.line_number, `${label}.line_number`, 1); integer(line.depth, `${label}.depth`);
    check(typeof line.formula === "string" && line.formula.trim() && typeof line.justification === "string" && line.justification.trim(), `${label} has an empty formula or justification`);
    return line;
  });
}

function snapshot(value: unknown, label: string, itemId: string): Json {
  const index = object(value, label);
  keys(index, ["schema_version", "digest", "entries"], label);
  check(index.schema_version === "propbench-frontier-snapshot-v1", `${label} schema mismatch`);
  const entries = array(index.entries, `${label}.entries`);
  check(entries.length <= 20000, `${label} has too many entries`);
  const names = new Set<string>();
  let total = 0;
  for (const raw of entries) {
    const entry = object(raw, `${label}.entry`);
    check(typeof entry.path === "string" && !entry.path.includes("\\") && entry.path.split("/").every((part: string) => part && part !== "." && part !== ".." && !/[\x00-\x1f\x7f]/.test(part)), `${label} has unsafe entry path`);
    check(/^(?:proofs(?:\/.*)?|tools(?:\/.*)?|METHODS\.md|LOG\.md|DEBRIEF\.md)$/.test(entry.path), `${label} has an unapproved root`);
    check(!names.has(entry.path), `${label} repeats an entry`); names.add(entry.path);
    check(integer(entry.mode, `${label}.mode`) <= 0o7777, `${label} invalid mode`);
    check(entry.kind === "directory" || entry.kind === "file", `${label} unsupported file kind`);
    keys(entry, entry.kind === "file" ? ["path", "kind", "mode", "bytes", "sha256"] : ["path", "kind", "mode"], label);
    if (entry.kind === "file") {
      const size = integer(entry.bytes, `${label}.bytes`); check(size <= 16 * 1024 * 1024, `${label} file too large`);
      total += size; hash(entry.sha256, `${label}.sha256`);
      if (size === 0) check(entry.sha256 === publicationSha256(""), `${label} empty-file hash mismatch`);
    }
    if (entry.path.startsWith("proofs/")) check([`proofs/${itemId}.json`, "proofs/.gitkeep"].includes(entry.path) && entry.kind === "file", `${label} contains an unknown proof`);
  }
  check(total <= 64 * 1024 * 1024, `${label} exceeds snapshot allowance`);
  for (const root of ["proofs", "tools"]) check(entries.some(entry => entry.path === root && entry.kind === "directory"), `${label} missing ${root} directory`);
  for (const name of ["METHODS.md", "LOG.md", "DEBRIEF.md"]) check(entries.some(entry => entry.path === name && entry.kind === "file"), `${label} missing ${name}`);
  for (const entry of entries) if (entry.path.includes("/")) {
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/"));
    check(entries.some(candidate => candidate.path === parent && candidate.kind === "directory"), `${label} missing ancestor directory`);
  }
  same(entries.map(entry => entry.path), [...names].sort(compare), `${label} order`);
  check(hash(index.digest, `${label}.digest`) === publicationSha256(publicationCanonical({ schema_version: index.schema_version, entries })), `${label} digest mismatch`);
  return index;
}

export function publicCohort(run: Json): string {
  const configuration = publicationSha256(publicationCanonical({ track: run.track, mode: run.mode, set_hash: run.set_hash,
    scorer: "efficiency-v2", protocol: run.execution_protocol, provider: run.provider, snapshot: run.starting_snapshot,
    budget: { wall_seconds: run.budget.wall_seconds, ...run.subscription }, temperature: null,
    validator: run.validator_sha256, rules: run.rulebook_sha256, evaluator: run.evaluator_hash, evidence: "evaluation" }));
  return publicationSha256(publicationCanonical({ configuration, runtime: run.runtime, injected: false }));
}

export interface PublicationVerificationOptions {
  dataFile?: string;
  validator?: string;
  expectedResultsSha256?: string;
  requireExactBinary?: boolean;
}

export async function verifyPublication(options: PublicationVerificationOptions = {}): Promise<Json> {
  const dataFile = path.resolve(options.dataFile ?? path.join(ROOT, "publication/data/results.json"));
  const root = fs.realpathSync(path.dirname(dataFile));
  const bytes = asset(root, path.basename(dataFile), 128 * 1024 * 1024);
  const resultsHash = publicationSha256(bytes);
  if (options.expectedResultsSha256 !== undefined) check(resultsHash === hash(options.expectedResultsSha256, "Expected results hash"), "Results file differs from externally pinned SHA-256");
  const data = json(bytes, "Publication");
  check(data.schema_version === "propbench-publication-v1", "Unsupported publication schema");
  time(data.generated_at, "Publication generated_at");
  const set = object(data.set, "set"), evaluator = object(data.evaluator, "evaluator"), campaign = object(data.campaign, "campaign");
  check(set.version === "v2" && set.core_tag === "v0.3.4", "This verifier supports the frozen v2/core-v0.3.4 census");
  check(set.hash === V2_SET_HASH && set.manifest_sha256 === V2_MANIFEST_HASH, "Frozen v2 identity mismatch");
  check(evaluator.scorer_version === "efficiency-v2", "Unsupported scoring version");
  const manifestBytes = asset(root, "theorems/manifest.json");
  check(publicationSha256(manifestBytes) === set.manifest_sha256, "Theorem manifest bytes hash mismatch");
  const manifest = json(manifestBytes, "Theorem manifest");
  check(manifest.set_version === set.version && manifest.core_tag === set.core_tag, "Manifest version mismatch");
  const manifestItems = array(manifest.items, "Manifest items");
  check(manifestItems.length === 24, "V2 must contain all 24 items");
  const setHash = (items: Json[]) => publicationSha256(publicationCanonical({ version: set.version, core_tag: set.core_tag, items }));
  check(setHash(manifestItems) === set.hash, "Set identity arithmetic mismatch");
  const items = array(data.items, "Publication items");
  check(items.length === manifestItems.length, "Publication theorem denominator mismatch");
  const itemById = new Map<string, Json>();
  for (let index = 0; index < manifestItems.length; index++) {
    const expected = object(manifestItems[index], "Manifest item"), item = object(items[index], "Publication item");
    id(expected.id, "Theorem ID"); integer(expected.par, "Reference length", 1); hash(expected.theorem_sha256, "Theorem SHA");
    check(!itemById.has(expected.id), "Repeated manifest item");
    check(item.id === expected.id && item.par === expected.par && item.theorem_sha256 === expected.theorem_sha256, "Published item differs from frozen manifest");
    const raw = asset(root, `theorems/${expected.id}.json`);
    check(publicationSha256(raw) === expected.theorem_sha256, `Theorem bytes hash mismatch: ${expected.id}`);
    const theorem = json(raw, "Theorem"); check(theorem.id === item.id, "Theorem ID mismatch");
    same(theorem, item.theorem, `Embedded theorem ${item.id}`); itemById.set(item.id, item);
  }
  check(publicationSha256(asset(root, "rules.md")) === hash(evaluator.rulebook_sha256, "Rulebook SHA"), "Rulebook bytes hash mismatch");
  hash(evaluator.validator_sha256, "Original referee SHA");
  id(campaign.id, "Campaign ID"); check(typeof campaign.model === "string" && campaign.model && typeof campaign.effort === "string" && campaign.effort, "Campaign model/effort missing");
  time(campaign.created_at, "Campaign created_at");
  check(typeof campaign.source_commit === "string" && /^[a-f0-9]{40}$/.test(campaign.source_commit), "Campaign source commit missing");
  hash(campaign.evaluator_hash, "Campaign evaluator SHA");
  const client = object(campaign.client, "Campaign client"); hash(client.sha256, "Native client SHA");
  check(typeof client.version === "string" && client.version.startsWith("codex-cli "), "Native client version missing");
  const jobs = array(campaign.jobs, "Campaign jobs"), runs = array(data.runs, "Runs");
  check(jobs.length === 96 && campaign.planned_jobs === 96 && campaign.recorded_runs === runs.length, "Campaign planned/recorded denominator mismatch");
  const jobByKey = new Map<string, Json>(), jobByRun = new Map<string, Json>();
  for (const raw of jobs) {
    const job = object(raw, "Job"), condition = CONDITIONS[job.condition];
    check(condition && itemById.has(job.item_id) && job.key === `${job.item_id}--${job.condition}`, "Unknown or malformed planned condition/item");
    check(!jobByKey.has(job.key), "Duplicate planned job"); jobByKey.set(job.key, job);
    check(job.wall_seconds === 900 && job.max_tool_calls === condition.calls, "Planned condition budget mismatch");
    check(["pending", "queued", "preparing", "prepared", "running", "complete", "interrupted"].includes(job.status), "Unknown job status");
    if (job.run_id !== undefined) { id(job.run_id, "Job run ID"); check(!jobByRun.has(job.run_id), "Duplicate planned run ID"); jobByRun.set(job.run_id, job); }
    if (job.status === "complete") check(job.run_id, "Completed job lacks a run");
  }
  for (const item of items) for (const condition of Object.keys(CONDITIONS)) check(jobByKey.has(`${item.id}--${condition}`), "Missing planned census unit");
  check(["running", "interrupted", "complete"].includes(campaign.status), "Unknown campaign status");
  if (campaign.status === "complete") check(jobs.every(job => job.status === "complete"), "Campaign falsely claims completion");
  if (jobs.every(job => job.status === "complete")) check(campaign.status === "complete", "Completed census is mislabeled");

  const replayJobs: Array<{ runId: string; itemId: string; proofFile: string; length: number }> = [];
  let checkpointReplays = 0;
  const runById = new Map<string, Json>();
  let frontierRuntime: string | null = null;
  for (const raw of runs) {
    const run = object(raw, "Run"); id(run.id, "Run ID");
    check(!runById.has(run.id), "Repeated run ID"); runById.set(run.id, run);
    const job = jobByRun.get(run.id); check(job, `Unplanned public run ${run.id}`);
    const condition = CONDITIONS[job.condition];
    check(run.campaign_id === campaign.id && run.campaign_condition === job.condition && run.model === campaign.model, "Run campaign/configuration mismatch");
    check(run.track === condition.track && run.mode === condition.mode && run.execution_protocol === condition.protocol, "Run track/mode/protocol mismatch");
    check(run.provider === "codex-subscription" && run.evidence === "subscription", "Public evaluation is not native Codex subscription evidence");
    check(["complete", "interrupted"].includes(run.evaluation_status), "Nonterminal public run");
    check(run.evaluation_status === job.status, "Run status differs from planned job snapshot");
    check(run.outcome === (run.evaluation_status === "complete" ? "completed" : "interrupted; excluded from comparative ranking"), "Run ranking outcome mismatch");
    same(run.selected_ids, [job.item_id], "Run singleton selection");
    same(run.subscription, { effort: campaign.effort, max_tool_calls: condition.calls }, "Run subscription settings");
    same(run.budget, { wall_seconds: 900, max_tool_calls: condition.calls }, "Run budget");
    check(run.set_version === set.version && run.core_tag === set.core_tag && run.set_hash === setHash(manifestItems.filter(item => item.id === job.item_id)), "Run singleton set hash mismatch");
    check(run.evaluator_hash === campaign.evaluator_hash && run.validator_sha256 === evaluator.validator_sha256 && run.rulebook_sha256 === evaluator.rulebook_sha256, "Run evaluator identity mismatch");
    hash(run.regraded_by, "Regrader SHA"); time(run.completed_at, "Run completion"); time(run.graded_at, "Run grading");
    const returned = array(run.returned_models, "Returned models"), observed = array(run.observed_models, "Observed models");
    check(new Set(returned).size === returned.length && returned.every(model => model === campaign.model), "Returned model fallback/mismatch"); same(observed, returned, "Observed/returned models");
    const sessions = integer(run.client_sessions, "Client sessions"); check(sessions <= (run.track === "unaided" ? 1 : 8), "Session allowance exceeded");
    if (run.evaluation_status === "complete") check(sessions > 0, "Completed run has no session");
    finite(run.elapsed_seconds, "Elapsed seconds");
    const coverage = object(run.usage_coverage, "Usage coverage"); check(integer(coverage.attempts, "Usage attempts") === sessions && integer(coverage.attempts_with_usage, "Usage-covered attempts") <= sessions, "Usage coverage exceeds sessions");
    const usage = object(run.usage, "Usage"); for (const [key, value] of Object.entries(usage)) { check(["input_tokens", "output_tokens", "thinking_tokens", "total_tokens"].includes(key), "Unknown subscription usage field"); integer(value, `Usage ${key}`); }
    const tools = object(run.tool_counts, "Tool counts"); let calls = 0;
    for (const [key, value] of Object.entries(tools)) { check(["exec", "delegate"].includes(key), "Unknown tool in public run"); calls += integer(value, "Tool calls"); }
    check(calls <= condition.calls, "Tool allowance exceeded");
    if (run.track === "unaided") {
      check(run.runtime === null && run.starting_snapshot === null && run.seed_run_id == null && run.initial_snapshot == null && run.final_snapshot == null, "Unaided inheritance/runtime contamination");
    } else {
      if (run.runtime !== null) {
        const runtime = object(run.runtime, "Runtime"); keys(runtime, ["backend", "image_id", "architecture"], "Runtime");
        check(runtime.backend === "docker" && typeof runtime.image_id === "string" && /^sha256:[a-f0-9]{64}$/.test(runtime.image_id) && typeof runtime.architecture === "string" && runtime.architecture, "Invalid Frontier runtime");
        const identity = publicationCanonical(runtime); if (frontierRuntime !== null) check(identity === frontierRuntime, "Frontier runtime changed within campaign"); frontierRuntime = identity;
      } else check(run.evaluation_status === "interrupted", "Completed Frontier lacks runtime identity");
      const initial = snapshot(run.initial_snapshot, "Initial snapshot", job.item_id);
      if (run.final_snapshot != null) snapshot(run.final_snapshot, "Final snapshot", job.item_id);
      else check(run.evaluation_status === "interrupted", "Completed Frontier lacks final snapshot");
      if (run.mode === "fresh") {
        check(run.starting_snapshot === null && run.seed_run_id == null, "Fresh run declares inheritance");
        check(initial.entries.every((entry: Json) => entry.kind === "directory" || (entry.bytes === 0 && !entry.path.endsWith(".json"))), "Fresh initial snapshot is not empty");
      } else { hash(run.starting_snapshot, "Starting snapshot"); id(run.seed_run_id, "Seed run ID"); check(initial.digest === run.starting_snapshot, "Initial snapshot differs from inherited digest"); }
    }
    check(hash(run.cohort, "Cohort SHA") === publicCohort(run), "Run cohort hash mismatch");
    const outcomes = array(run.items, "Run item results"); check(outcomes.length === 1 && run.total === 1, "Run result denominator mismatch");
    const result = object(outcomes[0], "Item result"), theorem = itemById.get(job.item_id)!;
    check(result.id === job.item_id && result.par === theorem.par, "Result theorem/reference mismatch");
    check(["valid", "invalid", "parse_error", "transport_error", "protocol_error", "missing", "interrupted"].includes(result.status), "Unsupported item outcome");
    if (result.status === "valid") {
      const count = integer(result.line_count, "Verified length"), lines = proof(result.proof, "Published proof");
      check(lines.length === count && lines.length <= 100000, "Published proof length mismatch");
      check(hash(result.proof_sha256, "Canonical proof SHA") === publicationSha256(publicationCanonical(lines)), "Canonical proof hash mismatch");
      check(result.proof_file === `proofs/${run.id}/${job.item_id}.json`, "Unexpected proof asset path");
      const proofBytes = asset(root, result.proof_file);
      check(publicationSha256(proofBytes) === hash(result.proof_bytes_sha256, "Proof bytes SHA"), "Exact proof bytes hash mismatch");
      let exact: unknown; try { exact = JSON.parse(proofBytes.toString("utf8")); } catch { throw new Error("Proof asset is not JSON"); }
      same(proof(exact, "Proof asset"), lines, "Embedded/asset proof");
      check(result.independently_replayed === true, "Published valid proof lacks export replay declaration");
      close(result.loss, count / (count + result.par), "Item loss"); check(run.valid_count === 1, "Valid count mismatch");
      if (run.final_snapshot) {
        const entry = run.final_snapshot.entries.find((entry: Json) => entry.path === `proofs/${job.item_id}.json`);
        check(entry?.sha256 === result.proof_bytes_sha256 && entry.bytes === proofBytes.length, "Final snapshot proof differs from published exact bytes");
      }
      replayJobs.push({ runId: run.id, itemId: job.item_id, proofFile: result.proof_file, length: count });
    } else {
      check(result.line_count === null && result.proof == null && result.proof_file == null && result.proof_sha256 == null && result.proof_bytes_sha256 == null && result.independently_replayed !== true, "Nonvalid outcome contains a claimed proof");
      close(result.loss, 1, "Unsolved item loss"); check(run.valid_count === 0, "Invalid valid_count");
      if (run.final_snapshot) check(!run.final_snapshot.entries.some((entry: Json) => entry.path === `proofs/${job.item_id}.json`), "Final snapshot claims an unreported proof");
    }
    close(run.score, result.loss, "Run mean loss");
  }
  for (const job of jobs) if (job.status === "complete") check(runById.has(job.run_id), "Completed planned run is omitted");
  for (const run of runs) if (run.mode === "cumulative") {
    const seed = runById.get(run.seed_run_id);
    check(seed && seed.mode === "fresh" && seed.evaluation_status === "complete" && seed.selected_ids[0] === run.selected_ids[0] && seed.campaign_id === run.campaign_id, "Cumulative seed is not the same item's completed fresh run");
    check(seed.final_snapshot?.digest === run.starting_snapshot, "Cumulative lineage digest mismatch");
    if (seed.items[0].status === "valid") check(run.items[0].status === "valid" && run.items[0].line_count <= seed.items[0].line_count, "Cumulative run regressed from inherited verified incumbent");
  }

  // Older public exports omit the sequence. If present, it must describe all
  // accepted improvements and end at the published incumbent. This verifies
  // declared timing/order, not the authenticity of the owner's clock.
  for (const run of runs) if (run.improvements !== undefined) {
    const improvements = array(run.improvements, "Run improvements");
    if (run.track !== "frontier") { check(improvements.length === 0, "Unaided run has checkpoint improvements"); continue; }
    check(improvements.length <= 128, "Too many accepted checkpoint improvements");
    const inherited = run.mode === "cumulative" ? runById.get(run.seed_run_id)!.items[0] : null;
    let incumbent = inherited?.status === "valid" ? inherited : null;
    let previousCheckpoint = 0, previousCommand = 0, previousImport = 0, previousCapture = 0;
    for (const raw of improvements) {
      const event = object(raw, "Improvement"), itemId = run.selected_ids[0];
      check(event.item_id === itemId, "Improvement belongs to a different theorem");
      check(typeof event.checkpoint_id === "string" && /^\d{6}$/.test(event.checkpoint_id) && Number(event.checkpoint_id) > previousCheckpoint, "Checkpoint identity/order mismatch");
      const command = integer(event.execution_command, "Improvement execution command", 1);
      check(command > previousCommand && command <= (run.tool_counts.exec ?? 0), "Improvement execution command/order exceeds recorded exec calls");
      const elapsed = finite(event.captured_elapsed_seconds, "Improvement capture time");
      check(elapsed >= previousCapture && elapsed < run.budget.wall_seconds, "Improvement capture is out of order or outside the wall budget");
      const length = integer(event.line_count, "Improvement length", 1);
      check(event.previous_line_count === (incumbent?.line_count ?? null), "Improvement previous incumbent length mismatch");
      check(incumbent === null || length < incumbent.line_count, "Accepted improvement did not shorten the incumbent");
      const lines = proof(event.proof, "Checkpoint proof");
      check(lines.length === length && lines.length <= 100000, "Checkpoint proof length mismatch");
      check(hash(event.proof_sha256, "Checkpoint canonical proof SHA") === publicationSha256(publicationCanonical(lines)), "Checkpoint canonical proof hash mismatch");
      const prefix = `proofs/${run.id}/checkpoints/${itemId}-`;
      check(typeof event.import_id === "string" && /^\d{6}$/.test(event.import_id) && event.proof_file === `${prefix}${event.import_id}.json`, "Unexpected checkpoint proof asset path/import identity");
      const importId = Number(event.import_id);
      check(importId > previousImport, "Checkpoint import identity/order mismatch");
      check(event.independently_replayed === true, "Checkpoint proof lacks export replay declaration");
      const proofBytes = asset(root, event.proof_file);
      check(publicationSha256(proofBytes) === hash(event.proof_bytes_sha256, "Checkpoint proof bytes SHA"), "Checkpoint exact proof bytes hash mismatch");
      let exact: unknown; try { exact = JSON.parse(proofBytes.toString("utf8")); } catch { throw new Error("Checkpoint proof asset is not JSON"); }
      same(proof(exact, "Checkpoint proof asset"), lines, "Embedded/asset checkpoint proof");
      replayJobs.push({ runId: run.id, itemId, proofFile: event.proof_file, length }); checkpointReplays++;
      incumbent = event; previousCheckpoint = Number(event.checkpoint_id); previousCommand = command; previousImport = importId; previousCapture = elapsed;
    }
    const final = run.items[0];
    check((incumbent !== null) === (final.status === "valid"), "Improvement sequence disagrees with final incumbent presence");
    if (incumbent !== null) check(incumbent.line_count === final.line_count && incumbent.proof_sha256 === final.proof_sha256 && incumbent.proof_bytes_sha256 === final.proof_bytes_sha256, "Improvement sequence disagrees with final incumbent proof");
  }

  const validator = path.resolve(options.validator ?? path.join(ROOT, "target/release/propbench-validate"));
  check(fs.existsSync(validator), `Replay validator missing. Build it with: cargo build --locked --release --no-default-features --bin propbench-validate`);
  const localHash = publicationSha256(fs.readFileSync(validator));
  const exactBinary = localHash === evaluator.validator_sha256;
  if (options.requireExactBinary) check(exactBinary, "Local binary SHA differs from original referee; exact-binary replay requested");
  for (const replay of replayJobs) {
    let stdout: string;
    try {
      ({ stdout } = await exec(validator, ["validate", "--strict-protocol", "--theorem", path.join(root, `theorems/${replay.itemId}.json`), "--proof", path.join(root, replay.proofFile)], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
    } catch (error) { throw new Error(`Strict replay failed for ${replay.runId}/${replay.itemId}: ${error instanceof Error ? error.message : String(error)}`); }
    const verdict = json(Buffer.from(stdout), "Referee response");
    check(verdict.valid === true && verdict.line_count === replay.length && Array.isArray(verdict.errors) && verdict.errors.length === 0, `Strict replay disagrees for ${replay.runId}/${replay.itemId}`);
  }
  return {
    schema_version: "propbench-publication-verification-v1", verified: true, results_sha256: resultsHash,
    externally_pinned_results: options.expectedResultsSha256 !== undefined, campaign_id: campaign.id,
    campaign_status: campaign.status, census_complete: campaign.status === "complete", planned_jobs: 96,
    recorded_runs: runs.length, completed_runs: runs.filter(run => run.evaluation_status === "complete").length,
    interrupted_runs: runs.filter(run => run.evaluation_status === "interrupted").length, independently_replayed_proofs: replayJobs.length,
    independently_replayed_incumbents: replayJobs.length - checkpointReplays, independently_replayed_checkpoint_proofs: checkpointReplays,
    frontier_runs_with_improvement_sequences: runs.filter(run => run.track === "frontier" && run.improvements !== undefined).length,
    frontier_runs_without_improvement_sequences: runs.filter(run => run.track === "frontier" && run.improvements === undefined).length,
    job_counts: Object.fromEntries(["pending", "queued", "preparing", "prepared", "running", "complete", "interrupted"].map(status => [status, jobs.filter(job => job.status === status).length])),
    referee: { local_sha256: localHash, original_sha256: evaluator.validator_sha256, exact_binary_match: exactBinary,
      comparison: exactBinary ? "original binary identity and strict proof replay" : "strict proof replay with a different binary; platform/build identity is not claimed" },
    limitations: ["Checks public metadata consistency and proof validity; it does not authenticate provider execution or hidden tool isolation.",
      "Snapshot inventories bind lineage metadata; unpublished tool/journal bytes are not independently verified.",
      "Checkpoint times and execution order are checked as owner-recorded metadata, not authenticated measurements.",
      "Without an externally trusted results hash, a consistently rewritten bundle is not cryptographically authenticated.",
      ...(campaign.status === "complete" ? [] : ["The campaign is incomplete; verified partial evidence is not a completed census."])],
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options: PublicationVerificationOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--require-exact-binary") { options.requireExactBinary = true; continue; }
    const key = ({ "--data": "dataFile", "--validator": "validator", "--expected-results-sha256": "expectedResultsSha256" } as const)[arg as "--data"];
    check(key && argv[index + 1] && !argv[index + 1].startsWith("--"), "Usage: publication:verify [--data RESULTS_JSON] [--validator EXECUTABLE] [--expected-results-sha256 HEX] [--require-exact-binary]");
    check(options[key] === undefined, `Repeated option: ${arg}`); options[key] = argv[++index];
  }
  console.log(JSON.stringify(await verifyPublication(options), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
