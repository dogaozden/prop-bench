import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { gradeRun, parseProof, readJson, readRegularFile, validateCandidate, verifyRunIdentity, writeJson, writeJsonExclusive } from "./core";
import { executeForRun } from "./bridge";
import { createControlledFrontierCheckpoints, finalizeControlledFrontier, verifyStartingBundle, type ControlledFrontierCheckpoints } from "./frontier";
import { inspectRuntime, SandboxUnavailableError } from "./sandbox";
import { theoremPrompt } from "./unaided";
import { type AttemptRecord, type RunContext, type RunReport } from "./types";
import type { SubscriptionSessionOptions, SubscriptionSessionResult, SubscriptionTools } from "./subscription-types";

type SessionClient = (options: SubscriptionSessionOptions) => Promise<SubscriptionSessionResult>;
interface State {
  schema_version: "propbench-subscription-v1";
  started_at: string;
  completed_at?: string;
  budget_expires_at?: string;
  client_completed_at?: string;
  tools_drained_at?: string;
  status: "running" | "complete" | "interrupted";
  client_sessions: number;
  tool_calls: number;
  error?: string;
  finished_reason?: string;
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const budgetError = (error: unknown): boolean => /Subscription (?:wall budget|tool allowance|delegation limit) exhausted|Codex (?:session|initialization) wall-clock timeout|Frontier wall-clock budget exhausted/.test(message(error));

/** Run native subscription clients without consulting an API-key adapter. */
export async function runSubscription(ctx: RunContext, options: {
  validator: string;
  /** Injected clients are marked and excluded from official comparisons. */
  sessionClient?: SessionClient;
}): Promise<RunReport> {
  if (ctx.config.provider !== "codex-subscription" || !ctx.config.subscription) throw new Error("New subscription runs require native Codex subscription settings; no Claude or API fallback");
  verifyRunIdentity(ctx, options.validator);
  const stateFile = path.join(ctx.dir, "subscription.json");
  if (fs.existsSync(stateFile) || fs.existsSync(path.join(ctx.dir, "report.json")) || fs.readdirSync(path.join(ctx.dir, "attempts")).length) {
    throw new Error("Refusing to reuse a started subscription run; prepare a fresh run");
  }
  const lock = fs.openSync(path.join(ctx.dir, "subscription.lock"), "wx", 0o600);
  const state: State = { schema_version: "propbench-subscription-v1", started_at: new Date().toISOString(), status: "running", client_sessions: 0, tool_calls: 0 };
  const deadline = performance.now() + ctx.config.budget.wall_seconds * 1000;
  const frontier = ctx.config.track === "frontier";
  let acceptingTools = true;
  const cancellation = new AbortController();
  const deadlineTimer = setTimeout(() => { acceptingTools = false; cancellation.abort(new Error("Subscription wall budget exhausted")); }, ctx.config.budget.wall_seconds * 1000);
  let execQueue: Promise<unknown> = Promise.resolve();
  const activeTools = new Set<Promise<unknown>>();
  let bundleDir = "";
  let checkpoints: ControlledFrontierCheckpoints | undefined;
  let ownerFailure: unknown;
  const failOwner = (error: unknown): void => {
    ownerFailure ??= error;
    acceptingTools = false;
    cancellation.abort(error);
  };
  const save = () => {
    writeJson(stateFile, state);
    if (frontier) writeJson(path.join(ctx.dir, "controller.json"), state);
  };
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error("Subscription wall budget exhausted");
    return ms;
  };
  try {
    fs.mkdirSync(path.join(ctx.dir, "sessions"), { mode: 0o700 });
    fs.mkdirSync(path.join(ctx.dir, "tool-events"), { mode: 0o700 });
    writeJsonExclusive(stateFile, state);
    if (options.sessionClient) writeJsonExclusive(path.join(ctx.dir, "test-injection.json"), { schema: "propbench-test-injection-v1", subscriptionClient: true });
    const client: SessionClient = options.sessionClient ?? (await import("./subscription-codex")).runCodexSession;
    const rules = readRegularFile(path.join(ctx.dir, "referee/rules.md")).toString("utf8");
    if (frontier) {
      verifyStartingBundle(ctx);
      bundleDir = readJson<{bundle_dir: string}>(path.join(ctx.dir, "frontier.json")).bundle_dir;
      writeJsonExclusive(path.join(ctx.dir, "runtime.json"), await inspectRuntime());
      fs.chmodSync(path.join(ctx.dir, "runtime.json"), 0o400);
      state.budget_expires_at = new Date(Date.parse(state.started_at) + ctx.config.budget.wall_seconds * 1000).toISOString();
      save();
      if (ctx.config.execution_protocol === "frontier-subscription-v2") {
        checkpoints = createControlledFrontierCheckpoints(ctx, options.validator, deadline);
      }
    }

    async function session(prompt: string, systemPrompt: string, itemId: string, depth = 0): Promise<SubscriptionSessionResult> {
      remaining();
      if (depth > 4 || (frontier && state.client_sessions >= 8)) throw new Error("Subscription delegation limit exhausted");
      const number = ++state.client_sessions;
      save();
      const stem = String(number).padStart(6, "0");
      const receiptPath = path.join(ctx.dir, "sessions", stem + ".json");
      const initial: AttemptRecord = {
        item_id: itemId, attempt: number, started_at: new Date().toISOString(), dispatch_state: "not_started",
        request: { provider: ctx.config.provider, model: ctx.config.model, effort: ctx.config.subscription!.effort,
          systemPrompt, prompt, tools: frontier ? ["exec", "delegate"] : [], timeout_ms: remaining(),
          billing: "subscription", inference_requests: "client-managed; not independently metered" },
      };
      writeJsonExclusive(receiptPath, initial);
      // The native client never opens the owner's checkout or the contestant bundle.
      // Its only work access is the explicitly supplied Docker tool capability.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-client-"));
      const tool = (name: "exec" | "delegate", input: unknown, work: () => Promise<unknown>): Promise<unknown> => {
        if (cancellation.signal.aborted) return Promise.reject(cancellation.signal.reason);
        if (!acceptingTools) return Promise.reject(new Error("Subscription run is closed"));
        remaining();
        if (state.tool_calls >= ctx.config.subscription!.max_tool_calls) return Promise.reject(new Error("Subscription tool allowance exhausted"));
        const index = ++state.tool_calls;
        save();
        const file = path.join(ctx.dir, "tool-events", String(index).padStart(6, "0") + ".json");
        const record = { session: number, tool: name, input, started_at: new Date().toISOString() };
        writeJsonExclusive(file, record);
        const pending = work().then(result => {
          writeJson(file, { ...record, completed_at: new Date().toISOString(), result });
          return result;
        }, error => {
          writeJson(file, { ...record, completed_at: new Date().toISOString(), error: message(error) });
          throw error;
        });
        activeTools.add(pending);
        pending.then(() => activeTools.delete(pending), () => activeTools.delete(pending));
        return pending;
      };
      const tools: SubscriptionTools | undefined = frontier ? {
        exec: command => tool("exec", { command }, async () => {
          if (!Array.isArray(command) || !command.length || command.length > 256 || command.some(v => typeof v !== "string" || v.includes("\0") || v.length > 100000)) throw new Error("Invalid command argument array");
          const operation = execQueue.then(async () => {
            if (!acceptingTools || cancellation.signal.aborted) throw new Error("Subscription run is closed");
            remaining();
            try {
              return await executeForRun(ctx.dir, command, checkpoints ? {
                deadline, signal: cancellation.signal, afterExecution: async number => {
                  try { await checkpoints!.afterExecution(number); }
                  catch (error) { failOwner(error); throw error; }
                },
              } : undefined);
            } catch (error) {
              if (error instanceof SandboxUnavailableError && !budgetError(error)) failOwner(error);
              throw error;
            }
          });
          execQueue = operation.catch(() => undefined);
          return operation;
        }),
        delegate: task => tool("delegate", { task }, async () => {
          if (typeof task !== "string" || !task.trim() || task.length > 100000) throw new Error("Invalid delegate task");
          const result = await session(task, systemPrompt, "delegate", depth + 1);
          if (result.error) throw new Error(result.error);
          return { final: result.text };
        }),
      } : undefined;
      try {
        initial.dispatch_state = "dispatched";
        writeJson(receiptPath, initial);
        const result = await client({ model: ctx.config.model, effort: ctx.config.subscription!.effort,
          systemPrompt, prompt, cwd, timeoutMs: remaining(), eventsPath: path.join(ctx.dir, "sessions", stem + ".ndjson"), tools, signal: cancellation.signal });
        remaining();
        if (!frontier && (result.available_tools.length || result.tool_calls.length)) throw new Error("Unaided protocol violation: native client exposed or called a tool");
        writeJson(receiptPath, { ...initial, completed_at: new Date().toISOString(), response: result, raw_response: result.text,
          usage: result.usage, model: result.model, backend: `${ctx.config.provider}:${result.client_version}`,
          dispatch_state: "response_confirmed" });
        return result;
      } catch (error) {
        writeJson(receiptPath, { ...initial, completed_at: new Date().toISOString(), transport_error: message(error), dispatch_state: "uncertain" });
        throw error;
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }

    try {
      if (frontier) {
        const system = ["You are a PropBench Frontier contestant. Find the shortest valid formal proofs you can.",
          "Use exec for shell commands, Python, custom solvers, and repeated verifier checks in your isolated workspace.",
          "Use delegate for independent assistants with the same workspace tools and a shared time/tool allowance.",
          "There is no host filesystem or internet access. The exec tool accepts an argv array; use /bin/sh -c for shell syntax.",
          "Read GOAL.md and rules.md first. Leave proof JSON files in proofs/, reusable programs in tools/, and record your experiments and methodology.",
          ...(checkpoints ? ["After each completed exec the owner freezes proof files before the deadline and independently retains each shortest valid incumbent. Later invalid or longer files do not erase it. No checkpoint verdict is returned; use ./validator for your own checks."] : []),
          `You share ${ctx.config.budget.wall_seconds} seconds, ${ctx.config.subscription.max_tool_calls} tool calls, at most 8 sessions and delegation depth 4.`,
          "The native subscription client owns inference limits; do not assume an API token or generation cap.",
        ].join("\n");
        const result = await session("Inspect the workspace using exec and pursue GOAL.md. Finish by saving your shortest valid proofs.", system, "frontier");
        if (result.error) throw new Error(result.error);
      } else {
        for (const item of ctx.set.items) {
          remaining();
          const prompts = theoremPrompt(item.theorem, rules);
          const attemptPath = path.join(ctx.dir, "attempts", item.id + ".json");
          const attempt: AttemptRecord = { item_id: item.id, attempt: 1, started_at: new Date().toISOString(),
            request: { ...prompts, tools: [], provider: ctx.config.provider, model: ctx.config.model, effort: ctx.config.subscription.effort }, dispatch_state: "dispatched" };
          writeJsonExclusive(attemptPath, attempt);
          try {
            const result = await session(prompts.user, prompts.system, item.id);
            if (result.error) throw new Error(result.error);
            const verdict = await validateCandidate(path.join(ctx.dir, "referee/validator"), item.theorem, result.text);
            if (verdict.status === "valid") writeJsonExclusive(path.join(ctx.dir, "submissions", item.id + ".json"), parseProof(result.text));
            writeJson(attemptPath, { ...attempt, completed_at: new Date().toISOString(), raw_response: result.text,
              response: { session: state.client_sessions }, verdict, usage: result.usage, model: result.model,
              backend: `${ctx.config.provider}:${result.client_version}`, dispatch_state: "response_confirmed" });
          } catch (error) {
            writeJson(attemptPath, { ...attempt, completed_at: new Date().toISOString(), transport_error: message(error),
              verdict: { status: /protocol violation/i.test(message(error)) ? "protocol_error" : "transport_error", line_count: null, errors: [message(error)] }, dispatch_state: "uncertain" });
            // Never spend additional subscription attempts after an infrastructure,
            // authentication, quota, or transport failure. An invalid proof above
            // is a scored model outcome and does not stop the next fresh theorem.
            throw error;
          }
        }
      }
      state.status = "complete";
      state.finished_reason = "client_completed";
    } catch (error) {
      state.status = budgetError(error) ? "complete" : "interrupted";
      state.error = message(error);
      state.finished_reason = budgetError(error) ? "budget_exhausted" : "client_error";
    }
    state.client_completed_at = new Date().toISOString();
    const outcome = state.status;
    // Keep controller authorization live for already-running isolated execs
    // until their writers stop and their captured bytes finish verification.
    state.status = "running";
    acceptingTools = false;
    while (activeTools.size) await Promise.allSettled([...activeTools]);
    state.tools_drained_at = new Date().toISOString();
    checkpoints?.close();
    state.status = ownerFailure ? "interrupted" : outcome;
    if (ownerFailure) { state.error = message(ownerFailure); state.finished_reason = "owner_error"; }
    state.completed_at = new Date().toISOString();
    save();
    if (frontier) {
      const finalized = await finalizeControlledFrontier(ctx.dir, path.join(bundleDir, "proofs"), options.validator);
      if (finalized.contestant_rejection) { state.finished_reason = "contestant_submission_rejected"; state.error = finalized.contestant_rejection; save(); }
      return finalized.report;
    }
    return await gradeRun(ctx.dir, options.validator);
  } catch (error) {
    acceptingTools = false;
    state.status = "interrupted";
    state.error = message(error);
    state.completed_at = new Date().toISOString();
    if (fs.existsSync(stateFile)) save();
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    fs.closeSync(lock);
    fs.unlinkSync(path.join(ctx.dir, "subscription.lock"));
  }
}
