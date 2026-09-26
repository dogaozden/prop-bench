import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import {
  PROJECT_ROOT,
  gradeRun,
  parseProof,
  readRegularFile,
  validateCandidate,
  verifyRunIdentity,
  writeJson,
  writeJsonExclusive,
} from "./core";
import type {
  AttemptRecord,
  ProofLine,
  RunContext,
  RunReport,
  Theorem,
  Usage,
  Verdict,
} from "./types";

/**
 * The unaided track has a deliberately small provider surface.  In
 * particular, this file does not import either of the legacy model adapters:
 * those adapters contain retry loops and expose a considerably larger API
 * surface than this track permits.
 */

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const RULEBOOK_MAX_BYTES = 16 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const FENCE_RE = /^```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n```$/;
const JSON_FIELDS = new Set(["line_number", "formula", "justification", "depth"]);
const TOOL_CALL_FIELDS = new Set([
  "tool_calls",
  "tool_call",
  "toolCalls",
  "function_call",
  "functionCall",
]);

type FetchImpl = typeof fetch;

interface ProviderRequest {
  provider: "openrouter" | "gemini" | "fixture";
  model: string;
  endpoint: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeout_ms: number;
  budget: {
    max_output_tokens: number;
    max_thinking_tokens: number;
  };
}

interface ProviderResult {
  payload: unknown;
  raw_response: string;
  model?: string;
  backend?: string;
  usage?: Usage;
  completion_reason?: string;
}

class ProviderCallError extends Error {
  readonly payload: unknown;
  readonly status: number | undefined;
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: { payload?: unknown; status?: number; timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "ProviderCallError";
    this.payload = options.payload;
    this.status = options.status;
    this.timedOut = options.timedOut ?? false;
  }
}

interface PersistedAttempt extends AttemptRecord {
  /** Returned provider model identity, retained outside the request config. */
  model?: string;
  /** Provider finish reason (or fixture marker). */
  completion_reason?: string;
}

function assertBudget(ctx: RunContext): void {
  const budget = ctx.config.budget;
  for (const key of [
    "wall_seconds",
    "max_generations",
    "max_output_tokens",
    "max_thinking_tokens",
  ] as const) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0) {
      throw new Error(`Invalid unaided budget: ${key}`);
    }
  }
  if (budget.wall_seconds > 7 * 86400) {
    throw new Error("Unaided wall budget exceeds supported bounds");
  }
}

function assertFreshRun(ctx: RunContext): void {
  for (const directory of ["attempts", "submissions"] as const) {
    const directoryPath = path.join(ctx.dir, directory);
    if (!fs.existsSync(directoryPath) || !fs.lstatSync(directoryPath).isDirectory()) {
      throw new Error(`Unaided run is missing its ${directory} directory`);
    }
    if (fs.readdirSync(directoryPath).length !== 0) {
      throw new Error("Refusing to reuse a populated unaided run; prepare a new run");
    }
  }
  if (fs.existsSync(path.join(ctx.dir, "report.json"))) {
    throw new Error("Refusing to reuse a graded unaided run; prepare a new run");
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: Usage = {};
  const input = finiteNonNegative(
    source.input_tokens ?? source.prompt_tokens ?? source.promptTokenCount,
  );
  const output = finiteNonNegative(
    source.output_tokens ?? source.completion_tokens ?? source.candidatesTokenCount,
  );
  const thinking = finiteNonNegative(
    source.thinking_tokens ?? source.thoughtsTokenCount ??
      (source.completion_tokens_details as Record<string, unknown> | undefined)
        ?.reasoning_tokens,
  );
  const total = finiteNonNegative(source.total_tokens ?? source.totalTokenCount);
  const cost = finiteNonNegative(source.cost_usd ?? source.cost);
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (thinking !== undefined) usage.thinking_tokens = thinking;
  if (total !== undefined) usage.total_tokens = total;
  if (cost !== undefined) usage.cost_usd = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
    } else if (part && typeof part === "object") {
      const candidate = (part as Record<string, unknown>).text;
      if (typeof candidate === "string") text += candidate;
    }
  }
  return text;
}

function hasToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, any>;
  const nonEmpty = (entry: unknown): boolean => entry != null && (!Array.isArray(entry) || entry.length > 0);
  const message = Array.isArray(payload.choices) ? payload.choices[0]?.message : payload;
  if (message && (nonEmpty(message.tool_calls) || nonEmpty(message.function_call))) return true;
  const parts = payload.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) && parts.some((part: any) => part &&
    ["functionCall", "functionResponse", "executableCode", "codeExecutionResult"].some(key => nonEmpty(part[key])));
}

function providerResultFromPayload(
  payload: unknown,
  provider: "openrouter" | "gemini" | "fixture",
  _configuredModel: string,
): ProviderResult {
  if (typeof payload === "string") {
    return { payload, raw_response: payload };
  }

  if (Array.isArray(payload)) {
    return { payload, raw_response: JSON.stringify(payload) };
  }

  if (!payload || typeof payload !== "object") {
    return { payload, raw_response: "" };
  }

  const object = payload as Record<string, unknown>;
  const usage = normalizeUsage(object.usage ?? object.usageMetadata);
  const model = typeof object.model === "string"
    ? object.model
    : typeof object.modelVersion === "string"
      ? object.modelVersion
      : undefined;
  const completion = typeof object.completion_reason === "string"
    ? object.completion_reason
    : typeof object.finish_reason === "string"
      ? object.finish_reason
      : typeof object.finishReason === "string"
        ? object.finishReason
        : undefined;

  // Fixture envelopes may use the same field names as AttemptRecord.  This
  // is intentionally a narrow convenience; arbitrary object wrappers remain
  // invalid JSON proof and are never interpreted as commands.
  const rawField = object.raw_response ?? object.rawResponse;
  if (typeof rawField === "string") {
    return {
      payload,
      raw_response: rawField,
      model,
      usage,
      completion_reason: completion,
    };
  }

  if (Array.isArray(object.choices)) {
    const choice = object.choices[0];
    const choiceObject = choice && typeof choice === "object"
      ? choice as Record<string, unknown>
      : undefined;
    const message = choiceObject?.message;
    const messageObject = message && typeof message === "object"
      ? message as Record<string, unknown>
      : undefined;
    const content = messageObject?.content ?? choiceObject?.text;
    return {
      payload,
      raw_response: textFromContent(content),
      model,
      backend: typeof object.provider === "string" ? object.provider : undefined,
      usage,
      completion_reason: typeof choiceObject?.finish_reason === "string"
        ? choiceObject.finish_reason
        : completion,
    };
  }

  if (Array.isArray(object.candidates)) {
    const candidate = object.candidates[0];
    const candidateObject = candidate && typeof candidate === "object"
      ? candidate as Record<string, unknown>
      : undefined;
    const content = candidateObject?.content;
    const contentObject = content && typeof content === "object"
      ? content as Record<string, unknown>
      : undefined;
    return {
      payload,
      raw_response: textFromContent(contentObject?.parts ?? content),
      model,
      usage,
      completion_reason: typeof candidateObject?.finishReason === "string"
        ? candidateObject.finishReason
        : typeof candidateObject?.finish_reason === "string"
          ? candidateObject.finish_reason
          : completion,
    };
  }

  if (typeof object.text === "string") {
    return { payload, raw_response: object.text, model, usage, completion_reason: completion };
  }
  if (typeof object.content === "string") {
    return { payload, raw_response: object.content, model, usage, completion_reason: completion };
  }
  if (typeof object.response === "string") {
    return { payload, raw_response: object.response, model, usage, completion_reason: completion };
  }

  // Keep the malformed payload in the attempt record.  JSON.stringify is
  // used only as a parser input, never evaluated or dispatched.
  return {
    payload,
    raw_response: JSON.stringify(payload),
    model,
    usage,
    completion_reason: completion,
  };
}

function stripOptionalFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = trimmed.match(FENCE_RE);
  if (!match || (match[1] && match[1].toLowerCase() !== "json")) {
    throw new Error("Expected one optional fenced JSON proof and no surrounding text");
  }
  return match[2].trim();
}

function strictProof(raw: string, _theorem: Theorem): ProofLine[] {
  // Both tracks submit the same replay protocol; the Rust verifier owns
  // scope and inference semantics, without track-specific extra rules.
  return parseProof(stripOptionalFence(raw));
}

export function theoremPrompt(theorem: Theorem, rulebook: string): { system: string; user: string } {
  const system = [
    "You are a formal propositional-logic proof generator.",
    "Use only the rules in the shared rules.md text below.",
    "Construct the shortest valid proof you can. Premises are free; every submitted assumption, derived line, and subproof closing line counts.",
    "The replay engine auto-seeds theorem premises as lines 1 through N.",
    "Return derived lines only; the first derived line is N+1.",
    "Each line object must contain exactly line_number, formula, justification, and depth.",
    'Each JSON object has this shape: {"line_number": 3, "formula": "Q", "justification": "MP 1,2", "depth": 0}.',
    "Justifications: RULE followed by cited line numbers (MP 1,2; Simp 1; DeM 2), Assumption (CP), Assumption (IP), CP start-end, or IP start-end.",
    "Output one JSON array and no commentary. A single ```json fenced array is also accepted.",
    "\n----- shared rules.md -----\n",
    rulebook,
    "\n----- end shared rules.md -----",
  ].join("\n");
  const user = [
    "THEOREM (JSON)",
    JSON.stringify({ premises: theorem.premises, conclusion: theorem.conclusion }, null, 2),
    "",
    `There are ${theorem.premises.length} auto-seeded premises. Prove the conclusion using derived replay lines only.`,
    "Return only the strict JSON array described above.",
  ].join("\n");
  return { system, user };
}

function normalizedModel(provider: "openrouter" | "gemini", model: string): string {
  let result = model.trim();
  if (provider === "openrouter" && (/:online(?:$|:)/i.test(result) || result.startsWith("@"))) throw new Error("Unaided cannot use online tool variants or server presets");
  if (provider === "gemini" && result.startsWith("models/")) result = result.slice("models/".length);
  if (provider === "gemini" && result.startsWith("google/")) result = result.slice("google/".length);
  if (!result) throw new Error("Model identity is required for unaided generation");
  return result;
}

function totalGenerationTokens(output: number, thinking: number): number {
  const total = output + thinking;
  if (!Number.isSafeInteger(total)) throw new Error("Unaided token budget sum is not safe");
  return total;
}

function buildProviderRequest(
  ctx: RunContext,
  theorem: Theorem,
  rulebook: string,
  timeoutMs: number,
): { request: ProviderRequest; actualUrl: string; actualHeaders: Record<string, string> } {
  const provider = ctx.config.provider;
  if (provider !== "openrouter" && provider !== "gemini") {
    throw new Error(`Provider ${provider} does not use a network request`);
  }
  const model = normalizedModel(provider, ctx.config.model);
  const prompts = theoremPrompt(theorem, rulebook);
  const budget = ctx.config.budget;
  const publicHeaders: Record<string, string> = { "Content-Type": "application/json" };

  if (provider === "openrouter") {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: prompts.system },
        { role: "user", content: prompts.user },
      ],
      temperature: ctx.config.temperature,
      max_tokens: totalGenerationTokens(budget.max_output_tokens, budget.max_thinking_tokens),
      provider: { allow_fallbacks: false, require_parameters: true },
    };
    if (budget.max_thinking_tokens > 0) {
      body.reasoning = { max_tokens: budget.max_thinking_tokens, exclude: true };
    } else {
      body.reasoning = { enabled: false, exclude: true };
    }
    const endpoint = OPENROUTER_ENDPOINT;
    const apiKey = process.env.OPENROUTER_API_KEY;
    const actualHeaders: Record<string, string> = {
      ...publicHeaders,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "HTTP-Referer": "https://github.com/dogaozden/prop-bench",
      "X-Title": "PropBench",
    };
    return {
      request: {
        provider,
        model,
        endpoint,
        url: endpoint,
        method: "POST",
        headers: publicHeaders,
        body,
        timeout_ms: timeoutMs,
        budget: {
          max_output_tokens: budget.max_output_tokens,
          max_thinking_tokens: budget.max_thinking_tokens,
        },
      },
      actualUrl: endpoint,
      actualHeaders,
    };
  }

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: prompts.system }] },
    contents: [{ role: "user", parts: [{ text: prompts.user }] }],
    generationConfig: {
      temperature: ctx.config.temperature,
      maxOutputTokens: totalGenerationTokens(budget.max_output_tokens, budget.max_thinking_tokens),
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: budget.max_thinking_tokens },
    },
  };
  const endpoint = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
  const apiKey = process.env.GEMINI_API_KEY;
  return {
    request: {
      provider,
      model,
      endpoint,
      url: endpoint,
      method: "POST",
      headers: publicHeaders,
      body,
      timeout_ms: timeoutMs,
      budget: {
        max_output_tokens: budget.max_output_tokens,
        max_thinking_tokens: budget.max_thinking_tokens,
      },
    },
    actualUrl: endpoint,
    actualHeaders: { ...publicHeaders, ...(apiKey ? { "x-goog-api-key": apiKey } : {}) },
  };
}

async function responsePayload(response: Response): Promise<unknown> {
  // Read the body once. Calling json() then text() loses malformed bodies.
  const maxBytes = 16 * 1024 * 1024;
  let raw: string;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ProviderCallError("Provider response exceeded 16 MiB", {
          payload: { response_truncated: true, body_prefix: Buffer.concat(chunks).toString("utf8") },
        });
      }
      chunks.push(part.value);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } else if (typeof response.text === "function") {
    raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw new ProviderCallError("Provider response exceeded 16 MiB");
  } else if (typeof response.json === "function") {
    // Only injected test responses lack the native fetch readable body.
    return response.json();
  } else throw new Error("Provider response has no readable body");
  try { return JSON.parse(raw); } catch { return raw; }
}

async function callNetworkProvider(
  ctx: RunContext,
  theorem: Theorem,
  rulebook: string,
  fetchImpl: FetchImpl,
  deadline: number,
  onDispatch: () => void,
): Promise<{ request: ProviderRequest; result: ProviderResult }> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new ProviderCallError("Unaided wall budget expired before provider request", { timedOut: true });
  }
  const timeoutMs = Math.max(1, Math.floor(remaining));
  const built = buildProviderRequest(ctx, theorem, rulebook, timeoutMs);
  const apiKeyName = ctx.config.provider === "gemini" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
  const apiKey = process.env[apiKeyName];
  if (!apiKey) {
    throw new ProviderCallError(`${apiKeyName} is not set`);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const operation = (async (): Promise<ProviderResult> => {
    let response: Response;
    try {
      onDispatch();
      response = await fetchImpl(built.actualUrl, {
        method: built.request.method,
        headers: built.actualHeaders,
        body: JSON.stringify(built.request.body),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      throw new ProviderCallError(error instanceof Error ? error.message : String(error));
    }
    const payload = await responsePayload(response);
    const status = typeof response.status === "number" ? response.status : undefined;
    const ok = typeof response.ok === "boolean"
      ? response.ok
      : status === undefined || (status >= 200 && status < 300);
    if (!ok) {
      throw new ProviderCallError(
        `Provider returned HTTP ${status ?? "error"}`,
        { payload, status },
      );
    }
    return providerResultFromPayload(
      payload,
      ctx.config.provider === "gemini" ? "gemini" : "openrouter",
      built.request.model,
    );
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProviderCallError("Unaided provider request exceeded wall budget", { timedOut: true }));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    return { request: built.request, result };
  } catch (error) {
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError(error instanceof Error ? error.message : String(error), { timedOut });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A fetch implementation is allowed to ignore AbortSignal.  It must not
    // keep a late rejection alive after this attempt has been finalized.
    operation.catch(() => undefined);
  }
}

function fixtureResult(
  ctx: RunContext,
  itemId: string,
  responses: Record<string, unknown> | undefined,
): ProviderResult {
  if (!responses || !Object.prototype.hasOwnProperty.call(responses, itemId)) {
    throw new ProviderCallError(`Fixture response missing for theorem ${itemId}`);
  }
  return providerResultFromPayload(responses[itemId], "fixture", ctx.config.model);
}

function redactString(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function redact(value: unknown, secrets: string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = redact(entry, secrets, seen);
  }
  return result;
}

function secretsFor(ctx: RunContext): string[] {
  const names = ctx.config.provider === "gemini"
    ? ["GEMINI_API_KEY"]
    : ctx.config.provider === "openrouter"
      ? ["OPENROUTER_API_KEY"]
      : [];
  return names.map((name) => process.env[name]).filter((value): value is string => !!value);
}

function finalizeAttempt(
  attemptPath: string,
  initial: PersistedAttempt,
  patch: Partial<PersistedAttempt>,
  secrets: string[],
): void {
  const record = redact({ ...initial, ...patch }, secrets) as PersistedAttempt;
  writeJson(attemptPath, record);
}

function baseRequestForFixture(ctx: RunContext, theorem: Theorem, rulebook: string, timeoutMs: number): ProviderRequest {
  const prompts = theoremPrompt(theorem, rulebook);
  return {
    provider: "fixture",
    model: ctx.config.model,
    endpoint: "fixture://unaided",
    url: "fixture://unaided",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: {
      model: ctx.config.model,
      messages: [
        { role: "system", content: prompts.system },
        { role: "user", content: prompts.user },
      ],
      temperature: ctx.config.temperature,
      max_tokens: totalGenerationTokens(
        ctx.config.budget.max_output_tokens,
        ctx.config.budget.max_thinking_tokens,
      ),
      ...(ctx.config.budget.max_thinking_tokens > 0
        ? { reasoning: { max_tokens: ctx.config.budget.max_thinking_tokens } }
        : {}),
    },
    timeout_ms: timeoutMs,
    budget: {
      max_output_tokens: ctx.config.budget.max_output_tokens,
      max_thinking_tokens: ctx.config.budget.max_thinking_tokens,
    },
  };
}

/**
 * Run one final-only generation per selected theorem.  A populated run is an
 * immutable experiment: callers must prepare a new run to try again.
 */
export async function runUnaided(
  ctx: RunContext,
  options: {
    validator: string;
    fixtureResponses?: Record<string, unknown>;
    fetchImpl?: FetchImpl;
  },
): Promise<RunReport> {
  if (ctx.config.track !== "unaided" || ctx.config.mode !== "unaided") {
    throw new Error("runUnaided requires an unaided run configuration");
  }
  if (ctx.config.provider === "external") {
    throw new Error("Unaided runs cannot use the external provider");
  }
  if (ctx.config.provider === "fixture" && !options.fixtureResponses) {
    throw new Error("Fixture unaided runs require explicit fixtureResponses");
  }

  assertBudget(ctx);
  verifyRunIdentity(ctx, options.validator);
  assertFreshRun(ctx);
  if (options.fetchImpl) writeJsonExclusive(path.join(ctx.dir, "test-injection.json"), { schema: "propbench-test-injection-v1", fetch: true });

  const rulebook = readRegularFile(path.join(PROJECT_ROOT, "rules.md"), RULEBOOK_MAX_BYTES)
    .toString("utf8");
  const fetchImpl = options.fetchImpl ?? fetch;
  const secrets = secretsFor(ctx);
  const start = performance.now();
  const deadline = start + ctx.config.budget.wall_seconds * 1000;
  let generations = 0;

  for (const item of ctx.set.items) {
    if (generations >= ctx.config.budget.max_generations) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;

    const timeoutMs = Math.max(1, Math.floor(remaining));
    const attemptPath = path.join(ctx.dir, "attempts", `${item.id}.json`);
    const startedAt = new Date().toISOString();
    let request: ProviderRequest;
    if (ctx.config.provider === "fixture") {
      request = baseRequestForFixture(ctx, item.theorem, rulebook, timeoutMs);
    } else {
      // Build the public request before writing the attempt.  The network
      // request itself is built again with the exact remaining timeout, while
      // retaining this key-free snapshot as the audit record.
      request = buildProviderRequest(ctx, item.theorem, rulebook, timeoutMs).request;
    }
    const initial: PersistedAttempt = {
      item_id: item.id,
      attempt: 1,
      started_at: startedAt,
      request,
      dispatch_state: "not_started",
    };
    // Exclusive creation is the no-duplicate guard if another worker races
    // this run after the initial freshness check.
    writeJsonExclusive(attemptPath, redact(initial, secrets));
    generations += 1;

    let result: ProviderResult | undefined;
    let response: unknown;
    let verdict: Verdict;
    let proof: ProofLine[] | undefined;
    let transportError: string | undefined;

    try {
      if (ctx.config.provider === "fixture") {
        result = fixtureResult(ctx, item.id, options.fixtureResponses);
      } else {
        ({ result } = await callNetworkProvider(
          ctx,
          item.theorem,
          rulebook,
          fetchImpl,
          deadline,
          () => { initial.dispatch_state = "dispatched"; writeJson(attemptPath, redact(initial, secrets)); },
        ));
      }
      initial.dispatch_state = "response_confirmed";
      response = result.payload;

      if (hasToolCall(result.payload)) {
        verdict = {
          status: "protocol_error",
          line_count: null,
          errors: ["Provider returned a tool/function call; unaided does not dispatch tools"],
        };
      } else {
        try {
          proof = strictProof(result.raw_response, item.theorem);
          verdict = await validateCandidate(options.validator, item.theorem, proof);
        } catch (error) {
          // Provider formatting and replay-shape failures are final parse
          // outcomes.  Validator infrastructure errors are transport-like
          // failures and are still final for this attempt.
          const message = error instanceof Error ? error.message : String(error);
          if (proof) {
            verdict = {
              status: "transport_error",
              line_count: null,
              errors: [`Validator failure: ${message}`],
            };
          } else {
            verdict = { status: "parse_error", line_count: null, errors: [message] };
          }
        }
      }
    } catch (error) {
      if (error instanceof ProviderCallError) {
        response = error.payload;
        transportError = error.message;
        if (error.status !== undefined) initial.dispatch_state = "response_confirmed";
        else if (initial.dispatch_state === "dispatched") initial.dispatch_state = "uncertain";
      } else {
        transportError = error instanceof Error ? error.message : String(error);
      }
      verdict = { status: "transport_error", line_count: null, errors: [transportError] };
    }

    const finalPatch: Partial<PersistedAttempt> = {
      completed_at: new Date().toISOString(),
      response,
      raw_response: result?.raw_response,
      proof,
      verdict,
      usage: result?.usage,
      model: result?.model,
      backend: result?.backend,
      completion_reason: result?.completion_reason,
      transport_error: transportError,
    };

    // Preserve a valid candidate as the selected submission only after its
    // one validation.  gradeRun independently revalidates this file.
    if (verdict.status === "valid" && proof) {
      writeJsonExclusive(
        path.join(ctx.dir, "submissions", `${item.id}.json`),
        redact(proof, secrets),
      );
    }
    finalizeAttempt(attemptPath, initial, finalPatch, secrets);
  }

  return gradeRun(ctx.dir, options.validator);
}
