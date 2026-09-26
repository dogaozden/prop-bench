import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import * as readline from "node:readline";
import { test } from "node:test";

import {
  runClaudeSessionWithDependencies,
  observedUsage,
} from "./subscription-claude";
import { createCapabilityBridge, MCP_DELEGATE_TOOL, MCP_EXEC_TOOL } from "./subscription-mcp";
import type { CapabilityBridge } from "./subscription-mcp";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  closed = false;
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => { this.closed = true; this.emit("close", null, "SIGTERM"); });
    return true;
  }
}

interface FakeSpawnOptions {
  initTools?: string[];
  auth?: Record<string, unknown>;
  hangSession?: boolean;
  closeDelayMs?: number;
}

function fakeSpawnFactory(records: string[][], settings: FakeSpawnOptions = {}, children: FakeChild[] = []): (executable: string, args: readonly string[], options: unknown) => FakeChild {
  return (_executable, args) => {
    const child = new FakeChild();
    children.push(child);
    records.push([...args]);
    queueMicrotask(() => {
      if (args[0] === "auth") {
        child.stdout.end(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "test@example.com", ...settings.auth }) + "\n");
      } else {
        if (settings.hangSession) return;
        const event = {
          type: "system", subtype: "init", cwd: "__TEST_CWD__", session_id: "session-test",
          tools: settings.initTools ?? [], mcp_servers: (settings.initTools ?? []).length ? [{ name: "propbench", status: "connected" }] : [],
          model: "claude-fable-5-1", permissionMode: "dontAsk", claude_code_version: "2.1.263",
          skills: [], plugins: [], slash_commands: [], apiKeySource: "none",
        };
        if (child.killed) return;
        child.stdout.write(JSON.stringify(event) + "\n");
        if (child.killed) return;
        child.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "READY" }], usage: { input_tokens: 2, output_tokens: 1 } } }) + "\n");
        if (child.killed) return;
        child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "session-test", result: "READY", usage: { input_tokens: 2, output_tokens: 3, total_cost_usd: 123 } }) + "\n");
      }
      setTimeout(() => child.emit("close", 0, null), settings.closeDelayMs ?? 0);
    });
    return child;
  };
}

function cwdSpawn(root: string, spawn: ReturnType<typeof fakeSpawnFactory>) {
  return (executable: string, args: readonly string[], spawnOptions: any): FakeChild => {
    const child = spawn(executable, args, spawnOptions);
    const originalWrite = child.stdout.write.bind(child.stdout);
    child.stdout.write = ((chunk: any, ...rest: any[]) => originalWrite(String(chunk).replaceAll("__TEST_CWD__", root), ...rest)) as typeof child.stdout.write;
    return child;
  };
}

function options(root: string, tools?: { exec(command: string[]): Promise<unknown>; delegate(task: string): Promise<unknown> }) {
  return {
    model: "fable",
    effort: "max",
    systemPrompt: "Reply exactly READY.",
    prompt: "reply exactly READY",
    cwd: root,
    timeoutMs: 10_000,
    eventsPath: path.join(path.dirname(root), `${path.basename(root)}-events.ndjson`),
    ...(tools ? { tools } : {}),
  };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(root), `${path.basename(root)}-events.ndjson`), { force: true });
}

test("Claude unaided session uses safe empty-tool mode and omits estimated cost", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-claude-test-"));
  const records: string[][] = [];
  try {
    const spawn = fakeSpawnFactory(records);
    const result = await runClaudeSessionWithDependencies(options(root), { executable: process.execPath, spawn: cwdSpawn(root, spawn) as any });
    assert.equal(result.text, "READY");
    assert.equal(result.model, "claude-fable-5-1");
    assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
    assert.deepEqual(result.available_tools, []);
    assert.ok(records.some((args) => args.includes("--safe-mode")));
    assert.ok(records.some((args) => args.includes("--tools") && args[args.indexOf("--tools") + 1] === ""));
    assert.ok(records.every((args) => !args.includes("--bare")));
    const events = fs.readFileSync(path.join(path.dirname(root), `${path.basename(root)}-events.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "adapter_complete"));
  } finally {
    cleanup(root);
  }
});

test("Claude Frontier enables only the explicit namespaced MCP tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-claude-test-"));
  const records: string[][] = [];
  try {
    const spawn = fakeSpawnFactory(records, { initTools: [MCP_EXEC_TOOL, MCP_DELEGATE_TOOL] });
    const tools = { exec: async () => ({ ok: true }), delegate: async () => ({ final: "done" }) };
    let result: Awaited<ReturnType<typeof runClaudeSessionWithDependencies>>;
    try {
      result = await runClaudeSessionWithDependencies(options(root, tools), { executable: process.execPath, spawn: cwdSpawn(root, spawn) as any });
    } catch (error) {
      // The managed test sandbox may disallow loopback listeners; the live
      // acceptance harness runs this path in the parent process.
      if (/listen EPERM/.test(String(error))) return;
      throw error;
    }
    assert.deepEqual(result.available_tools, [MCP_EXEC_TOOL, MCP_DELEGATE_TOOL]);
    assert.deepEqual(result.tool_calls, []);
    const launch = records.find((args) => args.includes("--restricted"));
    assert.ok(launch);
    assert.ok(launch.includes("--strict-mcp-config"));
    assert.ok(launch.includes("--allowedTools"));
    const allowed = launch.slice(launch.indexOf("--allowedTools") + 1, launch.indexOf("--strict-mcp-config"));
    assert.deepEqual(allowed, [MCP_EXEC_TOOL, MCP_DELEGATE_TOOL]);
    assert.equal(launch[launch.indexOf("--tools") + 1], "");
  } finally {
    cleanup(root);
  }
});

test("observedUsage excludes SDK cost estimates", () => {
  assert.deepEqual(observedUsage({ input_tokens: 4, output_tokens: 5, total_cost_usd: 99, output_tokens_details: { thinking_tokens: 3 } }), {
    input_tokens: 4, output_tokens: 5, thinking_tokens: 3,
  });
  assert.deepEqual(observedUsage({input_tokens:2,cache_creation_input_tokens:100,cache_read_input_tokens:50,output_tokens:3}),{input_tokens:152,output_tokens:3});
});

test("Claude rejects API-key authentication before starting inference", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-claude-test-"));
  const records: string[][] = [];
  try {
    const spawn = fakeSpawnFactory(records, { auth: { authMethod: "api_key" } });
    await assert.rejects(
      runClaudeSessionWithDependencies(options(root), { executable: process.execPath, spawn: cwdSpawn(root, spawn) as any }),
      /claude\.ai authentication/,
    );
    assert.equal(records.length, 1, "auth rejection must precede the inference launch");
    assert.match(fs.readFileSync(path.join(path.dirname(root), `${path.basename(root)}-events.ndjson`), "utf8"), /\"status\":\"auth\"/);
  } finally {
    cleanup(root);
  }
});

test("Claude rejects an unexpected Unaided tool catalog", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-claude-test-"));
  const records: string[][] = [];
  try {
    const spawn = fakeSpawnFactory(records, { initTools: ["Read"] });
    await assert.rejects(
      runClaudeSessionWithDependencies(options(root), { executable: process.execPath, spawn: cwdSpawn(root, spawn) as any }),
      /Unaided Claude session exposed a tool/,
    );
    assert.equal(records.length, 2);
  } finally {
    cleanup(root);
  }
});

test("Claude timeout waits for the native child to close", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-claude-test-"));
  const records: string[][] = [];
  const children: FakeChild[] = [];
  try {
    const spawn = fakeSpawnFactory(records, { hangSession: true }, children);
    await assert.rejects(
      runClaudeSessionWithDependencies({ ...options(root), timeoutMs: 30 }, { executable: process.execPath, spawn: cwdSpawn(root, spawn) as any }),
      /wall-clock timeout/,
    );
    assert.equal(children.length, 2);
    assert.equal(children[1].closed, true, "adapter must await close after termination");
  } finally {
    cleanup(root);
  }
});

test("capability bridge authenticates and validates only exec/delegate", async () => {
  const calls: string[] = [];
  let bridge: CapabilityBridge;
  try {
    bridge = await createCapabilityBridge({
      exec: async (command) => { calls.push(`exec:${command.join(" ")}`); return { stdout: "ok", secret: "sk-abcdefghijklmnopqrstuvwxyz" }; },
      delegate: async (task) => { calls.push(`delegate:${task}`); return { final: "done" }; },
    });
  } catch (error) {
    // The managed test sandbox disallows loopback listeners.  The same test
    // runs with the listener in the parent process's live acceptance harness.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
  try {
    const request = (body: unknown, token = bridge.token): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const target = new URL(bridge.endpoint);
      const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end(payload);
    });
    const execResult = await request({ method: "exec", arguments: { command: ["echo", "hello"] } });
    assert.equal(execResult.status, 200);
    assert.equal(execResult.body.ok, true);
    assert.equal(execResult.body.result.secret, "[REDACTED]");
    const delegateResult = await request({ method: "delegate", arguments: { task: "review" } });
    assert.equal(delegateResult.body.ok, true);
    assert.deepEqual(bridge.toolCalls, [MCP_EXEC_TOOL, MCP_DELEGATE_TOOL]);
    assert.deepEqual(calls, ["exec:echo hello", "delegate:review"]);
    const denied = await request({ method: "exec", arguments: { command: ["pwd"] } }, "wrong-token");
    assert.equal(denied.status, 404);
  } finally {
    await bridge.close();
  }
});

test("subscription MCP child handles standard metadata over real stdio", async () => {
  const token = "subprocess-test-token";
  const requests: any[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body);
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, result: { stdout: "READY" } }));
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: String(error) }));
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      if (server.listening) server.close();
      return;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = childProcess.spawn(process.execPath, ["--require", require.resolve("ts-node/register"), path.join(__dirname, "subscription-mcp.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CODEX_HOME: process.env.CODEX_HOME ?? "",
      PROPBENCH_SUBSCRIPTION_BRIDGE_URL: `http://127.0.0.1:${address.port}/call`,
      PROPBENCH_SUBSCRIPTION_BRIDGE_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = readline.createInterface({ input: child.stdout });
  const responseFor = (id: number): Promise<any> => new Promise((resolve, reject) => {
    const onLine = (line: string): void => {
      try {
        const value = JSON.parse(line);
        if (value.id === id) { cleanup(); resolve(value); }
      } catch (error) { cleanup(); reject(error); }
    };
    const onClose = (): void => { cleanup(); reject(new Error("MCP child closed before responding")); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      output.off("line", onLine);
      output.off("close", onClose);
      child.off("error", onError);
    };
    output.on("line", onLine);
    output.once("close", onClose);
    child.once("error", onError);
  });
  const send = async (request: unknown, id: number): Promise<any> => {
    child.stdin.write(JSON.stringify(request) + "\n");
    return responseFor(id);
  };
  try {
    const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" }, _meta: { progressToken: "init" },
    } }, 1);
    assert.equal(initialized.result.serverInfo.name, "propbench");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { progressToken: "list" } } }, 2);
    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ["exec", "delegate"]);
    const called = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "exec", arguments: { command: ["echo", "READY"] }, _meta: { progressToken: "call" },
    } }, 3);
    assert.equal(called.result.isError, false);
    assert.deepEqual(JSON.parse(called.result.content[0].text), { stdout: "READY" });
    assert.deepEqual(requests, [{ method: "exec", arguments: { command: ["echo", "READY"] } }]);
    const rejected = await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "exec", arguments: { command: ["echo", "READY"], unexpected: true }, _meta: { progressToken: "bad" },
    } }, 4);
    assert.match(rejected.error.message, /Invalid exec arguments/);
    assert.equal(requests.length, 1, "invalid tool arguments must not reach the callback bridge");
  } finally {
    output.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
