import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { PROJECT_ROOT, prepareRun, readJson } from "./core";
import { runUnaided } from "./unaided";
import type { RunContext } from "./types";

const SET_DIR = path.join(PROJECT_ROOT, "golf/set/rehearsal");
const VALIDATOR = path.join(PROJECT_ROOT, "target/release/propbench");

function newRun(provider: "fixture" | "openrouter" | "gemini"): { root: string; ctx: RunContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-unaided-test-"));
  const ctx = prepareRun({
    root,
    setDir: SET_DIR,
    track: "unaided",
    mode: "unaided",
    model: provider === "fixture" ? "fixture-model" : "openai/test-model",
    provider,
    temperature: 0,
    budget: {
      wall_seconds: 5,
      max_generations: 1,
      max_output_tokens: 256,
      max_thinking_tokens: 0,
    },
    validator: VALIDATOR,
  });
  return { root, ctx };
}

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

async function withOpenRouterKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "unaided-test-secret";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
}

function removeRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test("fixture mode performs a single final generation and revalidates its submission", async () => {
  const { root, ctx } = newRun("fixture");
  try {
    const proof = JSON.stringify([
      { line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 },
    ]);
    const report = await runUnaided(ctx, {
      validator: VALIDATOR,
      fixtureResponses: { r1: proof },
    });

    assert.equal(report.evidence, "fixture");
    assert.equal(report.valid_count, 1);
    assert.equal(report.generations, 1);
    assert.deepEqual(report.returned_models, [], "a configured label is not a returned provider identity");
    assert.equal(report.items[0]?.status, "valid");
    assert.equal(report.items[0]?.line_count, 1);
    assert.equal(fs.existsSync(path.join(ctx.dir, "submissions/r1.json")), true);

    const attempt = readJson<Record<string, unknown>>(path.join(ctx.dir, "attempts/r1.json"));
    assert.equal((attempt.verdict as { status: string }).status, "valid");
    assert.equal(attempt.raw_response, proof);
    assert.equal((attempt.request as { provider: string }).provider, "fixture");

    await assert.rejects(
      () => runUnaided(ctx, { validator: VALIDATOR, fixtureResponses: { r1: proof } }),
      /populated unaided run|graded unaided run/,
    );
  } finally {
    removeRoot(root);
  }
});

test("network request has no tool surface and tool-call responses are never dispatched", async () => {
  await withOpenRouterKey(async () => {
    const { root, ctx } = newRun("openrouter");
    try {
      let fetches = 0;
      let requestBody: Record<string, unknown> | undefined;
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        fetches += 1;
        assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          model: "returned-model",
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "execute", arguments: "touch /tmp/unaided-must-not-run" },
              }],
            },
          }],
        });
      }) as typeof fetch;

      const report = await runUnaided(ctx, { validator: VALIDATOR, fetchImpl });
      assert.equal(fetches, 1);
      assert.equal(report.items[0]?.status, "protocol_error");
      assert.equal(report.generations, 1);
      assert.equal(fs.existsSync("/tmp/unaided-must-not-run"), false);
      assert.equal(requestBody?.tools, undefined);
      assert.equal(requestBody?.tool_choice, undefined);
      assert.equal(requestBody?.functions, undefined);
      assert.equal(requestBody?.plugins, undefined);
      const messages = requestBody?.messages as Array<{ role: string; content: string }>;
      assert.equal(messages.length, 2);
      assert.match(messages[0].content, /shared rules\.md/);
      assert.match(messages[1].content, /"conclusion": "Q"/);

      const saved = fs.readFileSync(path.join(ctx.dir, "attempts/r1.json"), "utf8");
      assert.equal(saved.includes("unaided-test-secret"), false);
      const attempt = readJson<Record<string, unknown>>(path.join(ctx.dir, "attempts/r1.json"));
      assert.equal(attempt.model, "returned-model");
      assert.equal(attempt.completion_reason, "tool_calls");
    } finally {
      removeRoot(root);
    }
  });
});

test("malformed output and transport uncertainty each consume exactly one request", async () => {
  await withOpenRouterKey(async () => {
    const cases: Array<{
      name: string;
      fetchImpl: typeof fetch;
      expected: "parse_error" | "transport_error" | "invalid";
    }> = [
      {
        name: "malformed",
        fetchImpl: (async () => {
          return response({
            model: "returned-model",
            choices: [{ message: { content: "this is not JSON" }, finish_reason: "stop" }],
          });
        }) as typeof fetch,
        expected: "parse_error",
      },
      {
        name: "wrong-premise-offset",
        fetchImpl: (async () => {
          return response({
            model: "returned-model",
            choices: [{
              message: {
                content: JSON.stringify([
                  { line_number: 1, formula: "Q", justification: "MP 1,2", depth: 0 },
                ]),
              },
              finish_reason: "stop",
            }],
          });
        }) as typeof fetch,
        expected: "invalid",
      },
      {
        name: "transport",
        fetchImpl: (async () => {
          throw new Error("network uncertainty");
        }) as typeof fetch,
        expected: "transport_error",
      },
    ];

    for (const current of cases) {
      const { root, ctx } = newRun("openrouter");
      try {
        let fetches = 0;
        const countingFetch = (async (url: string | URL, init?: RequestInit) => {
          fetches += 1;
          return current.fetchImpl(url, init);
        }) as typeof fetch;
        const report = await runUnaided(ctx, {
          validator: VALIDATOR,
          fetchImpl: countingFetch,
        });
        assert.equal(fetches, 1, current.name);
        assert.equal(report.items[0]?.status, current.expected, current.name);
        assert.equal(report.generations, 1, current.name);
      } finally {
        removeRoot(root);
      }
    }
  });
});

test("Gemini uses one bounded credential-free persisted request and records available usage", async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-secret/+";
  const { root, ctx } = newRun("gemini");
  try {
    let requests = 0;
    const proof = [{ line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 }];
    const report = await runUnaided(ctx, { validator: VALIDATOR, fetchImpl: (async (url, init) => {
      requests++;
      assert.equal(String(url).includes("key="), false);
      assert.equal((init?.headers as Record<string,string>)["x-goog-api-key"], "test-gemini-secret/+");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
      assert.equal(body.generationConfig.maxOutputTokens, 256);
      assert.equal(body.tools, undefined);
      assert.equal(body.contents.length, 1);
      assert.deepEqual(Object.keys(JSON.parse(body.contents[0].parts[0].text.split("THEOREM (JSON)\n")[1].split("\n\n")[0])).sort(), ["conclusion", "premises"]);
      return new Response(JSON.stringify({ modelVersion: "test-returned", candidates: [{ content: { parts: [{ text: JSON.stringify(proof) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 0, totalTokenCount: 50 } }));
    }) as typeof fetch });
    assert.equal(requests, 1);
    assert.equal(report.valid_count, 1);
    assert.deepEqual(report.usage_coverage, { attempts_with_usage: 1, attempts: 1 });
    assert.equal(report.usage.total_tokens, 50);
    const saved = fs.readFileSync(path.join(ctx.dir, "attempts/r1.json"), "utf8");
    assert.equal(saved.includes("test-gemini-secret"), false);
  } finally {
    removeRoot(root);
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("OpenRouter disables routing retries and requests the declared total token cap", async () => {
  await withOpenRouterKey(async () => {
    const { root, ctx } = newRun("openrouter");
    try {
      const report = await runUnaided(ctx, { validator: VALIDATOR, fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_tokens, 256);
        assert.deepEqual(body.reasoning, { enabled: false, exclude: true });
        assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true });
        return new Response('{broken provider envelope', { status: 502 });
      }) as typeof fetch });
      assert.equal(report.items[0].status, "transport_error");
      assert.equal(report.generations, 1);
      const record = readJson(path.join(ctx.dir, "attempts/r1.json"));
      assert.equal(record.response, '{broken provider envelope');
      assert.match(record.transport_error, /502/);
    } finally { removeRoot(root); }
  });
});

test("a concurrent runner cannot earn a second generation while the first request is pending", async () => {
  await withOpenRouterKey(async () => {
    const { root, ctx } = newRun("openrouter");
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    try {
      const fetchImpl = (async () => { calls++; await hold; return response({ choices: [{ message: { content: "[]", tool_calls: null } }] }); }) as typeof fetch;
      const first = runUnaided(ctx, { validator: VALIDATOR, fetchImpl });
      await assert.rejects(runUnaided(ctx, { validator: VALIDATOR, fetchImpl }), /populated/);
      release();
      const report = await first;
      assert.equal(calls, 1);
      assert.equal(report.generations, 1);
      assert.equal(report.items[0].status, "invalid");
    } finally { release(); removeRoot(root); }
  });
});

test("generation and wall budgets leave unattempted items missing without retries", async () => {
  await withOpenRouterKey(async () => {
    for (const expires of [false, true]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-budget-test-"));
      try {
        const ctx = prepareRun({ root, setDir: path.join(PROJECT_ROOT, "golf/set/v2"), track: "unaided", mode: "unaided", provider: "openrouter", model: "test-model", temperature: 0,
          budget: { wall_seconds: expires ? 1 : 5, max_generations: expires ? 24 : 1, max_output_tokens: 256, max_thinking_tokens: 0 }, validator: VALIDATOR });
        let calls = 0;
        const report = await runUnaided(ctx, { validator: VALIDATOR, fetchImpl: (async (_url, init) => {
          calls++;
          if (expires) return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          return response({ choices: [{ message: { content: "not a proof" } }] });
        }) as typeof fetch });
        assert.equal(calls, 1);
        assert.equal(report.generations, 1);
        assert.equal(report.items[0].status, expires ? "transport_error" : "parse_error");
        assert.equal(report.items.slice(1).every(item => item.status === "missing"), true);
        assert.equal(fs.readdirSync(path.join(ctx.dir, "attempts")).length, 1);
      } finally { removeRoot(root); }
    }
  });
});

test("provider metadata about functions is retained without inventing a tool call", async () => {
  await withOpenRouterKey(async () => {
    const { root, ctx } = newRun("openrouter");
    try {
      const report = await runUnaided(ctx, { validator: VALIDATOR, fetchImpl: (async () => response({
        model: "resolved-model", provider: "resolved-backend",
        annotations: { type: "function_call", function: { name: "metadata-only" } },
        choices: [{ message: { content: JSON.stringify([{ line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 }]), tool_calls: null } }],
      })) as typeof fetch });
      assert.equal(report.valid_count, 1);
      assert.deepEqual(report.returned_models, ["resolved-model"]);
      assert.deepEqual(report.returned_backends, ["resolved-backend"]);
      assert.equal(readJson(path.join(ctx.dir, "attempts/r1.json")).response.annotations.type, "function_call");
    } finally { removeRoot(root); }
  });
});
