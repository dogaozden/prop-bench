import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RUN_SCHEMA, SCORER_VERSION, BenchmarkSet, PrepareOptions, RunContext, RunConfig, RunReport, Verdict, Theorem, ProofLine, AttemptRecord, Usage, isSubscriptionProvider } from "./types";

export const PROJECT_ROOT = fs.existsSync(path.resolve(__dirname, "../Cargo.toml"))
  ? path.resolve(__dirname, "..") : path.resolve(__dirname, "../..");
const exec = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
export function assertDirectory(dir: string): void {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("Expected a directory, not a symlink: " + dir);
}
export function readRegularFile(file: string, maxBytes = 16 * 1024 * 1024): Buffer {
  assertDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Not a regular bounded file: " + file);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function readJson<T = any>(file: string): T { return JSON.parse(readRegularFile(file, 64 * 1024 * 1024).toString("utf8")) as T; }
export function writeJsonExclusive(file: string, value: unknown): void {
  assertDirectory(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export function writeJson(file: string, value: unknown): void {
  assertDirectory(path.dirname(file));
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error("Refusing non-regular destination: " + file);
  const tmp = file + "." + randomUUID() + ".tmp";
  try { writeJsonExclusive(tmp, value); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export function loadSet(dir: string, ids?: string[]): BenchmarkSet {
  assertDirectory(dir);
  const manifest = readJson(path.join(dir, "manifest.json"));
  if (typeof manifest.set_version !== "string" || typeof manifest.core_tag !== "string" || !Array.isArray(manifest.items) || !manifest.items.length)
    throw new Error("Invalid or empty set manifest");
  const seen = new Set<string>();
  const items = manifest.items.map((item: any) => {
    if (!ID.test(item.id) || seen.has(item.id) || !Number.isSafeInteger(item.par) || item.par <= 0 || !/^[a-f0-9]{64}$/.test(item.theorem_sha256)) throw new Error("Invalid or duplicate manifest item");
    seen.add(item.id);
    const bytes = readRegularFile(path.join(dir, item.id + ".json"));
    if (sha256(bytes) !== item.theorem_sha256) throw new Error("Theorem hash mismatch: " + item.id);
    const t = JSON.parse(bytes.toString()) as Theorem;
    if (t.id !== item.id || !Array.isArray(t.premises) || !t.premises.every(p => typeof p === "string") || typeof t.conclusion !== "string" || !t.conclusion.trim()) throw new Error("Invalid theorem: " + item.id);
    return { id: item.id, par: item.par, theorem_sha256: item.theorem_sha256, theorem: t };
  });
  if (ids && (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !seen.has(id)))) throw new Error("Selection must contain distinct known item IDs");
  const selected = items.filter((item: {id: string}) => !ids || ids.includes(item.id));
  // The content identity includes the selection, par values, and source manifest
  // version. Display difficulty never substitutes for this identity.
  const identity = { version: manifest.set_version, core_tag: manifest.core_tag, items: selected.map(({theorem, ...i}: any) => i) };
  return { ...identity, hash: sha256(canonical(identity)), items: selected };
}
export function listSets(): Array<{name: string; version: string; count: number; ids: string[]; core_tag: string}> {
  const base = path.join(PROJECT_ROOT, "golf/set");
  return fs.readdirSync(base).sort().filter(name => name !== "v1" && fs.lstatSync(path.join(base, name)).isDirectory()).map(name => {
    const set = loadSet(path.join(base, name));
    return { name, version: set.version, count: set.items.length, ids: set.items.map(i => i.id), core_tag: set.core_tag };
  });
}

function evaluatorHash(): string {
  const root = path.join(PROJECT_ROOT, "tracks");
  const names = fs.readdirSync(root).filter(n => n.endsWith(".ts") && !n.endsWith(".test.ts")).sort();
  return sha256(names.map(n => n + ":" + sha256(readRegularFile(path.join(root, n)))).join("\n"));
}
function checkOptions(o: PrepareOptions): void {
  if (!o.model?.trim()) throw new Error("Model identity is required");
  if (!["openrouter", "gemini", "fixture", "external", "claude-subscription", "codex-subscription"].includes(o.provider)) throw new Error("Unknown provider");
  if (isSubscriptionProvider(o.provider)) {
    const s = o.subscription;
    if (!s || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(s.effort) ||
        !Number.isSafeInteger(s.max_tool_calls) || s.max_tool_calls < 0 || s.max_tool_calls > 10000 ||
        (o.track === "unaided" && s.max_tool_calls !== 0)) throw new Error("Invalid subscription effort or tool allowance");
  } else if (o.subscription) throw new Error("Subscription settings require a subscription client");
  if (o.track === "frontier" && o.provider === "gemini") throw new Error("Controlled Frontier currently supports openrouter or fixture; use external for MCP handoff");
  if ((o.track === "unaided" && (o.mode !== "unaided" || o.provider === "external" || o.startingSnapshot)) ||
      (o.track === "frontier" && !["fresh", "cumulative"].includes(o.mode)) || !["frontier", "unaided"].includes(o.track)) throw new Error("Invalid track/mode/provider combination");
  if (o.track === "frontier" && ((o.mode === "cumulative") !== !!o.startingSnapshot)) throw new Error("Only cumulative Frontier requires an inherited snapshot");
  if (!Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2) throw new Error("Temperature must be between 0 and 2");
  for (const k of ["wall_seconds", "max_generations", "max_output_tokens", "max_thinking_tokens"] as const) {
    if (!Number.isSafeInteger(o.budget[k]) || o.budget[k] < (k === "max_thinking_tokens" ? 0 : 1)) throw new Error("Invalid budget: " + k);
  }
  if (o.budget.wall_seconds > 7 * 86400 || o.budget.max_generations > 100000 || o.budget.max_output_tokens > 1000000 || o.budget.max_thinking_tokens > 1000000) throw new Error("Budget exceeds supported bounds");
}
export function prepareRun(o: PrepareOptions): RunContext {
  checkOptions(o);
  const set = loadSet(o.setDir, o.ids);
  const validatorBytes = readRegularFile(path.resolve(o.validator), 512 * 1024 * 1024);
  const validator_sha256 = sha256(validatorBytes);
  const rulebookBytes = readRegularFile(path.join(PROJECT_ROOT, "rules.md"));
  const rulebook_sha256 = sha256(rulebookBytes);
  fs.mkdirSync(o.root, { recursive: true, mode: 0o700 });
  assertDirectory(o.root);
  const run_id = randomUUID();
  const dir = path.join(fs.realpathSync(o.root), run_id);
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of ["set", "attempts", "submissions", "referee"]) fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "referee/validator"), validatorBytes, { flag: "wx", mode: 0o500 });
  fs.writeFileSync(path.join(dir, "referee/rules.md"), rulebookBytes, { flag: "wx", mode: 0o400 });
  const config: RunConfig = {
    schema_version: RUN_SCHEMA, scorer_version: SCORER_VERSION, run_id,
    track: o.track, mode: o.mode, model: o.model, provider: o.provider,
    execution_protocol: isSubscriptionProvider(o.provider)
      ? o.track === "unaided" ? "unaided-subscription-v1" : "frontier-subscription-v2"
      : o.track === "unaided" ? "unaided-v1" : o.provider === "external" ? "external-mcp-v1" : "frontier-controller-v1",
    ...(o.subscription ? { subscription: { ...o.subscription } } : {}),
    temperature: o.temperature, budget: { ...o.budget }, starting_snapshot: o.startingSnapshot ?? null,
    set_version: set.version, set_hash: set.hash, selected_ids: set.items.map(i => i.id), core_tag: set.core_tag,
    validator_sha256, rulebook_sha256, evaluator_hash: evaluatorHash(), created_at: new Date().toISOString(),
  };
  // Preserve original theorem bytes so existing frozen content hashes remain true.
  for (const item of set.items) fs.writeFileSync(path.join(dir, "set", item.id + ".json"), readRegularFile(path.join(o.setDir, item.id + ".json")), { flag: "wx", mode: 0o600 });
  writeJsonExclusive(path.join(dir, "set/manifest.json"), { set_version: set.version, core_tag: set.core_tag, items: set.items.map(({theorem, ...item}) => item) });
  writeJsonExclusive(path.join(dir, "run.json"), config);
  writeJsonExclusive(path.join(dir, "preparation.json"), { schema: "propbench-preparation-v1", config, config_sha256: sha256(canonical(config)) });
  fs.chmodSync(path.join(dir, "preparation.json"), 0o400);
  return { dir, config, set };
}
export function loadRun(dir: string): RunContext {
  assertDirectory(dir);
  dir = fs.realpathSync(dir);
  const config = readJson<RunConfig>(path.join(dir, "run.json"));
  const preparation = readJson(path.join(dir, "preparation.json"));
  if (preparation.schema !== "propbench-preparation-v1" || preparation.config_sha256 !== sha256(canonical(config)) || canonical(preparation.config) !== canonical(config)) throw new Error("Run configuration differs from sealed preparation receipt");
  if (config.schema_version !== RUN_SCHEMA || config.scorer_version !== SCORER_VERSION || !ID.test(config.run_id)) throw new Error("Unsupported run schema/scorer");
  const set = loadSet(path.join(dir, "set"));
  if (set.hash !== config.set_hash || canonical(set.items.map(i => i.id)) !== canonical(config.selected_ids)) throw new Error("Run set identity changed");
  return { dir, config, set };
}
export function verifyRunIdentity(ctx: RunContext, validator: string): void {
  const current = loadRun(ctx.dir);
  if (canonical(current.config) !== canonical(ctx.config)) throw new Error("Run configuration changed");
  if (canonical(current.set) !== canonical(ctx.set)) throw new Error("In-memory theorem set differs from frozen run");
  if (sha256(readRegularFile(path.resolve(validator), 512 * 1024 * 1024)) !== ctx.config.validator_sha256) throw new Error("Verifier binary changed since preparation");
  if (sha256(readRegularFile(path.join(PROJECT_ROOT, "rules.md"))) !== ctx.config.rulebook_sha256 || evaluatorHash() !== ctx.config.evaluator_hash) throw new Error("Rulebook or evaluator changed; prepare a new versioned run");
}
export function parseProof(raw: string): ProofLine[] {
  const text = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  const proof: unknown = JSON.parse(text);
  if (!Array.isArray(proof) || proof.length > 100000) throw new Error("Expected a bounded JSON array of derived proof lines");
  for (const line of proof) {
    if (!line || typeof line !== "object" || Object.keys(line).some(k => !["line_number", "formula", "justification", "depth"].includes(k)) ||
        !Number.isSafeInteger(line.line_number) || line.line_number < 1 || !Number.isSafeInteger(line.depth) || line.depth < 0 ||
        typeof line.formula !== "string" || !line.formula.trim() || typeof line.justification !== "string" || !line.justification.trim()) throw new Error("Malformed proof line");
  }
  return proof as ProofLine[];
}
export async function validateCandidate(validator: string, theorem: Theorem, proof: unknown): Promise<Verdict> {
  let lines: ProofLine[];
  try { lines = parseProof(typeof proof === "string" ? proof : JSON.stringify(proof)); }
  catch (err) { return { status: "parse_error", line_count: null, errors: [String(err)] }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-verification-"));
  try {
    writeJsonExclusive(path.join(tmp, "theorem.json"), theorem);
    writeJsonExclusive(path.join(tmp, "proof.json"), lines);
    let stdout: string;
    try {
      ({ stdout } = await exec(path.resolve(validator), ["validate", "--strict-protocol", "--theorem", path.join(tmp, "theorem.json"), "--proof", path.join(tmp, "proof.json")], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
    } catch (err: any) {
      // CLI exit 1 denotes malformed numbering/justification. Spawn failures,
      // signals, timeouts, and other exits are evaluator failures, not bad proofs.
      if (err.code === 1 && !err.killed && !err.signal) return { status: "invalid", line_count: null, errors: [String(err.stderr || err.stdout || err.message)] };
      throw new Error("Verifier infrastructure failure: " + String(err.message));
    }
    const result = JSON.parse(stdout);
    if (typeof result.valid !== "boolean" || !Array.isArray(result.errors)) throw new Error("Malformed verifier response");
    if (result.valid && (!Number.isSafeInteger(result.line_count) || result.line_count < 0)) throw new Error("Invalid verifier line count");
    return { status: result.valid ? "valid" : "invalid", line_count: result.valid ? result.line_count : null, errors: result.errors };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export function proofLoss(lines: number | null, par: number): number {
  if (!Number.isSafeInteger(par) || par <= 0 || (lines !== null && (!Number.isSafeInteger(lines) || lines < 0))) throw new Error("Invalid score inputs");
  return lines === null ? 1 : lines / (lines + par);
}
export function cohortKey(c: RunConfig): string {
  return sha256(canonical({ track: c.track, mode: c.mode, set_hash: c.set_hash, scorer: c.scorer_version,
    protocol: c.execution_protocol, provider: c.provider,
    snapshot: c.starting_snapshot,
    budget: isSubscriptionProvider(c.provider) ? { wall_seconds: c.budget.wall_seconds, ...c.subscription } : c.budget,
    temperature: isSubscriptionProvider(c.provider) ? null : c.temperature,
    validator: c.validator_sha256, rules: c.rulebook_sha256, evaluator: c.evaluator_hash,
    evidence: c.provider === "fixture" ? "fixture" : "evaluation" }));
}
export async function gradeRun(dir: string, validator?: string): Promise<RunReport> {
  const ctx = loadRun(dir);
  const pinnedValidator = path.join(ctx.dir, "referee/validator");
  if (sha256(readRegularFile(pinnedValidator, 512 * 1024 * 1024)) !== ctx.config.validator_sha256 ||
      (validator && sha256(readRegularFile(path.resolve(validator), 512 * 1024 * 1024)) !== ctx.config.validator_sha256)) throw new Error("Verifier binary changed since preparation");
  if (sha256(readRegularFile(path.join(ctx.dir, "referee/rules.md"))) !== ctx.config.rulebook_sha256) throw new Error("Pinned rulebook changed");
  const items = [];
  const usage: Usage = {};
  let generations = 0;
  let withUsage = 0;
  const times: number[] = [];
  const records: AttemptRecord[] = [];
  assertDirectory(path.join(dir, "submissions"));
  for (const name of fs.readdirSync(path.join(dir, "submissions"))) if (!ctx.set.items.some(i => name === i.id + ".json")) throw new Error("Unknown submission: " + name);
  for (const item of ctx.set.items) {
    let verdict: Verdict = { status: "missing", line_count: null, errors: [] };
    const attemptFile = path.join(dir, "attempts", item.id + ".json");
    const proofFile = path.join(dir, "submissions", item.id + ".json");
    if (fs.existsSync(attemptFile)) {
      const attempt = readJson<AttemptRecord>(attemptFile);
      records.push(attempt);
      generations++;
      if (attempt.usage && Object.keys(attempt.usage).length) withUsage++;
      for (const time of [attempt.started_at, attempt.completed_at]) {
        if (time && Number.isFinite(Date.parse(time))) times.push(Date.parse(time));
      }
      if (attempt.item_id !== item.id) throw new Error("Attempt item mismatch");
      for (const k of ["input_tokens", "output_tokens", "thinking_tokens", "total_tokens", "cost_usd"] as const) {
        const v = attempt.usage?.[k];
        if (v !== undefined && Number.isFinite(v) && v >= 0) usage[k] = (usage[k] ?? 0) + v;
      }
      if (attempt.verdict && attempt.verdict.status !== "valid") verdict = { ...attempt.verdict, line_count: null };
      else if (!attempt.completed_at) verdict = { status: "interrupted", line_count: null, errors: ["Attempt began without a recorded completion; no additional owner session was dispatched"] };
    }
    if (fs.existsSync(proofFile)) verdict = await validateCandidate(pinnedValidator, item.theorem, readRegularFile(proofFile).toString());
    items.push({ id: item.id, par: item.par, ...verdict, loss: proofLoss(verdict.status === "valid" ? verdict.line_count : null, item.par) });
  }
  const valid = items.filter(i => i.status === "valid");
  const total_lines = valid.reduce((sum, i) => sum + i.line_count!, 0);
  const report: RunReport = {
    schema_version: "propbench-report-v1", config: ctx.config, cohort: cohortKey(ctx.config), graded_at: new Date().toISOString(),
    score: items.reduce((s, i) => s + i.loss, 0) / items.length, valid_count: valid.length, total: items.length,
    valid_rate: valid.length / items.length, total_lines, mean_valid_lines: valid.length ? total_lines / valid.length : null,
    items, usage, generations: ctx.config.track === "frontier" ? null : generations,
    usage_coverage: { attempts_with_usage: withUsage, attempts: generations },
    execution_commands: null,
    elapsed_seconds: times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 1000 : null,
    evidence: isSubscriptionProvider(ctx.config.provider) ? "subscription" : ctx.config.provider === "fixture" ? "fixture" : ctx.config.provider === "external" ? "external-submission" : "provider",
    evaluation_status: ctx.config.track === "unaided" ? (generations ? "complete" : "unexecuted") : ctx.config.execution_protocol === "external-mcp-v1" ? "external-unmetered" : "unexecuted",
    returned_models: [], returned_backends: [], dispatches: { not_started: 0, dispatched: 0, response_confirmed: 0, uncertain: 0 }, regraded_by: evaluatorHash(), runtime: null,
  };
  const execution = path.join(ctx.dir, "execution.json");
  if (ctx.config.track === "frontier" && fs.existsSync(execution)) {
    const state = readJson<{started_at: string; commands: number}>(execution);
    report.execution_commands = state.commands;
    const lastFile = path.join(ctx.dir, "exec-" + String(state.commands).padStart(6, "0") + ".json");
    if (fs.existsSync(lastFile)) {
      const last = readJson<{completed_at?: string}>(lastFile);
      report.elapsed_seconds = last.completed_at ? (Date.parse(last.completed_at) - Date.parse(state.started_at)) / 1000 : null;
    }
  }
  if (ctx.config.execution_protocol === "frontier-controller-v1") {
    const controllerPath = path.join(ctx.dir, "controller.json");
    if (fs.existsSync(controllerPath)) {
      const controller = readJson<{status: string; started_at: string; completed_at?: string}>(controllerPath);
      const generationDir = path.join(ctx.dir, "generations");
      assertDirectory(generationDir);
      for (const name of fs.readdirSync(generationDir).sort()) {
        if (!/^\d{6}\.json$/.test(name)) throw new Error("Unknown generation receipt: " + name);
        records.push(readJson<AttemptRecord>(path.join(generationDir, name)));
      }
      report.generations = records.length;
      report.evaluation_status = controller.status === "complete" ? "complete" : "interrupted";
      report.elapsed_seconds = controller.completed_at ? (Date.parse(controller.completed_at) - Date.parse(controller.started_at)) / 1000 : null;
      report.usage = {};
      report.usage_coverage = { attempts: records.length, attempts_with_usage: records.filter(r => r.usage && Object.keys(r.usage).length).length };
      for (const record of records) for (const key of ["input_tokens", "output_tokens", "thinking_tokens", "total_tokens", "cost_usd"] as const) {
        const value = record.usage?.[key];
        if (value !== undefined && Number.isFinite(value) && value >= 0) report.usage[key] = (report.usage[key] ?? 0) + value;
      }
    }
  }
  if (isSubscriptionProvider(ctx.config.provider)) {
    // Native clients own hidden inference/transport retries. Count client sessions,
    // retain observed usage, and never present sessions as exact model requests.
    records.length = 0;
    report.generations = null;
    report.client_sessions = 0;
    report.usage = {};
    const stateFile = path.join(ctx.dir, "subscription.json");
    report.evaluation_status = "unexecuted";
    if (fs.existsSync(stateFile)) {
      const state = readJson<{status: string; started_at: string; completed_at?: string}>(stateFile);
      report.evaluation_status = state.status === "complete" ? "complete" : "interrupted";
      report.elapsed_seconds = state.completed_at ? (Date.parse(state.completed_at) - Date.parse(state.started_at)) / 1000 : null;
      const sessions = path.join(ctx.dir, "sessions");
      assertDirectory(sessions);
      for (const name of fs.readdirSync(sessions).sort()) {
        if (/^\d{6}\.json$/.test(name)) records.push(readJson<AttemptRecord>(path.join(sessions, name)));
      }
      report.client_sessions = records.length;
      for (const r of records) for (const k of ["input_tokens", "output_tokens", "thinking_tokens", "total_tokens"] as const) {
        const v = r.usage?.[k];
        if (v !== undefined && Number.isFinite(v) && v >= 0) report.usage[k] = (report.usage[k] ?? 0) + v;
      }
    }
    report.usage_coverage = { attempts: records.length, attempts_with_usage: records.filter(r => r.usage && Object.keys(r.usage).length).length };
  }
  report.returned_models = [...new Set(records.map(r => r.model).filter((v): v is string => typeof v === "string"))].sort();
  report.returned_backends = [...new Set(records.map(r => r.backend).filter((v): v is string => typeof v === "string"))].sort();
  for (const record of records) {
    const state = record.dispatch_state ?? (record.response !== undefined ? "response_confirmed" : record.completed_at ? "not_started" : "uncertain");
    if (!(state in report.dispatches)) throw new Error("Invalid dispatch state");
    report.dispatches[state]++;
  }
  if (ctx.config.track === "unaided" && records.some(r => !r.completed_at)) report.evaluation_status = "interrupted";
  const runtimeFile = path.join(ctx.dir, "runtime.json");
  if (fs.existsSync(runtimeFile)) {
    const runtime = readJson<NonNullable<RunReport["runtime"]>>(runtimeFile);
    if (runtime.backend !== "docker" || !/^sha256:[a-f0-9]{64}$/.test(runtime.image_id) || typeof runtime.architecture !== "string") throw new Error("Invalid pinned runtime identity");
    report.runtime = runtime;
  }
  const injected = fs.existsSync(path.join(ctx.dir, "test-injection.json"));
  const finalizationFile = path.join(ctx.dir, "controlled-finalization.json");
  if (fs.existsSync(finalizationFile)) {
    const finalization = readJson<{contestant_rejection?: string}>(finalizationFile);
    if (finalization.contestant_rejection) report.contestant_rejection = finalization.contestant_rejection;
  }
  if (injected) report.evidence = "fixture";
  report.cohort = sha256(canonical({ configuration: cohortKey(ctx.config), runtime: report.runtime, injected }));
  writeJson(path.join(dir, "report.json"), report);
  return report;
}
export async function listReports(root: string): Promise<RunReport[]> {
  if (!fs.existsSync(root)) return [];
  assertDirectory(root);
  const reports: RunReport[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!ID.test(name)) continue;
    const dir = path.join(root, name);
    if (!fs.lstatSync(dir).isDirectory() || !fs.existsSync(path.join(dir, "report.json"))) continue;
    reports.push(await gradeRun(dir));
  }
  return reports.sort((a, b) => a.cohort.localeCompare(b.cohort) || a.score - b.score);
}
export function compareReports(reports: RunReport[]): Array<{cohort: string; runs: RunReport[]}> {
  const groups = new Map<string, RunReport[]>();
  for (const r of reports) if (r.evaluation_status === "complete") groups.set(r.cohort, [...(groups.get(r.cohort) ?? []), r]);
  return [...groups].map(([cohort, runs]) => ({ cohort, runs: runs.sort((a, b) => a.score - b.score) }));
}
