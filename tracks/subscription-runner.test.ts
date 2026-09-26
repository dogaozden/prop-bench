import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cohortKey, prepareRun, PROJECT_ROOT, readJson } from "./core";
import { prepareFrontier, submitFrontier, finalizeControlledFrontier } from "./frontier";
import * as bridge from "./bridge";
import * as sandbox from "./sandbox";
import * as core from "./core";
import { runSubscription } from "./subscription-runner";
import type { SubscriptionSessionResult } from "./subscription-types";
import { CodexProcessCleanupError } from "./codex-process";

const validator = path.join(PROJECT_ROOT, "target/release/propbench");
const proof = JSON.stringify([{ line_number: 3, formula: "Q", justification: "MP 1,2", depth: 0 }]);
const result: SubscriptionSessionResult = { text: proof, model: "observed-model", client_version: "test-client", auth_type: "chatgpt", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, tool_calls: [], available_tools: [] };
function newRun(v2 = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-subscription-test-"));
  const options = { root, setDir: path.join(PROJECT_ROOT, "golf/set", v2 ? "v2" : "rehearsal"),
    ...(v2 ? { ids: ["g1-2000001", "g2-2100023"] } : {}),
    track: "unaided" as const, mode: "unaided" as const, provider: "codex-subscription" as const, model: "configured-model",
    subscription: { effort: "xhigh", max_tool_calls: 0 }, temperature: 0.2,
    budget: { wall_seconds: 10, max_generations: 1, max_output_tokens: 32, max_thinking_tokens: 0 }, validator };
  return { root, options, ctx: prepareRun(options) };
}

test("subscription Unaided has a fresh empty cwd, no tools, one session, and independent grading", async () => {
  const { root, ctx } = newRun();
  let calls = 0;
  try {
    const report = await runSubscription(ctx, { validator, sessionClient: async options => {
      calls++;
      assert.equal(options.tools, undefined);
      assert.deepEqual(fs.readdirSync(options.cwd), []);
      assert.match(options.prompt, /THEOREM/);
      assert.match(options.systemPrompt, /MP 1,2/);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10000);
      return result;
    } });
    assert.equal(calls, 1);
    assert.equal(report.score, 0.5);
    assert.equal(report.generations, null);
    assert.equal(report.client_sessions, 1);
    assert.equal(report.evidence, "fixture", "injected clients cannot masquerade as live subscription results");
    assert.deepEqual(report.returned_models, ["observed-model"]);
    assert.equal(report.usage.total_tokens, 30);
    await assert.rejects(runSubscription(ctx, { validator, sessionClient: async () => result }), /reuse/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a historical Claude provider cannot dispatch new subscription inference",async()=>{
  const {root,options}=newRun();
  try {
    const ctx=prepareRun({...options,provider:"claude-subscription"});
    let calls=0;
    await assert.rejects(runSubscription(ctx,{validator,sessionClient:async()=>{calls++;return result;}}),/native Codex/);
    assert.equal(calls,0);
    assert.equal(fs.existsSync(path.join(ctx.dir,"subscription.json")),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("Unaided rejects a client that exposes or calls a computation tool", async () => {
  const { root, ctx } = newRun();
  try {
    const report = await runSubscription(ctx, { validator, sessionClient: async () => ({ ...result, available_tools: ["exec"] }) });
    assert.equal(report.valid_count, 0);
    assert.equal(report.items[0].status, "protocol_error");
    assert.equal(report.evaluation_status, "interrupted");
    assert.equal(fs.existsSync(path.join(ctx.dir, "submissions/r1.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the owner deadline cancels the client and rejects a late proof", async () => {
  const {root,options} = newRun();
  try {
    const ctx = prepareRun({...options,budget:{...options.budget,wall_seconds:1}});
    let observedAbort = false;
    const report = await runSubscription(ctx,{validator,sessionClient:async session => {
      await new Promise<void>(resolve=>session.signal!.addEventListener("abort",()=>{observedAbort=true;resolve();},{once:true}));
      return result;
    }});
    assert.equal(observedAbort,true);
    assert.equal(report.valid_count,0);
    assert.equal(fs.existsSync(path.join(ctx.dir,"submissions/r1.json")),false);
    assert.equal(readJson<any>(path.join(ctx.dir,"subscription.json")).finished_reason,"budget_exhausted");
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("controlled finalization rejects another proofs directory before sealing", async () => {
  const {root,options} = newRun();
  try {
    const bundle = path.join(root,"bundle");
    const ctx = prepareFrontier({...options,root:path.join(root,"runs"),track:"frontier",mode:"fresh",subscription:{effort:"xhigh",max_tool_calls:4}},bundle);
    fs.writeFileSync(path.join(ctx.dir,"controller.json"),JSON.stringify({status:"complete"}));
    const other = path.join(root,"other-proofs"); fs.mkdirSync(other); fs.writeFileSync(path.join(other,"r1.json"),proof);
    await assert.rejects(finalizeControlledFrontier(ctx.dir,other,validator),/registered contestant/);
    assert.equal(fs.existsSync(path.join(ctx.dir,"controlled-finalization.json")),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("quota failures consume one attempt and stop further subscription dispatch", async () => {
  const { root, ctx } = newRun(true);
  let calls = 0;
  try {
    const report = await runSubscription(ctx, { validator, sessionClient: async () => { calls++; throw new Error("You've hit your session limit"); } });
    assert.equal(calls, 1);
    assert.equal(report.client_sessions, 1);
    assert.equal(report.items[1].status, "missing");
    assert.equal(report.evaluation_status, "interrupted");
    assert.match(readJson(path.join(ctx.dir, "subscription.json")).error, /session limit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an upstream timeout is an interrupted run, not a completed harness budget", async () => {
  const {root,ctx} = newRun(true);
  let calls=0;
  try {
    const report=await runSubscription(ctx,{validator,sessionClient:async()=>{calls++;throw new Error("upstream request timed out");}});
    assert.equal(calls,1);
    assert.equal(report.evaluation_status,"interrupted");
    assert.equal(report.items[1].status,"missing");
    assert.equal(readJson<any>(path.join(ctx.dir,"subscription.json")).finished_reason,"client_error");
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("invalid model proof is final but does not stop the next fresh theorem", async () => {
  const { root, ctx } = newRun(true);
  let calls = 0;
  try {
    const report = await runSubscription(ctx, { validator, sessionClient: async () => { calls++; return { ...result, text: "not proof JSON" }; } });
    assert.equal(calls, 2);
    assert.equal(report.client_sessions, 2);
    assert.equal(report.valid_count, 0);
    assert.equal(report.evaluation_status, "complete");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("subscription cohorts use enforced effort/time/tool settings, not unused API token controls", () => {
  const { root, ctx } = newRun();
  try {
    const changedTokens = { ...ctx.config, temperature: 1, budget: { ...ctx.config.budget, max_output_tokens: 8192, max_thinking_tokens: 8192 } };
    assert.equal(cohortKey(ctx.config), cohortKey(changedTokens));
    assert.notEqual(cohortKey(ctx.config), cohortKey({ ...ctx.config, subscription: { effort: "max", max_tool_calls: 0 } }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("subscription Frontier cannot be improved by off-budget public imports", async () => {
  const { root, options } = newRun();
  try {
    const ctx = prepareFrontier({ ...options, root: path.join(root, "frontier-runs"), track: "frontier", mode: "fresh", subscription: { effort: "max", max_tool_calls: 10 } }, path.join(root, "bundle"));
    assert.equal(ctx.config.execution_protocol, "frontier-subscription-v2");
    await assert.rejects(submitFrontier(ctx.dir, path.join(root, "bundle/proofs"), validator), /sealed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Frontier serial exec checkpoints survive overwrites and do not expose owner verdict feedback", async t => {
  const { root, options } = newRun();
  try {
    const bundle = path.join(root, "bundle");
    const ctx = prepareFrontier({ ...options, root: path.join(root, "runs"), track: "frontier", mode: "fresh", subscription: { effort: "xhigh", max_tool_calls: 10 } }, bundle);
    t.mock.method(sandbox, "inspectRuntime", async () => ({ backend: "docker", image_id: "sha256:" + "a".repeat(64), architecture: "arm64" }));
    let calls = 0;
    t.mock.method(bridge, "executeForRun", async (runDir: string, command: string[], controlled: bridge.ControlledExecutionOptions) => {
      assert.ok(controlled);
      const number = ++calls;
      const lock = path.join(runDir, "execution.lock");
      fs.writeFileSync(lock, "", { flag: "wx" });
      try {
        fs.writeFileSync(path.join(bundle, "proofs/r1.json"), command[0] === "short" ? proof : "[]");
        fs.writeFileSync(path.join(runDir, "execution.json"), JSON.stringify({ commands: number }));
        fs.writeFileSync(path.join(runDir, `exec-${String(number).padStart(6, "0")}.json`), JSON.stringify({ completed_at: new Date().toISOString() }));
        await controlled.afterExecution(number);
        return { stdout: "saved", stderr: "", exitCode: 0 };
      } finally { fs.unlinkSync(lock); }
    });
    const report = await runSubscription(ctx, { validator, sessionClient: async session => {
      assert.match(session.systemPrompt, /retains each shortest valid incumbent/);
      const outcomes = await Promise.all([session.tools!.exec(["short"]), session.tools!.exec(["invalid"])]);
      assert.deepEqual(outcomes, [{ stdout: "saved", stderr: "", exitCode: 0 }, { stdout: "saved", stderr: "", exitCode: 0 }]);
      fs.writeFileSync(path.join(bundle, "proofs/r1.json"), "mutable file after the last controlled execution");
      return result;
    } });
    assert.equal(calls, 2);
    assert.equal(report.items[0].line_count, 1);
    assert.equal(report.evidence, "fixture");
    assert.equal(readJson<any>(path.join(ctx.dir, "checkpoint-seal.json")).checkpoints, 2);
    assert.equal(readJson<any>(path.join(ctx.dir, "candidate-receipts/r1/000002.json")).accepted, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Frontier excludes a proof first observed after the cutoff even when mutable files remain", async t => {
  const { root, options } = newRun();
  try {
    const bundle = path.join(root, "bundle");
    const ctx = prepareFrontier({ ...options, root: path.join(root, "runs"), track: "frontier", mode: "fresh", budget: { ...options.budget, wall_seconds: 1 }, subscription: { effort: "xhigh", max_tool_calls: 10 } }, bundle);
    t.mock.method(sandbox, "inspectRuntime", async () => ({ backend: "docker", image_id: "sha256:" + "a".repeat(64), architecture: "arm64" }));
    t.mock.method(bridge, "executeForRun", async (runDir: string, _command: string[], controlled: bridge.ControlledExecutionOptions) => {
      const lock = path.join(runDir, "execution.lock");
      fs.writeFileSync(lock, "", { flag: "wx" });
      try {
        await new Promise<void>(resolve => controlled.signal.addEventListener("abort", () => resolve(), { once: true }));
        fs.writeFileSync(path.join(bundle, "proofs/r1.json"), proof);
        fs.writeFileSync(path.join(runDir, "execution.json"), JSON.stringify({ commands: 1 }));
        fs.writeFileSync(path.join(runDir, "exec-000001.json"), JSON.stringify({ completed_at: new Date().toISOString() }));
        await controlled.afterExecution(1);
        return { stdout: "late", stderr: "", exitCode: 0 };
      } finally { fs.unlinkSync(lock); }
    });
    const report = await runSubscription(ctx, { validator, sessionClient: async session => {
      await session.tools!.exec(["late"]);
      return result;
    } });
    assert.equal(report.valid_count, 0);
    assert.equal(readJson<any>(path.join(ctx.dir, "subscription.json")).finished_reason, "budget_exhausted");
    assert.equal(readJson<any>(path.join(ctx.dir, "checkpoint-seal.json")).checkpoints, 0);
    assert.equal(fs.existsSync(path.join(ctx.dir, "submissions/r1.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("owner checkpoint verification failures interrupt the run even if the model catches its tool error", async t => {
  const { root, options } = newRun();
  try {
    const bundle = path.join(root, "bundle");
    const ctx = prepareFrontier({ ...options, root: path.join(root, "runs"), track: "frontier", mode: "fresh", subscription: { effort: "xhigh", max_tool_calls: 10 } }, bundle);
    const runtime = { backend: "docker" as const, image_id: "sha256:" + "a".repeat(64), architecture: "arm64" };
    t.mock.method(sandbox, "inspectRuntime", async () => runtime);
    t.mock.method(sandbox, "runSandbox", async () => {
      fs.writeFileSync(path.join(bundle, "proofs/r1.json"), proof);
      return { stdout: "saved", stderr: "", exitCode: 0, runtime };
    });
    t.mock.method(core, "validateCandidate", async () => { throw new Error("Owner verifier could not be started"); });
    const report = await runSubscription(ctx, { validator, sessionClient: async session => {
      await session.tools!.exec(["true"]).catch(() => undefined);
      return result;
    } });
    assert.equal(report.evaluation_status, "interrupted");
    assert.equal(readJson<any>(path.join(ctx.dir, "subscription.json")).finished_reason, "owner_error");
    assert.equal(fs.existsSync(path.join(ctx.dir, "submissions/r1.json")), false);
    assert.equal(fs.existsSync(path.join(ctx.dir, "checkpoints/000001.json")), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("finalization drains a delegated execution and rejects queued work after the root client finishes", async t => {
  const { root, options } = newRun();
  try {
    const bundle = path.join(root, "bundle");
    const ctx = prepareFrontier({ ...options, root: path.join(root, "runs"), track: "frontier", mode: "fresh", subscription: { effort: "xhigh", max_tool_calls: 10 } }, bundle);
    const runtime = { backend: "docker" as const, image_id: "sha256:" + "a".repeat(64), architecture: "arm64" };
    const commands: string[] = [];
    t.mock.method(sandbox, "inspectRuntime", async () => runtime);
    t.mock.method(sandbox, "runSandbox", async (_bundle: string, command: string[]) => {
      commands.push(command[0]);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(path.join(ctx.dir, "controlled-finalization.json")), false);
      fs.writeFileSync(path.join(bundle, "proofs/r1.json"), proof);
      return { stdout: "saved", stderr: "", exitCode: 0, runtime };
    });
    const report = await runSubscription(ctx, { validator, sessionClient: async session => {
      if (session.prompt === "child") {
        await session.tools!.exec(["delegated"]);
      } else {
        void session.tools!.delegate("child").catch(() => undefined);
        void session.tools!.exec(["queued"]).catch(() => undefined);
      }
      return result;
    } });
    assert.deepEqual(commands, ["delegated"]);
    assert.equal(report.items[0].line_count, 1);
    assert.equal(report.client_sessions, 2);
    assert.equal(readJson<any>(path.join(ctx.dir, "checkpoint-seal.json")).checkpoints, 1);
    assert.equal(fs.existsSync(path.join(ctx.dir, "execution.lock")), false);
    assert.equal(readJson<any>(path.join(ctx.dir, "tool-events/000003.json")).error, "Subscription run is closed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("owner rejection receipts charge the shared allowance without execution or delegation",async t=>{
  const {root,options}=newRun();
  try {
    const bundle=path.join(root,"bundle");
    const ctx=prepareFrontier({...options,root:path.join(root,"runs"),track:"frontier",mode:"fresh",subscription:{effort:"xhigh",max_tool_calls:4}},bundle);
    t.mock.method(sandbox,"inspectRuntime",async()=>({backend:"docker",image_id:"sha256:"+"a".repeat(64),architecture:"arm64"}));
    let executions=0,sessions=0;
    t.mock.method(bridge,"executeForRun",async()=>{executions++;return {stdout:"READY",stderr:"",exitCode:0};});
    const report=await runSubscription(ctx,{validator,sessionClient:async session=>{
      sessions++;
      assert.ok(session.tools?.reject);
      const malformed=[
        {tool:"exec" as const,arguments:{command:["echo","READY"],timeout:10},native_call_id:"extra-timeout"},
        {tool:"delegate" as const,arguments:{task:5},native_call_id:"invalid-task"},
        {tool:"exec" as const,arguments:null,native_call_id:"nonobject"},
      ];
      for(const input of malformed){const rejected:any=await session.tools.reject(input);assert.equal(rejected.error.code,"invalid_tool_arguments");assert.ok(rejected.error.message.length<200);}
      assert.equal(executions,0);assert.equal(sessions,1);
      await session.tools.exec(["echo","READY"]);
      await assert.rejects(session.tools.reject(malformed[0]),/tool allowance exhausted/);
      return result;
    }});
    assert.equal(report.evaluation_status,"complete");assert.equal(executions,1);assert.equal(sessions,1);
    assert.equal(readJson<any>(path.join(ctx.dir,"subscription.json")).tool_calls,4);
    const files=fs.readdirSync(path.join(ctx.dir,"tool-events")).sort();assert.equal(files.length,4);
    const receipt=readJson<any>(path.join(ctx.dir,"tool-events",files[0]));
    assert.equal(receipt.outcome,"input_rejected");assert.equal(receipt.native_call_id,"extra-timeout");
    assert.deepEqual(receipt.input,{command:["echo","READY"],timeout:10});assert.equal(receipt.result.error.code,"invalid_tool_arguments");
    assert.ok(receipt.completed_at);assert.equal(readJson<any>(path.join(ctx.dir,"tool-events",files[1])).tool,"delegate");
    assert.equal(readJson<any>(path.join(ctx.dir,"tool-events",files[2])).input,null);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("delegated native cleanup failure overrides a root budget outcome during tool drain",async t=>{
  const {root,options}=newRun();
  try {
    const ctx=prepareFrontier({...options,root:path.join(root,"runs"),track:"frontier",mode:"fresh",subscription:{effort:"xhigh",max_tool_calls:4}},path.join(root,"bundle"));
    t.mock.method(sandbox,"inspectRuntime",async()=>({backend:"docker",image_id:"sha256:"+"a".repeat(64),architecture:"arm64"}));
    const report=await runSubscription(ctx,{validator,sessionClient:async session=>{
      if(session.prompt==="child") {
        await new Promise(resolve=>setTimeout(resolve,20));
        throw new CodexProcessCleanupError("Codex process cleanup failed: termination of native process/group 4242 is unconfirmed");
      }
      void session.tools!.delegate("child").catch(()=>undefined);
      throw new Error("Codex session wall-clock timeout");
    }});
    assert.equal(report.evaluation_status,"interrupted");
    const state=readJson<any>(path.join(ctx.dir,"subscription.json"));
    assert.equal(state.finished_reason,"owner_error");assert.match(state.error,/cleanup failed.*unconfirmed/);
    assert.equal(readJson<any>(path.join(ctx.dir,"sessions/000002.json")).dispatch_state,"uncertain");
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
