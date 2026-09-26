import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { publicationCanonical as canonical, publicationSha256 as sha, publicCohort, verifyPublication } from "./verify-publication";
import { analyzePublication } from "./analyze-publication";

type Json = Record<string, any>;
const ROOT = path.resolve(__dirname, "..");
const VALIDATOR = path.join(ROOT, "target/release/propbench-validate");
const CONDITIONS = ["unaided-1", "unaided-2", "frontier-fresh", "frontier-cumulative"];
// A transparent, fixed synthetic test proof. No native/model session is run.
const PROOF = [
  { line_number: 2, formula: "~S", justification: "Taut 1", depth: 0 },
  { line_number: 3, formula: "~S v ~S", justification: "Taut 2", depth: 0 },
  { line_number: 4, formula: "~S v ~~R", justification: "Add 2", depth: 0 },
  { line_number: 5, formula: "~(S . ~R)", justification: "DeM 4", depth: 0 },
  { line_number: 6, formula: "~~~(S . ~R)", justification: "DN 5", depth: 0 },
  { line_number: 7, formula: "~~~(S . ~R) . ~~~(S . ~R)", justification: "Taut 6", depth: 0 },
  { line_number: 8, formula: "(~S v ~S) . (~~~(S . ~R) . ~~~(S . ~R))", justification: "Conj 3,7", depth: 0 },
];
const LONG_PROOF = [...PROOF,
  { line_number: 9, formula: `~~(${PROOF[6].formula})`, justification: "DN 8", depth: 0 },
  { line_number: 10, formula: PROOF[6].formula, justification: "DN 9", depth: 0 },
];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-public-replay-test-"));
  fs.cpSync(path.join(ROOT, "golf/set/v2"), path.join(dir, "theorems"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "rules.md"), path.join(dir, "rules.md"));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "theorems/manifest.json"), "utf8"));
  const items = manifest.items.map((item: Json) => ({ ...item, theorem: JSON.parse(fs.readFileSync(path.join(dir, "theorems", item.id + ".json"), "utf8")) }));
  const created = "2026-09-25T00:00:00.000Z";
  const data: Json = {
    schema_version: "propbench-publication-v1", generated_at: created,
    set: { version: "v2", core_tag: "v0.3.4", hash: sha(canonical({ version: "v2", core_tag: "v0.3.4", items: manifest.items })),
      manifest_sha256: sha(fs.readFileSync(path.join(dir, "theorems/manifest.json"))) },
    evaluator: { scorer_version: "efficiency-v2", rulebook_sha256: sha(fs.readFileSync(path.join(dir, "rules.md"))), validator_sha256: "b".repeat(64) },
    campaign: { id: "synthetic-public-replay-test", created_at: created, source_commit: "c".repeat(40), model: "synthetic-model", effort: "xhigh",
      evaluator_hash: "a".repeat(64), client: { version: "codex-cli synthetic-test", sha256: "d".repeat(64) }, status: "running", planned_jobs: 96, recorded_runs: 0,
      jobs: items.flatMap((item: Json) => CONDITIONS.map(condition => ({ key: `${item.id}--${condition}`, item_id: item.id, condition, status: "queued", wall_seconds: 900, max_tool_calls: condition.startsWith("frontier") ? 128 : 0 }))) },
    items, runs: [],
  };
  function putProof(run: Json, value = structuredClone(PROOF)): void {
    const record = run.items[0], bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    record.proof = value; record.proof_sha256 = sha(canonical(value)); record.proof_bytes_sha256 = sha(bytes);
    record.proof_file = `proofs/${run.id}/${record.id}.json`;
    fs.mkdirSync(path.dirname(path.join(dir, record.proof_file)), { recursive: true }); fs.writeFileSync(path.join(dir, record.proof_file), bytes);
  }
  function snapshot(run?: Json): Json {
    const entries: Json[] = [
      { path: "proofs", kind: "directory", mode: 0o700 }, { path: "tools", kind: "directory", mode: 0o700 },
      ...["METHODS.md", "LOG.md", "DEBRIEF.md"].map(name => ({ path: name, kind: "file", mode: 0o600, bytes: 0, sha256: sha("") })),
    ];
    if (run) { const item = run.items[0]; entries.push({ path: `proofs/${item.id}.json`, kind: "file", mode: 0o600,
      bytes: fs.statSync(path.join(dir, item.proof_file)).size, sha256: item.proof_bytes_sha256 }); }
    else entries.push({ path: "proofs/.gitkeep", kind: "file", mode: 0o644, bytes: 0, sha256: sha("") });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const index = { schema_version: "propbench-frontier-snapshot-v1", entries };
    return { ...index, digest: sha(canonical(index)) };
  }
  function addRun(condition = "unaided-1", seed?: Json): Json {
    const item = items[0], frontier = condition.startsWith("frontier"), cumulative = condition === "frontier-cumulative";
    const run: Json = {
      id: `test-${condition}`, campaign_id: data.campaign.id, campaign_condition: condition,
      track: frontier ? "frontier" : "unaided", mode: frontier ? cumulative ? "cumulative" : "fresh" : "unaided",
      model: data.campaign.model, observed_models: [data.campaign.model], returned_models: [data.campaign.model], provider: "codex-subscription",
      execution_protocol: frontier ? "frontier-subscription-v2" : "unaided-subscription-v1", evidence: "subscription", evaluation_status: "complete",
      graded_at: created, completed_at: created, selected_ids: [item.id],
      budget: { wall_seconds: 900, max_tool_calls: frontier ? 128 : 0 }, subscription: { effort: "xhigh", max_tool_calls: frontier ? 128 : 0 },
      score: 7 / 20, valid_count: 1, total: 1, usage: { input_tokens: 2, output_tokens: 3 }, usage_coverage: { attempts: 1, attempts_with_usage: 1 },
      client_sessions: 1, elapsed_seconds: 42, tool_counts: frontier ? { exec: 1 } : {},
      evaluator_hash: data.campaign.evaluator_hash, regraded_by: data.campaign.evaluator_hash, validator_sha256: data.evaluator.validator_sha256,
      rulebook_sha256: data.evaluator.rulebook_sha256, set_version: "v2", core_tag: "v0.3.4",
      set_hash: sha(canonical({ version: "v2", core_tag: "v0.3.4", items: [manifest.items[0]] })), starting_snapshot: cumulative ? seed!.final_snapshot.digest : null,
      runtime: frontier ? { backend: "docker", image_id: "sha256:" + "e".repeat(64), architecture: "synthetic-test" } : null,
      items: [{ id: item.id, status: "valid", line_count: 7, par: item.par, loss: 7 / 20, independently_replayed: true }], outcome: "completed",
    };
    putProof(run);
    if (frontier) { run.initial_snapshot = cumulative ? structuredClone(seed!.final_snapshot) : snapshot(); run.final_snapshot = snapshot(run); }
    if (cumulative) run.seed_run_id = seed!.id;
    run.cohort = publicCohort(run);
    data.runs.push(run); data.campaign.recorded_runs = data.runs.length;
    Object.assign(data.campaign.jobs.find((job: Json) => job.key === `${item.id}--${condition}`), { status: "complete", run_id: run.id });
    return run;
  }
  function write(): string { const file = path.join(dir, "results.json"); fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); return file; }
  function improvement(run: Json, value: typeof PROOF, previous: number | null, command: number): Json {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"), number = String(command).padStart(6, "0");
    const event: Json = { item_id: run.selected_ids[0], checkpoint_id: number, import_id: number, execution_command: command,
      captured_elapsed_seconds: command * 10, line_count: value.length, previous_line_count: previous,
      proof_sha256: sha(canonical(value)), proof_bytes_sha256: sha(bytes),
      proof_file: `proofs/${run.id}/checkpoints/${run.selected_ids[0]}-${number}.json`, proof: structuredClone(value), independently_replayed: true };
    fs.mkdirSync(path.dirname(path.join(dir, event.proof_file)), { recursive: true }); fs.writeFileSync(path.join(dir, event.proof_file), bytes);
    run.improvements ??= []; run.improvements.push(event); run.tool_counts.exec = Math.max(run.tool_counts.exec ?? 0, command);
    return event;
  }
  return { dir, data, addRun, putProof, snapshot, improvement, write, verify: () => verifyPublication({ dataFile: write(), validator: VALIDATOR }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("offline replay accepts a partial public-only bundle and distinguishes binary identity", async () => {
  const f = fixture();
  try {
    f.addRun(); const result = await f.verify();
    assert.equal(result.verified, true); assert.equal(result.census_complete, false); assert.equal(result.planned_jobs, 96);
    assert.equal(result.independently_replayed_proofs, 1); assert.equal(result.referee.exact_binary_match, false);
    await assert.rejects(verifyPublication({ dataFile: f.write(), validator: VALIDATOR, requireExactBinary: true }), /binary SHA differs/);
    const expected = sha(fs.readFileSync(f.write()));
    assert.equal((await verifyPublication({ dataFile: path.join(f.dir, "results.json"), validator: VALIDATOR, expectedResultsSha256: expected })).externally_pinned_results, true);
    await assert.rejects(verifyPublication({ dataFile: f.write(), validator: VALIDATOR, expectedResultsSha256: "f".repeat(64) }), /externally pinned/);
  } finally { f.cleanup(); }
});

test("an empty partial census is verified as zero proof replays, never campaign completion", async () => {
  const f = fixture();
  try { const result = await f.verify(); assert.equal(result.independently_replayed_proofs, 0); assert.equal(result.census_complete, false); }
  finally { f.cleanup(); }
});

test("theorem/rule bytes, embedded formulas, canonical proof and exact proof bytes are separately checked", async t => {
  const changes: Array<[string, (f: ReturnType<typeof fixture>, r: Json) => void, RegExp]> = [
    ["theorem", f => fs.appendFileSync(path.join(f.dir, "theorems/g1-2000001.json"), " "), /Theorem bytes hash/],
    ["rules", f => fs.appendFileSync(path.join(f.dir, "rules.md"), "changed"), /Rulebook bytes hash/],
    ["embedded theorem", f => { f.data.items[0].theorem.conclusion = "P"; }, /Embedded theorem/],
    ["canonical proof", (_f, r) => { r.items[0].proof[0].formula = "P"; }, /Canonical proof hash/],
    ["exact proof formatting", (f, r) => fs.appendFileSync(path.join(f.dir, r.items[0].proof_file), "\n"), /Exact proof bytes hash/],
    ["embedded proof with changed hash", (_f, r) => { r.items[0].proof[0].formula = "P"; r.items[0].proof_sha256 = sha(canonical(r.items[0].proof)); }, /Embedded\/asset proof/],
  ];
  for (const [name, change, pattern] of changes) await t.test(name, async () => {
    const f = fixture(); try { const run = f.addRun(); change(f, run); await assert.rejects(f.verify(), pattern); } finally { f.cleanup(); }
  });
});

test("a forged proof with internally consistent hashes and scores still fails the real strict referee", async () => {
  const f = fixture();
  try { const run = f.addRun(), wrong = structuredClone(PROOF); wrong[0].formula = "P"; f.putProof(run, wrong); await assert.rejects(f.verify(), /Strict replay disagrees/); }
  finally { f.cleanup(); }
});

test("public proof paths cannot escape the bundle or follow a symlink", async () => {
  const f = fixture();
  try {
    const run = f.addRun(), record = run.items[0], original = record.proof_file;
    record.proof_file = "../secret.json"; await assert.rejects(f.verify(), /Unexpected proof asset path/); record.proof_file = original;
    const file = path.join(f.dir, original), copied = file + ".copy"; fs.renameSync(file, copied); fs.symlinkSync(copied, file);
    await assert.rejects(f.verify(), /symlink forbidden/);
  } finally { f.cleanup(); }
});

test("scoring, cohort identity, condition budgets and evidence cannot be relabeled", async t => {
  const changes: Array<[string, (f: ReturnType<typeof fixture>, r: Json) => void, RegExp]> = [
    ["score", (_f, r) => { r.score = 0; }, /Run mean loss arithmetic/],
    ["loss", (_f, r) => { r.items[0].loss = 0; }, /Item loss arithmetic/],
    ["valid count", (_f, r) => { r.valid_count = 0; }, /Valid count/],
    ["cohort", (_f, r) => { r.cohort = "0".repeat(64); }, /cohort hash/],
    ["budget even with new cohort", (_f, r) => { r.budget.wall_seconds = 901; r.cohort = publicCohort(r); }, /Run budget/],
    ["tools in Unaided", (_f, r) => { r.tool_counts.exec = 1; }, /Tool allowance/],
    ["wrong actual model", (_f, r) => { r.returned_models = ["fallback"]; }, /Returned model/],
    ["fixture in official results", (_f, r) => { r.evidence = "fixture"; }, /not native Codex/],
    ["false campaign completion", f => { f.data.campaign.status = "complete"; }, /falsely claims completion/],
    ["omitted terminal result", f => { f.data.runs = []; f.data.campaign.recorded_runs = 0; }, /Completed planned run is omitted/],
    ["duplicate census cell", f => { f.data.campaign.jobs[1] = structuredClone(f.data.campaign.jobs[0]); }, /Duplicate planned job/],
  ];
  for (const [name, change, pattern] of changes) await t.test(name, async () => {
    const f = fixture(); try { const run = f.addRun(); change(f, run); await assert.rejects(f.verify(), pattern); } finally { f.cleanup(); }
  });
});

test("Frontier snapshot hashes and same-item cumulative lineage bind inherited proof bytes", async () => {
  const f = fixture();
  try {
    const fresh = f.addRun("frontier-fresh"), cumulative = f.addRun("frontier-cumulative", fresh);
    assert.equal((await f.verify()).independently_replayed_proofs, 2);
    cumulative.seed_run_id = "missing-parent"; await assert.rejects(f.verify(), /same item's completed fresh/); cumulative.seed_run_id = fresh.id;
    const entry = cumulative.initial_snapshot.entries.find((entry: Json) => entry.path.endsWith(".json")); entry.bytes++;
    await assert.rejects(f.verify(), /Initial snapshot digest/); entry.bytes--;
    fresh.final_snapshot.entries.find((entry: Json) => entry.path.endsWith(".json")).sha256 = "0".repeat(64);
    fresh.final_snapshot.digest = sha(canonical({ schema_version: fresh.final_snapshot.schema_version, entries: fresh.final_snapshot.entries }));
    await assert.rejects(f.verify(), /Final snapshot proof differs/);
  } finally { f.cleanup(); }
});

test("an interrupted valid proof remains replayable but stays excluded from completed counts", async () => {
  const f = fixture();
  try {
    const run = f.addRun(); run.evaluation_status = "interrupted"; run.outcome = "interrupted; excluded from comparative ranking";
    f.data.campaign.jobs.find((job: Json) => job.run_id === run.id).status = "interrupted"; f.data.campaign.status = "interrupted";
    const result = await f.verify(); assert.equal(result.completed_runs, 0); assert.equal(result.interrupted_runs, 1); assert.equal(result.independently_replayed_proofs, 1);
  } finally { f.cleanup(); }
});

test("accepted checkpoint proofs replay independently and lead monotonically to the final incumbent", async () => {
  const f = fixture();
  try {
    const fresh = f.addRun("frontier-fresh"); f.improvement(fresh, LONG_PROOF, null, 4); f.improvement(fresh, PROOF, 9, 9);
    const cumulative = f.addRun("frontier-cumulative", fresh); cumulative.improvements = [];
    const result = await f.verify();
    assert.equal(result.independently_replayed_incumbents, 2); assert.equal(result.independently_replayed_checkpoint_proofs, 2); assert.equal(result.independently_replayed_proofs, 4);
  } finally { f.cleanup(); }
});

test("checkpoint timing, sequence, exact bytes and final-incumbent claims cannot be relabeled", async t => {
  const changes: Array<[string, (f: ReturnType<typeof fixture>, r: Json) => void, RegExp]> = [
    ["late capture", (_f, r) => { r.improvements[0].captured_elapsed_seconds = 900; }, /outside the wall budget/],
    ["negative capture", (_f, r) => { r.improvements[0].captured_elapsed_seconds = -1; }, /finite and nonnegative/],
    ["time goes backwards", (_f, r) => { r.improvements[1].captured_elapsed_seconds = 1; }, /out of order/],
    ["wrong previous incumbent", (_f, r) => { r.improvements[1].previous_line_count = 10; }, /previous incumbent length/],
    ["checkpoint repeated", (_f, r) => { r.improvements[1].checkpoint_id = r.improvements[0].checkpoint_id; }, /Checkpoint identity\/order/],
    ["command exceeds recorded calls", (_f, r) => { r.improvements[1].execution_command = 10; }, /exceeds recorded exec/],
    ["omitted accepted result", (_f, r) => { r.improvements.pop(); }, /final incumbent proof/],
    ["empty accepted sequence", (_f, r) => { r.improvements = []; }, /final incumbent presence/],
    ["proof byte change", (f, r) => fs.appendFileSync(path.join(f.dir, r.improvements[0].proof_file), " "), /Checkpoint exact proof bytes/],
    ["import does not match file", (_f, r) => { r.improvements[0].import_id = "000002"; }, /asset path\/import identity/],
    ["canonical hash change", (_f, r) => { r.improvements[0].proof_sha256 = "f".repeat(64); }, /Checkpoint canonical proof hash/],
  ];
  for (const [name, change, pattern] of changes) await t.test(name, async () => {
    const f = fixture();
    try { const run = f.addRun("frontier-fresh"); f.improvement(run, LONG_PROOF, null, 4); f.improvement(run, PROOF, 9, 9); change(f, run); await assert.rejects(f.verify(), pattern); }
    finally { f.cleanup(); }
  });
});

test("a fully rehashed invalid intermediate checkpoint fails strict replay despite a valid final proof", async () => {
  const f = fixture();
  try {
    const run = f.addRun("frontier-fresh"), bad = structuredClone(LONG_PROOF); bad[0].formula = "P";
    f.improvement(run, bad, null, 4); f.improvement(run, PROOF, 9, 9);
    await assert.rejects(f.verify(), /Strict replay disagrees/);
  } finally { f.cleanup(); }
});

test("cumulative checkpoints begin at the inherited incumbent length", async () => {
  const f = fixture();
  try {
    const fresh = f.addRun("frontier-fresh"); f.putProof(fresh, LONG_PROOF);
    fresh.items[0].line_count = 9; fresh.score = fresh.items[0].loss = 9 / (9 + fresh.items[0].par); fresh.final_snapshot = f.snapshot(fresh);
    f.improvement(fresh, LONG_PROOF, null, 4);
    const cumulative = f.addRun("frontier-cumulative", fresh); const event = f.improvement(cumulative, PROOF, 9, 5);
    assert.equal((await f.verify()).independently_replayed_checkpoint_proofs, 2);
    event.previous_line_count = null; await assert.rejects(f.verify(), /previous incumbent length/);
  } finally { f.cleanup(); }
});

test("CLI report is current and atomic on success; failed replay preserves the prior receipt", () => {
  const f = fixture();
  const invoke = (...args: string[]) => spawnSync(process.execPath,
    ["--require", require.resolve("ts-node/register"), path.join(ROOT, "scripts/verify-publication.ts"), "--data", path.join(f.dir, "results.json"), "--validator", VALIDATOR, ...args],
    { cwd: ROOT, encoding: "utf8" });
  try {
    const run = f.addRun(), dataFile = f.write(), report = path.join(f.dir, "verification.json");
    const readonly = invoke(); assert.equal(readonly.status, 0, readonly.stderr); assert.equal(fs.existsSync(report), false);
    fs.writeFileSync(report, "old receipt\n");
    const written = invoke("--report", report); assert.equal(written.status, 0, written.stderr);
    const prior = fs.readFileSync(report, "utf8"); assert.equal(prior, written.stdout);
    assert.equal(JSON.parse(prior).results_sha256, sha(fs.readFileSync(dataFile)));
    fs.appendFileSync(path.join(f.dir, run.items[0].proof_file), " ");
    const failed = invoke("--report", report); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /Exact proof bytes hash mismatch/);
    assert.equal(failed.stdout, ""); assert.equal(fs.readFileSync(report, "utf8"), prior);
    const absentReport = path.join(f.dir, "new-receipt.json");
    assert.notEqual(invoke("--report", absentReport).status, 0); assert.equal(fs.existsSync(absentReport), false);
    assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith(".verification-")), false);
    assert.notEqual(invoke("--report", dataFile).status, 0); assert.equal(sha(fs.readFileSync(dataFile)), JSON.parse(prior).results_sha256);
  } finally { f.cleanup(); }
});

test("packaging requires current successful replay and summary receipts for the main data and every pilot", async t => {
  const f = fixture(), site = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-package-receipts-"));
  const output = path.join(site, "release.zip");
  const pack = () => spawnSync("python3", [path.join(ROOT, "scripts/package-publication.py"), "--source", site, "--output", output, "--allow-partial"], { cwd: ROOT, encoding: "utf8" });
  try {
    const unaided = f.addRun(), frontier = f.addRun("frontier-fresh"), checkpoint = f.improvement(frontier, PROOF, null, 1); f.write();
    const receipt = await f.verify(), { summary, csv } = analyzePublication(f.data);
    summary.source_export_sha256 = sha(fs.readFileSync(path.join(f.dir, "results.json")));
    fs.writeFileSync(path.join(f.dir, "verification.json"), JSON.stringify(receipt));
    fs.writeFileSync(path.join(f.dir, "summary.json"), JSON.stringify(summary));
    fs.writeFileSync(path.join(f.dir, "jobs.csv"), csv);
    for (const prefix of ["", "pilots/20260925"]) {
      const base = path.join(site, prefix); fs.mkdirSync(base, { recursive: true });
      for (const name of ["index.html", "app.js", "data.js", "style.css", "favicon.svg"]) fs.writeFileSync(path.join(base, name), "synthetic packaging fixture\n");
      fs.cpSync(f.dir, path.join(base, "data"), { recursive: true });
    }
    const good = pack(); assert.equal(good.status, 0, good.stderr); const priorArchive = fs.readFileSync(output);
    const changes: Array<[string, string, (bytes: Buffer) => Buffer | null, RegExp]> = [
      ["missing verification", "verification.json", () => null, /Missing verification.json/],
      ["false verification", "verification.json", bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), verified: false })), /unsuccessful verification/],
      ["stale verification hash", "verification.json", bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), results_sha256: "f".repeat(64) })), /stale.*verification/],
      ["new export after replay", "results.json", bytes => Buffer.concat([bytes, Buffer.from(" \n")]), /stale.*verification/],
      ["missing summary", "summary.json", () => null, /Missing summary.json/],
      ["stale summary", "summary.json", bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), source_export_sha256: "f".repeat(64) })), /stale analysis summary/],
      ["missing job ledger", "jobs.csv", () => null, /Missing jobs.csv/],
    ];
    for (const [label, filename] of [
      ["final proof", unaided.items[0].proof_file], ["checkpoint proof", checkpoint.proof_file],
      ["theorem", `theorems/${f.data.items[0].id}.json`], ["manifest", "theorems/manifest.json"], ["rules", "rules.md"],
    ]) {
      changes.push([`missing ${label}`, filename, () => null, /Missing evidence asset/]);
      changes.push([`changed ${label} bytes`, filename, () => Buffer.from("[]\n"), /Evidence asset byte hash mismatch/]);
    }
    for (const prefix of ["data", "pilots/20260925/data"]) for (const [name, filename, change, expected] of changes) await t.test(`${prefix}: ${name}`, () => {
      const file = path.join(site, prefix, filename), original = fs.readFileSync(file), changed = change(original);
      try {
        if (changed === null) fs.unlinkSync(file); else fs.writeFileSync(file, changed);
        const result = pack(); assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
        assert.deepEqual(fs.readFileSync(output), priorArchive, "Rejected package must preserve the previous ZIP");
      } finally { fs.writeFileSync(file, original); }
    });
    for (const prefix of ["data", "pilots/20260925/data"]) await t.test(`${prefix}: proof path cannot escape its data root even with rehashed receipts`, () => {
      const names = ["results.json", "verification.json", "summary.json"];
      const originals = names.map(name => fs.readFileSync(path.join(site, prefix, name)));
      try {
        const result = JSON.parse(originals[0].toString()); result.runs[0].items[0].proof_file = "../outside.json";
        const bytes = Buffer.from(JSON.stringify(result));
        const receipt = { ...JSON.parse(originals[1].toString()), results_sha256: sha(bytes) };
        const summary = { ...JSON.parse(originals[2].toString()), source_export_sha256: sha(bytes) };
        for (const [index, value] of [bytes, Buffer.from(JSON.stringify(receipt)), Buffer.from(JSON.stringify(summary))].entries()) fs.writeFileSync(path.join(site, prefix, names[index]), value);
        const rejected = pack(); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Unexpected final proof asset path/);
        assert.deepEqual(fs.readFileSync(output), priorArchive);
      } finally { names.forEach((name, index) => fs.writeFileSync(path.join(site, prefix, name), originals[index])); }
    });
    for (const prefix of ["data", "pilots/20260925/data"]) {
      for (const [name, relative, contents] of [
        ["unlisted account metadata", "account.json", '{"account_type":"synthetic","email":"fixture@example.invalid"}\n'],
        ["unreferenced proof", "proofs/old-run/unlisted.json", JSON.stringify(PROOF)],
      ]) await t.test(`${prefix}: reject ${name}`, () => {
        const file = path.join(site, prefix, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents);
        try {
          const rejected = pack(); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Unexpected data asset/);
          assert.deepEqual(fs.readFileSync(output), priorArchive);
        } finally { fs.unlinkSync(file); }
      });
    }
    for (const prefix of ["data", "pilots/20260925/data"]) await t.test(`${prefix}: optional README is allowed`, () => {
      const file = path.join(site, prefix, "README.md"); fs.writeFileSync(file, "# Synthetic archive note\n\nThis file explains the fixture.\n");
      try {
        const accepted = pack(); assert.equal(accepted.status, 0, accepted.stderr);
        assert.equal(JSON.parse(accepted.stdout).files, JSON.parse(good.stdout).files + 1);
      } finally { fs.unlinkSync(file); }
    });
  } finally { f.cleanup(); fs.rmSync(site, { recursive: true, force: true }); }
});
