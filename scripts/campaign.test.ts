import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManifest, executeCampaign, type CampaignIdentity, type CampaignState } from "./campaign";
import type { PrepareOptions, RunContext, RunReport } from "../tracks/types";

const digest = "a".repeat(64);
const identity: CampaignIdentity = {
  set_version: "v2", set_hash: digest,
  set_ids: ["g1", "g2", "g3"].flatMap(band => Array.from({ length: 8 }, (_, i) => `${band}-${String(i + 1).padStart(2, "0")}`)),
  set_manifest_sha256: digest, rulebook_sha256: digest, validator_sha256: digest, evaluator_hash: digest,
  source_commit: null, runtime: { path: "/fake/codex", version: "test", sha256: digest, source: "test" },
};

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-campaign-test-"));
  const root = path.join(temp, "owner");
  const bundles = path.join(temp, "contestants");
  const calls: Array<{ item: string; mode: string; snapshot?: string }> = [];
  const prepare = (options: PrepareOptions, bundleDir?: string, archiveDir?: string): RunContext => {
    fs.mkdirSync(options.root, { recursive: true });
    const run_id = randomUUID();
    const dir = path.join(options.root, run_id);
    fs.mkdirSync(dir);
    if (bundleDir) {
      assert.equal(fs.existsSync(bundleDir), false);
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.mkdirSync(path.join(dir, "archives", "000001"), { recursive: true });
    }
    let starting_snapshot: string | null = null;
    if (archiveDir) {
      assert.match(archiveDir, new RegExp(`${options.ids![0]}--frontier-fresh`));
      starting_snapshot = JSON.parse(fs.readFileSync(path.join(archiveDir, "RECEIPT.json"), "utf8")).snapshot.digest;
    }
    calls.push({ item: options.ids![0], mode: options.mode, snapshot: archiveDir });
    return { dir, set: { version: "v2", core_tag: "test", hash: digest, items: [] }, config: {
      schema_version: "propbench-run-v1", scorer_version: "efficiency-v2", run_id, track: options.track, mode: options.mode,
      model: options.model, provider: options.provider, execution_protocol: options.track === "frontier" ? "frontier-subscription-v2" : "unaided-subscription-v1",
      subscription: options.subscription, temperature: options.temperature, budget: options.budget,
      starting_snapshot, set_version: "v2", set_hash: digest, selected_ids: options.ids!, core_tag: "test",
      validator_sha256: digest, rulebook_sha256: digest, evaluator_hash: digest, created_at: new Date().toISOString(),
    } };
  };
  const run = async (ctx: RunContext): Promise<RunReport> => {
    const key = `${ctx.config.selected_ids[0]}--${ctx.config.track === "unaided" ? "unaided" : `frontier-${ctx.config.mode}`}`;
    const receiptDir = path.join(root, "jobs");
    assert.ok(fs.readdirSync(receiptDir).some(name => name.startsWith(ctx.config.selected_ids[0] + "--") &&
      JSON.parse(fs.readFileSync(path.join(receiptDir, name), "utf8")).run_id === ctx.config.run_id), `receipt before model call: ${key}`);
    if (ctx.config.track === "frontier") {
      const final = path.join(ctx.dir, "archives", "000002");
      fs.mkdirSync(final);
      fs.writeFileSync(path.join(final, "RECEIPT.json"), JSON.stringify({ schema_version: "propbench-frontier-archive-v1", trigger: "import", snapshot: { digest } }));
    }
    const report = { config: ctx.config, evaluation_status: "complete", client_sessions: 1, evidence: "subscription" } as RunReport;
    fs.writeFileSync(path.join(ctx.dir, "report.json"), JSON.stringify(report));
    return report;
  };
  return { temp, root, bundles, calls, prepare, run, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

test("dry run is deterministic and does not create owner or contestant artifacts", async () => {
  const f = fixture();
  try {
    const options = { root: f.root, bundles: f.bundles, inspectIdentity: () => identity, dryRun: true };
    const a = await executeCampaign(options);
    const b = await executeCampaign(options);
    assert.deepEqual(a, b);
    assert.equal((a.manifest as ReturnType<typeof buildManifest>).jobs.length, 96);
    assert.equal((a.manifest as ReturnType<typeof buildManifest>).jobs.filter(job => job.condition === "frontier-cumulative").length, 24);
    assert.deepEqual((a.manifest as ReturnType<typeof buildManifest>).jobs.slice(0, 12).map(job => job.key),
      ["g1-01", "g2-01", "g3-01"].flatMap(id => ["unaided-1", "frontier-fresh", "unaided-2", "frontier-cumulative"].map(condition => `${id}--${condition}`)));
    assert.equal(fs.existsSync(f.root), false);
    assert.equal(fs.existsSync(f.bundles), false);
  } finally { f.cleanup(); }
});

test("all 96 jobs have receipts, isolated runs, and own fresh ancestry", async () => {
  const f = fixture();
  try {
    const result = await executeCampaign({ root: f.root, bundles: f.bundles, inspectIdentity: () => identity,
      prepare: f.prepare, run: f.run, maxInflight: 4, emit: () => undefined });
    assert.equal(result.complete, true);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, "state.json"), "utf8")) as CampaignState;
    const manifest = JSON.parse(fs.readFileSync(path.join(f.root, "manifest.json"), "utf8")) as ReturnType<typeof buildManifest>;
    assert.match(manifest.campaign_id, /^[a-f0-9-]{36}$/);
    assert.equal(manifest.jobs.length, 96);
    assert.equal(new Set(Object.values(state.jobs).map(job => job.run_id)).size, 96);
    assert.equal(Object.values(state.jobs).filter(job => job.status === "complete").length, 96);
    for (const item of identity.set_ids) {
      const fresh = state.jobs[`${item}--frontier-fresh`];
      const cumulative = state.jobs[`${item}--frontier-cumulative`];
      assert.equal(cumulative.seed_run_id, fresh.run_id);
      assert.equal(cumulative.inherited_archive, fresh.final_archive);
      assert.equal(cumulative.inherited_snapshot, fresh.final_snapshot);
      assert.notEqual(state.jobs[`${item}--unaided-1`].run_id, state.jobs[`${item}--unaided-2`].run_id);
    }
    assert.deepEqual(f.calls.slice(0, 4).map(call => call.mode), ["unaided", "fresh", "unaided", "unaided"]);
    assert.deepEqual(f.calls.slice(0, 4).map(call => call.item), ["g1-01", "g1-01", "g1-01", "g2-01"]);
    state.jobs["g1-01--frontier-fresh"].status = "running"; // final report landed just before controller exit
    fs.writeFileSync(path.join(f.root, "state.json"), JSON.stringify(state));
    const recovered = await executeCampaign({ root: f.root, bundles: f.bundles, inspectIdentity: () => identity,
      prepare: f.prepare, run: async () => { throw new Error("completed job was dispatched again"); },
      resume: true, emit: () => undefined });
    assert.equal(recovered.complete, true);
  } finally { f.cleanup(); }
});

test("identity drift stops before preparation and leaves every job queued", async () => {
  const f = fixture();
  try {
    let checks = 0;
    const result = await executeCampaign({ root: f.root, bundles: f.bundles,
      inspectIdentity: () => ++checks === 1 ? identity : { ...identity, rulebook_sha256: "b".repeat(64) },
      prepare: () => { throw new Error("must not prepare"); }, run: f.run, emit: () => undefined });
    assert.equal(result.dispatch_stopped, true);
    assert.equal((result.counts as Record<string, number>).queued, 96);
    assert.equal(fs.readdirSync(path.join(f.root, "jobs")).length, 0);
  } finally { f.cleanup(); }
});

test("quota stop preserves queued jobs; resume never repeats interrupted or crashed jobs", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const options = { root: f.root, bundles: f.bundles, inspectIdentity: () => identity, prepare: f.prepare,
      maxInflight: 1, emit: () => undefined };
    const first = await executeCampaign({ ...options, run: async ctx => { calls++; throw new Error("subscription quota exhausted"); } });
    assert.equal(first.dispatch_stopped, true);
    assert.equal(calls, 1);
    const stateFile = path.join(f.root, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as CampaignState;
    assert.equal(state.jobs["g1-01--unaided-1"].status, "interrupted");
    state.jobs["g1-01--frontier-fresh"].status = "running"; // simulated controller crash
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(path.join(f.root, "campaign.lock"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(executeCampaign({ ...options, run: f.run, resume: true }), /already active/);
    fs.unlinkSync(path.join(f.root, "campaign.lock"));
    const resumed = await executeCampaign({ ...options, run: f.run, resume: true });
    assert.equal(resumed.complete, false);
    assert.equal(calls, 1);
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8")) as CampaignState;
    assert.equal(after.jobs["g1-01--unaided-1"].status, "interrupted");
    assert.equal(after.jobs["g1-01--frontier-fresh"].status, "interrupted");
    assert.equal(after.jobs["g1-01--frontier-cumulative"].status, "queued");
    assert.ok((resumed.blocked_dependencies as number) >= 1);
    delete after.jobs["g3-08--unaided-2"];
    fs.writeFileSync(stateFile, JSON.stringify(after));
    await assert.rejects(executeCampaign({ ...options, run: f.run, resume: true }), /state does not match complete manifest/);
  } finally { f.cleanup(); }
});
