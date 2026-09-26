import test from "node:test";
import assert from "node:assert/strict";
import { parsePublication, groupRuns, matchedLedger, summarizeMatchedEvidence, editorialLimitation } from "../data.js";

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
  raw.runs[1].items[0].par = 3;
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

test("a planned campaign rejects fixture evidence or a non-subscription protocol", () => {
  const raw = publication();
  raw.runs.pop();
  raw.campaign = { id: "campaign", model: "example-model", effort: "high", status: "complete", planned_jobs: 1,
    jobs: [{ key: "t1--unaided-1", item_id: "t1", condition: "unaided-1", status: "complete", wall_seconds: 900, max_tool_calls: 0, run_id: "r1" }] };
  raw.runs[0].evidence = "fixture";
  assert.throws(() => groupRuns(parsePublication(raw)), /non-subscription evidence or protocol/);
  raw.runs[0].evidence = "subscription";
  raw.runs[0].execution_protocol = "external-mcp-v1";
  assert.throws(() => groupRuns(parsePublication(raw)), /non-subscription evidence or protocol/);
});

test("public proof links cannot escape the publication data directory", () => {
  const raw = publication();
  raw.runs[0].items[0].proof_file = "../owner-run/secrets.json";
  assert.throws(() => parsePublication(raw), /unsafe public proof path/);
  raw.runs[0].items[0].proof_file = "proofs/public-run-1/t1.json";
  assert.equal(parsePublication(raw).runs[0].items[0].proof_file, "proofs/public-run-1/t1.json");
});

test("frozen par and efficiency loss are checked before rendering", () => {
  const raw = publication();
  raw.runs[0].items[0].par = 9;
  assert.throws(() => parsePublication(raw), /par inconsistent/);
  raw.runs[0].items[0].par = 3;
  raw.runs[0].items[0].loss = 0.9;
  assert.throws(() => parsePublication(raw), /loss inconsistent/);
});

function frontierCheckpoints() {
  const raw = publication();
  raw.runs.pop();
  const frontier = raw.runs[0];
  frontier.id = "frontier-example";
  frontier.track = "frontier";
  frontier.mode = "fresh";
  frontier.campaign_condition = "frontier-fresh";
  frontier.execution_protocol = "frontier-subscription-v2";
  frontier.subscription.max_tool_calls = 128;
  const lines = count => Array.from({ length: count }, (_, index) => ({ line_number: index + 1, formula: `synthetic-${index}`, justification: "example", depth: 0 }));
  frontier.items[0].line_count = 2;
  frontier.items[0].loss = .4;
  frontier.items[0].proof = lines(2);
  frontier.improvements = [
    { item_id: "t1", import_id: "000001", checkpoint_id: "000002", execution_command: 2,
      captured_elapsed_seconds: 168.21, line_count: 3, previous_line_count: null, proof: lines(3),
      proof_sha256: "example", proof_bytes_sha256: "example", independently_replayed: true,
      proof_file: "proofs/frontier-example/checkpoints/t1-000001.json" },
    { item_id: "t1", import_id: "000003", checkpoint_id: "000004", execution_command: 4,
      captured_elapsed_seconds: 210.66, line_count: 2, previous_line_count: 3, proof: lines(2),
      proof_sha256: "example", proof_bytes_sha256: "example", independently_replayed: true,
      proof_file: "proofs/frontier-example/checkpoints/t1-000003.json" }
  ];
  return raw;
}

test("Frontier accepted checkpoints retain exact observed reductions and public proof links", () => {
  const [run] = parsePublication(frontierCheckpoints()).runs;
  assert.deepEqual(run.improvements.map(event => [event.line_count, event.previous_line_count, event.captured_elapsed_seconds]),
    [[3, null, 168.21], [2, 3, 210.66]]);
  assert.ok(run.improvements.every(event => event.independently_replayed));
  assert.equal(run.improvements[1].proof_file, "proofs/frontier-example/checkpoints/t1-000003.json");
});

test("planned Frontier subscription v2 runs score only when complete and retain checkpoint evidence", () => {
  const raw = frontierCheckpoints();
  raw.campaign = { id: "campaign", model: "example-model", effort: "high", status: "complete", planned_jobs: 1,
    jobs: [{ key: "t1--frontier-fresh", item_id: "t1", condition: "frontier-fresh", status: "complete", wall_seconds: 900, max_tool_calls: 128, run_id: "frontier-example" }] };
  const [group] = groupRuns(parsePublication(raw));
  assert.equal(group.scoredRecords.length, 1);
  assert.equal(group.meanCompletedLoss, .4);
  assert.equal(group.records[0].run.improvements.length, 2);
});

test("checkpoint sequence rejects inflated lengths, broken lineage, and unsafe or mismatched proof links", () => {
  const raw = frontierCheckpoints();
  raw.runs[0].improvements[1].line_count = 4;
  assert.throws(() => parsePublication(raw), /not a strict line reduction/);
  raw.runs[0].improvements[1].line_count = 2;
  raw.runs[0].improvements[1].previous_line_count = 5;
  assert.throws(() => parsePublication(raw), /sequence is inconsistent/);
  raw.runs[0].improvements[1].previous_line_count = 3;
  raw.runs[0].improvements[1].proof_file = "../private/checkpoint.json";
  assert.throws(() => parsePublication(raw), /unsafe public proof path/);
  raw.runs[0].improvements[1].proof_file = "proofs/other-run/checkpoints/t1-000003.json";
  assert.throws(() => parsePublication(raw), /path disagrees with its identity/);
  raw.runs[0].improvements[1].proof_file = "proofs/frontier-example/checkpoints/t1-000003.json";
  raw.runs[0].improvements[1].proof = [];
  assert.throws(() => parsePublication(raw), /checkpoint proof length disagrees/);
});

test("an Unaided run cannot claim Frontier checkpoint progress", () => {
  const raw = frontierCheckpoints();
  raw.runs[0].track = "unaided";
  raw.runs[0].mode = "unaided";
  assert.throws(() => parsePublication(raw), /Frontier checkpoints on another track/);
});

test("matched ledger preserves planned denominators and explicit pending, active, and awaiting states", () => {
  const raw = publication();
  const frontier = structuredClone(raw.runs[0]);
  frontier.id = "frontier-interrupted";
  frontier.track = "frontier";
  frontier.mode = "fresh";
  frontier.campaign_condition = "frontier-fresh";
  frontier.execution_protocol = "frontier-subscription-v2";
  frontier.subscription.max_tool_calls = 128;
  frontier.evaluation_status = "interrupted";
  frontier.outcome = "interrupted";
  raw.runs.push(frontier);
  const job = (item_id, condition, status, run_id = null) => ({ key: `${item_id}--${condition}`, item_id, condition, status,
    wall_seconds: 900, max_tool_calls: condition.startsWith("frontier") ? 128 : 0, run_id });
  raw.campaign = { id: "campaign", model: "example-model", effort: "high", status: "active", planned_jobs: 8,
    jobs: [job("t1", "unaided-1", "complete", "r1"), job("t2", "unaided-1", "complete", "r2"),
      job("t1", "unaided-2", "running"), job("t2", "unaided-2", "pending"),
      job("t1", "frontier-fresh", "interrupted", "frontier-interrupted"), job("t2", "frontier-fresh", "complete"),
      job("t1", "frontier-cumulative", "queued"), job("t2", "frontier-cumulative", "queued")] };
  const data = parsePublication(raw);
  const ledger = matchedLedger(data, groupRuns(data));
  assert.deepEqual(ledger.columns.map(column => [column.completed, column.planned]), [[2, 2], [0, 2], [0, 2], [0, 2]]);
  assert.deepEqual(ledger.rows[0].cells.map(cell => [cell.kind, cell.label]),
    [["valid", "1 line"], ["active", "Active"], ["interrupted", "Interrupted"], ["pending", "Pending"]]);
  assert.equal(ledger.rows[0].cells[2].record.result.line_count, 1);
  assert.deepEqual(ledger.rows[1].cells.map(cell => [cell.kind, cell.label]),
    [["nonvalid", "missing"], ["pending", "Pending"], ["awaiting", "Awaiting export"], ["pending", "Pending"]]);
  assert.ok(ledger.rows.flatMap(row => row.cells).every(cell => cell.label.length));
  const summary = summarizeMatchedEvidence(ledger);
  assert.equal(summary.fresh.matched, 0);
  assert.equal(summary.fresh.unavailable, 2);
  assert.equal(summary.cumulative.matched, 0);
  assert.equal(summary.cumulative.unavailable, 2);
});

test("matched ledger is absent for an unplanned historical export", () => {
  const data = parsePublication(publication());
  assert.equal(matchedLedger(data, groupRuns(data)), null);
  assert.equal(summarizeMatchedEvidence(null), null);
});

test("evidence readout compares only completed valid matches and keeps missing denominators", () => {
  const valid = line_count => ({ kind: "valid", record: { result: { line_count } } });
  const missing = { kind: "nonvalid", label: "missing" };
  const pending = { kind: "pending", label: "Pending" };
  const ledger = { rows: [
    { cells: [valid(8), valid(7), valid(5), valid(4)] },
    { cells: [valid(6), valid(7), valid(6), valid(6)] },
    { cells: [valid(4), valid(3), valid(5), valid(3)] },
    { cells: [valid(4), missing, valid(2), pending] }
  ] };
  const summary = summarizeMatchedEvidence(ledger);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.fresh, { matched: 3, unavailable: 1, shorterThanBoth: 1, withinUnaidedRange: 1, longerThanBoth: 1 });
  assert.deepEqual(summary.cumulative, { matched: 3, unavailable: 1, shorter: 2, tied: 1, longer: 0 });
});

test("submission-capture editorial note is limited to its campaign and never edits verdicts", () => {
  const raw = publication();
  raw.campaign = { id: "f5718b6e-dc3e-4219-b823-cd62cb98023c", model: "example-model", effort: "high", status: "running", planned_jobs: 0, jobs: [] };
  const data = parsePublication(raw);
  const before = JSON.stringify(data.runs);
  const note = editorialLimitation(data.campaign);
  assert.match(note.body, /remain missing \(loss 1\)/);
  assert.match(note.body, /not evidence that the model could not construct a valid proof/);
  assert.equal(note.href, "https://github.com/dogaozden/prop-bench/blob/master/research/SUBMISSION-FAILURE.md");
  assert.equal(JSON.stringify(data.runs), before);
  assert.equal(editorialLimitation({ id: "another-campaign" }), null);
  assert.equal(editorialLimitation({ id: "__proto__" }), null);
  assert.equal(editorialLimitation(null), null);
});
