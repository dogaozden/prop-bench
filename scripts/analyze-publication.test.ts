import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePublication, CONDITIONS } from "./analyze-publication";

const digest = "a".repeat(64);
const itemIds = Array.from({ length: 24 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const jobs = itemIds.flatMap(item_id => CONDITIONS.map(condition => ({
    key: `${item_id}--${condition}`, item_id, condition, status: "queued", wall_seconds: 900,
    max_tool_calls: condition.startsWith("frontier-") ? 128 : 0,
  })));
  return { schema_version: "propbench-publication-v1", generated_at: "2026-09-25T00:00:00Z", set: { version: "v2" },
    campaign: { id: "campaign-test", model: "gpt-6-astra", effort: "xhigh", planned_jobs: 96, jobs },
    items: itemIds.map(id => ({ id, par: 10 })), runs: [] as Record<string, any>[] };
}

function finish(data: Fixture, item: string, condition: typeof CONDITIONS[number], verdict: "valid" | "invalid", lines = 5) {
  const job = data.campaign.jobs.find(job => job.item_id === item && job.condition === condition)!;
  job.status = "complete";
  const id = `${item}-${condition}`;
  (job as typeof job & {run_id: string}).run_id = id;
  const loss = verdict === "valid" ? lines / (lines + 10) : 1;
  const record: Record<string, any> = {
    id, campaign_id: data.campaign.id, campaign_condition: condition, track: condition.startsWith("frontier-") ? "frontier" : "unaided",
    mode: condition === "frontier-cumulative" ? "cumulative" : condition === "frontier-fresh" ? "fresh" : "unaided",
    provider: "codex-subscription", evidence: "subscription", evaluation_status: "complete", outcome: "completed",
    model: "gpt-6-astra", subscription: { effort: "xhigh", max_tool_calls: job.max_tool_calls },
    budget: { wall_seconds: 900, max_tool_calls: job.max_tool_calls }, selected_ids: [item],
    score: loss, usage: { input_tokens: 10, output_tokens: 20 }, usage_coverage: { attempts: 1, attempts_with_usage: 1 }, client_sessions: 1,
    items: [{ id: item, par: 10, status: verdict, line_count: verdict === "valid" ? lines : null, loss,
      ...(verdict === "valid" ? { independently_replayed: true, proof_sha256: digest, proof: Array.from({ length: lines }, () => ({})) } : {}) }],
  };
  if (condition === "frontier-fresh") record.final_snapshot = { digest };
  if (condition === "frontier-cumulative") { record.seed_run_id = `${item}-frontier-fresh`; record.starting_snapshot = digest; }
  data.runs.push(record);
  return record;
}

test("partial census retains invalid loss and all pending/interrupted denominators", () => {
  const data = fixture();
  finish(data, "t01", "unaided-1", "valid", 6);
  finish(data, "t01", "unaided-2", "valid", 8);
  finish(data, "t01", "frontier-fresh", "valid", 5);
  finish(data, "t01", "frontier-cumulative", "valid", 4);
  finish(data, "t02", "unaided-1", "invalid");
  finish(data, "t02", "unaided-2", "valid", 7);
  finish(data, "t02", "frontier-fresh", "invalid");
  finish(data, "t02", "frontier-cumulative", "valid", 3);
  finish(data, "t03", "frontier-fresh", "valid", 1);
  data.campaign.jobs.find(job => job.key === "t03--frontier-fresh")!.status = "interrupted";
  const { summary, csv, rows } = analyzePublication(data);
  assert.equal(rows.length, 96);
  assert.equal(csv.trim().split("\n").length, 97);
  assert.equal(summary.status, "incomplete");
  assert.equal(summary.completed_jobs, 8);
  assert.equal(summary.interrupted_jobs, 1);
  assert.equal(summary.pending_jobs, 87);
  assert.equal(summary.conditions["frontier-fresh"].planned, 24);
  assert.equal(summary.conditions["frontier-fresh"].completed, 2);
  assert.equal(summary.conditions["frontier-fresh"].nonvalid_completed, 1);
  assert.equal(rows.find(row => row.key === "t03--frontier-fresh")!.included_in_completed, false,
    "a result attached to an interrupted campaign job cannot enter the mean");
  assert.equal(summary.conditions["frontier-fresh"].loss.full_census_mean, null);
  assert.equal(summary.conditions["frontier-fresh"].loss.completed_mean, (5 / 15 + 1) / 2);
  assert.equal(summary.conditions["frontier-fresh"].native_observations.tokens.input.observed_sum, 20);
  assert.equal(summary.conditions["frontier-fresh"].native_observations.interrupted.tokens.input.observed_sum, 10);
  assert.equal(summary.conditions["frontier-fresh"].native_observations.interrupted.jobs_with_public_run, 1);
  assert.equal(summary.native_observations.interrupted.tokens.output.observed_sum, 20);
  assert.equal(summary.native_observations.interrupted.usage_receipts.total, 1);
  assert.equal(summary.native_observations.interrupted.exact_cost_usd, null);
  assert.equal(summary.conditions["frontier-fresh"].native_observations.exact_cost_usd, null);
  assert.equal(summary.matched_comparisons.frontier_fresh_to_cumulative.matched_completed_pairs, 2);
  assert.equal(summary.matched_comparisons.frontier_fresh_to_cumulative.items.length, 24);
  assert.equal(summary.matched_comparisons.frontier_fresh_to_cumulative.right_improved, 2);
  assert.equal(summary.matched_comparisons.frontier_fresh_to_cumulative.lineage_budget_per_item.total_wall_seconds, 1800);
  assert.equal(summary.matched_comparisons.unaided_1_to_frontier_fresh.matched_completed_pairs, 2);
  assert.equal(summary.matched_comparisons.unaided_1_to_frontier_fresh.items.length, 24);
  assert.equal(summary.matched_comparisons.unaided_1_to_frontier_fresh.right_improved, 1);
  assert.equal(summary.matched_comparisons.unaided_1_to_frontier_fresh.tied, 1, "invalid loss 1 remains in the pair");
  assert.equal(summary.matched_comparisons.unaided_2_to_frontier_fresh.matched_completed_pairs, 2);
  assert.equal(summary.matched_comparisons.unaided_2_to_frontier_fresh.right_worsened, 1);
  assert.equal(summary.matched_comparisons.unaided_1_to_frontier_fresh.wall_allowance_per_job_seconds, 900);
  assert.match(summary.matched_comparisons.unaided_1_to_frontier_fresh.interpretation, /neither an equal-compute comparison nor a causal estimate/);
  assert.equal(summary.matched_comparisons.unaided_replicate_variability.matched_completed_pairs, 2);
  assert.equal(summary.matched_comparisons.unaided_replicate_variability.right_worsened, 1);
  assert.equal(summary.matched_comparisons.unaided_replicate_variability.right_improved, 1);
  assert.equal(Object.keys(summary.conditions).length, 4, "unaided replicates remain distinct conditions");
});

test("complete census gives 24 matched pairs and full denominators", () => {
  const data = fixture();
  for (const id of itemIds) for (const condition of CONDITIONS) finish(data, id, condition, "valid", condition === "frontier-cumulative" ? 4 : 5);
  const { summary } = analyzePublication(data);
  assert.equal(summary.status, "complete");
  assert.equal(summary.completed_jobs, 96);
  assert.ok(Math.abs(summary.conditions["frontier-cumulative"].loss.full_census_mean - 4 / 14) < 1e-12);
  assert.equal(summary.matched_comparisons.frontier_fresh_to_cumulative.matched_completed_pairs, 24);
  assert.equal(summary.matched_comparisons.frontier_fresh_to_cumulative.right_improved, 24);
  assert.equal(summary.matched_comparisons.unaided_1_to_frontier_fresh.matched_completed_pairs, 24);
  assert.equal(summary.matched_comparisons.unaided_2_to_frontier_fresh.matched_completed_pairs, 24);
  assert.equal(summary.matched_comparisons.unaided_replicate_variability.tied, 24);
});

test("rejects missing jobs, mismatched scores, unreplayed proofs, and false ancestry", () => {
  const data = fixture();
  data.campaign.jobs.pop();
  assert.throws(() => analyzePublication(data), /all 96 planned jobs/);
  data.campaign.jobs = fixture().campaign.jobs;
  const fresh = finish(data, "t01", "frontier-fresh", "valid");
  const cumulative = finish(data, "t01", "frontier-cumulative", "valid");
  cumulative.seed_run_id = "wrong-parent";
  assert.throws(() => analyzePublication(data), /own completed fresh archive/);
  cumulative.seed_run_id = fresh.id;
  fresh.items[0].independently_replayed = false;
  assert.throws(() => analyzePublication(data), /lacks replay/);
  fresh.items[0].independently_replayed = true;
  fresh.items[0].loss = 0.9;
  assert.throws(() => analyzePublication(data), /correct score/);
});
