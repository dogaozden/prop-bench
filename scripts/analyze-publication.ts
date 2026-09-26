/** Descriptive analysis of the allowlisted public export only. No owner paths are read. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

type Json = Record<string, any>;
export const CONDITIONS = ["unaided-1", "unaided-2", "frontier-fresh", "frontier-cumulative"] as const;
type Condition = typeof CONDITIONS[number];
type Row = {
  key: string; item_id: string; condition: Condition; job_status: string; run_id: string | null;
  run_status: string | null; included_in_completed: boolean; verdict: string | null;
  line_count: number | null; par: number; loss: number | null; proof_sha256: string | null;
  wall_seconds: number; max_tool_calls: number; seed_run_id: string | null;
  observed_input_tokens: number | null; observed_output_tokens: number | null;
  observed_thinking_tokens: number | null; observed_total_tokens: number | null;
  client_sessions: number | null; usage_attempts: number | null; usage_attempts_with_usage: number | null;
};
const OUTCOMES = new Set(["valid", "invalid", "parse_error", "transport_error", "protocol_error", "missing", "interrupted"]);
const JOB_STATUSES = new Set(["pending", "queued", "preparing", "prepared", "running", "complete", "interrupted"]);
const ACTIVE = new Set(["preparing", "prepared", "running"]);
const object = (value: unknown, name: string): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Json;
};
const array = (value: unknown, name: string): any[] => { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value; };
const text = (value: unknown, name: string): string => { if (typeof value !== "string" || !value) throw new Error(`${name} must be a nonempty string`); return value; };
const integer = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
};
const finite = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
};
const maybeCount = (value: unknown, name: string): number | null => value == null ? null : integer(value, name);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-10;
const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function usage(run: Json | undefined, key: string): number | null {
  if (!run || run.usage?.[key] == null) return null;
  const value = finite(run.usage[key], `run.usage.${key}`);
  if (value < 0) throw new Error(`Negative observed usage: ${key}`);
  return value;
}

function validateCompleted(run: Json, row: Row, item: Json, campaign: Json): void {
  if (run.campaign_id !== campaign.id || run.campaign_condition !== row.condition || run.id !== row.run_id ||
      run.provider !== "codex-subscription" || run.evidence !== "subscription" || run.evaluation_status !== "complete" ||
      run.outcome !== "completed" || run.model !== campaign.model || run.subscription?.effort !== campaign.effort ||
      run.budget?.wall_seconds !== row.wall_seconds || run.subscription?.max_tool_calls !== row.max_tool_calls ||
      !Array.isArray(run.selected_ids) || run.selected_ids.length !== 1 || run.selected_ids[0] !== row.item_id) {
    throw new Error(`Completed job/run identity mismatch: ${row.key}`);
  }
  const expectedTrack = row.condition.startsWith("frontier-") ? "frontier" : "unaided";
  const expectedMode = row.condition === "frontier-cumulative" ? "cumulative" : row.condition === "frontier-fresh" ? "fresh" : "unaided";
  if (run.track !== expectedTrack || run.mode !== expectedMode || (expectedTrack === "unaided" && row.max_tool_calls !== 0)) {
    throw new Error(`Completed job track/mode mismatch: ${row.key}`);
  }
  const items = array(run.items, `${row.key}.items`);
  if (items.length !== 1 || items[0].id !== row.item_id) throw new Error(`Completed singleton item mismatch: ${row.key}`);
  const result = object(items[0], `${row.key}.item`);
  if (!OUTCOMES.has(result.status) || result.par !== item.par) throw new Error(`Invalid verdict or par: ${row.key}`);
  row.verdict = result.status;
  row.loss = finite(result.loss, `${row.key}.loss`);
  if (row.loss < 0 || row.loss > 1) throw new Error(`Loss outside [0,1]: ${row.key}`);
  if (result.status === "valid") {
    row.line_count = integer(result.line_count, `${row.key}.line_count`);
    if (row.line_count < 1 || result.independently_replayed !== true || !Array.isArray(result.proof) || result.proof.length !== row.line_count ||
        !near(row.loss, row.line_count / (row.line_count + row.par))) throw new Error(`Valid proof lacks replay or correct score: ${row.key}`);
    row.proof_sha256 = text(result.proof_sha256, `${row.key}.proof_sha256`);
  } else {
    if (result.line_count != null || !near(row.loss, 1)) throw new Error(`Nonvalid verdict must retain loss 1: ${row.key}`);
  }
  if (run.score != null && !near(finite(run.score, `${row.key}.score`), row.loss)) throw new Error(`Run score differs from item loss: ${row.key}`);
  row.included_in_completed = true;
}

function nativeObservations(group: Row[]): Json {
  const tokenFields = ["input", "output", "thinking", "total"] as const;
  const tokenRows = Object.fromEntries(tokenFields.map(field => {
    const key = `observed_${field}_tokens` as keyof Row;
    const values = group.map(row => row[key] as number | null).filter((value): value is number => value != null);
    return [field, { observed_sum: values.length ? values.reduce((a, b) => a + b, 0) : null,
      runs_with_observation: values.length, jobs_in_group: group.length }];
  }));
  const receipts = group.filter(row => row.usage_attempts != null && row.usage_attempts_with_usage != null);
  return {
    jobs_in_group: group.length, jobs_with_public_run: group.filter(row => row.run_status != null).length,
    tokens: tokenRows,
    client_sessions_observed: group.reduce((sum, row) => sum + (row.client_sessions ?? 0), 0),
    runs_with_session_count: group.filter(row => row.client_sessions != null).length,
    usage_receipts: { with_usage: receipts.reduce((sum, row) => sum + row.usage_attempts_with_usage!, 0),
      total: receipts.reduce((sum, row) => sum + row.usage_attempts!, 0), runs_with_coverage: receipts.length },
    exact_inference_requests: null, exact_cost_usd: null,
    note: "Native-client token observations can be incomplete; session counts are not exact inference requests and no exact charge is available.",
  };
}

function conditionSummary(rows: Row[], condition: Condition): Json {
  const selected = rows.filter(row => row.condition === condition);
  const completed = selected.filter(row => row.included_in_completed);
  const valid = completed.filter(row => row.verdict === "valid");
  const invalid = completed.filter(row => row.verdict !== "valid");
  const pending = selected.filter(row => row.job_status === "pending" || row.job_status === "queued");
  const active = selected.filter(row => ACTIVE.has(row.job_status));
  const interrupted = selected.filter(row => row.job_status === "interrupted");
  const loss = completed.map(row => row.loss!);
  return {
    planned: selected.length, completed: completed.length, valid: valid.length, nonvalid_completed: invalid.length,
    interrupted: interrupted.length, active: active.length, pending: pending.length,
    outcome_counts: Object.fromEntries([...OUTCOMES].map(outcome => [outcome, completed.filter(row => row.verdict === outcome).length])),
    loss: { completed_sum: loss.reduce((a, b) => a + b, 0), completed_mean: mean(loss),
      full_census_mean: completed.length === selected.length ? mean(loss) : null,
      denominator_completed: completed.length, denominator_planned: selected.length },
    valid_proof_lengths: { sum: valid.reduce((sum, row) => sum + row.line_count!, 0), mean: mean(valid.map(row => row.line_count!)),
      par_sum_for_valid: valid.reduce((sum, row) => sum + row.par, 0), pairs: valid.map(row => ({ item_id: row.item_id, lines: row.line_count, par: row.par })) },
    budget_per_job: { wall_seconds: selected[0]?.wall_seconds ?? null, max_tool_calls: selected[0]?.max_tool_calls ?? null },
    native_observations: { ...nativeObservations(completed), interrupted: nativeObservations(interrupted) },
  };
}

function pairs(rows: Row[], items: Json[], left: Condition, right: Condition): Json {
  const byKey = new Map(rows.map(row => [row.key, row]));
  const details = items.map(item => {
    const a = byKey.get(`${item.id}--${left}`)!;
    const b = byKey.get(`${item.id}--${right}`)!;
    const matched = a.included_in_completed && b.included_in_completed;
    return { item_id: item.id, par: item.par, left_status: a.job_status, right_status: b.job_status,
      matched_completed: matched, left_verdict: matched ? a.verdict : null, right_verdict: matched ? b.verdict : null,
      left_lines: matched ? a.line_count : null, right_lines: matched ? b.line_count : null,
      left_loss: matched ? a.loss : null, right_loss: matched ? b.loss : null,
      loss_delta_right_minus_left: matched ? b.loss! - a.loss! : null,
      line_delta_when_both_valid: matched && a.verdict === "valid" && b.verdict === "valid" ? b.line_count! - a.line_count! : null };
  });
  const matched = details.filter(pair => pair.matched_completed);
  const deltas = matched.map(pair => pair.loss_delta_right_minus_left!);
  return { left, right, planned_pairs: items.length, matched_completed_pairs: matched.length,
    unmatched_pairs: items.length - matched.length, mean_loss_delta_matched: mean(deltas),
    full_census_mean_loss_delta: matched.length === items.length ? mean(deltas) : null,
    right_improved: deltas.filter(delta => delta < -1e-10).length,
    tied: deltas.filter(delta => Math.abs(delta) <= 1e-10).length,
    right_worsened: deltas.filter(delta => delta > 1e-10).length,
    both_valid_length_pairs: matched.filter(pair => pair.line_delta_when_both_valid != null).length,
    mean_absolute_loss_difference_matched: mean(deltas.map(Math.abs)),
    items: details };
}

export function analyzePublication(raw: unknown): { summary: Json; rows: Row[]; csv: string } {
  const data = object(raw, "publication");
  if (data.schema_version !== "propbench-publication-v1") throw new Error("Unsupported public results schema");
  const campaign = object(data.campaign, "campaign");
  const items = array(data.items, "items").map((value, index) => object(value, `items[${index}]`));
  if (data.set?.version !== "v2" || items.length !== 24 || new Set(items.map(item => item.id)).size !== 24) throw new Error("Analysis requires the complete public v2 24-item census");
  const itemMap = new Map(items.map(item => [text(item.id, "item.id"), item]));
  for (const item of items) if (integer(item.par, `${item.id}.par`) < 1) throw new Error("Par must be positive");
  const jobs = array(campaign.jobs, "campaign.jobs");
  if (campaign.planned_jobs !== 96 || jobs.length !== 96) throw new Error("Public campaign must show all 96 planned jobs");
  const jobsByKey = new Set<string>();
  const runs = array(data.runs, "runs").map((value, index) => object(value, `runs[${index}]`));
  const runsById = new Map<string, Json>();
  for (const run of runs) {
    const id = text(run.id, "run.id");
    if (runsById.has(id)) throw new Error(`Duplicate public run ID: ${id}`);
    runsById.set(id, run);
  }
  const rows: Row[] = jobs.map((value, index) => {
    const job = object(value, `campaign.jobs[${index}]`);
    const item_id = text(job.item_id, "job.item_id");
    const condition = text(job.condition, "job.condition") as Condition;
    const key = text(job.key, "job.key");
    if (!itemMap.has(item_id) || !CONDITIONS.includes(condition) || key !== `${item_id}--${condition}` || jobsByKey.has(key)) throw new Error(`Unexpected or duplicate campaign job: ${key}`);
    jobsByKey.add(key);
    if (!JOB_STATUSES.has(job.status)) throw new Error(`Unknown campaign job status: ${job.status}`);
    const par = itemMap.get(item_id)!.par;
    const run_id = job.run_id == null ? null : text(job.run_id, "job.run_id");
    const run = run_id ? runsById.get(run_id) : undefined;
    if (job.status === "complete" && !run) throw new Error(`Completed job lacks a public run: ${key}`);
    const row: Row = { key, item_id, condition, job_status: job.status, run_id,
      run_status: run?.evaluation_status ?? null, included_in_completed: false, verdict: null, line_count: null, par, loss: null,
      proof_sha256: null, wall_seconds: integer(job.wall_seconds, "job.wall_seconds"),
      max_tool_calls: integer(job.max_tool_calls, "job.max_tool_calls"), seed_run_id: run?.seed_run_id ?? null,
      observed_input_tokens: usage(run, "input_tokens"), observed_output_tokens: usage(run, "output_tokens"),
      observed_thinking_tokens: usage(run, "thinking_tokens"), observed_total_tokens: usage(run, "total_tokens"),
      client_sessions: run?.client_sessions == null ? null : integer(run.client_sessions, "run.client_sessions"),
      usage_attempts: run?.usage_coverage?.attempts == null ? null : integer(run.usage_coverage.attempts, "run.usage_coverage.attempts"),
      usage_attempts_with_usage: run?.usage_coverage?.attempts_with_usage == null ? null : integer(run.usage_coverage.attempts_with_usage, "run.usage_coverage.attempts_with_usage") };
    if (row.wall_seconds !== 900 || row.max_tool_calls !== (condition.startsWith("frontier-") ? 128 : 0)) {
      throw new Error(`Job budget differs from the prespecified campaign: ${key}`);
    }
    if (row.usage_attempts != null && row.usage_attempts_with_usage != null && row.usage_attempts_with_usage > row.usage_attempts) throw new Error(`Usage coverage exceeds attempts: ${key}`);
    if (job.status === "complete") validateCompleted(run!, row, itemMap.get(item_id)!, campaign);
    return row;
  });
  for (const item of items) for (const condition of CONDITIONS) if (!jobsByKey.has(`${item.id}--${condition}`)) throw new Error(`Missing planned item: ${item.id} ${condition}`);
  const rowsByKey = new Map(rows.map(row => [row.key, row]));
  for (const item of items) {
    const fresh = rowsByKey.get(`${item.id}--frontier-fresh`)!;
    const cumulative = rowsByKey.get(`${item.id}--frontier-cumulative`)!;
    if (!cumulative.included_in_completed) continue;
    const parent = fresh.run_id && runsById.get(fresh.run_id);
    const child = cumulative.run_id && runsById.get(cumulative.run_id);
    if (!fresh.included_in_completed || !parent || !child || child.seed_run_id !== fresh.run_id ||
        typeof parent.final_snapshot?.digest !== "string" || child.starting_snapshot !== parent.final_snapshot.digest) {
      throw new Error(`Cumulative run lacks its own completed fresh archive: ${item.id}`);
    }
  }
  const referenced = new Set(rows.map(row => row.run_id).filter((id): id is string => id != null));
  for (const id of runsById.keys()) if (!referenced.has(id)) throw new Error(`Public run is not attached to a planned job: ${id}`);
  const completed = rows.filter(row => row.included_in_completed).length;
  if (campaign.status === "complete" && completed !== 96) throw new Error("Public campaign claims completion while jobs are incomplete");
  const condition = Object.fromEntries(CONDITIONS.map(name => [name, conditionSummary(rows, name)]));
  const fresh = pairs(rows, items, "frontier-fresh", "frontier-cumulative");
  const unaided = pairs(rows, items, "unaided-1", "unaided-2");
  const unaidedOneToFresh = pairs(rows, items, "unaided-1", "frontier-fresh");
  const unaidedTwoToFresh = pairs(rows, items, "unaided-2", "frontier-fresh");
  const crossTrackContext = {
    wall_allowance_per_job_seconds: 900, unaided_max_tool_calls: 0, frontier_max_tool_calls: 128,
    interpretation: "Each run has the same 900-second wall allowance. Tool access and native inference differ, so this is neither an equal-compute comparison nor a causal estimate of tool benefit.",
  };
  const summary: Json = {
    schema_version: "propbench-publication-analysis-v1", source_schema_version: data.schema_version,
    source_generated_at: data.generated_at ?? null, campaign_id: campaign.id, set_version: data.set.version,
    status: completed === 96 ? "complete" : "incomplete", planned_jobs: 96, completed_jobs: completed,
    nonvalid_completed_jobs: rows.filter(row => row.included_in_completed && row.verdict !== "valid").length,
    interrupted_jobs: rows.filter(row => row.job_status === "interrupted").length,
    active_jobs: rows.filter(row => ACTIVE.has(row.job_status)).length,
    pending_jobs: rows.filter(row => row.job_status === "pending" || row.job_status === "queued").length,
    conditions: condition,
    native_observations: {
      completed: nativeObservations(rows.filter(row => row.included_in_completed)),
      interrupted: nativeObservations(rows.filter(row => row.job_status === "interrupted")),
    },
    matched_comparisons: {
      unaided_1_to_frontier_fresh: { ...unaidedOneToFresh, ...crossTrackContext },
      unaided_2_to_frontier_fresh: { ...unaidedTwoToFresh, ...crossTrackContext },
      frontier_fresh_to_cumulative: {
      ...fresh,
      lineage_budget_per_item: { fresh_wall_seconds: 900, cumulative_additional_wall_seconds: 900, total_wall_seconds: 1800,
        fresh_tool_calls: 128, cumulative_additional_tool_calls: 128, total_tool_calls: 256 },
      interpretation: "Cumulative inherits its own fresh archive and receives another allowance; this is a lineage comparison, not equal total compute." },
      unaided_replicate_variability: { ...unaided,
        interpretation: "Two independent unaided attempts are separate prespecified replicates. No best-of-two pooling is used as a single-attempt condition." } },
    interpretation: "This is a descriptive census of 24 public synthetic items. Partial completed subsets are shown with explicit denominators; no population inference is claimed.",
  };
  const headers = ["key", "item_id", "condition", "job_status", "run_id", "run_status", "included_in_completed", "verdict", "line_count", "par", "loss", "proof_sha256",
    "wall_seconds", "max_tool_calls", "seed_run_id", "observed_input_tokens", "observed_output_tokens", "observed_thinking_tokens", "observed_total_tokens",
    "client_sessions", "usage_attempts", "usage_attempts_with_usage"] as const;
  const cell = (value: unknown) => `"${String(value == null ? "" : value).replaceAll('"', '""')}"`;
  const csv = [headers.join(","), ...rows.map(row => headers.map(key => cell(row[key])).join(","))].join("\n") + "\n";
  return { summary, rows, csv };
}

export function writeAnalysis(inputFile: string, summaryFile: string, csvFile: string): Json {
  const bytes = fs.readFileSync(inputFile);
  const { summary, csv } = analyzePublication(JSON.parse(bytes.toString("utf8")));
  summary.source_export_sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
  fs.mkdirSync(path.dirname(csvFile), { recursive: true });
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(csvFile, csv);
  return summary;
}

if (require.main === module) {
  const input = path.resolve(process.argv[2] ?? path.join(__dirname, "../publication/data/results.json"));
  const summary = path.resolve(process.argv[3] ?? path.join(path.dirname(input), "summary.json"));
  const csv = path.resolve(process.argv[4] ?? path.join(path.dirname(input), "jobs.csv"));
  try {
    const result = writeAnalysis(input, summary, csv);
    process.stdout.write(JSON.stringify({ summary, csv, status: result.status, completed: result.completed_jobs, planned: result.planned_jobs }) + "\n");
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
}
