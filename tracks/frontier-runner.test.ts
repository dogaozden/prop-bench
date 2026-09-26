import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { PROJECT_ROOT, readJson } from "./core";
import { prepareFrontier, submitFrontier } from "./frontier";
import { runFrontier } from "./frontier-runner";
import { SandboxInputError } from "./sandbox";
import type { PrepareOptions, RunContext } from "./types";

const SET_DIR = path.join(PROJECT_ROOT, "golf", "set", "rehearsal");

test("invalid sandbox command paths remain ranked contestant failures", async () => {
  const { base, ctx } = makeRun();
  try {
    const report = await runFrontier(ctx, {
      validator: path.join(PROJECT_ROOT, "target/release/propbench"),
      fixtureResponses: [envelope(null, [call("bad-path", "exec", { command: ["/outside/program"] })])],
      execute: async () => { throw new SandboxInputError("Command is outside permitted roots"); },
    });
    assert.equal(report.evaluation_status, "complete");
    assert.equal(report.generations, 1);
    assert.equal(report.score, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

function makeRun(options: {
  provider?: "fixture" | "openrouter";
  generations?: number;
  seconds?: number;
  model?: string;
} = {}): {base: string; bundle: string; ctx: RunContext} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-frontier-runner-test-"));
  const bundle = path.join(base, "bundle");
  const config: PrepareOptions = {
    root: path.join(base, "runs"),
    setDir: SET_DIR,
    ids: ["r1"],
    track: "frontier",
    mode: "fresh",
    model: options.model ?? "frontier-fixture",
    provider: options.provider ?? "fixture",
    temperature: 0,
    budget: {
      wall_seconds: options.seconds ?? 30,
      max_generations: options.generations ?? 8,
      max_output_tokens: 256,
      max_thinking_tokens: 32,
    },
    validator: path.join(PROJECT_ROOT, "target/release/propbench"),
  };
  return { base, bundle, ctx: prepareFrontier(config, bundle) };
}

function envelope(content: string | null, toolCalls?: unknown[], usage = true): unknown {
  return {
    model: "returned-fixture-model",
    provider: "fixture-backend",
    choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    ...(usage ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } : {}),
  };
}

function call(id: string, name: string, arguments_: unknown): unknown {
  return { id, type: "function", function: { name, arguments: typeof arguments_ === "string" ? arguments_ : JSON.stringify(arguments_) } };
}

test("delegates share generation accounting, token settings, and the two-tool surface", async () => {
  const { base, ctx } = makeRun({ generations: 4 });
  let executions = 0;
  const secret = "frontier-secret-never-persist";
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = secret;
  try {
    const report = await runFrontier(ctx, {
      validator: path.join(PROJECT_ROOT, "target/release/propbench"),
      fixtureResponses: [
        envelope(null, [call("d1", "delegate", { task: "Inspect the bundle." })]),
        envelope(null, [call("e1", "exec", { command: ["/bin/sh", "-c", `printf '%s' '${secret}'`] })]),
        envelope("child complete"),
        envelope("root complete"),
      ],
      execute: async (_runDir, command) => {
        executions++;
        assert.deepEqual(command.slice(0, 2), ["/bin/sh", "-c"]);
        return { stdout: secret, stderr: "", exitCode: 0 };
      },
    });
    assert.equal(executions, 1);
    assert.equal(report.generations, 4);
    assert.equal(report.usage.total_tokens, 20);
    assert.deepEqual(report.returned_models, ["returned-fixture-model"]);
    assert.deepEqual(report.returned_backends, ["fixture-backend"]);
    assert.deepEqual(report.dispatches, { not_started: 0, dispatched: 0, response_confirmed: 4, uncertain: 0 });
    assert.equal(report.evaluation_status, "complete");
    const controller = readJson<{status: string; generations: number; contexts: number}>(path.join(ctx.dir, "controller.json"));
    assert.deepEqual(controller, { ...controller, status: "complete", generations: 4, contexts: 2 });
    const first = readJson<any>(path.join(ctx.dir, "generations", "000001.json"));
    assert.deepEqual(first.request.body.tools.map((tool: any) => tool.function.name), ["exec", "delegate"]);
    assert.equal(first.request.body.max_tokens, 288);
    assert.deepEqual(first.request.body.reasoning, { max_tokens: 32, exclude: true });
    const records = fs.readdirSync(path.join(ctx.dir, "generations")).map((name) => fs.readFileSync(path.join(ctx.dir, "generations", name), "utf8")).join("\n");
    assert.doesNotMatch(records, /Authorization/i);
    assert.doesNotMatch(records, new RegExp(secret));
    assert.match(records, /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the total generation limit includes child contexts and ends as a measured budget completion", async () => {
  const { base, ctx } = makeRun({ generations: 2 });
  try {
    const report = await runFrontier(ctx, {
      validator: path.join(PROJECT_ROOT, "target/release/propbench"),
      fixtureResponses: [
        envelope(null, [call("d1", "delegate", { task: "Return once." })]),
        envelope("child complete"),
        envelope("must not be consumed"),
      ],
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    assert.equal(report.generations, 2);
    assert.equal(report.evaluation_status, "complete");
    const controller = readJson<{status: string; generations: number; finished_reason: string}>(path.join(ctx.dir, "controller.json"));
    assert.equal(controller.status, "complete");
    assert.equal(controller.generations, 2);
    assert.equal(controller.finished_reason, "generation_budget_exhausted");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("unadvertised and malformed tool calls stop that context without dispatch or retry", async (t) => {
  for (const [name, first] of [
    ["unadvertised", envelope(null, [call("x1", "read_host_file", { path: "/etc/passwd" })])],
    ["malformed", envelope(null, [call("x1", "exec", "{not json")])],
  ] as const) {
    await t.test(name, async () => {
      const { base, ctx } = makeRun();
      let dispatched = 0;
      try {
        const report = await runFrontier(ctx, {
          validator: path.join(PROJECT_ROOT, "target/release/propbench"),
          fixtureResponses: [first, envelope("must not be consumed")],
          execute: async () => { dispatched++; return { stdout: "", stderr: "", exitCode: 0 }; },
        });
        assert.equal(dispatched, 0);
        assert.equal(report.generations, 1);
        assert.equal(report.evaluation_status, "complete");
        const controller = readJson<{status: string; error: string}>(path.join(ctx.dir, "controller.json"));
        assert.equal(controller.status, "complete");
        assert.match(controller.error, name === "unadvertised" ? /Unadvertised/ : /not valid JSON/);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
  }
});

test("a transport failure is one uncertain dispatch with no retry and no saved credential", async () => {
  const { base, ctx } = makeRun({ provider: "openrouter", generations: 4, model: "openai/test-model" });
  const previous = process.env.OPENROUTER_API_KEY;
  const secret = "transport-test-api-key";
  process.env.OPENROUTER_API_KEY = secret;
  let calls = 0;
  try {
    const report = await runFrontier(ctx, {
      validator: path.join(PROJECT_ROOT, "target/release/propbench"),
      fetchImpl: (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
        calls++;
        assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
        throw new Error("socket outcome unknown");
      }) as typeof fetch,
    });
    assert.equal(calls, 1);
    assert.equal(report.generations, 1);
    assert.deepEqual(report.dispatches, { not_started: 0, dispatched: 0, response_confirmed: 0, uncertain: 1 });
    assert.equal(report.evaluation_status, "complete");
    const bytes = fs.readFileSync(path.join(ctx.dir, "generations", "000001.json"), "utf8");
    assert.doesNotMatch(bytes, new RegExp(secret));
    assert.doesNotMatch(bytes, /Authorization/i);
    assert.match(bytes, /socket outcome unknown/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the wall clock is shared with execution and prevents a second generation", async () => {
  const { base, ctx } = makeRun({ generations: 3, seconds: 1 });
  try {
    const report = await runFrontier(ctx, {
      validator: path.join(PROJECT_ROOT, "target/release/propbench"),
      fixtureResponses: [
        envelope(null, [call("e1", "exec", { command: ["slow"] })]),
        envelope("must not be consumed"),
      ],
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1050));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(report.generations, 1);
    assert.equal(report.evaluation_status, "complete");
    const controller = readJson<{status: string; finished_reason: string}>(path.join(ctx.dir, "controller.json"));
    assert.equal(controller.status, "complete");
    assert.equal(controller.finished_reason, "wall_budget_exhausted");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("network-enabled model aliases and populated controller records are rejected", async () => {
  for (const model of ["model:online", "model@preset"]) {
    const { base, ctx } = makeRun({ model });
    try {
      await assert.rejects(runFrontier(ctx, { validator: path.join(PROJECT_ROOT, "target/release/propbench"), fixtureResponses: [envelope("done")] }), /forbids/);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  const { base, ctx } = makeRun();
  try {
    fs.mkdirSync(path.join(ctx.dir, "generations"));
    fs.writeFileSync(path.join(ctx.dir, "generations", "000001.json"), "{}\n");
    await assert.rejects(runFrontier(ctx, { validator: path.join(PROJECT_ROOT, "target/release/propbench"), fixtureResponses: [envelope("done")] }), /restart a populated/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("controlled fixture writes a proof and receives an independent Rust referee score", async () => {
  const { base, bundle, ctx } = makeRun({ generations: 2 });
  try {
    const report = await runFrontier(ctx, {
      validator: path.join(PROJECT_ROOT, "target/release/propbench"),
      fixtureResponses: [envelope(null, [call("proof", "exec", { command: ["write-rehearsal-proof"] })]), envelope("done")],
      execute: async () => {
        fs.writeFileSync(path.join(bundle, "proofs/r1.json"), JSON.stringify([{ line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 }]));
        return { stdout: "saved", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(report.valid_count, 1);
    assert.equal(report.items[0].line_count, 1);
    assert.equal(report.score, 0.5);
    assert.equal(report.evidence, "fixture");
    assert.equal(report.generations, 2);
    assert.equal(fs.readdirSync(path.join(ctx.dir, "candidate-receipts/r1")).length, 1);
    assert.equal(readJson(path.join(ctx.dir, "tool-events/000001.json")).result.stdout, "saved");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a completed controlled run is sealed against later owner imports", async () => {
  const { base, bundle, ctx } = makeRun({ generations: 2 });
  const validator = path.join(PROJECT_ROOT, "target/release/propbench");
  try {
    const report = await runFrontier(ctx, {
      validator,
      fixtureResponses: [envelope(null, [call("proof", "exec", { command: ["write-two-line-proof"] })]), envelope("done")],
      execute: async () => {
        fs.writeFileSync(path.join(bundle, "proofs/r1.json"), JSON.stringify([
          { line_number: 3, formula: "P v P", justification: "Add 2", depth: 0 },
          { line_number: 4, formula: "Q", justification: "MP 1,2", depth: 0 },
        ]));
        return { stdout: "saved", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(report.items[0].line_count, 2);
    assert.equal(fs.existsSync(path.join(ctx.dir, "controlled-finalization.json")), true);

    const outside = path.join(base, "outside-candidate");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "r1.json"), JSON.stringify([
      { line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 },
    ]));
    await assert.rejects(submitFrontier(ctx.dir, outside, validator), /sealed.*metered controller/);
    assert.equal(readJson<any>(path.join(ctx.dir, "report.json")).items[0].line_count, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, "submissions/r1.json"), "utf8")).length, 2);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("unknown contestant proof is a sealed ranked failure and preserves methodology", async () => {
  const { base, bundle, ctx } = makeRun({ generations: 2 });
  const validator = path.join(PROJECT_ROOT, "target/release/propbench");
  try {
    const report = await runFrontier(ctx, {
      validator,
      fixtureResponses: [envelope(null, [call("bad-proof", "exec", { command: ["write-unknown-proof"] })]), envelope("done")],
      execute: async () => {
        fs.writeFileSync(path.join(bundle, "proofs/unknown.json"), "[]\n");
        fs.writeFileSync(path.join(bundle, "METHODS.md"), "attempted a method\n");
        return { stdout: "saved", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(report.evaluation_status, "complete");
    assert.equal(report.score, 1);
    const controller = readJson<any>(path.join(ctx.dir, "controller.json"));
    assert.equal(controller.status, "complete");
    assert.equal(controller.finished_reason, "attempt_failed");
    assert.match(controller.error, /Unknown submission item/);
    const marker = readJson<any>(path.join(ctx.dir, "controlled-finalization.json"));
    assert.match(marker.contestant_rejection, /Unknown submission item/);
    assert.equal(marker.submissions.find((entry: any) => entry.name === "unknown.json")?.sha256.length, 64);
    const archiveIds = fs.readdirSync(path.join(ctx.dir, "archives")).sort();
    assert.equal(fs.readFileSync(path.join(ctx.dir, "archives", archiveIds.at(-1)!, "METHODS.md"), "utf8"), "attempted a method\n");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a malformed contestant proofs root is sealed, ranked, and archived without traversal", async () => {
  const { base, bundle, ctx } = makeRun({ generations: 2 });
  const validator = path.join(PROJECT_ROOT, "target/release/propbench");
  try {
    const report = await runFrontier(ctx, {
      validator,
      fixtureResponses: [envelope(null, [call("bad-root", "exec", { command: ["replace-proofs-root"] })]), envelope("done")],
      execute: async () => {
        fs.rmSync(path.join(bundle, "proofs"), { recursive: true });
        fs.writeFileSync(path.join(bundle, "proofs"), "contestant output that is not a directory\n");
        fs.writeFileSync(path.join(bundle, "METHODS.md"), "attempted malformed output\n");
        return { stdout: "saved", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(report.evaluation_status, "complete");
    assert.equal(report.score, 1);
    const controller = readJson<any>(path.join(ctx.dir, "controller.json"));
    assert.equal(controller.status, "complete");
    assert.equal(controller.finished_reason, "attempt_failed");
    assert.match(controller.error, /Proofs directory must be a directory/);
    const marker = readJson<any>(path.join(ctx.dir, "controlled-finalization.json"));
    assert.match(marker.contestant_rejection, /Proofs directory must be a directory/);
    assert.deepEqual(marker.submissions, [{ name: ".", kind: "special" }]);
    const archiveIds = fs.readdirSync(path.join(ctx.dir, "archives")).sort();
    const archive = path.join(ctx.dir, "archives", archiveIds.at(-1)!);
    assert.equal(fs.readFileSync(path.join(archive, "METHODS.md"), "utf8"), "attempted malformed output\n");
    assert.equal(fs.statSync(path.join(archive, "proofs")).isDirectory(), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
