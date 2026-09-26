import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical } from "../tracks/core";
import { buildManifest, type CampaignIdentity, type CampaignState } from "./campaign";
import { recoverCrashedCampaign } from "./recover-campaign";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const digest = "a".repeat(64);
const identity: CampaignIdentity = { set_version: "v2", set_hash: digest,
  set_ids: ["g1", "g2", "g3"].flatMap(band => Array.from({ length: 8 }, (_, index) => `${band}-${String(index).padStart(2, "0")}`)),
  set_manifest_sha256: digest, rulebook_sha256: digest, validator_sha256: digest, evaluator_hash: digest,
  source_commit: "f".repeat(40), runtime: { path: "/test/codex", source: "test", version: "test", sha256: digest } };

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-recover-test-"));
  const root = path.join(temp, "owner");
  fs.mkdirSync(root);
  const manifest = buildManifest(root, path.join(temp, "bundles"), "/test/validator", "/test/set", identity,
    { campaign_id: "pilot-1", created_at: "2026-09-25T00:00:00Z" });
  const state: CampaignState = { schema_version: "propbench-campaign-state-v1", manifest_sha256: sha(canonical(manifest)),
    created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", dispatch_stopped: true,
    jobs: Object.fromEntries(manifest.jobs.map(job => [job.key, { status: "queued" }])) };
  const running = manifest.jobs[0];
  const runId = "00000000-0000-4000-8000-000000000001";
  const runDir = path.join(root, "runs", running.key, runId);
  fs.mkdirSync(path.join(runDir, "candidate-receipts", "proof"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "submissions"));
  const proof = '{"proof":"saved before crash"}\n';
  fs.writeFileSync(path.join(runDir, "candidate-receipts", "proof", "000001.json"), proof);
  fs.writeFileSync(path.join(runDir, "submissions", "proof.json"), proof);
  state.jobs[running.key] = { status: "running", started_at: "2026-09-25T00:00:01Z", run_id: runId, run_dir: runDir };
  const interrupted = manifest.jobs[1];
  state.jobs[interrupted.key] = { status: "interrupted", error: "existing", completed_at: "2026-09-25T00:00:02Z" };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "campaign.lock"), JSON.stringify({ pid: 999999, started_at: "2026-09-25T00:00:00Z" }) + "\n");
  fs.writeFileSync(path.join(root, "campaign.log"), "Error: kill EPERM\n    at NativeRpc.stop (/repo/tracks/subscription-codex.ts:279:5)\n  code: 'EPERM',\n  syscall: 'kill'\n");
  fs.writeFileSync(path.join(root, "progress.ndjson"), "");
  return { temp, root, running, interrupted, runDir, proof, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

test("recovery backs up exact state and lock, retains proof bytes, and changes only active job", () => {
  const f = fixture();
  try {
    const stateBefore = fs.readFileSync(path.join(f.root, "state.json"));
    const lockBefore = fs.readFileSync(path.join(f.root, "campaign.lock"));
    const result = recoverCrashedCampaign({ root: f.root, orphanClearanceConfirmed: true, processAlive: () => false });
    const recoveryDir = result.recovery_dir as string;
    assert.deepEqual(fs.readFileSync(path.join(recoveryDir, "state.json")), stateBefore);
    assert.deepEqual(fs.readFileSync(path.join(recoveryDir, "lock.json")), lockBefore);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "campaign.lock")), lockBefore);
    assert.equal(fs.readFileSync(path.join(f.runDir, "candidate-receipts/proof/000001.json"), "utf8"), f.proof);
    assert.equal(fs.existsSync(path.join(f.runDir, "report.json")), false);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, "state.json"), "utf8")) as CampaignState;
    assert.equal(state.jobs[f.running.key].status, "interrupted");
    assert.equal(state.jobs[f.interrupted.key].error, "existing");
    assert.equal(Object.values(state.jobs).filter(job => job.status === "queued").length, 94);
    const receipt = JSON.parse(fs.readFileSync(path.join(recoveryDir, "receipt.json"), "utf8"));
    assert.equal(receipt.failure.code, "EPERM");
    assert.equal(receipt.failure.source_callback, "NativeRpc.stop");
    assert.equal(receipt.counts_before.running, 1);
    assert.equal(receipt.counts_after.interrupted, 2);
    assert.equal(receipt.artifact_inventory.proof_receipts, 2);
    const inventoryBytes = fs.readFileSync(path.join(recoveryDir, "artifact-inventory.json"));
    assert.equal(receipt.artifact_inventory.file_sha256, createHash("sha256").update(inventoryBytes).digest("hex"));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    assert.equal(receipt.artifact_inventory.canonical_sha256, sha(canonical(inventory)));
    assert.equal(inventory[0].sha256, sha(f.proof));
    assert.equal(result.queued_unchanged, 94);
    assert.match(fs.readFileSync(path.join(f.root, "progress.ndjson"), "utf8"), /controller_crash_recovery/);
  } finally { f.cleanup(); }
});

test("recovery refuses live PID, missing orphan clearance, and unsupported crash evidence", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(path.join(f.root, "state.json"));
    assert.throws(() => recoverCrashedCampaign({ root: f.root, orphanClearanceConfirmed: false, processAlive: () => false }), /clearance/);
    assert.throws(() => recoverCrashedCampaign({ root: f.root, orphanClearanceConfirmed: true, processAlive: () => true }), /still active/);
    fs.writeFileSync(path.join(f.root, "campaign.log"), "unrelated failure\n");
    assert.throws(() => recoverCrashedCampaign({ root: f.root, orphanClearanceConfirmed: true, processAlive: () => false }), /does not document/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "state.json")), before);
    assert.equal(fs.existsSync(path.join(f.root, "recovery")), false);
  } finally { f.cleanup(); }
});
