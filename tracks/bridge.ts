import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { loadRun, readJson, writeJsonExclusive, writeJson, sha256, verifyRunIdentity, PROJECT_ROOT } from "./core";
import { runSandbox, inspectRuntime, SandboxRuntime } from "./sandbox";
import { performance } from "node:perf_hooks";

export interface ControlledExecutionOptions {
  /** Monotonic owner deadline, shared with the native subscription session. */
  deadline: number;
  signal: AbortSignal;
  /** Owner-only callback; called after all writers stop, while locked. */
  afterExecution: (executionCommand: number) => Promise<void>;
}

/** This owner-side bridge is the only execution capability exposed to contestants. */
export async function executeForRun(runDir: string, command: string[], controlled?: ControlledExecutionOptions): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const ctx = loadRun(runDir);
  if (ctx.config.track !== "frontier") throw new Error("Unaided runs never expose execution tools");
  if (!Array.isArray(command) || !command.length || command.length > 256 || command.some(s => typeof s !== "string" || s.includes("\0") || s.length > 100000)) throw new Error("Invalid command argument array");
  const info = readJson<{bundle_dir: string; validator_path?: string}>(path.join(ctx.dir, "frontier.json"));
  verifyRunIdentity(ctx, path.join(ctx.dir, "referee/validator"));
  if (["frontier-controller-v1", "frontier-subscription-v1", "frontier-subscription-v2"].includes(ctx.config.execution_protocol)) {
    const controller = readJson<{status: string}>(path.join(ctx.dir, "controller.json"));
    if (controller.status !== "running") throw new Error("Controlled Frontier execution requires an active budget controller");
  }
  if (ctx.config.execution_protocol === "frontier-subscription-v2" && !controlled) throw new Error("Frontier v2 execution requires the subscription controller capability");
  if (controlled && (ctx.config.execution_protocol !== "frontier-subscription-v2" || controlled.signal.aborted || performance.now() >= controlled.deadline)) {
    throw new Error("Frontier wall-clock budget exhausted");
  }
  const lock = path.join(ctx.dir, "execution.lock");
  // Serializes commands from multiple agents. Crashes leave a visible lock for
  // owner inspection; they never silently reset clocks or overlap processes.
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    const sessionFile = path.join(ctx.dir, "execution.json");
    let state: {started_at: string; commands: number};
    if (fs.existsSync(sessionFile)) state = readJson(sessionFile);
    else {
      const controllerFile = path.join(ctx.dir, "controller.json");
      const started_at = fs.existsSync(controllerFile) ? readJson<{started_at: string}>(controllerFile).started_at : new Date().toISOString();
      state = { started_at, commands: 0 }; writeJsonExclusive(sessionFile, state);
    }
    const remaining = ctx.config.budget.wall_seconds - (Date.now() - Date.parse(state.started_at)) / 1000;
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Frontier wall-clock budget exhausted");
    const runtimePath = path.join(ctx.dir, "runtime.json");
    let runtime: SandboxRuntime;
    if (fs.existsSync(runtimePath)) runtime = readJson<SandboxRuntime>(runtimePath);
    else { runtime = await inspectRuntime(); writeJsonExclusive(runtimePath, runtime); fs.chmodSync(runtimePath, 0o400); }
    state.commands++;
    writeJson(sessionFile, state);
    const log = path.join(ctx.dir, "exec-" + String(state.commands).padStart(6, "0") + ".json");
    const began = { command, started_at: new Date().toISOString(), timeout_seconds: Math.max(1, Math.floor(remaining)) };
    writeJsonExclusive(log, began);
    try {
      const result = await runSandbox(info.bundle_dir, command, { timeoutSeconds: began.timeout_seconds, imageId: runtime.image_id,
        ...(controlled ? { deadline: controlled.deadline, signal: controlled.signal } : {}) });
      writeJson(log, { ...began, completed_at: new Date().toISOString(), exit_code: result.exitCode,
        stdout_sha256: sha256(result.stdout), stderr_sha256: sha256(result.stderr), runtime: result.runtime });
      if (controlled) await controlled.afterExecution(state.commands);
      return result;
    } catch (err) {
      writeJson(log, { ...began, completed_at: new Date().toISOString(), error: String(err) });
      throw err;
    }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export async function serveBridge(runDir: string): Promise<void> {
  const ctx = loadRun(runDir);
  if (ctx.config.track !== "frontier") throw new Error("Unaided has no tool server");
  if (ctx.config.execution_protocol !== "external-mcp-v1") throw new Error("Controlled Frontier uses its metered driver; external MCP requires --provider external");
  const stream = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of stream) {
    let request: any;
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("MCP request too large");
      request = JSON.parse(line);
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new Error("Invalid JSON-RPC request");
      if (request.id === undefined) continue;
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "propbench-frontier", version: "1.0.0" } };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: [{ name: "exec", description: "Execute a command in the isolated Frontier workspace. Shell, scripts, solver building, and repeated validation are allowed. Host files, history, secrets, and network are inaccessible. Commands share the run wall-clock budget.",
        inputSchema: { type: "object", properties: { command: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["command"], additionalProperties: false } }] };
      else if (request.method === "tools/call") {
        if (request.params?.name !== "exec" || Object.keys(request.params.arguments ?? {}).some(k => k !== "command")) throw new Error("Unknown tool or arguments");
        try {
          const out = await executeForRun(ctx.dir, request.params.arguments.command);
          result = { content: [{ type: "text", text: JSON.stringify(out) }], isError: out.exitCode !== 0 };
        } catch (err) { result = { content: [{ type: "text", text: String(err) }], isError: true }; }
      } else throw new Error("Unsupported method");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: String(err) } }) + "\n");
    }
  }
}
