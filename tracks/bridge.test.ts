import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PROJECT_ROOT, prepareRun, writeJson } from "./core";
import { prepareFrontier } from "./frontier";
import { executeForRun } from "./bridge";
import * as sandbox from "./sandbox";
import type { PrepareOptions } from "./types";

const validator = path.join(PROJECT_ROOT, "target/release/propbench");
function options(root: string, frontier = false): PrepareOptions {
  return { root, setDir: path.join(PROJECT_ROOT, "golf/set/rehearsal"), track: frontier ? "frontier" : "unaided", mode: frontier ? "fresh" : "unaided", provider: frontier ? "external" : "fixture", model: "fixture", temperature: 0,
    budget: { wall_seconds: 30, max_generations: 2, max_output_tokens: 256, max_thinking_tokens: 0 }, validator };
}

test("Unaided cannot acquire a bridge execution capability", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-bridge-test-"));
  try {
    const ctx = prepareRun(options(root));
    await assert.rejects(executeForRun(ctx.dir, ["/bin/sh", "-c", "exit 0"]), /never expose execution/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Frontier MCP exposes only the confined exec tool and rejects unknown tool calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-bridge-test-"));
  try {
    const ctx = prepareFrontier(options(path.join(root, "owner"), true), path.join(root, "contestant"));
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "host_shell", arguments: { command: ["/bin/sh"] } } },
    ];
    const lines = await new Promise<string>((resolve, reject) => {
      // Type checking is a separate acceptance gate. Avoid repeating the
      // complete TypeScript compiler startup inside this protocol deadline.
      const child = spawn(process.execPath, ["--require", path.join(PROJECT_ROOT, "node_modules/ts-node/register/transpile-only"), path.join(PROJECT_ROOT, "tracks/cli.ts"), "bridge", "--run", ctx.dir], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP handshake timed out")); }, 15000);
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr)); });
      child.stdin.end(messages.map(m => JSON.stringify(m)).join("\n") + "\n");
    });
    const replies = lines.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(replies[0].result.capabilities, { tools: {} });
    assert.deepEqual(replies[1].result.tools.map((tool: { name: string }) => tool.name), ["exec"]);
    assert.match(replies[2].error.message, /Unknown tool/);
    assert.equal(fs.existsSync(path.join(ctx.dir, "execution.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Frontier's owner clock cannot be reset by a fresh bridge process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-bridge-test-"));
  try {
    const ctx = prepareFrontier(options(path.join(root, "owner"), true), path.join(root, "contestant"));
    writeJson(path.join(ctx.dir, "execution.json"), { started_at: "2000-01-01T00:00:00Z", commands: 0 });
    await assert.rejects(executeForRun(ctx.dir, ["/bin/sh", "-c", "exit 0"]), /budget exhausted/);
    assert.equal(fs.existsSync(path.join(ctx.dir, "execution.lock")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("subscription v2 bridge requires its controller and invokes capture before releasing the execution lock", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-bridge-test-"));
  try {
    const ctx = prepareFrontier({ ...options(path.join(root, "owner"), true), provider: "codex-subscription", subscription: { effort: "xhigh", max_tool_calls: 10 } }, path.join(root, "contestant"));
    writeJson(path.join(ctx.dir, "controller.json"), { status: "running", started_at: new Date().toISOString() });
    await assert.rejects(executeForRun(ctx.dir, ["true"]), /controller capability/);
    const runtime = { backend: "docker" as const, image_id: "sha256:" + "a".repeat(64), architecture: "arm64" };
    writeJson(path.join(ctx.dir, "runtime.json"), runtime);
    const deadline = performance.now() + 5000;
    const cancellation = new AbortController();
    let callback = false;
    t.mock.method(sandbox, "runSandbox", async (_bundle: string, _command: string[], settings: sandbox.SandboxRunOptions) => {
      assert.equal(settings.deadline, deadline);
      assert.equal(settings.signal, cancellation.signal);
      return { stdout: "", stderr: "", exitCode: 0, runtime };
    });
    await executeForRun(ctx.dir, ["true"], { deadline, signal: cancellation.signal, afterExecution: async number => {
      callback = true;
      assert.equal(number, 1);
      assert.ok(fs.existsSync(path.join(ctx.dir, "execution.lock")));
      assert.ok(JSON.parse(fs.readFileSync(path.join(ctx.dir, "exec-000001.json"), "utf8")).completed_at);
    } });
    assert.equal(callback, true);
    assert.equal(fs.existsSync(path.join(ctx.dir, "execution.lock")), false);
    writeJson(path.join(ctx.dir, "controller.json"), { status: "complete" });
    await assert.rejects(executeForRun(ctx.dir, ["true"], { deadline, signal: cancellation.signal, afterExecution: async () => {} }), /active budget controller/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
