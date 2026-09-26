import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { performance } from "node:perf_hooks";

import { PROJECT_ROOT } from "./core";
import {
  prepareFrontier,
  submitFrontier,
  createControlledFrontierCheckpoints,
  finalizeControlledFrontier,
} from "./frontier";
import { runSandbox, SandboxUnavailableError } from "./sandbox";
import type { PrepareOptions } from "./types";

const SET_DIR = path.join(PROJECT_ROOT, "golf", "set", "rehearsal");
const VALID_PROOF = path.join(PROJECT_ROOT, "golf", "runs", "rehearsal-dry", "proofs", "r1.json");
const TWO_LINE_PROOF = Buffer.from(JSON.stringify([
  { line_number: 3, formula: "P v P", justification: "Add 2", depth: 0 },
  { line_number: 4, formula: "Q", justification: "MP 1,2", depth: 0 },
]) + "\n");

function validatorPath(): string | null {
  for (const candidate of [
    process.env.PROPBENCH_VALIDATOR,
    path.join(PROJECT_ROOT, "target", "release", "propbench"),
    path.join(PROJECT_ROOT, "target", "debug", "propbench"),
  ]) {
    if (!candidate) continue;
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // The TypeScript tests remain useful before the Rust validator is built.
    }
  }
  return null;
}

function options(root: string, validator: string, provider: "fixture" | "external" = "fixture"): PrepareOptions {
  return {
    root,
    setDir: SET_DIR,
    ids: ["r1"],
    track: "frontier",
    mode: "fresh",
    model: provider === "external" ? "external-test-agent" : "frontier-fixture",
    provider,
    temperature: 0,
    budget: {
      wall_seconds: 30,
      max_generations: 1,
      max_output_tokens: 256,
      max_thinking_tokens: 0,
    },
    validator,
  };
}

function walk(root: string): string[] {
  const output: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      output.push(childRelative);
      if (entry.isDirectory()) visit(path.join(current, entry.name), childRelative);
    }
  };
  visit(root, "");
  return output.sort();
}

function makeBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "propbench-frontier-test-"));
}

test("fresh Frontier export contains only selected public state", () => {
  const base = makeBase();
  try {
    const validator = validatorPath() ?? "/bin/sh";
    const bundle = path.join(base, "bundle");
    const ctx = prepareFrontier(options(path.join(base, "owner-runs"), validator), bundle);
    const names = walk(bundle);
    assert.ok(names.includes("set/manifest.json"));
    assert.ok(names.includes("set/r1.json"));
    assert.ok(names.includes("rules.md"));
    assert.ok(names.includes("GOAL.md"));
    assert.ok(names.includes("validator"));
    assert.ok((fs.statSync(path.join(bundle, "validator")).mode & 0o111) !== 0);
    const goal = fs.readFileSync(path.join(bundle, "GOAL.md"), "utf8");
    assert.match(goal, /L\/\(L\+par\)/);
    assert.match(goal, /Premise lines are free/);
    assert.match(goal, /par is an achievable reference target, not a minimum/);
    assert.match(goal, /rules\.md is the authoritative rulebook/);
    assert.match(goal, /Scripts, solvers, and subagents may be used only through/);
    assert.match(goal, /\.\/validator validate --strict-protocol --theorem/);
    assert.ok(names.includes("proofs/.gitkeep"));
    assert.ok(names.includes("tools/.gitkeep"));
    for (const journal of ["METHODS.md", "LOG.md", "DEBRIEF.md"]) {
      assert.equal(fs.statSync(path.join(bundle, journal)).size, 0);
    }
    assert.ok(!names.some(name => name === ".git" || name.startsWith(".git/")));
    assert.ok(!names.includes("run.json"));
    assert.ok(!names.includes("submissions"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dir, "frontier.json"), "utf8")), {
      bundle_dir: path.resolve(bundle),
      starting_snapshot: null,
      validator_path: path.join(ctx.dir, "referee", "validator"),
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Frontier cumulative export preserves the explicit snapshot bytes and modes", () => {
  const base = makeBase();
  try {
    const validator = validatorPath() ?? "/bin/sh";
    const first = path.join(base, "first");
    prepareFrontier(options(path.join(base, "owner-one"), validator), first);
    fs.writeFileSync(path.join(first, "proofs", "r1.json"), "[\n  {\"line_number\":3}\n]\n");
    fs.chmodSync(path.join(first, "proofs", "r1.json"), 0o640);
    fs.mkdirSync(path.join(first, "tools", "nested"));
    fs.writeFileSync(path.join(first, "tools", "nested", "solver.sh"), "#!/bin/sh\necho ok\n");
    fs.chmodSync(path.join(first, "tools", "nested", "solver.sh"), 0o751);
    fs.writeFileSync(path.join(first, "METHODS.md"), "methodology\n");
    fs.chmodSync(path.join(first, "METHODS.md"), 0o600);

    const second = path.join(base, "second");
    const ctx = prepareFrontier({ ...options(path.join(base, "owner-two"), validator), mode: "cumulative" }, second, first);
    assert.equal(ctx.config.starting_snapshot, JSON.parse(fs.readFileSync(path.join(ctx.dir, "frontier.json"), "utf8")).starting_snapshot);
    for (const relative of ["proofs/r1.json", "tools/nested/solver.sh", "METHODS.md"]) {
      assert.deepEqual(
        fs.readFileSync(path.join(second, relative)),
        fs.readFileSync(path.join(first, relative)),
        relative,
      );
      assert.equal(
        fs.statSync(path.join(second, relative)).mode & 0o7777,
        fs.statSync(path.join(first, relative)).mode & 0o7777,
        relative,
      );
    }
    const snapshot = JSON.parse(fs.readFileSync(path.join(second, "SNAPSHOT.json"), "utf8"));
    assert.equal(snapshot.digest, ctx.config.starting_snapshot);
    assert.ok(snapshot.entries.some((entry: { path: string }) => entry.path === "tools/nested/solver.sh"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Frontier rejects bundle overlap, snapshot symlinks, and unknown submissions", async (t) => {
  const base = makeBase();
  try {
    const validator = validatorPath() ?? "/bin/sh";
    assert.throws(
      () => prepareFrontier(options(path.join(base, "owner-runs"), validator), path.join(base, "owner-runs", "inside")),
      /disjoint/,
    );
    assert.throws(
      () => prepareFrontier(options(path.join(base, "owner-runs-2"), validator), path.join(PROJECT_ROOT, "tracks", "fixtures", "frontier", "inside")),
      /disjoint/,
    );

    const unsafe = path.join(base, "unsafe");
    for (const directory of ["proofs", "tools"]) fs.mkdirSync(path.join(unsafe, directory), { recursive: true });
    for (const file of ["METHODS.md", "LOG.md", "DEBRIEF.md"]) fs.writeFileSync(path.join(unsafe, file), "");
    fs.writeFileSync(path.join(base, "answer-key"), "private");
    fs.symlinkSync(path.join(base, "answer-key"), path.join(unsafe, "proofs", "leak"));
    assert.throws(
      () => prepareFrontier({ ...options(path.join(base, "owner-runs-3"), validator), mode: "cumulative" }, path.join(base, "unsafe-out"), unsafe),
      /Symlink/,
    );

    const validatorBinary = validatorPath();
    if (!validatorBinary) {
      t.skip("Rust validator unavailable; unknown submission gate was not run.");
      return;
    }
    const bundle = path.join(base, "submit-bundle");
    const ctx = prepareFrontier(options(path.join(base, "owner-runs-4"), validatorBinary, "external"), bundle);
    fs.writeFileSync(path.join(bundle, "proofs", "unknown.json"), "[]");
    await assert.rejects(() => submitFrontier(ctx.dir, path.join(bundle, "proofs"), validatorBinary), /Unknown submission/);
    assert.ok(!fs.existsSync(path.join(ctx.dir, "submissions", "unknown.json")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Frontier submission is copied into owner records and independently graded", async (t) => {
  const validator = validatorPath();
  if (!validator) {
    t.skip("Rust validator unavailable; owner-side grading gate was not run.");
    return;
  }
  const base = makeBase();
  try {
    const bundle = path.join(base, "bundle");
    const ctx = prepareFrontier(options(path.join(base, "owner-runs"), validator, "external"), bundle);
    fs.copyFileSync(VALID_PROOF, path.join(bundle, "proofs", "r1.json"));
    const report = await submitFrontier(ctx.dir, path.join(bundle, "proofs"), validator);
    assert.equal(report.evidence, "external-submission");
    assert.equal(report.valid_count, 1);
    assert.equal(report.items[0].status, "valid");
    assert.ok(fs.existsSync(path.join(ctx.dir, "submissions", "r1.json")));
    assert.ok(!fs.existsSync(path.join(ctx.dir, "submissions", "run.json")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Frontier imports are monotonic, locked, and durably receipted", async (t) => {
  const validator = validatorPath();
  if (!validator) {
    t.skip("Rust validator unavailable; monotonic import gate was not run.");
    return;
  }
  const base = makeBase();
  try {
    const bundle = path.join(base, "bundle");
    const ctx = prepareFrontier(options(path.join(base, "owner-runs"), validator, "external"), bundle);
    const candidate = path.join(base, "candidate");
    fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(candidate, "r1.json"), TWO_LINE_PROOF);
    const first = await submitFrontier(ctx.dir, candidate, validator);
    assert.equal(first.items[0]?.status, "valid");
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions", "r1.json")), TWO_LINE_PROOF);

    fs.writeFileSync(path.join(candidate, "r1.json"), fs.readFileSync(VALID_PROOF));
    const improved = await submitFrontier(ctx.dir, candidate, validator);
    assert.equal(improved.items[0]?.line_count, 1);
    const oneLine = fs.readFileSync(path.join(ctx.dir, "submissions", "r1.json"));

    fs.writeFileSync(path.join(candidate, "r1.json"), TWO_LINE_PROOF);
    const regressive = await submitFrontier(ctx.dir, candidate, validator);
    assert.equal(regressive.items[0]?.line_count, 1);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions", "r1.json")), oneLine);

    fs.writeFileSync(path.join(candidate, "r1.json"), "[]\n");
    const invalid = await submitFrontier(ctx.dir, candidate, validator);
    assert.equal(invalid.items[0]?.line_count, 1);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions", "r1.json")), oneLine);

    fs.writeFileSync(path.join(ctx.dir, "execution.lock"), "active\n");
    await assert.rejects(() => submitFrontier(ctx.dir, candidate, validator), /execution\.lock/);
    fs.unlinkSync(path.join(ctx.dir, "execution.lock"));

    const receiptRoot = path.join(ctx.dir, "candidate-receipts", "r1");
    const receipts = fs.readdirSync(receiptRoot).sort();
    assert.equal(receipts.length, 4);
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptRoot, receipts[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(receipt.schema_version, "propbench-frontier-candidate-v1");
    assert.equal(typeof receipt.proof_sha256, "string");
    assert.equal(typeof receipt.proof_bytes_base64, "string");
    assert.ok(fs.readdirSync(path.join(ctx.dir, "archives")).length >= 5);

    const pending = submitFrontier(ctx.dir, candidate, validator);
    await assert.rejects(submitFrontier(ctx.dir, candidate, validator), /execution\.lock/);
    await pending;
    assert.equal(fs.existsSync(path.join(ctx.dir, "execution.lock")), false);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions", "r1.json")), oneLine);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("cumulative Frontier initializes only owner-validated inherited proofs", async (t) => {
  const validator = validatorPath();
  if (!validator) {
    t.skip("Rust validator unavailable; inherited baseline gate was not run.");
    return;
  }
  const base = makeBase();
  try {
    const first = path.join(base, "first");
    prepareFrontier(options(path.join(base, "owner-one"), validator, "external"), first);
    fs.copyFileSync(VALID_PROOF, path.join(first, "proofs", "r1.json"));
    const second = path.join(base, "second");
    const ctx = prepareFrontier({ ...options(path.join(base, "owner-two"), validator, "external"), mode: "cumulative" }, second, first);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions", "r1.json")), fs.readFileSync(VALID_PROOF));
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, "frontier.json"), "utf8")).validator_path,
      path.join(ctx.dir, "referee", "validator"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function checkpointRun(base: string, validator: string, snapshot?: string) {
  const bundle = path.join(base, "contestant-parent", "bundle");
  const ctx = prepareFrontier({ ...options(path.join(base, "owner"), validator), provider: "codex-subscription",
    subscription: { effort: "xhigh", max_tool_calls: 20 }, mode: snapshot ? "cumulative" : "fresh" }, bundle, snapshot);
  const activate = () => {
    fs.writeFileSync(path.join(ctx.dir, "subscription.lock"), "");
    fs.writeFileSync(path.join(ctx.dir, "controller.json"), JSON.stringify({ status: "running" }));
    return createControlledFrontierCheckpoints(ctx, validator, performance.now() + 30000);
  };
  return { ctx, bundle, activate };
}

async function checkpointExecution(ctx: { dir: string }, number: number, capture: (number: number) => Promise<void>) {
  const lock = path.join(ctx.dir, "execution.lock");
  fs.writeFileSync(lock, "", { flag: "wx" });
  try {
    fs.writeFileSync(path.join(ctx.dir, "execution.json"), JSON.stringify({ commands: number }));
    fs.writeFileSync(path.join(ctx.dir, `exec-${String(number).padStart(6, "0")}.json`), JSON.stringify({ completed_at: new Date().toISOString() }));
    await capture(number);
  } finally { fs.unlinkSync(lock); }
}

test("subscription checkpoints retain the shortest proof and freeze submitted bytes before finalization", async () => {
  const validator = validatorPath()!;
  const base = makeBase();
  try {
    const { ctx, bundle, activate } = checkpointRun(base, validator);
    const checkpoints = activate();
    const file = path.join(bundle, "proofs/r1.json");
    const shortest = fs.readFileSync(VALID_PROOF);
    fs.writeFileSync(path.join(bundle, "METHODS.md"), "timely method\n");
    fs.writeFileSync(path.join(bundle, "tools/solver.py"), "# timely solver\n");
    for (const [index, bytes] of [TWO_LINE_PROOF, shortest, TWO_LINE_PROOF, Buffer.from("[]\n")].entries()) {
      fs.writeFileSync(file, bytes);
      await checkpointExecution(ctx, index + 1, checkpoints.afterExecution);
    }
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions/r1.json")), shortest);
    const receipts = fs.readdirSync(path.join(ctx.dir, "candidate-receipts/r1")).sort().map(name => JSON.parse(fs.readFileSync(path.join(ctx.dir, "candidate-receipts/r1", name), "utf8")));
    assert.deepEqual(receipts.map(receipt => receipt.accepted), [true, true, false, false]);
    assert.deepEqual(receipts.map(receipt => receipt.verdict.status), ["valid", "valid", "valid", "invalid"]);
    assert.deepEqual(Buffer.from(receipts[1].proof_bytes_base64, "base64"), shortest);
    assert.equal(receipts[1].checkpoint.execution_command, 2);
    fs.unlinkSync(file);
    await checkpointExecution(ctx, 5, checkpoints.afterExecution);
    checkpoints.close();
    fs.writeFileSync(file, "post-cutoff host mutation");
    fs.writeFileSync(path.join(bundle, "METHODS.md"), "late method\n");
    fs.writeFileSync(path.join(bundle, "tools/solver.py"), "# late solver\n");
    fs.writeFileSync(path.join(ctx.dir, "controller.json"), JSON.stringify({ status: "complete" }));
    const { report } = await finalizeControlledFrontier(ctx.dir, path.dirname(file), validator);
    assert.equal(report.items[0].line_count, 1);
    const archive = path.join(ctx.dir, "archives", fs.readdirSync(path.join(ctx.dir, "archives")).sort().at(-1)!);
    assert.equal(fs.readFileSync(path.join(archive, "METHODS.md"), "utf8"), "timely method\n");
    assert.equal(fs.readFileSync(path.join(archive, "tools/solver.py"), "utf8"), "# timely solver\n");
    const checkpoint = JSON.parse(fs.readFileSync(path.join(ctx.dir, "checkpoints/000001.json"), "utf8"));
    assert.ok(checkpoint.capture_remaining_ms > 0);
    assert.equal(Math.round(checkpoint.capture_remaining_ms + checkpoint.capture_elapsed_ms), 30000);
    await assert.rejects(submitFrontier(ctx.dir, path.dirname(file), validator), /sealed/);
    await assert.rejects(finalizeControlledFrontier(ctx.dir, path.dirname(file), validator), /already been finalized/);
    await assert.rejects(checkpointExecution(ctx, 6, checkpoints.afterExecution), /closed/);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions/r1.json")), shortest);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("checkpoints require an active controller, completed locked execution, and an unexpired cutoff", async () => {
  const base = makeBase();
  try {
    const { ctx, bundle, activate } = checkpointRun(base, validatorPath()!);
    assert.throws(() => createControlledFrontierCheckpoints(ctx, validatorPath()!, performance.now() + 10000), /ENOENT/);
    const checkpoints = activate();
    await assert.rejects(checkpoints.afterExecution(1), /execution.lock/);
    fs.writeFileSync(path.join(ctx.dir, "controller.json"), JSON.stringify({ status: "complete" }));
    await assert.rejects(checkpointExecution(ctx, 1, checkpoints.afterExecution), /active subscription controller/);
    fs.writeFileSync(path.join(ctx.dir, "controller.json"), JSON.stringify({ status: "running" }));
    checkpoints.close();

    const lateBase = path.join(base, "late");
    fs.mkdirSync(lateBase);
    const late = checkpointRun(lateBase, validatorPath()!);
    fs.writeFileSync(path.join(late.ctx.dir, "subscription.lock"), "");
    fs.writeFileSync(path.join(late.ctx.dir, "controller.json"), JSON.stringify({ status: "running" }));
    const cutoff = createControlledFrontierCheckpoints(late.ctx, validatorPath()!, performance.now() + 20);
    await new Promise(resolve => setTimeout(resolve, 30));
    fs.copyFileSync(VALID_PROOF, path.join(late.bundle, "proofs/r1.json"));
    await checkpointExecution(late.ctx, 1, cutoff.afterExecution);
    assert.deepEqual(fs.readdirSync(path.join(late.ctx.dir, "checkpoints")), []);
    assert.equal(fs.existsSync(path.join(late.ctx.dir, "submissions/r1.json")), false);
    cutoff.close();
    fs.writeFileSync(path.join(late.ctx.dir, "controller.json"), JSON.stringify({ status: "complete" }));
    const finalized = await finalizeControlledFrontier(late.ctx.dir, path.join(late.bundle, "proofs"), validatorPath()!);
    assert.equal(finalized.report.valid_count, 0);
    assert.equal(fs.existsSync(path.join(ctx.dir, "submissions/r1.json")), false);
    assert.ok(fs.existsSync(bundle));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("checkpoints reject unknown paths, proof links, and changed symlink ancestry", async t => {
  for (const scenario of ["unknown", "symlink", "hardlink", "proofs-link", "ancestor-link"] as const) {
    await t.test(scenario, async () => {
      const base = makeBase();
      try {
        const { ctx, bundle, activate } = checkpointRun(base, validatorPath()!);
        const checkpoints = activate();
        const source = path.join(base, "outside.json");
        fs.copyFileSync(VALID_PROOF, source);
        if (scenario === "unknown") fs.copyFileSync(source, path.join(bundle, "proofs/unknown.json"));
        if (scenario === "symlink") fs.symlinkSync(source, path.join(bundle, "proofs/r1.json"));
        if (scenario === "hardlink") fs.linkSync(source, path.join(bundle, "proofs/r1.json"));
        if (scenario === "proofs-link") {
          fs.rmSync(path.join(bundle, "proofs"), { recursive: true });
          fs.symlinkSync(base, path.join(bundle, "proofs"));
        }
        if (scenario === "ancestor-link") {
          const parent = path.dirname(bundle);
          fs.renameSync(parent, parent + "-moved");
          fs.symlinkSync(parent + "-moved", parent);
        }
        await checkpointExecution(ctx, 1, checkpoints.afterExecution);
        assert.equal(fs.existsSync(path.join(ctx.dir, "submissions/r1.json")), false);
        const checkpoint = JSON.parse(fs.readFileSync(path.join(ctx.dir, "checkpoints/000001.json"), "utf8"));
        assert.match(checkpoint.contestant_rejection, /Unknown submission|Symlink|Hardlink/);
        assert.deepEqual(checkpoint.submissions, []);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
  }
});

test("cumulative checkpoints begin from the independently validated inherited incumbent", async () => {
  const base = makeBase();
  try {
    const validator = validatorPath()!;
    const first = path.join(base, "inherited");
    prepareFrontier(options(path.join(base, "prior-owner"), validator), first);
    fs.copyFileSync(VALID_PROOF, path.join(first, "proofs/r1.json"));
    const { ctx, bundle, activate } = checkpointRun(base, validator, first);
    const checkpoints = activate();
    fs.writeFileSync(path.join(bundle, "proofs/r1.json"), TWO_LINE_PROOF);
    await checkpointExecution(ctx, 1, checkpoints.afterExecution);
    const receipt = JSON.parse(fs.readFileSync(path.join(ctx.dir, "candidate-receipts/r1/000001.json"), "utf8"));
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.incumbent_before.line_count, 1);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dir, "submissions/r1.json")), fs.readFileSync(VALID_PROOF));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("sandbox canary is isolated or reports explicit runtime unavailability", async (t) => {
  const base = makeBase();
  try {
    const bundle = path.join(base, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(base, "answer-key"), "secret");
    fs.writeFileSync(path.join(bundle, "solver.sh"), "#!/bin/sh\nif [ -e ../answer-key ]; then echo leaked; else echo denied; fi\nprintf '%s' \"$PROPbench_SECRET\" > env-result\nprintf ok > marker\n");
    fs.chmodSync(path.join(bundle, "solver.sh"), 0o755);
    try {
      const result = await runSandbox(bundle, ["./solver.sh"], { timeoutSeconds: 5 });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /denied/);
      assert.doesNotMatch(result.stdout, /leaked/);
      assert.equal(fs.readFileSync(path.join(bundle, "marker"), "utf8"), "ok");
      assert.equal(fs.readFileSync(path.join(bundle, "env-result"), "utf8"), "");
    } catch (err) {
      if (err instanceof SandboxUnavailableError) {
        t.skip(`sandbox unavailable: ${err.evidence}`);
        return;
      }
      throw err;
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
