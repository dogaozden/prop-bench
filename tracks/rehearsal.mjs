// Deterministic integration rehearsal. Every generation is explicitly a fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-rehearsal-"));
const runRoot = path.join(output, "runs");
const bundles = path.join(output, "bundles");
fs.mkdirSync(bundles);
const cli = ["--require", path.join(project, "node_modules/ts-node/register/transpile-only"), path.join(project, "tracks/cli.ts")];
const saved = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
function call(name, args, expectedFailure = false) {
  const result = spawnSync(process.execPath, [...cli, ...args], { cwd: project, encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (expectedFailure) {
    assert.notEqual(result.status, 0);
    fs.writeFileSync(path.join(output, name + ".txt"), result.stderr);
    return result.stderr;
  }
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  saved(name + ".json", value);
  return value;
}
const shared = ["--set", "rehearsal", "--provider", "fixture", "--model", "rehearsal-fixture", "--run-root", runRoot, "--generations", "4", "--tokens", "256", "--thinking", "0", "--seconds", "60"];
function check(report, generations) {
  assert.equal(report.evidence, "fixture");
  assert.equal(report.evaluation_status, "complete");
  assert.equal(report.generations, generations);
  assert.equal(report.valid_count, 1);
  assert.equal(report.items[0].line_count, 1);
  assert.equal(report.score, 0.5);
}

try {
  const unaided = call("unaided-prepared", ["prepare", "--track", "unaided", ...shared]);
  const unaidedReport = call("unaided-report", ["run-unaided", "--run", unaided.run, "--fixture-responses", "tracks/fixtures/unaided-rehearsal.json"]);
  check(unaidedReport, 1);
  assert.match(call("unaided-restart-rejected", ["run-unaided", "--run", unaided.run, "--fixture-responses", "tracks/fixtures/unaided-rehearsal.json"], true), /populated|graded/);

  const frontier = call("frontier-prepared", ["prepare", "--track", "frontier", "--mode", "fresh", "--bundle", path.join(bundles, "fresh"), ...shared]);
  const frontierReport = call("frontier-report", ["run-frontier", "--run", frontier.run, "--fixture-responses", "tracks/fixtures/frontier-rehearsal.json"]);
  check(frontierReport, 4);
  assert.equal(frontierReport.runtime?.backend, "docker");
  assert.equal(frontierReport.execution_commands, 1);
  assert.match(call("frontier-import-rejected", ["submit", "--run", frontier.run, "--proofs", path.join(bundles, "fresh/proofs")], true), /sealed/);
  const archives = fs.readdirSync(path.join(frontier.run, "archives")).sort();
  const snapshot = path.join(frontier.run, "archives", archives.at(-1));
  assert.match(fs.readFileSync(path.join(snapshot, "METHODS.md"), "utf8"), /delegated/);
  saved("cumulative-responses.json", [{ model: "rehearsal-fixture", choices: [{ message: { role: "assistant", content: "Keep the inherited valid one-line proof." } }] }]);
  const cumulative = call("cumulative-prepared", ["prepare", "--track", "frontier", "--mode", "cumulative", "--snapshot", snapshot, "--bundle", path.join(bundles, "cumulative"), ...shared]);
  const cumulativeReport = call("cumulative-report", ["run-frontier", "--run", cumulative.run, "--fixture-responses", path.join(output, "cumulative-responses.json")]);
  check(cumulativeReport, 1);
  assert.ok(cumulativeReport.config.starting_snapshot);
  assert.notEqual(cumulativeReport.cohort, frontierReport.cohort);

  const external = call("external-prepared", ["prepare", "--track", "frontier", "--mode", "fresh", "--set", "rehearsal", "--provider", "external", "--model", "external-rehearsal", "--run-root", runRoot, "--bundle", path.join(bundles, "external")]);
  const handoff = call("external-handoff", ["handoff", "--run", external.run]);
  assert.ok(handoff.mcp_server.args.includes("bridge"));
  fs.copyFileSync(path.join(bundles, "fresh/proofs/r1.json"), path.join(bundles, "external/proofs/r1.json"));
  const externalReport = call("external-report", ["submit", "--run", external.run, "--proofs", path.join(bundles, "external/proofs")]);
  assert.equal(externalReport.evaluation_status, "external-unmetered");
  assert.equal(externalReport.generations, null);
  assert.equal(externalReport.score, 0.5);
  const groups = call("comparison", ["compare", "--root", runRoot]);
  assert.equal(groups.length, 3);
  assert.equal(groups.flatMap(group => group.runs).length, 3);
  const result = { status: "passed", output, runs: { unaided: unaided.run, frontier: frontier.run, cumulative: cumulative.run, external: external.run }, runtime: frontierReport.runtime, paid_generations: 0 };
  saved("result.json", result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  saved("failure.json", { error: String(error), output });
  console.error(`Rehearsal failed; retained evidence: ${output}`);
  throw error;
}
