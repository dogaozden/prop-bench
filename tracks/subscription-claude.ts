import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { performance } from "node:perf_hooks";

import {
  createCapabilityBridge,
  MCP_DELEGATE_TOOL,
  MCP_EXEC_TOOL,
  MCP_SERVER_NAME,
  type CapabilityBridge,
} from "./subscription-mcp";
import type { Usage } from "./types";
import type { SubscriptionSessionOptions, SubscriptionSessionResult } from "./subscription-types";

/**
 * Claude Code is intentionally invoked as an installed native client.  The
 * adapter never talks to Anthropic's OAuth endpoints and never supplies an API
 * key.  Keep this path explicit so a different executable cannot silently
 * change the billing or authentication boundary of a recorded run.
 */
export const CLAUDE_CODE_PATH = path.join(os.homedir(), ".local/bin/claude");

const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MCP_CONFIG_PREFIX = "propbench-claude-mcp-";
const EMPTY_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_URL", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_API_KEY_HELPER", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_PROXY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "COHERE_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY",
  "GROQ_API_KEY", "XAI_API_KEY", "TOGETHER_API_KEY", "PERPLEXITY_API_KEY", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
  "GOOGLE_CLOUD_PROJECT", "CLOUD_ML_REGION", "NODE_OPTIONS", "NODE_PATH", "TS_NODE_PROJECT",
  "TS_NODE_TRANSPILE_ONLY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_CONFIG_DIR",
] as const;

// Keep this in lockstep with the installed Claude CLI's --effort choices.
// PropBench accepts `ultra` for other subscription clients, but this native
// Claude build reports only low/medium/high/xhigh/max.
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const EXPECTED_FRONTIER_TOOLS = new Set<string>([MCP_EXEC_TOOL, MCP_DELEGATE_TOOL]);

type Spawn = typeof childProcess.spawn;

export interface ClaudeSessionDependencies {
  /** Test seam; production uses the fixed native path and Node's spawn. */
  executable?: string;
  spawn?: Spawn;
}

class ClaudeSessionFailure extends Error {
  constructor(message: string, readonly kind: "validation" | "auth" | "quota" | "timeout" | "protocol" | "process" = "process") {
    super(message);
    this.name = "ClaudeSessionFailure";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, "$1[REDACTED]");
}

function sanitize(value: unknown, secrets: readonly string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, secrets, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry, secrets, seen)]));
}

function jsonWithin(value: unknown, maxBytes: number, label: string): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new ClaudeSessionFailure(`${label} is not JSON serializable: ${messageOf(error)}`, "protocol"); }
  if (serialized === undefined) serialized = "null";
  if (byteLength(serialized) > maxBytes) throw new ClaudeSessionFailure(`${label} exceeded ${maxBytes} bytes`, "protocol");
  return serialized;
}

function validText(value: unknown, label: string, maxBytes = MAX_PROMPT_BYTES): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || byteLength(value) > maxBytes) {
    throw new ClaudeSessionFailure(`Invalid ${label}`, "validation");
  }
}

function validateOptions(options: SubscriptionSessionOptions): void {
  if (!options || typeof options !== "object") throw new ClaudeSessionFailure("Session options are required", "validation");
  validText(options.model, "model", 256);
  validText(options.effort, "effort", 32);
  if (!ALLOWED_EFFORTS.has(options.effort)) throw new ClaudeSessionFailure(`Unsupported Claude effort: ${options.effort}`, "validation");
  validText(options.systemPrompt, "system prompt");
  validText(options.prompt, "prompt");
  validText(options.cwd, "cwd", 4096);
  validText(options.eventsPath, "events path", 4096);
  if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.eventsPath)) throw new ClaudeSessionFailure("cwd and eventsPath must be absolute", "validation");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new ClaudeSessionFailure("timeoutMs is outside the supported bound", "validation");
  }
  if (options.tools !== undefined) {
    if (!options.tools || typeof options.tools !== "object" || typeof options.tools.exec !== "function" || typeof options.tools.delegate !== "function") {
      throw new ClaudeSessionFailure("Frontier tools must provide exec and delegate callbacks", "validation");
    }
  }
}

function assertEmptyDirectory(cwd: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(cwd); }
  catch (error) { throw new ClaudeSessionFailure(`Session cwd is unavailable: ${messageOf(error)}`, "validation"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ClaudeSessionFailure("Session cwd must be a real directory", "validation");
  let entries: string[];
  try { entries = fs.readdirSync(cwd); }
  catch (error) { throw new ClaudeSessionFailure(`Session cwd cannot be read: ${messageOf(error)}`, "validation"); }
  if (entries.length) throw new ClaudeSessionFailure("Session cwd must be fresh and empty", "validation");
}

class EventLog {
  private bytes: number;
  private fd: number;
  private closed = false;

  constructor(readonly file: string, private readonly secrets: readonly string[]) {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let existing: fs.Stats | undefined;
    try { existing = fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new ClaudeSessionFailure("eventsPath must be a regular file", "validation");
    this.bytes = existing?.size ?? 0;
    if (this.bytes > MAX_EVENTS_BYTES) throw new ClaudeSessionFailure("eventsPath already exceeds the event bound", "validation");
    this.fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(this.fd, 0o600);
  }

  write(value: unknown): void {
    if (this.closed) return;
    const serialized = jsonWithin(sanitize(value, this.secrets), MAX_EVENT_LINE_BYTES, "event");
    const line = serialized + "\n";
    const next = this.bytes + byteLength(line);
    if (next > MAX_EVENTS_BYTES) throw new ClaudeSessionFailure("eventsPath exceeded the 32 MiB bound", "protocol");
    fs.writeSync(this.fd, line, undefined, "utf8");
    this.bytes = next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}

function credentialEnvironment(): { env: NodeJS.ProcessEnv; removed: string[]; secrets: string[] } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const removed = new Set<string>();
  for (const key of EMPTY_CREDENTIAL_ENV) {
    if (env[key] !== undefined) removed.add(key);
    delete env[key];
  }
  // Remove common provider credentials without touching HOME or CODEX_HOME.
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD|CREDENTIALS?)$/i.test(key) ||
        /^(?:ANTHROPIC|OPENAI|OPENROUTER|GOOGLE|GEMINI|AZURE|COHERE|MISTRAL|DEEPSEEK|GROQ|XAI|TOGETHER|PERPLEXITY|CLAUDE|AWS|VERTEX|BEDROCK)_.*(?:BASE_URL|API_URL|ENDPOINT|MODEL)$/i.test(key) ||
        /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/.test(key)) {
      removed.add(key);
      delete env[key];
    }
  }
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => value && (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || /^(?:AWS|ANTHROPIC|OPENAI|OPENROUTER|GOOGLE)_/i.test(key)))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 8);
  return { env, removed: [...removed].sort(), secrets };
}

interface NativeProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutLines: string[];
  stderr: string;
}

function terminate(child: childProcess.ChildProcess): void {
  try { child.kill("SIGTERM"); } catch { /* process may already have exited */ }
  const timer = setTimeout(() => {
    try {
      // ChildProcess.killed means that a signal was sent, not that the child
      // exited.  Check the exit fields so a slow native client receives the
      // hard bound even after accepting SIGTERM.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch { /* process may already have exited */ }
  }, 250);
  timer.unref();
}

function runNative(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onStdoutLine: (line: string) => void,
  onStderrChunk: (chunk: string) => void,
  spawnImpl: Spawn,
  onSpawned?: (child: childProcess.ChildProcess) => void,
): Promise<NativeProcessResult> {
  return new Promise((resolve, reject) => {
    let child: childProcess.ChildProcess;
    try {
      child = spawnImpl(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ClaudeSessionFailure(`Unable to start Claude Code: ${messageOf(error)}`, "process"));
      return;
    }
    onSpawned?.(child);
    const stdoutLines: string[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let failure: Error | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      resolve({ code, signal, stdoutLines, stderr });
    };
    const failAndStop = (error: unknown): void => {
      if (!failure) failure = error instanceof Error ? error : new Error(String(error));
      terminate(child);
    };
    const timer = setTimeout(() => failAndStop(new ClaudeSessionFailure("Claude Code wall-clock timeout", "timeout")), timeoutMs);
    timer.unref();
    if (child.stdout) {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        try {
          if (byteLength(line) > MAX_EVENT_LINE_BYTES) throw new ClaudeSessionFailure("Claude Code emitted an oversized event line", "protocol");
          stdoutBytes += byteLength(line) + 1;
          if (stdoutBytes > MAX_EVENTS_BYTES) throw new ClaudeSessionFailure("Claude Code stdout exceeded the 32 MiB bound", "protocol");
          stdoutLines.push(line);
          onStdoutLine(line);
        } catch (error) { failAndStop(error); }
      });
      child.once("close", () => lines.close());
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (byteLength(stderr) + byteLength(text) > MAX_STDERR_BYTES) { failAndStop(new ClaudeSessionFailure("Claude Code stderr exceeded the 2 MiB bound", "protocol")); return; }
        stderr += text;
        try { onStderrChunk(text); } catch (error) { failAndStop(error); }
      });
    }
    child.once("error", (error) => failAndStop(new ClaudeSessionFailure(`Claude Code process error: ${messageOf(error)}`, "process")));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

function parseJsonLine(line: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new ClaudeSessionFailure(`${label} was not valid JSON`, "protocol"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeSessionFailure(`${label} must be a JSON object`, "protocol");
  return value as Record<string, unknown>;
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider?: string;
  subscriptionType?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
}

function parseAuthStatus(stdoutLines: string[], stderr: string): AuthStatus {
  const joined = stdoutLines.join("\n");
  if (byteLength(joined) > MAX_AUTH_BYTES) throw new ClaudeSessionFailure("Claude auth status exceeded the bound", "auth");
  let parsed: unknown;
  try { parsed = JSON.parse(joined); }
  catch { throw new ClaudeSessionFailure(`Claude native auth status was not JSON: ${stderr.trim() || joined.slice(0, 500)}`, "auth"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ClaudeSessionFailure("Claude native auth status was malformed", "auth");
  const value = parsed as Record<string, unknown>;
  if (typeof value.loggedIn !== "boolean" || typeof value.authMethod !== "string") throw new ClaudeSessionFailure("Claude native auth status omitted login identity", "auth");
  const status: AuthStatus = {
    loggedIn: value.loggedIn,
    authMethod: value.authMethod,
    ...(typeof value.apiProvider === "string" ? { apiProvider: value.apiProvider } : {}),
    ...(typeof value.subscriptionType === "string" ? { subscriptionType: value.subscriptionType } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.orgId === "string" ? { orgId: value.orgId } : {}),
    ...(typeof value.orgName === "string" ? { orgName: value.orgName } : {}),
  };
  if (!status.loggedIn) throw new ClaudeSessionFailure(`Claude subscription is not logged in (${status.authMethod})`, "auth");
  if (status.authMethod !== "claude.ai") throw new ClaudeSessionFailure(`Claude subscription requires claude.ai authentication, got ${status.authMethod}`, "auth");
  if (status.apiProvider !== "firstParty") throw new ClaudeSessionFailure(`Claude subscription requires first-party provider, got ${status.apiProvider ?? "missing"}`, "auth");
  if (!status.subscriptionType) throw new ClaudeSessionFailure("Claude native auth status omitted the subscription plan", "auth");
  return status;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Keep only observed token counts.  `total_cost_usd` in Claude's JSON result
 * is a client-side estimate for SDK/API accounting, not subscription spend. */
export function observedUsage(value: unknown): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  const details = object.output_tokens_details && typeof object.output_tokens_details === "object" && !Array.isArray(object.output_tokens_details)
    ? object.output_tokens_details as Record<string, unknown> : undefined;
  const usage: Usage = {};
  const input = normalizeNumber(object.input_tokens ?? object.prompt_tokens);
  const output = normalizeNumber(object.output_tokens ?? object.completion_tokens);
  const thinking = normalizeNumber(object.thinking_tokens ?? details?.thinking_tokens ?? details?.reasoning_tokens);
  const total = normalizeNumber(object.total_tokens);
  if (input !== undefined) usage.input_tokens = input + (normalizeNumber(object.cache_creation_input_tokens) ?? 0) + (normalizeNumber(object.cache_read_input_tokens) ?? 0);
  if (output !== undefined) usage.output_tokens = output;
  if (thinking !== undefined) usage.thinking_tokens = thinking;
  if (total !== undefined) usage.total_tokens = total;
  return usage;
}

function mcpScriptCommand(): { command: string; args: string[] } {
  const js = path.join(__dirname, "subscription-mcp.js");
  if (fs.existsSync(js)) return { command: process.execPath, args: [js] };
  const ts = path.join(__dirname, "subscription-mcp.ts");
  if (fs.existsSync(ts)) {
    let register: string;
    try { register = require.resolve("ts-node"); }
    catch { throw new ClaudeSessionFailure("The subscription MCP child is unavailable before TypeScript compilation", "process"); }
    // The native client runs from an empty cwd. Do not let ts-node discover a
    // different project there, or Node 25 treat the .ts entrypoint as ESM.
    const launcher = `require(${JSON.stringify(register)}).register({transpileOnly:true,skipProject:true,compilerOptions:{module:"CommonJS",moduleResolution:"Node",target:"ES2022"}});require(${JSON.stringify(ts)}).serveSubscriptionMcp().catch(error=>{console.error(error.message);process.exitCode=1});`;
    return { command: process.execPath, args: ["--eval", launcher] };
  }
  throw new ClaudeSessionFailure("Subscription MCP child source is unavailable", "process");
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new ClaudeSessionFailure("Claude init omitted a valid tool catalog", "protocol");
  return value as string[];
}

function serverNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ClaudeSessionFailure("Claude init omitted MCP server metadata", "protocol");
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).name === "string") {
      const object = entry as Record<string, unknown>;
      if (object.status !== undefined && (typeof object.status !== "string" || !["connected", "ready"].includes(object.status.toLowerCase()))) {
        throw new ClaudeSessionFailure(`Claude MCP server ${object.name} was not connected`, "protocol");
      }
      return object.name as string;
    }
    throw new ClaudeSessionFailure("Claude init contained malformed MCP server metadata", "protocol");
  });
}

function requireEmptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length) throw new ClaudeSessionFailure(`Claude init exposed unexpected ${label}`, "protocol");
}

interface StreamState {
  init?: Record<string, unknown>;
  final?: Record<string, unknown>;
  assistantText: string;
  assistantUsage: Usage;
  toolCalls: string[];
  sessionId?: string;
  model?: string;
  clientVersion?: string;
  availableTools?: string[];
}

function appendText(state: StreamState, text: string): void {
  if (byteLength(state.assistantText) + byteLength(text) > MAX_EVENTS_BYTES) throw new ClaudeSessionFailure("Claude response exceeded the 32 MiB bound", "protocol");
  state.assistantText += text;
}

function inspectInit(event: Record<string, unknown>, options: SubscriptionSessionOptions, state: StreamState): void {
  if (event.type !== "system" || event.subtype !== "init") throw new ClaudeSessionFailure("Claude stream started without system/init", "protocol");
  if (state.init) throw new ClaudeSessionFailure("Claude stream emitted duplicate system/init", "protocol");
  if (typeof event.apiKeySource !== "string" || !["none", "oauth"].includes(event.apiKeySource)) {
    throw new ClaudeSessionFailure(`Claude session did not report native non-key authentication (apiKeySource=${String(event.apiKeySource)})`, "auth");
  }
  if (typeof event.model !== "string" || !event.model) throw new ClaudeSessionFailure("Claude init omitted resolved model", "protocol");
  if (typeof event.claude_code_version !== "string" || !event.claude_code_version) throw new ClaudeSessionFailure("Claude init omitted client version", "protocol");
  if (typeof event.session_id !== "string" || !event.session_id) throw new ClaudeSessionFailure("Claude init omitted session ID", "protocol");
  if (typeof event.cwd !== "string" || fs.realpathSync(event.cwd) !== fs.realpathSync(options.cwd)) throw new ClaudeSessionFailure("Claude session cwd did not match the fresh cwd", "protocol");
  if (event.permissionMode !== "dontAsk") throw new ClaudeSessionFailure(`Claude session permission mode was ${String(event.permissionMode)}`, "protocol");
  const tools = toolNames(event.tools);
  const servers = serverNames(event.mcp_servers);
  if (event.mcp_server_errors !== undefined && (!Array.isArray(event.mcp_server_errors) || event.mcp_server_errors.length)) {
    throw new ClaudeSessionFailure("Claude skipped or malformed an explicit MCP server", "protocol");
  }
  if (event.plugin_errors !== undefined && (!Array.isArray(event.plugin_errors) || event.plugin_errors.length)) {
    throw new ClaudeSessionFailure("Claude loaded an unexpected plugin error", "protocol");
  }
  requireEmptyArray(event.skills, "skills");
  requireEmptyArray(event.plugins, "plugins");
  requireEmptyArray(event.slash_commands, "slash commands");
  const frontier = options.tools !== undefined;
  if (!frontier) {
    if (tools.length || servers.length) throw new ClaudeSessionFailure("Unaided Claude session exposed a tool or MCP server", "protocol");
  } else {
    const actual = new Set(tools);
    if (actual.size !== EXPECTED_FRONTIER_TOOLS.size || [...EXPECTED_FRONTIER_TOOLS].some((name) => !actual.has(name))) {
      throw new ClaudeSessionFailure(`Frontier Claude tool catalog was unexpected: ${tools.join(",")}`, "protocol");
    }
    if (servers.length !== 1 || servers[0] !== MCP_SERVER_NAME) throw new ClaudeSessionFailure(`Frontier MCP catalog was unexpected: ${servers.join(",")}`, "protocol");
  }
  state.init = event;
  state.availableTools = tools;
  state.sessionId = event.session_id;
  state.model = event.model;
  state.clientVersion = event.claude_code_version;
}

function inspectAssistant(event: Record<string, unknown>, options: SubscriptionSessionOptions, state: StreamState): void {
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new ClaudeSessionFailure("Malformed Claude assistant event", "protocol");
  const object = message as Record<string, unknown>;
  if (typeof object.model === "string" && object.model) {
    if (state.model && object.model !== state.model) throw new ClaudeSessionFailure(`Claude model changed during the session (${state.model} -> ${object.model})`, "protocol");
    state.model = object.model;
  }
  const usage = observedUsage(object.usage);
  state.assistantUsage = usage;
  const content = object.content;
  if (!Array.isArray(content)) throw new ClaudeSessionFailure("Claude assistant content was not a block array", "protocol");
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ClaudeSessionFailure("Malformed Claude content block", "protocol");
    const block = entry as Record<string, unknown>;
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new ClaudeSessionFailure("Claude text block was malformed", "protocol");
      appendText(state, block.text);
    } else if (block.type === "tool_use") {
      if (typeof block.name !== "string" || !block.name) throw new ClaudeSessionFailure("Claude tool call was malformed", "protocol");
      const frontier = options.tools !== undefined;
      if (!frontier || !EXPECTED_FRONTIER_TOOLS.has(block.name)) throw new ClaudeSessionFailure(`Claude attempted unsupported tool ${String(block.name)}`, "protocol");
      if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) throw new ClaudeSessionFailure(`Claude tool ${block.name} had malformed input`, "protocol");
      const input = block.input as Record<string, unknown>;
      if (block.name === MCP_EXEC_TOOL && (Object.keys(input).some((key) => key !== "command") || !Array.isArray(input.command) || !input.command.length || input.command.length > 256 || input.command.some((part) => typeof part !== "string" || part.includes("\0") || byteLength(part) > 100_000))) {
        throw new ClaudeSessionFailure("Claude exec tool input was malformed", "protocol");
      }
      if (block.name === MCP_DELEGATE_TOOL && (Object.keys(input).some((key) => key !== "task") || typeof input.task !== "string" || !input.task.trim() || byteLength(input.task) > 100_000 || input.task.includes("\0"))) {
        throw new ClaudeSessionFailure("Claude delegate tool input was malformed", "protocol");
      }
      state.toolCalls.push(block.name);
    } else if (block.type !== "thinking" && block.type !== "redacted_thinking") {
      throw new ClaudeSessionFailure(`Claude returned unsupported content block ${String(block.type)}`, "protocol");
    }
  }
}

function inspectToolResult(event: Record<string, unknown>): void {
  const message = event.message;
  const source = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : event.type === "tool_result" ? event : undefined;
  if (!source) return;
  if (source.is_error === true) {
    const detail = typeof source.content === "string" ? source.content.slice(0, 1000) : "capability returned an error";
    throw new ClaudeSessionFailure(`Claude MCP capability failed: ${detail}`, "process");
  }
  const content = source.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const block = entry as Record<string, unknown>;
    if (block.type === "tool_result" && block.is_error === true) {
      const detail = typeof block.content === "string" ? block.content.slice(0, 1000) : "capability returned an error";
      throw new ClaudeSessionFailure(`Claude MCP capability failed: ${detail}`, "process");
    }
  }
}

function inspectResult(event: Record<string, unknown>, state: StreamState): void {
  if (event.type !== "result") throw new ClaudeSessionFailure("Malformed Claude result event", "protocol");
  state.final = event;
  if (typeof event.session_id === "string") state.sessionId = event.session_id;
  const result = event.result;
  if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
    const error = typeof event.error === "string" ? event.error : typeof result === "string" ? result : `Claude result subtype ${String(event.subtype)}`;
    const kind = /quota|rate.?limit|usage.?limit|billing|subscription/i.test(error) ? "quota" : "process";
    throw new ClaudeSessionFailure(`Claude Code subscription failure: ${error}`, kind);
  }
  if (typeof event.model === "string" && event.model) {
    if (state.model && event.model !== state.model) throw new ClaudeSessionFailure(`Claude model changed at the final result (${state.model} -> ${event.model})`, "protocol");
    state.model = event.model;
  }
  if (typeof result !== "string") throw new ClaudeSessionFailure("Claude result omitted final text", "protocol");
}

function failureKindMessage(error: ClaudeSessionFailure): string {
  if (error.kind === "quota") return error.message;
  if (error.kind === "timeout") return error.message;
  return error.message;
}

function checkClaudeExecutable(executable: string): void {
  try {
    const stat = fs.statSync(executable);
    if (!stat.isFile()) throw new Error("is not a regular file");
    fs.accessSync(executable, fs.constants.X_OK);
  } catch (error) {
    throw new ClaudeSessionFailure(`Claude Code executable is unavailable: ${executable} (${messageOf(error)})`, "process");
  }
}

function nativeArgs(options: SubscriptionSessionOptions, mcpConfig?: string): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--no-chrome", "--disable-slash-commands", "--setting-sources", "",
    "--tools", "", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--no-session-persistence",
    "--model", options.model, "--effort", options.effort, "--system-prompt", options.systemPrompt,
  ];
  if (options.tools === undefined) {
    // Print mode emits one final result; with every built-in and MCP tool
    // disabled there is no tool loop that could create another turn.
    args.push("--safe-mode");
  } else {
    // Safe mode disables MCP entirely in the installed CLI. Restricted mode
    // removes built-in command tools while retaining this explicit server.
    args.push(
      "--restricted",
      "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      "--allowedTools", MCP_EXEC_TOOL, MCP_DELEGATE_TOOL,
      "--strict-mcp-config", "--mcp-config", mcpConfig as string,
    );
  }
  // `--mcp-config` is variadic in the native CLI.  Terminate option parsing so
  // the user prompt cannot be consumed as another config path.
  args.push("--", options.prompt);
  return args;
}

function temporaryMcpConfig(bridge: CapabilityBridge): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), MCP_CONFIG_PREFIX));
  try {
    const child = mcpScriptCommand();
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: child.command,
          args: child.args,
          env: {
            PROPBENCH_SUBSCRIPTION_BRIDGE_URL: bridge.endpoint,
            PROPBENCH_SUBSCRIPTION_BRIDGE_TOKEN: bridge.token,
          },
        },
      },
    };
    const file = path.join(directory, "mcp.json");
    fs.writeFileSync(file, jsonWithin(config, MAX_EVENT_LINE_BYTES, "MCP configuration"), { flag: "wx", mode: 0o600 });
    return { directory, file };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function classifyProcessFailure(result: NativeProcessResult): ClaudeSessionFailure | undefined {
  if (result.code === 0) return undefined;
  const detail = result.stderr.trim().replace(/\s+/g, " ").slice(0, 2000);
  const suffix = detail ? `: ${detail}` : result.signal ? ` (${result.signal})` : "";
  const kind = /quota|rate.?limit|usage.?limit|billing|subscription/i.test(detail) ? "quota" : "process";
  return new ClaudeSessionFailure(`Claude Code exited with status ${result.code ?? "unknown"}${suffix}`, kind);
}

/**
 * Run one isolated Claude Code subscription session.  Unaided sessions use a
 * fresh empty cwd, safe mode, an empty built-in tool list, and one turn.
 * Frontier sessions use restricted mode plus exactly one explicit stdio MCP
 * server that forwards exec/delegate to the callbacks supplied by the owner.
 */
export async function runClaudeSession(options: SubscriptionSessionOptions): Promise<SubscriptionSessionResult> {
  return runClaudeSessionWithDependencies(options, {});
}

/** Internal test seam; it does not alter the public session contract. */
export async function runClaudeSessionWithDependencies(
  options: SubscriptionSessionOptions,
  dependencies: ClaudeSessionDependencies,
): Promise<SubscriptionSessionResult> {
  const eventSecrets = [...credentialEnvironment().secrets];
  let events: EventLog | undefined;
  try {
    validateOptions(options);
    events = new EventLog(options.eventsPath, eventSecrets);
    assertEmptyDirectory(options.cwd);
    const envInfo = credentialEnvironment();
    events.write({
      type: "adapter_start",
      provider: "claude-subscription",
      mode: options.tools === undefined ? "unaided" : "frontier",
      model: options.model,
      effort: options.effort,
      cwd: path.resolve(options.cwd),
      auth_policy: "native claude.ai subscription; no API key or provider override",
      removed_env_keys: envInfo.removed,
    });

    const executable = dependencies.executable ?? CLAUDE_CODE_PATH;
    const spawnImpl = dependencies.spawn ?? childProcess.spawn;
    checkClaudeExecutable(executable);
    const start = performance.now();
    const remaining = (): number => {
      const value = Math.floor(options.timeoutMs - (performance.now() - start));
      if (value <= 0) throw new ClaudeSessionFailure("Claude Code wall-clock timeout", "timeout");
      return value;
    };

    // Auth is checked through the native CLI itself.  Its output proves which
    // account and provider are active before a billed subscription turn starts.
    const auth = await runNative(executable, ["auth", "status", "--json"], options.cwd, envInfo.env, remaining(),
      (line) => events?.write({ type: "auth_stdout", raw: line }),
      (chunk) => events?.write({ type: "auth_stderr", raw: chunk }), spawnImpl);
    if (auth.code !== 0) {
      const detail = auth.stderr.trim().replace(/\s+/g, " ").slice(0, 2000);
      throw new ClaudeSessionFailure(`Claude native auth status failed${detail ? `: ${detail}` : ""}`, "auth");
    }
    const status = parseAuthStatus(auth.stdoutLines, auth.stderr);
    events.write({ type: "auth_status", status });

    let bridge: CapabilityBridge | undefined;
    let configDirectory: string | undefined;
    let activeSession: childProcess.ChildProcess | undefined;
    let fatalCapabilityError: Error | undefined;
    const onAbort = () => {
      fatalCapabilityError ??= new Error("Claude Code wall-clock timeout");
      if (activeSession) terminate(activeSession);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const state: StreamState = { assistantText: "", assistantUsage: {}, toolCalls: [] };
    try {
      options.signal?.throwIfAborted();
      let config: string | undefined;
      if (options.tools !== undefined) {
        bridge = await createCapabilityBridge(options.tools, {
          onError: (error) => {
            if (!fatalCapabilityError) fatalCapabilityError = error;
            if (activeSession) terminate(activeSession);
          },
        });
        eventSecrets.push(bridge.token);
        const temporary = temporaryMcpConfig(bridge);
        configDirectory = temporary.directory;
        config = temporary.file;
      }
      const args = nativeArgs(options, config);
      events.write({
        type: "adapter_launch",
        executable,
        args: args.map((arg, index) => index === args.length - 1 && arg === options.prompt ? "[PROMPT]" : arg),
        mode: options.tools === undefined ? "safe-mode-empty-tools" : "restricted-explicit-mcp",
      });
      const result = await runNative(executable, args, options.cwd, envInfo.env, remaining(), (line) => {
        if (!line.trim()) return;
        const event = parseJsonLine(line, "Claude stream event");
        events?.write(event);
        if (state.final) throw new ClaudeSessionFailure("Claude stream emitted data after the final result", "protocol");
        if (event.type === "system" && event.subtype === "init") inspectInit(event, options, state);
        else {
          if (!state.init && (event.type === "assistant" || event.type === "user" || event.type === "tool_result" || event.type === "result")) {
            throw new ClaudeSessionFailure("Claude stream emitted content before system/init", "protocol");
          }
          if (event.type === "assistant") inspectAssistant(event, options, state);
          else if (event.type === "user" || event.type === "tool_result") inspectToolResult(event);
          else if (event.type === "result") inspectResult(event, state);
        }
      }, (chunk) => events?.write({ type: "stderr", raw: chunk }), spawnImpl, (child) => { activeSession = child; if (options.signal?.aborted) onAbort(); });
      if (fatalCapabilityError) throw new ClaudeSessionFailure(`Claude capability callback failed: ${messageOf(fatalCapabilityError)}`, "process");
      const processFailure = classifyProcessFailure(result);
      if (processFailure) throw processFailure;
      if (!state.init) throw new ClaudeSessionFailure("Claude stream omitted system/init", "protocol");
      if (!state.final) throw new ClaudeSessionFailure("Claude stream omitted final result", "protocol");
      if (bridge?.errors.length) throw new ClaudeSessionFailure(`Claude capability callback failed: ${messageOf(bridge.errors[0])}`, "process");
      if (bridge && state.toolCalls.length !== bridge.toolCalls.length) {
        throw new ClaudeSessionFailure(`Claude tool event count did not match capability calls (${state.toolCalls.length} vs ${bridge.toolCalls.length})`, "protocol");
      }
      const finalText = state.final.result;
      if (typeof finalText !== "string") throw new ClaudeSessionFailure("Claude result text was malformed", "protocol");
      const usage = observedUsage(state.final.usage);
      const returnedUsage = Object.keys(usage).length ? usage : state.assistantUsage;
      const output: SubscriptionSessionResult = {
        text: finalText,
        model: state.model ?? options.model,
        client_version: state.clientVersion ?? "unknown",
        auth_type: `${status.authMethod}/${status.subscriptionType}`,
        usage: returnedUsage,
        tool_calls: bridge ? [...bridge.toolCalls] : [...state.toolCalls],
        available_tools: state.availableTools ?? [],
        ...(state.sessionId ? { session_id: state.sessionId } : {}),
      };
      events.write({ type: "adapter_complete", status: "complete", session_id: output.session_id, model: output.model, usage: output.usage, tool_calls: output.tool_calls, available_tools: output.available_tools });
      return output;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await bridge?.close();
      if (configDirectory) fs.rmSync(configDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    const failure = error instanceof ClaudeSessionFailure ? error : new ClaudeSessionFailure(messageOf(error), "process");
    try { events?.write({ type: "adapter_error", status: failure.kind, error: failureKindMessage(failure) }); }
    catch { /* preserve the original failure if the event file itself is full */ }
    throw failure;
  } finally {
    events?.close();
  }
}
