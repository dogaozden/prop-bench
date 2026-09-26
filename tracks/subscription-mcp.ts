import * as http from "node:http";
import * as readline from "node:readline";
import { randomBytes } from "node:crypto";

/**
 * The loopback bridge is deliberately small.  Claude Code starts this file as
 * an MCP stdio child; the child can call only the two capability names below,
 * and the parent forwards those calls to owner supplied callbacks over a
 * bearer-token protected loopback connection.
 */

export const MCP_SERVER_NAME = "propbench";
export const MCP_EXEC_NAME = "exec";
export const MCP_DELEGATE_NAME = "delegate";
export const MCP_EXEC_TOOL = "mcp__propbench__exec";
export const MCP_DELEGATE_TOOL = "mcp__propbench__delegate";
export const MCP_TOOL_NAMES = [MCP_EXEC_TOOL, MCP_DELEGATE_TOOL] as const;

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_PARTS = 256;
const MAX_ARGUMENT_BYTES = 100_000;

export interface CapabilityHandlers {
  exec(command: string[]): Promise<unknown>;
  delegate(task: string): Promise<unknown>;
}

export interface CapabilityBridge {
  readonly endpoint: string;
  readonly token: string;
  readonly toolCalls: string[];
  readonly errors: Error[];
  close(): Promise<void>;
}

export interface BridgeOptions {
  /** Called after a supplied callback rejects.  The adapter uses this to stop
   * a session immediately when its owner-side budget has been exhausted. */
  onError?: (error: Error) => void;
  /** Test-only bound override; production callers use the fixed limits. */
  maxResponseBytes?: number;
}

type BridgeRequest =
  | { method: "exec"; arguments: { command: string[] } }
  | { method: "delegate"; arguments: { task: string } };

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactString(value: string, secrets: readonly string[] = []): string {
  // These patterns, plus the per-run secret list, prevent an accidental
  // credential-shaped callback result from crossing the loopback boundary or
  // being sent back to Claude.
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]");
}

export function sanitizeCapabilityValue(value: unknown, secrets: readonly string[] = [], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    let result = redactString(value);
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeCapabilityValue(entry, secrets, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeCapabilityValue(entry, secrets, seen)]));
}

function boundedJson(value: unknown, maxBytes: number): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new Error(`Capability result is not JSON serializable: ${errorMessage(error)}`); }
  if (serialized === undefined) serialized = "null";
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("Capability result exceeded the 16 MiB limit");
  return serialized;
}

function validCommand(command: unknown): command is string[] {
  return Array.isArray(command) && command.length >= 1 && command.length <= MAX_COMMAND_PARTS &&
    command.every((value) => typeof value === "string" && value.length <= MAX_ARGUMENT_BYTES && !value.includes("\0"));
}

function validDelegate(task: unknown): task is string {
  return typeof task === "string" && task.trim().length > 0 && task.length <= MAX_ARGUMENT_BYTES && !task.includes("\0");
}

function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capability request");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "method" && key !== "arguments") ||
      (request.method !== "exec" && request.method !== "delegate") ||
      !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
    throw new Error("Invalid capability request");
  }
  const args = request.arguments as Record<string, unknown>;
  if (request.method === "exec") {
    if (Object.keys(args).some((key) => key !== "command") || !validCommand(args.command)) throw new Error("Invalid exec arguments");
    return { method: "exec", arguments: { command: args.command } };
  }
  if (Object.keys(args).some((key) => key !== "task") || !validDelegate(args.task)) throw new Error("Invalid delegate arguments");
  return { method: "delegate", arguments: { task: args.task } };
}

function sendJson(response: http.ServerResponse, status: number, value: unknown, maxBytes = MAX_RESPONSE_BYTES): void {
  const body = boundedJson(value, maxBytes);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.setHeader("Connection", "close");
  response.end(body);
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        request.resume();
        fail(new Error("Capability request exceeded the 1 MiB limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** Start a token-protected owner-side HTTP endpoint for the stdio child. */
export async function createCapabilityBridge(handlers: CapabilityHandlers, options: BridgeOptions = {}): Promise<CapabilityBridge> {
  const token = randomBytes(32).toString("hex");
  const toolCalls: string[] = [];
  const errors: Error[] = [];
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error("Invalid capability response bound");

  let closing = false;
  let server: http.Server;
  const serverReady = new Promise<{ port: number }>((resolve, reject) => {
    server = http.createServer(async (request, response) => {
      if (closing) { sendJson(response, 503, { ok: false, error: "Capability bridge is closed" }, maxResponseBytes); return; }
      try {
        const target = new URL(request.url ?? "/", "http://127.0.0.1");
        const authorization = request.headers.authorization;
        if (request.method !== "POST" || target.pathname !== "/call" || authorization !== `Bearer ${token}`) {
          sendJson(response, 404, { ok: false, error: "Capability endpoint not found" }, maxResponseBytes);
          request.resume();
          return;
        }
        const body = JSON.parse(await readRequestBody(request)) as unknown;
        const parsed = parseBridgeRequest(body);
        const toolName = parsed.method === "exec" ? MCP_EXEC_TOOL : MCP_DELEGATE_TOOL;
        toolCalls.push(toolName);
        const result = parsed.method === "exec"
          ? await handlers.exec(parsed.arguments.command)
          : await handlers.delegate(parsed.arguments.task);
        const sanitized = sanitizeCapabilityValue(result, [token]);
        // Check the serialized, sanitized value before placing it in an HTTP
        // response.  This prevents a hostile callback result from creating an
        // unbounded MCP message.
        boundedJson(sanitized, maxResponseBytes);
        sendJson(response, 200, { ok: true, result: sanitized }, maxResponseBytes);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        errors.push(failure);
        try { sendJson(response, 200, { ok: false, error: redactString(failure.message, [token]) }, maxResponseBytes); }
        catch { response.destroy(); }
        try { options.onError?.(failure); } catch { /* observer failures never escape the HTTP handler */ }
      }
    });
    server.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Capability bridge did not expose a TCP port")); return; }
      resolve({ port: address.port });
    });
  });

  const { port } = await serverReady;
  const endpoint = `http://127.0.0.1:${port}/call`;
  return {
    endpoint,
    token,
    toolCalls,
    errors,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        server.close(() => finish());
        const timer = setTimeout(() => {
          // Node 22 exposes closeAllConnections; the fallback still lets the
          // normal close callback finish when running on an older runtime.
          const closeAll = (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections;
          closeAll?.call(server);
          finish();
        }, 500);
        timer.unref();
      });
    },
  };
}

const EXEC_SCHEMA = {
  type: "object",
  properties: { command: { type: "array", items: { type: "string", maxLength: MAX_ARGUMENT_BYTES }, minItems: 1, maxItems: MAX_COMMAND_PARTS } },
  required: ["command"],
  additionalProperties: false,
};
const DELEGATE_SCHEMA = {
  type: "object",
  properties: { task: { type: "string", minLength: 1, maxLength: MAX_ARGUMENT_BYTES } },
  required: ["task"],
  additionalProperties: false,
};

function toolDefinitions(): unknown[] {
  return [
    {
      name: MCP_EXEC_NAME,
      description: "Run one argv command in the isolated PropBench Frontier bundle. This is the only execution capability.",
      inputSchema: EXEC_SCHEMA,
    },
    {
      name: MCP_DELEGATE_NAME,
      description: "Start one subordinate reasoning context with the same isolated PropBench capabilities.",
      inputSchema: DELEGATE_SCHEMA,
    },
  ];
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpc(value: unknown): JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP request");
  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || request.method.length > 200 ||
      (request.id !== undefined && request.id !== null && typeof request.id !== "string" && typeof request.id !== "number")) {
    throw new Error("Invalid MCP request");
  }
  return request as unknown as JsonRpcRequest;
}

function writeMcp(value: unknown): void {
  process.stdout.write(boundedJson(value, MAX_RESPONSE_BYTES) + "\n");
}

function requestCapability(endpoint: string, token: string, value: BridgeRequest): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(endpoint);
      if (target.protocol !== "http:" || !loopbackHost(target.hostname)) throw new Error("Capability endpoint must be loopback HTTP");
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
    const body = boundedJson(value, MAX_REQUEST_BYTES);
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf8"),
        Connection: "close",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (part: Buffer | string) => {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) { response.destroy(new Error("Capability bridge response exceeded the 16 MiB limit")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeResponse;
          if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") throw new Error("Malformed capability response");
          resolve(parsed);
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
      response.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    });
    request.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    request.end(body);
  });
}

function parseToolCall(request: JsonRpcRequest): { tool: string; request: BridgeRequest } {
  const params = request.params;
  if (!params || Object.keys(params).some((key) => key !== "name" && key !== "arguments" && key !== "_meta") ||
      (params._meta !== undefined && (!params._meta || typeof params._meta !== "object" || Array.isArray(params._meta))) ||
      typeof params.name !== "string" || !params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
    throw new Error("Invalid MCP tools/call arguments");
  }
  const name = params.name;
  const requestBody = name === MCP_EXEC_NAME
    ? { method: "exec", arguments: params.arguments }
    : name === MCP_DELEGATE_NAME
      ? { method: "delegate", arguments: params.arguments }
      : null;
  if (!requestBody) throw new Error("Unexpected MCP tool");
  return { tool: name, request: parseBridgeRequest(requestBody) };
}

function validateMetaOnly(params: Record<string, unknown> | undefined, label: string): void {
  if (!params) return;
  if (Object.keys(params).some((key) => key !== "_meta") ||
      (params._meta !== undefined && (!params._meta || typeof params._meta !== "object" || Array.isArray(params._meta)))) {
    throw new Error(`${label} takes only standard metadata`);
  }
}

/** Entry point used by the stdio MCP child. */
export async function serveSubscriptionMcp(): Promise<void> {
  const endpoint = process.env.PROPBENCH_SUBSCRIPTION_BRIDGE_URL;
  const token = process.env.PROPBENCH_SUBSCRIPTION_BRIDGE_TOKEN;
  if (!endpoint || !token) throw new Error("Subscription MCP bridge configuration is missing");
  // The child receives a sanitized environment from the adapter.  Delete any
  // credential-like values that a parent launcher might have added anyway.
  for (const key of Object.keys(process.env)) {
    if (/(_API_KEY|_AUTH_TOKEN|_TOKEN|_SECRET|^AWS_|^GOOGLE_|^AZURE_|^ANTHROPIC_)/i.test(key) &&
        key !== "PROPBENCH_SUBSCRIPTION_BRIDGE_TOKEN") delete process.env[key];
  }
  const stream = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of stream) {
    let request: JsonRpcRequest | undefined;
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) throw new Error("MCP request exceeded the 1 MiB limit");
      request = jsonRpc(JSON.parse(line));
      // Notifications carry no id and must not receive a response.
      if (request.id === undefined) {
        if (request.method !== "notifications/initialized" && request.method !== "notifications/cancelled") {
          if (request.method !== "initialized") throw new Error("Unsupported MCP notification");
        }
        continue;
      }
      let result: unknown;
      if (request.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
        };
      } else if (request.method === "ping") {
        result = {};
      } else if (request.method === "tools/list") {
        validateMetaOnly(request.params, "tools/list");
        result = { tools: toolDefinitions() };
      } else if (request.method === "tools/call") {
        const parsed = parseToolCall(request);
        const response = await requestCapability(endpoint, token, parsed.request);
        const content = response.ok ? JSON.stringify(response.result) ?? "null" : response.error ?? "Capability failed";
        if (Buffer.byteLength(content, "utf8") > MAX_RESPONSE_BYTES) throw new Error("MCP tool result exceeded the 16 MiB limit");
        result = { content: [{ type: "text", text: content }], isError: !response.ok };
      } else {
        throw new Error("Unsupported MCP method");
      }
      writeMcp({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const message = redactString(errorMessage(error), [token]);
      writeMcp({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message } });
    }
  }
}

if (require.main === module) {
  serveSubscriptionMcp().catch((error) => {
    process.stderr.write(redactString(errorMessage(error), [process.env.PROPBENCH_SUBSCRIPTION_BRIDGE_TOKEN ?? ""]) + "\n");
    process.exitCode = 1;
  });
}
