import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { prepareRun } = createRequire(import.meta.url)(path.join(PROJECT_ROOT, "tracks/core"));

test("campaign run groups stay live without grading and appear only after completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-tracks-route-"));
  const runs = path.join(root, "runs");
  const group = "r1--unaided-1";
  const groupDir = path.join(runs, group);
  fs.mkdirSync(groupDir, { recursive: true });
  const priorRoot = process.env.PROPBENCH_TRACK_RUN_ROOT;
  process.env.PROPBENCH_TRACK_RUN_ROOT = runs;
  const { default: router } = await import("./tracks");
  const ctx = prepareRun({ root: groupDir, setDir: path.join(PROJECT_ROOT, "golf/set/rehearsal"), ids: ["r1"],
    track: "unaided", mode: "unaided", provider: "codex-subscription", model: "gpt-6-astra", temperature: 0.2,
    budget: { wall_seconds: 900, max_generations: 1, max_output_tokens: 8192, max_thinking_tokens: 8192 },
    subscription: { effort: "xhigh", max_tool_calls: 0 }, validator: path.join(PROJECT_ROOT, "target/release/propbench") });
  const stateFile = path.join(root, "state.json");
  const saveCampaign = (status: string) => fs.writeFileSync(stateFile, JSON.stringify({ schema_version: "propbench-campaign-state-v1", jobs: {
    [group]: { status, run_id: ctx.config.run_id, run_dir: ctx.dir, started_at: ctx.config.created_at },
  } }));
  saveCampaign("prepared");
  const app = express();
  app.use("/api/tracks", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const get = async (endpoint: string) => {
      const response = await fetch(`${origin}/api/tracks/${endpoint}`);
      return { status: response.status, body: await response.json() as any };
    };

    const prepared = await get(`status/${ctx.config.run_id}`);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.state, "prepared");
    assert.equal(prepared.body.campaign_job, group);
    assert.equal((await get("reports")).body.reports.length, 0);
    assert.equal(fs.existsSync(path.join(ctx.dir, "report.json")), false, "GET created a report before dispatch");

    fs.writeFileSync(path.join(ctx.dir, "subscription.json"), JSON.stringify({ status: "running", started_at: ctx.config.created_at, client_sessions: 1, tool_calls: 0 }));
    saveCampaign("running");
    const running = await get(`status/${ctx.config.run_id}`);
    assert.equal(running.body.state, "running");
    assert.equal(running.body.client_sessions, 1);
    assert.equal((await get("")).body.active.some((job: any) => job.runId === ctx.config.run_id), true);
    assert.equal(fs.existsSync(path.join(ctx.dir, "report.json")), false);

    const frontierGroup = "r1--frontier-fresh";
    fs.mkdirSync(path.join(runs, frontierGroup));
    const frontier = prepareRun({ root: path.join(runs, frontierGroup), setDir: path.join(PROJECT_ROOT, "golf/set/rehearsal"), ids: ["r1"],
      track: "frontier", mode: "fresh", provider: "codex-subscription", model: "gpt-6-astra", temperature: 0.2,
      budget: { wall_seconds: 900, max_generations: 1, max_output_tokens: 8192, max_thinking_tokens: 8192 },
      subscription: { effort: "xhigh", max_tool_calls: 128 }, validator: path.join(PROJECT_ROOT, "target/release/propbench") });
    const receipts = path.join(frontier.dir, "candidate-receipts", "r1");
    fs.mkdirSync(receipts, { recursive: true });
    const receipt = (name: string, fields: Record<string, unknown>) => fs.writeFileSync(path.join(receipts, `${name}.json`), JSON.stringify({
      schema_version: "propbench-frontier-candidate-v1", import_id: name, theorem_id: "r1", accepted: true,
      verdict: { status: "valid", line_count: 9 }, checkpoint: { checkpoint_id: name, execution_command: 1, captured_at: new Date().toISOString() },
      ...fields,
    }));
    receipt("000001", {});
    receipt("000002", { verdict: { status: "valid", line_count: 7 } });
    receipt("000003", { accepted: false, verdict: { status: "valid", line_count: 3 } });
    receipt("000004", { verdict: { status: "invalid", line_count: 2 } });
    receipt("000005", { verdict: { status: "valid", line_count: 1 }, checkpoint: undefined });
    receipt("000006", { theorem_id: "wrong", verdict: { status: "valid", line_count: 1 } });
    fs.writeFileSync(stateFile, JSON.stringify({ schema_version: "propbench-campaign-state-v1", jobs: {
      [group]: { status: "running", run_id: ctx.config.run_id, run_dir: ctx.dir, started_at: ctx.config.created_at },
      [frontierGroup]: { status: "running", run_id: frontier.config.run_id, run_dir: frontier.dir, started_at: frontier.config.created_at },
    } }));
    const frontierStatus = await get(`status/${frontier.config.run_id}`);
    assert.equal(frontierStatus.status, 200);
    assert.equal(frontierStatus.body.state, "running");
    assert.deepEqual(frontierStatus.body.checkpoint_progress, { theorems: [{ id: "r1", best_lines: 7, accepted_improvements: 2 }], accepted_improvements: 2 });
    assert.equal((await get("")).body.active.find((job: any) => job.runId === frontier.config.run_id)?.checkpoint_progress.theorems[0].best_lines, 7);
    assert.equal(fs.existsSync(path.join(frontier.dir, "report.json")), false, "live checkpoint inspection must never grade a run");

    const report = { schema_version: "propbench-report-v1", config: ctx.config, cohort: "test-cohort", score: 1,
      graded_at: new Date().toISOString(), evaluation_status: "complete", evidence: "subscription", client_sessions: 1,
      total: 1, valid_count: 0, valid_rate: 0, total_lines: 0, mean_valid_lines: null, generations: null,
      items: [{ id: "r1", par: 1, status: "missing", line_count: null, errors: [], loss: 1 }], usage: {} };
    fs.writeFileSync(path.join(ctx.dir, "report.json"), JSON.stringify(report));
    assert.equal((await get("reports")).body.reports.length, 0, "in-flight report was exposed before campaign commit");
    fs.writeFileSync(path.join(ctx.dir, "subscription.json"), JSON.stringify({ status: "complete", started_at: ctx.config.created_at,
      completed_at: new Date().toISOString(), client_sessions: 1, tool_calls: 0 }));
    saveCampaign("complete");
    const completed = await get("reports");
    assert.equal(completed.body.reports.length, 1);
    assert.equal(completed.body.leaderboards[0].entries.length, 1);
    assert.equal((await get(`runs/${ctx.config.run_id}`)).body.report.config.run_id, ctx.config.run_id);
    assert.equal((await get(`status/${ctx.config.run_id}`)).body.state, "complete");

    saveCampaign("interrupted");
    const interrupted = await get("reports");
    assert.equal(interrupted.body.reports[0].evaluation_status, "interrupted");
    assert.equal(interrupted.body.leaderboards.length, 0);
    assert.equal((await get(`status/${ctx.config.run_id}`)).body.state, "error");

    const flat = prepareRun({ root: runs, setDir: path.join(PROJECT_ROOT, "golf/set/rehearsal"), ids: ["r1"],
      track: "unaided", mode: "unaided", provider: "fixture", model: "fixture-v1", temperature: 0.2,
      budget: { wall_seconds: 300, max_generations: 1, max_output_tokens: 4096, max_thinking_tokens: 8192 },
      validator: path.join(PROJECT_ROOT, "target/release/propbench") });
    fs.writeFileSync(path.join(flat.dir, "report.json"), JSON.stringify({ ...report, config: flat.config, cohort: "flat-cohort", evidence: "fixture" }));
    assert.equal((await get(`status/${flat.config.run_id}`)).body.state, "complete");
    assert.equal((await get("reports")).body.reports.length, 2, "flat GUI runs remain visible beside campaign runs");

    const duplicateGroup = path.join(runs, "r2--unaided-2");
    fs.mkdirSync(path.join(duplicateGroup, ctx.config.run_id), { recursive: true });
    const duplicate = await get("reports");
    assert.equal(duplicate.status, 500);
    assert.match(duplicate.body.error, /Duplicate track run ID/);
    fs.rmSync(duplicateGroup, { recursive: true });

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-route-outside-"));
    try {
      fs.symlinkSync(outside, path.join(runs, "r2--frontier-fresh"));
      const escaped = await get("reports");
      assert.equal(escaped.status, 500);
      assert.match(escaped.body.error, /real directory/);
    } finally { fs.rmSync(outside, { recursive: true }); }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (priorRoot === undefined) delete process.env.PROPBENCH_TRACK_RUN_ROOT;
    else process.env.PROPBENCH_TRACK_RUN_ROOT = priorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
