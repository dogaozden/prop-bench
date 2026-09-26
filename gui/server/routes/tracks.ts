import { Router, Request, Response } from "express";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The track API is deliberately a narrow owner-side adapter.  It knows the
 * frozen set directory and the private run root, while the track workers own
 * preparation, provider calls, packaging, and grading details.
 */
const router = Router();
const require_ = createRequire(import.meta.url);
const ROUTE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(ROUTE_DIR, "..", "..", "..");
const configuredTrackRunRoot = process.env.PROPBENCH_TRACK_RUN_ROOT?.trim();
const configuredContestantRoot = process.env.PROPBENCH_CONTESTANT_ROOT?.trim();
export const TRACK_RUN_ROOT = path.resolve(configuredTrackRunRoot || path.join(PROJECT_ROOT, "track-runs"));
const SET_ROOT = path.join(PROJECT_ROOT, "golf", "set");
const CONTESTANT_ROOT = path.resolve(configuredContestantRoot || path.join(PROJECT_ROOT, "..", "propbench-contestants"));
export const DEFAULT_VALIDATOR = path.join(
  PROJECT_ROOT,
  "target",
  "release",
  process.platform === "win32" ? "propbench.exe" : "propbench",
);

// Each selected theorem gets one fresh native subscription session. Legacy
// generation/token fields are retained only for fixture compatibility.
export const UNAIDED_BUDGET = Object.freeze({
  wall_seconds: 300,
  max_generations: 1,
  max_output_tokens: 4096,
  max_thinking_tokens: 8192,
});
export const FRONTIER_BUDGET = Object.freeze({
  wall_seconds: 3600,
  max_generations: 24,
  max_output_tokens: 8192,
  max_thinking_tokens: 16384,
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CAMPAIGN_GROUP = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}--(?:unaided-[12]|frontier-(?:fresh|cumulative))$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_RUN_GROUPS = 256;
const MAX_INDEXED_RUNS = 1024;
const MAX_GROUP_CHILDREN = 16;
const MAX_CHECKPOINT_RECEIPTS_PER_ITEM = 1024;
const CHECKPOINT_RECEIPT_NAME = /^\d{6}\.json$/;
// New owner-console runs use the native Codex subscription. Fixtures remain a
// deterministic local test path; historical Claude/external reports are read-only.
const RUN_PROVIDERS = new Set(["codex-subscription", "fixture"]);
type AnyRecord = Record<string, any>;
type TrackContext = { dir: string; config: AnyRecord; set: AnyRecord };
type TrackReport = AnyRecord;
type Provider = "codex-subscription" | "fixture";
const isSubscription = (provider: string) => provider === "claude-subscription" || provider === "codex-subscription";

interface TrackJob {
  runId: string;
  context: TrackContext;
  track: "frontier" | "unaided";
  mode: "fresh" | "cumulative" | "unaided";
  state: "preparing" | "prepared" | "running" | "complete" | "error";
  startedAt: string;
  finishedAt?: string;
  report?: TrackReport;
  error?: string;
  bundleDir?: string;
  handoff?: Handoff;
}

interface Handoff {
  run_dir: string;
  bundle_dir: string;
  handoff_command: string;
  bridge_command: string;
  submit_command: string;
  mcp_server: { command: string; args: string[]; env?: { PROPBENCH_DOCKER_HOST: string } };
  requirement: string;
  note: string;
}

interface FrontierRunOption {
  run_id: string;
  model: string;
  mode: "fresh" | "cumulative";
  set_version: string;
  set_hash: string;
  starting_snapshot: string | null;
  state: "prepared" | "complete";
  score: number | null;
}

interface IndexedRun { id: string; dir: string; group?: string }
interface RunIndex { runs: Map<string, IndexedRun>; campaignState: AnyRecord | null }

const jobs = new Map<string, TrackJob>();

function exactModule(candidate: string, label: string): AnyRecord {
  try {
    const loaded = require_(candidate) as AnyRecord;
    if (loaded && typeof loaded === "object") {
      return loaded.default && typeof loaded.default === "object"
        ? { ...loaded.default, ...loaded }
        : loaded;
    }
    throw new Error(`${label} source did not export a module object`);
  } catch (error) {
    throw new Error(`${label} source is unavailable: ${errorMessage(error)}`);
  }
}

function coreModule(): AnyRecord {
  return exactModule(path.join(PROJECT_ROOT, "tracks", "core"), "Track core");
}

function workerModule(kind: "frontier" | "unaided"): AnyRecord {
  return exactModule(path.join(PROJECT_ROOT, "tracks", kind), `${kind[0].toUpperCase()}${kind.slice(1)} worker`);
}

function frontierRunnerModule(): AnyRecord {
  return exactModule(path.join(PROJECT_ROOT, "tracks", "frontier-runner"), "Controlled Frontier runner");
}

function fn<T extends (...args: any[]) => any>(mod: AnyRecord, name: string): T | undefined {
  if (typeof mod[name] === "function") return mod[name] as T;
  if (typeof mod.default?.[name] === "function") return mod.default[name] as T;
  return undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Errors are useful to the owner, but request bodies, credentials, and long
  // provider transcripts must never be echoed by this API.
  return message.replace(/\0/g, "").slice(0, 4000);
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Numeric option must be finite");
  return value;
}

function boundedInteger(value: unknown, fallback: number, maximum: number, allowZero = false): number {
  if (value === undefined) return fallback;
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1) || number > maximum) {
    throw new Error(`Integer option must be between ${allowZero ? 0 : 1} and ${maximum}`);
  }
  return number;
}

function normalizeModel(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("model must be a string");
  const model = value.trim();
  if (!model || model.length > 200 || /[\0\r\n]/.test(model)) throw new Error("model must be a non-empty bounded string");
  return model;
}

export function normalizeProvider(value: unknown, _track: "frontier" | "unaided"): Provider {
  const fallback: Provider = "codex-subscription";
  if (value === undefined) return fallback;
  if (typeof value === "string" && RUN_PROVIDERS.has(value)) return value as Provider;
  throw new Error("New Tracks runs require the native Codex subscription or an explicit local fixture rehearsal.");
}

function normalizeTemperature(value: unknown): number {
  const temperature = finiteNumber(value, 0.2);
  if (temperature < 0 || temperature > 2) throw new Error("Temperature must be between 0 and 2");
  return temperature;
}

function normalizeBudget(value: unknown, fallback: Readonly<{
  wall_seconds: number;
  max_generations: number;
  max_output_tokens: number;
  max_thinking_tokens: number;
}>): AnyRecord {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value)) throw new Error("budget must be an object");
  const allowed = new Set(["wall_seconds", "max_generations", "max_output_tokens", "max_thinking_tokens"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("budget contains an unknown option");
  return {
    wall_seconds: boundedInteger(value.wall_seconds, fallback.wall_seconds, 7 * 86400),
    max_generations: boundedInteger(value.max_generations, fallback.max_generations, 100000),
    max_output_tokens: boundedInteger(value.max_output_tokens, fallback.max_output_tokens, 1000000),
    max_thinking_tokens: boundedInteger(value.max_thinking_tokens, fallback.max_thinking_tokens, 1000000, true),
  };
}

function catalogFromManifest(name: string): AnyRecord | null {
  if (!SAFE_ID.test(name)) return null;
  const dir = path.join(SET_ROOT, name);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as AnyRecord;
    if (typeof manifest.set_version !== "string" || typeof manifest.core_tag !== "string" || !Array.isArray(manifest.items)) return null;
    const ids = manifest.items.filter((item: AnyRecord) => typeof item?.id === "string" && SAFE_ID.test(item.id)).map((item: AnyRecord) => item.id);
    return { name, version: manifest.set_version, count: ids.length, ids, core_tag: manifest.core_tag };
  } catch {
    return null;
  }
}

function listKnownSets(): AnyRecord[] {
  const coreList = fn<() => AnyRecord[]>(coreModule(), "listSets");
  if (!coreList) throw new Error("Track core does not export listSets");
  const listed = coreList().filter((set) => isRecord(set) && typeof set.name === "string");

  const result: AnyRecord[] = [];
  for (const raw of listed) {
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!SAFE_ID.test(name)) continue;
    // Re-read the server-known manifest.  This prevents a worker export from
    // turning an arbitrary path into an accepted set directory.
    const fixed = catalogFromManifest(name);
    if (!fixed) continue;
    const item = {
      name,
      version: typeof raw.version === "string" ? raw.version : fixed.version,
      count: fixed.count,
      ids: fixed.ids,
      core_tag: typeof raw.core_tag === "string" ? raw.core_tag : fixed.core_tag,
    };
    result.push(item);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function fixedSet(name: unknown): AnyRecord {
  const candidate = typeof name === "string" ? name : "";
  const set = listKnownSets().find((entry) => entry.name === candidate);
  if (!set) throw new Error("Unknown benchmark set");
  return set;
}

function selectedIds(body: AnyRecord, set: AnyRecord): string[] | undefined {
  if (body.ids === undefined && body.selectedIds === undefined) return undefined;
  if (body.ids !== undefined && body.selectedIds !== undefined) {
    if (!Array.isArray(body.ids) || !Array.isArray(body.selectedIds) || JSON.stringify(body.ids) !== JSON.stringify(body.selectedIds)) {
      throw new Error("ids and selectedIds must not disagree");
    }
  }
  const value = body.ids ?? body.selectedIds;
  if (!Array.isArray(value) || value.length === 0 || value.length > set.ids.length) {
    throw new Error("ids must be a non-empty array of known set item IDs");
  }
  const ids = value.map((id: unknown) => (typeof id === "string" ? id.trim() : ""));
  const allowed = new Set<string>(set.ids);
  if (ids.some((id) => !SAFE_ID.test(id) || !allowed.has(id)) || new Set(ids).size !== ids.length) {
    throw new Error("ids must contain distinct known set item IDs");
  }
  return ids;
}

function readBoundedJson(file: string): AnyRecord {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Expected a bounded regular JSON file");
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!isRecord(value)) throw new Error("Expected a JSON object");
    return value;
  } finally { fs.closeSync(fd); }
}

function runIndex(): RunIndex {
  const runs = new Map<string, IndexedRun>();
  if (!fs.existsSync(TRACK_RUN_ROOT)) return { runs, campaignState: null };
  if (!fs.lstatSync(TRACK_RUN_ROOT).isDirectory()) throw new Error("Track run root must be a real directory");
  const root = fs.realpathSync(TRACK_RUN_ROOT);
  const add = (id: string, dir: string, group?: string) => {
    if (runs.has(id)) throw new Error(`Duplicate track run ID: ${id}`);
    if (runs.size >= MAX_INDEXED_RUNS) throw new Error("Track run index exceeds its bounded limit");
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("Track run path must be a real directory");
    const real = fs.realpathSync(dir);
    if (!real.startsWith(root + path.sep)) throw new Error("Track run escaped the private run root");
    runs.set(id, { id, dir: real, group });
  };
  let groups = 0;
  const rootEntries = fs.readdirSync(root, { withFileTypes: true });
  if (rootEntries.length > MAX_RUN_GROUPS + MAX_INDEXED_RUNS + 64) throw new Error("Track run root exceeds the bounded entry limit");
  for (const entry of rootEntries) {
    const candidate = path.join(root, entry.name);
    if (CAMPAIGN_GROUP.test(entry.name)) {
      if (++groups > MAX_RUN_GROUPS) throw new Error("Track run groups exceed the bounded limit");
      if (!entry.isDirectory()) throw new Error("Campaign run group must be a real directory");
      const children = fs.readdirSync(candidate, { withFileTypes: true });
      if (children.length > MAX_GROUP_CHILDREN) throw new Error("Campaign run group exceeds the bounded entry limit");
      for (const child of children) {
        if (!UUID.test(child.name)) continue;
        if (!child.isDirectory()) throw new Error("Campaign run must be a real directory");
        add(child.name, path.join(candidate, child.name), entry.name);
      }
    } else if (SAFE_ID.test(entry.name) && entry.isDirectory()) {
      add(entry.name, candidate);
    } else if (SAFE_ID.test(entry.name) && entry.isSymbolicLink()) {
      throw new Error("Track run path must be a real directory");
    }
  }
  const stateFile = path.join(path.dirname(root), "state.json");
  const campaignState = path.basename(root) === "runs" && fs.existsSync(stateFile) ? readBoundedJson(stateFile) : null;
  if (campaignState && (campaignState.schema_version !== "propbench-campaign-state-v1" || !isRecord(campaignState.jobs))) {
    throw new Error("Malformed campaign state");
  }
  return { runs, campaignState };
}

function safeRunDir(runId: unknown): string {
  if (typeof runId !== "string" || !SAFE_ID.test(runId)) throw new Error("Invalid run ID");
  const run = runIndex().runs.get(runId);
  if (!run) throw new Error("Track run not found");
  return run.dir;
}

function safeBundleDir(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Frontier bundle path is missing");
  const rootPath = path.resolve(CONTESTANT_ROOT);
  if (!fs.existsSync(rootPath) || !fs.lstatSync(rootPath).isDirectory()) throw new Error("Contestant export root is unavailable");
  const root = fs.realpathSync(rootPath);
  const candidate = path.resolve(value);
  if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isDirectory()) throw new Error("Frontier bundle directory is unavailable");
  const real = fs.realpathSync(candidate);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("Frontier bundle escaped the contestant export root");
  return real;
}

function priorFrontierBundle(priorRunId: unknown): string {
  const dir = safeRunDir(priorRunId);
  const loadRun = fn<(runDir: string) => TrackContext>(coreModule(), "loadRun");
  if (!loadRun) throw new Error("Track core run loader is unavailable");
  const prior = loadRun(dir);
  if (prior.config.track !== "frontier") throw new Error("Cumulative Frontier requires a prior Frontier run");
  const frontierPath = path.join(dir, "frontier.json");
  if (!fs.existsSync(frontierPath) || !fs.lstatSync(frontierPath).isFile()) throw new Error("Selected Frontier run has no frontier.json");
  const metadata = JSON.parse(fs.readFileSync(frontierPath, "utf8")) as AnyRecord;
  if (!isRecord(metadata) || typeof metadata.bundle_dir !== "string") throw new Error("Selected Frontier run has malformed frontier metadata");
  return safeBundleDir(metadata.bundle_dir);
}

function normalizeFixtureResponses(value: unknown, allowedIds: string[]): AnyRecord | undefined {
  if (value === undefined) throw new Error("Fixture provider requires explicit fixtureResponses");
  if (!isRecord(value)) throw new Error("fixtureResponses must be an object keyed by item ID");
  const allowed = new Set(allowedIds);
  const result: AnyRecord = {};
  for (const [id, response] of Object.entries(value)) {
    if (!allowed.has(id)) throw new Error(`fixtureResponses contains unknown item ID: ${id}`);
    if (typeof response !== "string" && !Array.isArray(response) && !isRecord(response)) {
      throw new Error("fixtureResponses values must be strings, arrays, or objects");
    }
    const encoded = JSON.stringify(response);
    if (encoded.length > 1_000_000) throw new Error("fixture response is too large");
    result[id] = response;
  }
  return result;
}

function normalizeFrontierFixtureResponses(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Controlled Frontier fixtureResponses must be a non-empty array");
  if (value.length > 100000) throw new Error("Controlled Frontier fixtureResponses is too large");
  const encoded = JSON.stringify(value);
  if (encoded.length > 10_000_000) throw new Error("Controlled Frontier fixtureResponses is too large");
  return value;
}

function safeContext(context: unknown): TrackContext {
  if (!isRecord(context) || typeof context.dir !== "string" || !isRecord(context.config) || !isRecord(context.set)) {
    throw new Error("Track worker returned an invalid run context");
  }
  const dir = safeRunDir(context.config.run_id);
  if (path.resolve(context.dir) !== dir) throw new Error("Track worker returned a run outside the private run root");
  return { dir, config: context.config, set: context.set };
}

function publicConfig(config: AnyRecord): AnyRecord {
  return {
    schema_version: config.schema_version,
    scorer_version: config.scorer_version,
    run_id: config.run_id,
    track: config.track,
    mode: config.mode,
    model: config.model,
    provider: config.provider,
    execution_protocol: config.execution_protocol,
    subscription: config.subscription,
    temperature: config.temperature,
    budget: config.budget,
    // A snapshot digest is safe owner metadata and is needed to tell two
    // cumulative cohorts apart. Never expose the source bundle path here.
    starting_snapshot: typeof config.starting_snapshot === "string" ? config.starting_snapshot : null,
    set_version: config.set_version,
    set_hash: config.set_hash,
    selected_ids: Array.isArray(config.selected_ids) ? config.selected_ids : [],
    core_tag: config.core_tag,
    created_at: config.created_at,
  };
}

function publicReport(report: TrackReport): TrackReport {
  if (!isRecord(report)) return report;
  let toolCallsUsed: number | undefined;
  if (isSubscription(report.config?.provider) && typeof report.config?.run_id === "string" && SAFE_ID.test(report.config.run_id)) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(safeRunDir(report.config.run_id), "subscription.json"), "utf8")) as AnyRecord;
      if (Number.isSafeInteger(receipt.tool_calls) && receipt.tool_calls >= 0) toolCallsUsed = receipt.tool_calls;
    } catch { /* Older reports may not have a subscription receipt. */ }
  }
  return { ...report, ...(toolCallsUsed === undefined ? {} : { tool_calls: toolCallsUsed }), config: isRecord(report.config) ? publicConfig(report.config) : undefined };
}

function modelLabels(report: TrackReport): { model: string; requested_model: string } {
  const requested = typeof report.config?.model === "string" && report.config.model.trim()
    ? report.config.model
    : "unknown";
  const returned = Array.isArray(report.returned_models)
    ? report.returned_models.filter((model: unknown): model is string => typeof model === "string" && !!model.trim())
    : [];
  const legacyReturned = [report.returned_model, report.actual_model]
    .find((model: unknown): model is string => typeof model === "string" && !!model.trim());
  return {
    model: returned.length ? returned.join(", ") : legacyReturned ?? requested,
    requested_model: requested,
  };
}

function reportShape(value: unknown): value is TrackReport {
  return isRecord(value) && value.schema_version === "propbench-report-v1" && typeof value.cohort === "string" && typeof value.score === "number";
}

function attemptsProgress(job: TrackJob): { completed: number; generations: number; total: number } {
  const total = Array.isArray(job.context.config.selected_ids) ? job.context.config.selected_ids.length : Array.isArray(job.context.set.items) ? job.context.set.items.length : 0;
  let generations = 0;
  let completed = 0;
  try {
    const attemptDir = path.join(job.context.dir, "attempts");
    if (fs.existsSync(attemptDir) && fs.lstatSync(attemptDir).isDirectory()) {
      const files = fs.readdirSync(attemptDir).filter((name) => SAFE_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"));
      generations = files.length;
      completed = files.filter(name => { try { return !!JSON.parse(fs.readFileSync(path.join(attemptDir,name),"utf8")).completed_at; } catch { return false; } }).length;
    }
  } catch {
    generations = 0;
  }
  return { completed: Math.min(completed, total), generations, total };
}

function checkpointProgress(job: TrackJob): AnyRecord | null {
  const ids: unknown = job.context.config.selected_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || !SAFE_ID.test(id))) return null;
  const receiptRoot = path.join(job.context.dir, "candidate-receipts");
  if (fs.existsSync(receiptRoot) && !fs.lstatSync(receiptRoot).isDirectory()) {
    throw new Error("Checkpoint receipt root must be a real directory");
  }
  const theorems = ids.map((id: string) => {
    let bestLines: number | null = null;
    let acceptedImprovements = 0;
    const itemDir = path.join(receiptRoot, id);
    if (fs.existsSync(itemDir)) {
      // These immutable owner receipts record verifier results. Read only the
      // accepted checkpoint records; neither candidates nor live submissions
      // are graded by a status request.
      if (!fs.lstatSync(itemDir).isDirectory()) throw new Error("Checkpoint receipt path must be a real directory");
      const entries = fs.readdirSync(itemDir, { withFileTypes: true });
      if (entries.length > MAX_CHECKPOINT_RECEIPTS_PER_ITEM) throw new Error("Checkpoint receipt directory exceeds its bounded limit");
      for (const entry of entries) {
        if (!CHECKPOINT_RECEIPT_NAME.test(entry.name) || !entry.isFile()) continue;
        let receipt: AnyRecord;
        try { receipt = readBoundedJson(path.join(itemDir, entry.name)); } catch { continue; }
        const lines = receipt.verdict?.line_count;
        if (receipt.schema_version !== "propbench-frontier-candidate-v1" ||
            receipt.import_id !== entry.name.slice(0, -5) || receipt.theorem_id !== id ||
            receipt.accepted !== true || receipt.verdict?.status !== "valid" ||
            !Number.isSafeInteger(lines) || lines <= 0 ||
            !isRecord(receipt.checkpoint) || !/^\d{6}$/.test(receipt.checkpoint.checkpoint_id)) continue;
        acceptedImprovements++;
        bestLines = bestLines === null ? lines : Math.min(bestLines, lines);
      }
    }
    return { id, best_lines: bestLines, accepted_improvements: acceptedImprovements };
  });
  return { theorems, accepted_improvements: theorems.reduce((sum, item) => sum + item.accepted_improvements, 0) };
}

function statusPayload(job: TrackJob): AnyRecord {
  const progress = attemptsProgress(job);
  const completed = job.report && ["complete", "external-unmetered"].includes(job.report.evaluation_status)
    ? job.report.total : progress.completed;
  let persistedState: AnyRecord | undefined;
  const stateFile = isSubscription(job.context.config.provider)
    ? "subscription.json"
    : job.track === "frontier" ? "controller.json" : undefined;
  if (stateFile) {
    try { persistedState = JSON.parse(fs.readFileSync(path.join(job.context.dir, stateFile), "utf8")); } catch { /* not yet started */ }
  }
  const reportRejection = typeof job.report?.contestant_rejection === "string" && job.report.contestant_rejection.trim()
    ? job.report.contestant_rejection.slice(0, 4000)
    : undefined;
  const persistedError = typeof persistedState?.error === "string" && persistedState.error.trim()
    ? persistedState.error.slice(0, 4000)
    : undefined;
  return {
    runId: job.runId,
    track: job.track,
    mode: job.mode,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    completed,
    // A completed Frontier report intentionally carries `null`: no provider
    // generation count exists for an external submission. Preserve that
    // unknown instead of replacing it with an attempt-directory count.
    generations: isSubscription(job.context.config.provider) ? null : job.report ? job.report.generations : progress.generations,
    client_sessions: job.report?.client_sessions ?? persistedState?.client_sessions,
    tool_calls: persistedState?.tool_calls,
    provider: job.context.config.provider,
    subscription: job.context.config.subscription,
    budget: job.context.config.budget,
    total: progress.total,
    error: job.error ?? reportRejection ?? persistedError ?? null,
    finished_reason: persistedState?.finished_reason ?? null,
    handoff: job.handoff ?? null,
    report: job.report ? publicReport(job.report) : null,
    checkpoint_progress: job.track === "frontier" && ["preparing", "prepared", "running"].includes(job.state)
      ? checkpointProgress(job) : null,
  };
}

function registerJob(context: TrackContext, track: "frontier" | "unaided", mode: "fresh" | "cumulative" | "unaided", state: TrackJob["state"]): TrackJob {
  const runId = String(context.config.run_id);
  if (!SAFE_ID.test(runId)) throw new Error("Track worker returned an invalid run ID");
  const job: TrackJob = { runId, context, track, mode, state, startedAt: new Date().toISOString() };
  jobs.set(runId, job);
  // Retain status long enough for a human to copy the handoff or result.  The
  // report remains available through /reports after this in-memory entry goes.
  setTimeout(() => {
    if (jobs.get(runId) === job && job.state !== "running" && job.state !== "preparing") jobs.delete(runId);
  }, 30 * 60 * 1000).unref?.();
  return job;
}

function handoffFor(runId: string, bundleDir: string): Handoff {
  const runDir = safeRunDir(runId);
  const cli = path.join(PROJECT_ROOT, "tracks", "cli.ts");
  const tsNodeRegister = path.join(PROJECT_ROOT, "node_modules", "ts-node", "register");
  const shellArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const handoffCommand = `npm run tracks -- handoff --run ${shellArg(runDir)}`;
  const bridgeCommand = `npm run tracks -- bridge --run ${shellArg(runDir)}`;
  const submitCommand = `npm run tracks -- submit --run ${shellArg(runDir)} --proofs ${shellArg(path.join(bundleDir, "proofs"))}`;
  const dockerHost = process.env.PROPBENCH_DOCKER_HOST?.trim();
  return {
    run_dir: runDir,
    bundle_dir: bundleDir,
    handoff_command: handoffCommand,
    bridge_command: bridgeCommand,
    submit_command: submitCommand,
    mcp_server: {
      command: process.execPath,
      args: ["--require", tsNodeRegister, cli, "bridge", "--run", runDir],
      ...(dockerHost ? { env: { PROPBENCH_DOCKER_HOST: dockerHost } } : {}),
    },
    requirement: "Start a fresh agent context with ONLY this MCP server as its filesystem/execution access; give subagents the same boundary. Do not expose other host tools or old conversations. Model API communication remains controller-side.",
    note: "The GUI prepares and reports the run. Use the bridge command in a fresh agent context, then submit the bundle proofs with the submit command.",
  };
}

function requestOptions(body: AnyRecord, set: AnyRecord, track: "frontier" | "unaided", mode: "fresh" | "cumulative" | "unaided", startingSnapshot?: string): AnyRecord {
  const ids = selectedIds(body, set);
  if (track === "unaided" && body.budget !== undefined) throw new Error("Unaided runs use the fixed request limits");
  const provider = normalizeProvider(body.provider, track);
  const model = normalizeModel(body.model, provider === "codex-subscription" ? "gpt-6-astra" : "fixture-v1");
  const temperature = normalizeTemperature(body.temperature);
  const budget = track === "unaided"
    ? { ...UNAIDED_BUDGET, max_generations: ids?.length ?? set.count }
    : normalizeBudget(body.budget, FRONTIER_BUDGET);
  let subscription: AnyRecord | undefined;
  if (isSubscription(provider)) {
    const s = body.subscription ?? {};
    if (!isRecord(s) || Object.keys(s).some(k => !["effort", "max_tool_calls"].includes(k))) throw new Error("Invalid subscription settings");
    const effort = s.effort ?? "xhigh";
    if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("Unsupported reasoning effort");
    subscription = { effort, max_tool_calls: boundedInteger(s.max_tool_calls, track === "unaided" ? 0 : 96, 10000, true) };
    if (track === "unaided" && subscription.max_tool_calls !== 0) throw new Error("Unaided must expose zero tools");
  } else if (body.subscription !== undefined) throw new Error("Subscription settings require a subscription client");
  return {
    root: TRACK_RUN_ROOT,
    setDir: path.join(SET_ROOT, set.name),
    ids,
    track,
    mode,
    model,
    provider,
    temperature,
    budget,
    subscription,
    startingSnapshot,
    validator: DEFAULT_VALIDATOR,
  };
}

async function prepareCore(options: AnyRecord): Promise<TrackContext> {
  const prepare = fn<(opts: AnyRecord) => TrackContext>(coreModule(), "prepareRun");
  if (!prepare) throw new Error("Track core is unavailable");
  return safeContext(await Promise.resolve(prepare(options)));
}

async function runUnaidedJob(job: TrackJob, fixtureResponses: AnyRecord | undefined): Promise<void> {
  if (isSubscription(job.context.config.provider)) return runSubscriptionJob(job);
  const worker = fn<(context: TrackContext, options: AnyRecord) => Promise<TrackReport>>(workerModule("unaided"), "runUnaided");
  if (!worker) throw new Error("Unaided worker is unavailable");
  const result = await Promise.resolve(worker(job.context, {
    validator: DEFAULT_VALIDATOR,
    ...(fixtureResponses === undefined ? {} : { fixtureResponses }),
  }));
  if (!reportShape(result)) throw new Error("Unaided worker returned no valid evaluation report");
  job.report = result;
  job.state = "complete";
  job.finishedAt = new Date().toISOString();
}

async function runFrontierJob(job: TrackJob, fixtureResponses: unknown): Promise<void> {
  if (isSubscription(job.context.config.provider)) return runSubscriptionJob(job);
  const worker = fn<(context: TrackContext, options: AnyRecord) => Promise<TrackReport>>(frontierRunnerModule(), "runFrontier");
  if (!worker) throw new Error("Controlled Frontier runner is unavailable; use owner handoff for an external run");
  const result = await Promise.resolve(worker(job.context, {
    validator: DEFAULT_VALIDATOR,
    ...(fixtureResponses === undefined ? {} : { fixtureResponses }),
  }));
  if (!reportShape(result)) throw new Error("Frontier runner returned no valid evaluation report");
  job.report = result;
  if (result.evaluation_status && result.evaluation_status !== "complete") {
    // A controlled runner can return an owner-gradeable report after a runtime
    // interruption (for example when the local isolation runtime is absent).
    // Keep the report for inspection, but do not present it as a successful run.
    let detail = `Frontier evaluation ended with status ${String(result.evaluation_status)}`;
    try {
      const controller = JSON.parse(fs.readFileSync(path.join(job.context.dir, "controller.json"), "utf8")) as AnyRecord;
      if (typeof controller.error === "string" && controller.error.trim()) detail = controller.error.slice(0, 4000);
      else if (typeof controller.finished_reason === "string" && controller.finished_reason.trim()) detail = `Frontier evaluation ended: ${controller.finished_reason}`;
    } catch {
      // The report remains the authoritative result when the optional detail
      // receipt is unavailable.
    }
    job.error = detail;
    job.state = "error";
  } else {
    job.state = "complete";
  }
  job.finishedAt = new Date().toISOString();
}

async function runSubscriptionJob(job: TrackJob): Promise<void> {
  const mod = exactModule(path.join(PROJECT_ROOT, "tracks", "subscription-runner"), "Subscription runner");
  const run = fn<(ctx: TrackContext, options: AnyRecord) => Promise<TrackReport>>(mod, "runSubscription");
  if (!run) throw new Error("Subscription runner is unavailable");
  job.report = await run(job.context, { validator: DEFAULT_VALIDATOR });
  job.state = job.report.evaluation_status === "complete" ? "complete" : "error";
  if (job.state === "error") {
    const state = JSON.parse(fs.readFileSync(path.join(job.context.dir, "subscription.json"), "utf8"));
    job.error = state.error ?? "Subscription client did not complete";
  } else if (typeof job.report.contestant_rejection === "string" && job.report.contestant_rejection.trim()) {
    // A malformed contestant tree is a ranked, sealed result. Keep the run
    // complete for comparison while surfacing the rejection in status.
    job.error = job.report.contestant_rejection.slice(0, 4000);
  }
  job.finishedAt = new Date().toISOString();
}

function campaignJob(index: RunIndex, run: IndexedRun): AnyRecord | null {
  if (!run.group || !index.campaignState) return null;
  const entry = index.campaignState.jobs[run.group];
  if (!isRecord(entry)) return null;
  if (entry.run_id !== undefined && entry.run_id !== run.id) return null;
  if (entry.run_dir !== undefined && path.resolve(entry.run_dir) !== run.dir) throw new Error("Campaign run path disagrees with the indexed run");
  return entry;
}

function storedReport(index: RunIndex, run: IndexedRun): TrackReport | null {
  const file = path.join(run.dir, "report.json");
  if (!fs.existsSync(file)) return null;
  const job = campaignJob(index, run);
  // The controller can write its report before it commits the campaign job as
  // complete. Never turn that transient receipt into a ranked GUI result.
  if (run.group && index.campaignState && job?.status !== "complete" && job?.status !== "interrupted") return null;
  const report = readBoundedJson(file);
  if (!reportShape(report) || report.config?.run_id !== run.id) throw new Error("Stored track report has the wrong run identity");
  const receiptFile = path.join(run.dir, "subscription.json");
  if (isSubscription(report.config?.provider) && !fs.existsSync(receiptFile)) return null;
  let subscriptionStatus: string | undefined;
  if (isSubscription(report.config?.provider)) {
    const receipt = readBoundedJson(receiptFile);
    if (receipt.status === "running" || !receipt.completed_at) return null;
    subscriptionStatus = typeof receipt.status === "string" ? receipt.status : undefined;
  }
  if (job?.status === "interrupted" || (subscriptionStatus && subscriptionStatus !== "complete")) {
    return { ...report, evaluation_status: "interrupted" };
  }
  return report;
}

async function listTrackReports(): Promise<TrackReport[]> {
  const index = runIndex();
  const reports: TrackReport[] = [];
  for (const run of index.runs.values()) {
    const report = storedReport(index, run);
    if (report) reports.push(report);
  }
  return reports.sort((a, b) => a.cohort.localeCompare(b.cohort) || a.score - b.score);
}

async function loadReportForRun(runId: string): Promise<TrackReport | null> {
  const index = runIndex();
  const run = index.runs.get(runId);
  if (!run) throw new Error("Track run not found");
  return storedReport(index, run);
}

function restoredJob(index: RunIndex, run: IndexedRun): TrackJob {
  const loadRun = fn<(runDir: string) => TrackContext>(coreModule(), "loadRun");
  if (!loadRun) throw new Error("Track core run loader is unavailable");
  const context = loadRun(run.dir);
  if (context.config.run_id !== run.id || path.resolve(context.dir) !== run.dir) throw new Error("Stored track run has the wrong identity");
  const campaign = campaignJob(index, run);
  const report = storedReport(index, run);
  let receipt: AnyRecord | null = null;
  const stateFile = path.join(run.dir, isSubscription(context.config.provider) ? "subscription.json" : "controller.json");
  if (fs.existsSync(stateFile)) receipt = readBoundedJson(stateFile);
  const campaignStatus = campaign?.status;
  const reportCompleted = report?.evaluation_status === "complete" || report?.evaluation_status === "external-unmetered";
  const state: TrackJob["state"] = campaignStatus === "interrupted" ? "error"
    : campaignStatus === "complete" ? reportCompleted ? "complete" : "error"
    : campaignStatus === "running" ? "running"
    : campaignStatus === "preparing" ? "preparing"
    : campaignStatus === "prepared" ? "prepared"
    : receipt?.status === "running" ? "running"
    : reportCompleted ? "complete"
    : report || receipt?.status === "interrupted" ? "error" : "prepared";
  let handoff: Handoff | undefined;
  if (context.config.track === "frontier" && context.config.execution_protocol === "external-mcp-v1") {
    try {
      const metadata = readBoundedJson(path.join(run.dir, "frontier.json"));
      if (typeof metadata.bundle_dir === "string") handoff = handoffFor(run.id, safeBundleDir(metadata.bundle_dir));
    } catch { /* Historical handoff path may be unavailable. */ }
  }
  return {
    runId: run.id,
    context,
    track: context.config.track,
    mode: context.config.mode,
    state,
    startedAt: typeof campaign?.started_at === "string" ? campaign.started_at : context.config.created_at,
    finishedAt: typeof campaign?.completed_at === "string" ? campaign.completed_at : typeof receipt?.completed_at === "string" ? receipt.completed_at : report?.graded_at,
    report: state === "running" || state === "preparing" || state === "prepared" ? undefined : report ?? undefined,
    error: typeof campaign?.error === "string" ? campaign.error.slice(0, 4000)
      : state === "error" && !receipt?.error && !report?.contestant_rejection
        ? `Track evaluation ended with status ${String(report?.evaluation_status ?? receipt?.status ?? "unknown")}`
        : undefined,
    handoff,
  };
}

function activeCampaignStatuses(): AnyRecord[] {
  const index = runIndex();
  const active: AnyRecord[] = [];
  for (const run of index.runs.values()) {
    if (!run.group) continue;
    const campaign = campaignJob(index, run);
    if (!campaign || !["preparing", "prepared", "running"].includes(campaign.status)) continue;
    if (!fs.existsSync(path.join(run.dir, "run.json"))) continue;
    active.push({ ...statusPayload(restoredJob(index, run)), campaign_job: run.group });
  }
  return active;
}

function groupedLeaderboards(reports: TrackReport[]): AnyRecord[] {
  const groups = new Map<string, TrackReport[]>();
  for (const report of reports) {
    // External handoffs, interrupted runs, and prepared records remain visible
    // in reports/history, but only complete evaluations are rankable evidence.
    if (!reportShape(report) || report.evaluation_status !== "complete") continue;
    const current = groups.get(report.cohort) ?? [];
    current.push(report);
    groups.set(report.cohort, current);
  }
  return [...groups.entries()].map(([cohort, cohortReports]) => {
    const first = cohortReports[0];
    const entries = cohortReports
      .slice()
      .sort((a, b) => a.score - b.score)
      .map((report, index) => {
        const models = modelLabels(report);
        return {
          rank: index + 1,
          run_id: report.config?.run_id ?? null,
          ...models,
          provider: report.config?.provider ?? "unknown",
          score: report.score,
          valid_count: report.valid_count,
          total: report.total,
          valid_rate: report.valid_rate,
          total_lines: report.total_lines,
          mean_valid_lines: report.mean_valid_lines ?? null,
          generations: report.generations,
          usage_coverage: report.usage_coverage ?? null,
          evaluation_status: report.evaluation_status ?? null,
          evidence: report.evidence,
          usage: report.usage ?? {},
        };
      });
    return {
      cohort,
      track: first.config?.track ?? null,
      mode: first.config?.mode ?? null,
      set_version: first.config?.set_version ?? null,
      set_hash: first.config?.set_hash ?? null,
      budget: first.config?.budget ?? null,
      subscription: first.config?.subscription ?? null,
      provider: first.config?.provider ?? null,
      temperature: first.config?.temperature ?? null,
      entries,
    };
  }).sort((a, b) => String(a.cohort).localeCompare(String(b.cohort)));
}

function frontierRunOptions(reports: TrackReport[]): FrontierRunOption[] {
  const options = new Map<string, FrontierRunOption>();
  for (const report of reports) {
    if (!reportShape(report) || report.config?.track !== "frontier" || report.evaluation_status !== "complete") continue;
    const runId = typeof report.config?.run_id === "string" ? report.config.run_id : "";
    if (!SAFE_ID.test(runId)) continue;
    options.set(runId, {
      run_id: runId,
      model: typeof report.config?.model === "string" ? report.config.model : "unknown",
      mode: report.config?.mode === "cumulative" ? "cumulative" : "fresh",
      set_version: typeof report.config?.set_version === "string" ? report.config.set_version : "unknown",
      set_hash: typeof report.config?.set_hash === "string" ? report.config.set_hash : "unknown",
      starting_snapshot: typeof report.config?.starting_snapshot === "string" ? report.config.starting_snapshot : null,
      state: "complete",
      score: typeof report.score === "number" ? report.score : null,
    });
  }
  for (const job of jobs.values()) {
    if (job.track !== "frontier" || job.state !== "prepared") continue;
    const config = job.context.config;
    options.set(job.runId, {
      run_id: job.runId,
      model: typeof config.model === "string" ? config.model : "unknown",
      mode: config.mode === "cumulative" ? "cumulative" : "fresh",
      set_version: typeof config.set_version === "string" ? config.set_version : "unknown",
      set_hash: typeof config.set_hash === "string" ? config.set_hash : "unknown",
      starting_snapshot: typeof config.starting_snapshot === "string" ? config.starting_snapshot : null,
      state: "prepared",
      score: null,
    });
  }
  return [...options.values()].sort((a, b) => a.run_id.localeCompare(b.run_id));
}

// GET /api/tracks — the page bootstrap payload.
router.get("/", async (_req: Request, res: Response) => {
  try {
    const sets = listKnownSets();
    // A malformed private run should be visible as an API error instead of
    // silently being mixed into a leaderboard. listTrackReports delegates to
    // the canonical core reader, whether that reader is sync or async.
    const reports = await listTrackReports();
    res.json({
      sets,
      reports: reports.map(publicReport),
      leaderboards: groupedLeaderboards(reports),
      frontierRuns: frontierRunOptions(reports),
      active: [
        ...[...jobs.values()].filter((job) => job.state === "running" || job.state === "preparing" || job.state === "prepared").map(statusPayload),
        ...activeCampaignStatuses(),
      ],
      unaidedBudget: UNAIDED_BUDGET,
      frontierBudget: FRONTIER_BUDGET,
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

router.get("/sets", (_req: Request, res: Response) => {
  try { res.json(listKnownSets()); }
  catch (error) { res.status(500).json({ error: errorMessage(error) }); }
});

router.get("/reports", async (_req: Request, res: Response) => {
  try {
    const reports = await listTrackReports();
    res.json({ reports: reports.map(publicReport), leaderboards: groupedLeaderboards(reports), frontierRuns: frontierRunOptions(reports) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

router.get("/leaderboard", async (_req: Request, res: Response) => {
  try {
    const reports = await listTrackReports();
    res.json({ leaderboards: groupedLeaderboards(reports) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// POST /api/tracks/unaided — prepare synchronously, then run without tying the
// provider request to the HTTP request's abort signal.
router.post("/unaided", async (req: Request, res: Response) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    if (body.mode !== undefined && body.mode !== "unaided") throw new Error("Unaided mode must be unaided");
    if (body.startingSnapshot !== undefined || body.priorRunId !== undefined || body.startingRunId !== undefined) {
      throw new Error("Unaided runs cannot inherit a Frontier snapshot");
    }
    const set = fixedSet(body.set ?? body.setName);
    const options = requestOptions(body, set, "unaided", "unaided");
    const fixtureResponses = options.provider === "fixture"
      ? normalizeFixtureResponses(body.fixtureResponses, options.ids ?? set.ids)
      : undefined;
    const context = await prepareCore(options);
    const job = registerJob(context, "unaided", "unaided", "running");
    void runUnaidedJob(job, fixtureResponses).catch((error) => {
      job.state = "error";
      job.error = errorMessage(error);
      job.finishedAt = new Date().toISOString();
    });
    res.status(202).json({ runId: job.runId, state: job.state, total: context.set.items?.length ?? set.count });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

interface PreparedFrontier {
  context: TrackContext;
  bundleDir: string;
  mode: "fresh" | "cumulative";
  set: AnyRecord;
}

async function prepareFrontierContext(body: AnyRecord): Promise<PreparedFrontier> {
  const mode = body.mode === undefined ? "fresh" : body.mode;
  if (mode !== "fresh" && mode !== "cumulative") throw new Error("Frontier mode must be fresh or cumulative");
  if (body.startingSnapshot !== undefined) throw new Error("Choose a prior Frontier run; direct snapshots are not accepted by the GUI");
  const set = fixedSet(body.set ?? body.setName);
  let snapshotDir: string | undefined;
  if (mode === "cumulative") {
    snapshotDir = priorFrontierBundle(body.priorRunId ?? body.startingRunId);
  } else if (body.priorRunId !== undefined || body.startingRunId !== undefined) {
    throw new Error("Fresh Frontier runs cannot specify a prior run");
  }
  // prepareFrontier computes the snapshot digest and stores it in the run
  // config. Passing the bundle itself as startingSnapshot would make the
  // worker reject the request and would confuse cohort identity.
  const options = requestOptions(body, set, "frontier", mode);
  const bundleRoot = path.resolve(CONTESTANT_ROOT);
  fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(bundleRoot).isDirectory()) throw new Error("Contestant export root is not a directory");
  const bundleDir = path.join(bundleRoot, randomUUID());
  const prepareFrontier = fn<(opts: AnyRecord, dir: string, snapshot?: string) => TrackContext>(workerModule("frontier"), "prepareFrontier");
  if (!prepareFrontier) throw new Error("Frontier worker is unavailable");
  let context: TrackContext;
  try {
    context = safeContext(await Promise.resolve(prepareFrontier(options, bundleDir, snapshotDir)));
  } catch (error) {
    // The directory is a newly-created, private export for this failed
    // preparation. Remove only this exact target; never touch the root.
    try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* report original error */ }
    throw error;
  }
  return { context, bundleDir: safeBundleDir(bundleDir), mode, set };
}

async function prepareFrontierHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const prepared = await prepareFrontierContext(body);
    const job = registerJob(prepared.context, "frontier", prepared.mode, "prepared");
    job.bundleDir = prepared.bundleDir;
    if (prepared.context.config.provider === "external") job.handoff = handoffFor(job.runId, job.bundleDir);
    res.status(201).json({ runId: job.runId, state: job.state, mode: prepared.mode, bundleDir: job.bundleDir, handoff: job.handoff, config: publicConfig(prepared.context.config) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
}

router.post("/frontier/prepare", prepareFrontierHandler);
router.post("/frontier", prepareFrontierHandler);

// POST /api/tracks/frontier/run — controlled Frontier execution. External
// Frontier work remains an explicit owner handoff through /prepare.
router.post("/frontier/run", async (req: Request, res: Response) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const provider = normalizeProvider(body.provider, "frontier");
    const fixtureResponses = provider === "fixture"
      ? normalizeFrontierFixtureResponses(body.fixtureResponses)
      : undefined;
    const prepared = await prepareFrontierContext(body);
    const job = registerJob(prepared.context, "frontier", prepared.mode, "running");
    job.bundleDir = prepared.bundleDir;
    void runFrontierJob(job, fixtureResponses).catch((error) => {
      job.state = "error";
      job.error = errorMessage(error);
      job.finishedAt = new Date().toISOString();
    });
    res.status(202).json({ runId: job.runId, state: job.state, mode: prepared.mode, total: prepared.context.set.items?.length ?? prepared.set.count, config: publicConfig(prepared.context.config) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/status/:runId", async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    if (!SAFE_ID.test(runId)) throw new Error("Invalid run ID");
    const job = jobs.get(runId);
    if (job) {
      res.json(statusPayload(job));
      return;
    }
    const index = runIndex();
    const run = index.runs.get(runId);
    if (!run) {
      res.status(404).json({ error: "Track run not found" });
      return;
    }
    const restored = restoredJob(index, run);
    res.json({ ...statusPayload(restored), ...(run.group ? { campaign_job: run.group } : {}) });
  } catch (error) {
    const status = errorMessage(error) === "Track run not found" ? 404 : 400;
    res.status(status).json({ error: errorMessage(error) });
  }
});

router.get("/runs/:runId", async (req: Request, res: Response) => {
  try {
    const report = await loadReportForRun(String(req.params.runId));
    if (!report) {
      res.status(404).json({ error: "Track report not found" });
      return;
    }
    res.json({ report: publicReport(report) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

export default router;
