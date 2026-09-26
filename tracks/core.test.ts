import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROJECT_ROOT, prepareRun, loadSet, loadRun, gradeRun, listReports, proofLoss, validateCandidate, readJson, writeJson, writeJsonExclusive, cohortKey, compareReports, readRegularFile, parseProof } from "./core";
import type { PrepareOptions } from "./types";

const validator = path.join(PROJECT_ROOT, "target/release/propbench");
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "propbench-core-test-"));
function options(root: string): PrepareOptions {
  return { root, setDir: path.join(PROJECT_ROOT, "golf/set/rehearsal"), track: "unaided", mode: "unaided", provider: "fixture",
    model: "fixture", temperature: 0, budget: { wall_seconds: 60, max_generations: 1, max_output_tokens: 512, max_thinking_tokens: 0 }, validator };
}
const valid = [{ line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 }];

test("every valid proof beats omission; every removed line improves v2", () => {
  for (const par of [1, 13, 100]) {
    assert.equal(proofLoss(null, par), 1);
    assert.equal(proofLoss(par, par), 0.5);
    for (const lines of [1, 2, 20, 10000, 100000]) {
      assert.ok(proofLoss(lines, par) < proofLoss(null, par));
      assert.ok(proofLoss(lines - 1, par) < proofLoss(lines, par));
    }
  }
  assert.throws(() => proofLoss(-1, 1));
  assert.throws(() => proofLoss(1, 0));
});
test("frozen set selections have distinct identities, reject unknown and duplicate ids", () => {
  const dir = path.join(PROJECT_ROOT, "golf/set/v2");
  const full = loadSet(dir);
  const single = loadSet(dir, [full.items[0].id]);
  assert.equal(single.items.length, 1);
  assert.notEqual(single.hash, full.hash);
  assert.equal(single.hash, loadSet(dir, [full.items[0].id]).hash);
  assert.throws(() => loadSet(dir, ["../secret"]));
  assert.throws(() => loadSet(dir, []));
  assert.throws(() => loadSet(dir, [full.items[0].id, full.items[0].id]));
});
test("corrupted theorem bytes cannot be prepared", () => {
  const tmp = temporary();
  try {
    const src = path.join(PROJECT_ROOT, "golf/set/rehearsal");
    fs.cpSync(src, path.join(tmp, "set"), { recursive: true });
    fs.appendFileSync(path.join(tmp, "set/r1.json"), " ");
    assert.throws(() => loadSet(path.join(tmp, "set")), /hash mismatch/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("replay accounts premises, CP/IP, and invalid inference independently", async () => {
  const set = loadSet(path.join(PROJECT_ROOT, "golf/set/rehearsal"));
  assert.deepEqual(await validateCandidate(validator, set.items[0].theorem, valid), { status: "valid", line_count: 1, errors: [] });
  assert.equal((await validateCandidate(validator, set.items[0].theorem, [{ ...valid[0], justification: "MP 1,1" }])).status, "invalid");
  for (const [name, proof, count] of [
    ["round3_theorem.json", "round3_proof.json", 4],
    ["round10_theorem.json", "round10_proof_5line.json", 5],
  ] as const) {
    const theorem = readJson(path.join(PROJECT_ROOT, "fixtures/regression", name));
    const lines = readJson(path.join(PROJECT_ROOT, "fixtures/regression", proof));
    const result = await validateCandidate(validator, theorem, lines);
    assert.equal(result.status, "valid");
    assert.equal(result.line_count, count);
  }
});
test("proof protocol never executes strings and rejects wrong shapes", () => {
  for (const text of ["process.exit()", "{}", '{"proof":[]}', '[{"line_number":1,"formula":"P","justification":"Simp 1","depth":0,"exec":"rm"}]']) assert.throws(() => parseProof(text));
  assert.deepEqual(parseProof(JSON.stringify(valid)), valid);
});
test("owner grading recomputes proofs, so forged line counts do not count", async () => {
  const tmp = temporary();
  try {
    const ctx = prepareRun(options(tmp));
    writeJsonExclusive(path.join(ctx.dir, "submissions/r1.json"), valid);
    const report = await gradeRun(ctx.dir, validator);
    assert.equal(report.score, 0.5);
    assert.equal(report.valid_count, 1);
    assert.equal(report.total_lines, 1);
    writeJson(path.join(ctx.dir, "report.json"), { ...report, score: -999 });
    assert.equal((await gradeRun(ctx.dir, validator)).score, 0.5);
    writeJson(path.join(ctx.dir, "submissions/r1.json"), [{ ...valid[0], formula: "R" }]);
    const invalid = await gradeRun(ctx.dir, validator);
    assert.equal(invalid.score, 1);
    assert.equal(invalid.valid_count, 0);
    assert.equal(invalid.mean_valid_lines, null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("unknown and symlinked submissions fail closed", async () => {
  const tmp = temporary();
  try {
    const ctx = prepareRun(options(tmp));
    const outside = path.join(tmp, "outside.json");
    writeJsonExclusive(outside, valid);
    fs.symlinkSync(outside, path.join(ctx.dir, "submissions/r1.json"));
    await assert.rejects(gradeRun(ctx.dir, validator));
    fs.unlinkSync(path.join(ctx.dir, "submissions/r1.json"));
    writeJsonExclusive(path.join(ctx.dir, "submissions/unknown.json"), valid);
    await assert.rejects(gradeRun(ctx.dir, validator), /Unknown submission/);
    assert.equal(fs.existsSync(path.join(ctx.dir, "report.json")), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("grading rejects changed verifier and canonical set", async () => {
  const tmp = temporary();
  try {
    const ctx = prepareRun(options(tmp));
    const changed = path.join(tmp, "changed-validator");
    fs.writeFileSync(changed, "not the verifier");
    await assert.rejects(gradeRun(ctx.dir, changed), /Verifier binary changed/);
    fs.appendFileSync(path.join(ctx.dir, "set/r1.json"), " ");
    assert.throws(() => loadRun(ctx.dir), /hash mismatch/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("comparison cohorts separate tools, inheritance, budgets, sets, and fixtures", async () => {
  const tmp = temporary();
  try {
    const ctx = prepareRun(options(tmp));
    const key = cohortKey(ctx.config);
    assert.equal(key, cohortKey({ ...ctx.config, model: "a different model" }));
    for (const change of [
      { mode: "fresh" as const, track: "frontier" as const }, { starting_snapshot: "another-snapshot" },
      { budget: { ...ctx.config.budget, max_output_tokens: 1024 } }, { set_hash: "another-set" }, { provider: "openrouter" as const }
    ]) assert.notEqual(key, cohortKey({ ...ctx.config, ...change }));
    const report = await gradeRun(ctx.dir, validator);
    assert.equal(compareReports([report]).length, 0, "an unexecuted run is not a ranked evaluation");
    assert.equal(compareReports([{ ...report, evaluation_status: "complete" }, { ...report, evaluation_status: "complete", cohort: "other" }]).length, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("comparisons regrade cached scores and preparation receipts detect metadata drift", async () => {
  const root = temporary();
  try {
    const ctx = prepareRun(options(root));
    writeJsonExclusive(path.join(ctx.dir, "submissions/r1.json"), valid);
    const report = await gradeRun(ctx.dir, validator);
    writeJson(path.join(ctx.dir, "report.json"), { ...report, score: -999, valid_count: 999 });
    const reports = await listReports(root);
    assert.equal(reports[0].score, 0.5);
    assert.equal(reports[0].valid_count, 1);
    writeJson(path.join(ctx.dir, "run.json"), { ...ctx.config, budget: { ...ctx.config.budget, max_generations: 999 } });
    await assert.rejects(listReports(root), /preparation receipt/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new rulebook matches repeated-subformula replacement in the pinned engine", async () => {
  const theorem = { id: "duplicates", premises: ["(P & P)"], conclusion: "(~~P & ~~P)", difficulty: "fixture", difficulty_value: 1 };
  assert.equal((await validateCandidate(validator, theorem, [{ line_number: 2, formula: theorem.conclusion, justification: "DN 1", depth: 0 }])).status, "valid");
});
test("atomic writes do not follow symlinks", () => {
  const tmp = temporary();
  try {
    const outside = path.join(tmp, "target");
    fs.writeFileSync(outside, "unchanged");
    const link = path.join(tmp, "link");
    fs.symlinkSync(outside, link);
    assert.throws(() => readRegularFile(link));
    assert.throws(() => writeJson(link, { changed: true }));
    assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
