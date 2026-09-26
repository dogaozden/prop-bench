import test from "node:test";
import assert from "node:assert/strict";
import { parsePublication, groupRuns } from "../data.js";

function publication() {
  return {
    schema_version: "propbench-publication-v1", generated_at: "2026-09-25T00:00:00Z",
    set: { version: "v2", hash: "set-hash", core_tag: "core" },
    evaluator: { scorer_version: "efficiency-v2", rulebook_sha256: "rule", validator_sha256: "validator" },
    items: [
      { id: "t1", par: 3, theorem_sha256: "a", theorem: { premises: ["P"], conclusion: "P", difficulty: "Easy" } },
      { id: "t2", par: 4, theorem_sha256: "b", theorem: { premises: ["Q"], conclusion: "Q", difficulty: "Easy" } }
    ],
    runs: [
      run("r1", "t1", "valid", 1, [{ line_number: 2, formula: "P", justification: "R 1", depth: 0 }]),
      run("r2", "t2", "missing", null, null)
    ]
  };
}
function run(id, itemId, status, lines, proof) {
  return {
    id, track: "unaided", mode: "unaided", model: "example-model", provider: "codex-subscription",
    execution_protocol: "unaided-subscription-v1", evidence: "subscription", evaluation_status: "complete",
    graded_at: "2026-09-25T00:00:00Z", cohort: id, selected_ids: [itemId],
    campaign_id: "campaign", campaign_condition: "unaided-1",
    budget: { wall_seconds: 900 }, subscription: { effort: "high", max_tool_calls: 0 },
    score: status === "valid" ? .25 : 1, items: [{ id: itemId, status, line_count: lines, par: itemId === "t1" ? 3 : 4, loss: status === "valid" ? .25 : 1, proof }]
  };
}

test("groups singleton runs into their condition without calling a partial census complete", () => {
  const data = parsePublication(publication());
  const [group] = groupRuns(data);
  assert.equal(group.runs.length, 2);
  assert.equal(group.observed, 2);
  assert.equal(group.target, 2);
  assert.equal(group.valid, 1);
  assert.equal(group.meanCompletedLoss, .625);
  assert.equal(group.scoredRecords.length, 2);
});

test("a missing proof can retain its verdict, but a supplied proof must match the verified count", () => {
  const raw = publication();
  raw.runs[0].items[0].proof = null;
  assert.equal(parsePublication(raw).runs[0].items[0].line_count, 1);
  raw.runs[0].items[0].proof = [];
  assert.throws(() => parsePublication(raw), /disagrees with verified line count/);
});

test("rejects unsupported schemas, unknown items, and inconsistent track modes", () => {
  const raw = publication();
  raw.schema_version = "other";
  assert.throws(() => parsePublication(raw), /Unsupported publication schema/);
  raw.schema_version = "propbench-publication-v1";
  raw.runs[0].items[0].id = "foreign";
  assert.throws(() => parsePublication(raw), /unknown item/);
  raw.runs[0].items[0].id = "t1";
  raw.runs[0].mode = "fresh";
  assert.throws(() => parsePublication(raw), /Track\/mode mismatch/);
});

test("historical runs stay separate from campaign groups", () => {
  const raw = publication();
  delete raw.runs[1].campaign_id;
  delete raw.runs[1].campaign_condition;
  assert.equal(groupRuns(parsePublication(raw)).length, 2);
});

test("a campaign cannot silently count the same theorem twice", () => {
  const raw = publication();
  raw.runs[1].items[0].id = "t1";
  assert.throws(() => groupRuns(parsePublication(raw)), /repeats a theorem/);
});

test("interrupted valid proof remains visible but cannot improve completed mean or validity", () => {
  const raw = publication();
  raw.runs[0].evaluation_status = "interrupted";
  raw.runs[0].outcome = "interrupted; excluded from comparative ranking";
  raw.runs[1].items[0].loss = 1;
  raw.campaign = { id: "campaign", model: "example-model", effort: "high", status: "interrupted", planned_jobs: 3,
    jobs: [
      { key: "t1--unaided-1", item_id: "t1", condition: "unaided-1", status: "interrupted", wall_seconds: 900, max_tool_calls: 0, run_id: "r1" },
      { key: "t2--unaided-1", item_id: "t2", condition: "unaided-1", status: "complete", wall_seconds: 900, max_tool_calls: 0, run_id: "r2" },
      { key: "t1--frontier-fresh", item_id: "t1", condition: "frontier-fresh", status: "queued", wall_seconds: 900, max_tool_calls: 128 }
    ] };
  const groups = groupRuns(parsePublication(raw));
  assert.equal(groups.length, 2);
  const unaided = groups.find(group => group.campaign_condition === "unaided-1");
  assert.equal(unaided.records.length, 2);
  assert.equal(unaided.scoredRecords.length, 1);
  assert.equal(unaided.valid, 0);
  assert.equal(unaided.meanCompletedLoss, 1);
  assert.equal(unaided.jobCounts.interrupted, 1);
  const frontier = groups.find(group => group.campaign_condition === "frontier-fresh");
  assert.equal(frontier.runs.length, 0);
  assert.equal(frontier.jobCounts.pending, 1);
  assert.equal(frontier.meanCompletedLoss, null);
});

test("fixture evidence cannot pool with subscription or earn an official mean", () => {
  const raw = publication();
  raw.runs[0].evidence = "fixture";
  assert.throws(() => groupRuns(parsePublication(raw)), /mixes models, budgets, protocols, or evidence/);
  raw.runs.pop();
  const [fixture] = groupRuns(parsePublication(raw));
  assert.equal(fixture.official, false);
  assert.equal(fixture.scoredRecords.length, 0);
  assert.equal(fixture.meanCompletedLoss, null);
});

test("mismatched protocol or budget cannot pool in one condition", () => {
  const raw = publication();
  raw.runs[1].execution_protocol = "other-protocol";
  assert.throws(() => groupRuns(parsePublication(raw)), /mixes models, budgets, protocols, or evidence/);
  raw.runs[1].execution_protocol = raw.runs[0].execution_protocol;
  raw.runs[1].budget.wall_seconds = 300;
  assert.throws(() => groupRuns(parsePublication(raw)), /mixes models, budgets, protocols, or evidence/);
});
