import * as fs from "node:fs";
import * as path from "node:path";
import { canonical, gradeRun, loadRun, loadSet, parseProof, PROJECT_ROOT, readJson, readRegularFile, sha256, validateCandidate, writeJson } from "../tracks/core";
import type { RunReport } from "../tracks/types";

type Json = Record<string, any>;
const digest = (value: unknown): string | null => typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(value) ? value : null;
const safeId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw new Error("Invalid public identity");
  return value;
};

function publicSnapshot(runDir: string, final: boolean): Json | null {
  const root=path.join(runDir,"archives");
  if(!fs.existsSync(root))return null;
  const names=fs.readdirSync(root).filter(name=>/^\d{6}$/.test(name)).sort();
  if(!names.length || (final && names.length<2))return null;
  const receipt=readJson<Json>(path.join(root,final?names[names.length-1]:names[0],"RECEIPT.json"));
  if(receipt.trigger!==(final?"import":"initial"))throw new Error("Unexpected archive trigger");
  const snapshot=receipt.snapshot;
  const entries=snapshot.entries.map((entry:Json)=>{
    if(typeof entry.path!=="string" || entry.path.includes("\\") || entry.path.split("/").some((part:string)=>!part || part==="." || part==="..") ||
      !/^(?:proofs(?:\/.*)?|tools(?:\/.*)?|METHODS\.md|LOG\.md|DEBRIEF\.md)$/.test(entry.path) ||
      !["file","directory"].includes(entry.kind) || !Number.isSafeInteger(entry.mode))throw new Error("Unsafe public snapshot entry");
    if(entry.kind==="file" && (!Number.isSafeInteger(entry.bytes) || entry.bytes<0 || !digest(entry.sha256)))throw new Error("Invalid snapshot file identity");
    return {path:entry.path,kind:entry.kind,mode:entry.mode,...(entry.kind==="file"?{bytes:entry.bytes,sha256:entry.sha256}:{})};
  });
  const clean={schema_version:"propbench-frontier-snapshot-v1",entries};
  if(snapshot.schema_version!==clean.schema_version || sha256(canonical(clean))!==snapshot.digest)throw new Error("Snapshot inventory hash differs");
  return {...clean,digest:snapshot.digest};
}

function publicBytes(file:string, bytes:Buffer):void {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o755});
  fs.writeFileSync(file,bytes,{mode:0o644});fs.chmodSync(file,0o644);
}

/** Deliberate allowlist: never serialize native events, prompts, paths or account data. */
export async function publicRun(runDir: string, campaign: {id: string; condition: string; seedRunId?: string}): Promise<Json> {
  const ctx=loadRun(runDir);
  if(ctx.config.provider!=="codex-subscription")throw new Error("Publication accepts only Codex subscription runs");
  const state=readJson<Json>(path.join(ctx.dir,"subscription.json"));
  if(!state.completed_at || state.status==="running")throw new Error("Cannot publish an active run");
  const report:RunReport=await gradeRun(ctx.dir);
  if(report.evidence!=="subscription")throw new Error("Synthetic evidence cannot enter published evaluations");
  const items=[];
  for(const item of report.items) {
    const record:Json={id:safeId(item.id),status:item.status,line_count:item.line_count,par:item.par,loss:item.loss};
    if(item.status==="valid") {
      const bytes=readRegularFile(path.join(ctx.dir,"submissions",item.id+".json"));
      const proof=parseProof(bytes.toString("utf8"));
      const theorem=ctx.set.items.find(candidate=>candidate.id===item.id)!.theorem;
      const verdict=await validateCandidate(path.join(ctx.dir,"referee/validator"),theorem,proof);
      if(verdict.status!=="valid" || verdict.line_count!==item.line_count)throw new Error("Independent publication replay disagrees");
      record.proof=proof;record.proof_sha256=sha256(canonical(proof));record.independently_replayed=true;
      record.proof_file=`proofs/${safeId(ctx.config.run_id)}/${safeId(item.id)}.json`;record.proof_bytes_sha256=sha256(bytes);
    }
    items.push(record);
  }
  const improvements:Json[]=[];
  if(ctx.config.track==="frontier")for(const item of ctx.set.items) {
    const receipts=path.join(ctx.dir,"candidate-receipts",item.id);
    if(!fs.existsSync(receipts))continue;
    for(const name of fs.readdirSync(receipts).filter(name=>/^\d{6}\.json$/.test(name)).sort()) {
      const receipt=readJson<Json>(path.join(receipts,name));
      if(!receipt.accepted)continue;
      if(receipt.theorem_id!==item.id || receipt.import_id+".json"!==name || !/^\d{6}$/.test(receipt.checkpoint?.checkpoint_id))throw new Error("Invalid accepted checkpoint identity");
      const checkpoint=readJson<Json>(path.join(ctx.dir,"checkpoints",receipt.checkpoint.checkpoint_id+".json"));
      const elapsed=checkpoint.capture_elapsed_ms/1000;
      if(!Number.isFinite(elapsed) || elapsed<0 || elapsed>ctx.config.budget.wall_seconds || checkpoint.execution_command!==receipt.checkpoint.execution_command)throw new Error("Checkpoint capture falls outside its allowance");
      const bytes=Buffer.from(receipt.proof_bytes_base64,"base64"),proof=parseProof(bytes.toString("utf8"));
      if(sha256(bytes)!==receipt.proof_sha256)throw new Error("Accepted checkpoint byte hash differs");
      const verdict=await validateCandidate(path.join(ctx.dir,"referee/validator"),item.theorem,proof);
      if(verdict.status!=="valid" || verdict.line_count!==receipt.verdict.line_count)throw new Error("Accepted checkpoint fails independent replay");
      improvements.push({item_id:item.id,import_id:receipt.import_id,checkpoint_id:receipt.checkpoint.checkpoint_id,
        execution_command:checkpoint.execution_command,captured_elapsed_seconds:elapsed,line_count:verdict.line_count,
        previous_line_count:receipt.incumbent_before.status==="valid"?receipt.incumbent_before.line_count:null,
        proof,proof_sha256:sha256(canonical(proof)),proof_bytes_sha256:sha256(bytes),independently_replayed:true,
        proof_file:`proofs/${safeId(ctx.config.run_id)}/checkpoints/${safeId(item.id)}-${receipt.import_id}.json`});
    }
  }
  const toolCounts:Record<string,number>={};
  const toolsDir=path.join(ctx.dir,"tool-events");
  if(fs.existsSync(toolsDir))for(const file of fs.readdirSync(toolsDir).filter(file=>/^\d{6}\.json$/.test(file))) {
    const event=readJson<Json>(path.join(toolsDir,file));
    if(["exec","delegate"].includes(event.tool))toolCounts[event.tool]=(toolCounts[event.tool]??0)+1;
  }
  const c=ctx.config;
  return {
    id:safeId(c.run_id),campaign_id:safeId(campaign.id),campaign_condition:safeId(campaign.condition),
    ...(campaign.seedRunId?{seed_run_id:safeId(campaign.seedRunId)}:{}),
    track:c.track,mode:c.mode,model:safeId(c.model),observed_models:report.returned_models.map(safeId),returned_models:report.returned_models.map(safeId),provider:c.provider,
    execution_protocol:c.execution_protocol,evidence:report.evidence,evaluation_status:report.evaluation_status,
    graded_at:report.graded_at,completed_at:state.completed_at,cohort:report.cohort,selected_ids:c.selected_ids.map(safeId),
    budget:{wall_seconds:c.budget.wall_seconds,max_tool_calls:c.subscription?.max_tool_calls},subscription:c.subscription,
    score:report.score,valid_count:report.valid_count,total:report.total,usage:report.usage,usage_coverage:report.usage_coverage,
    client_sessions:report.client_sessions,elapsed_seconds:report.elapsed_seconds,tool_counts:toolCounts,
    evaluator_hash:digest(c.evaluator_hash),regraded_by:digest(report.regraded_by),validator_sha256:digest(c.validator_sha256),
    rulebook_sha256:digest(c.rulebook_sha256),set_hash:digest(c.set_hash),starting_snapshot:digest(c.starting_snapshot),
    set_version:c.set_version,core_tag:c.core_tag,
    ...(c.track==="frontier"?{initial_snapshot:publicSnapshot(ctx.dir,false),final_snapshot:publicSnapshot(ctx.dir,true),improvements}:{}),
    runtime:report.runtime,items,
    outcome:state.status==="complete" ? "completed" : "interrupted; excluded from comparative ranking",
  };
}

export async function exportPublication(campaignRoot: string, outputFile: string): Promise<Json> {
  const manifest=readJson<Json>(path.join(campaignRoot,"manifest.json"));
  const state=readJson<Json>(path.join(campaignRoot,"state.json"));
  const set=loadSet(path.join(PROJECT_ROOT,"golf/set/v2"));
  if(manifest.provider!=="codex-subscription" || manifest.identity.set_hash!==set.hash)throw new Error("Campaign provider or set identity mismatch");
  if(state.manifest_sha256!==sha256(canonical(manifest)))throw new Error("Campaign state is not bound to this manifest");
  const conditions=["unaided-1","unaided-2","frontier-fresh","frontier-cumulative"];
  const expected=new Set(set.items.flatMap(item=>conditions.map(condition=>`${item.id}--${condition}`)));
  if(manifest.jobs.length!==expected.size || manifest.jobs.some((job:Json)=>!expected.delete(`${job.item_id}--${job.condition}`)) || expected.size)throw new Error("Publication requires the complete prespecified census plan");
  const campaignId=safeId(manifest.campaign_id);
  const runs=[];
  const planned=[];
  for(const job of manifest.jobs) {
    const progress=state.jobs[job.key];
    const plan:Json={key:safeId(job.key),item_id:safeId(job.item_id),condition:safeId(job.condition),wall_seconds:job.wall_seconds,
      max_tool_calls:job.max_tool_calls,status:progress?.status??"pending"};
    if(progress?.run_id)plan.run_id=safeId(progress.run_id);
    planned.push(plan);
    // Read one coherent state snapshot: a subscription may finish just after
    // it was captured, but its run must wait for a terminal campaign receipt.
    if(!["complete","interrupted"].includes(progress?.status) || !progress?.run_dir || !fs.existsSync(path.join(progress.run_dir,"subscription.json")))continue;
    const subscription=readJson<Json>(path.join(progress.run_dir,"subscription.json"));
    if(!subscription.completed_at || subscription.status==="running")continue;
    const seed=progress.inherited_from ? state.jobs[progress.inherited_from]?.run_id : undefined;
    const record=await publicRun(progress.run_dir,{id:campaignId,condition:job.condition,seedRunId:seed});
    if(record.id!==progress.run_id || record.selected_ids.length!==1 || record.selected_ids[0]!==job.item_id || record.budget.wall_seconds!==job.wall_seconds ||
      record.model!==manifest.model || record.subscription?.effort!==manifest.effort || record.subscription?.max_tool_calls!==job.max_tool_calls ||
      record.evaluator_hash!==manifest.identity.evaluator_hash || record.validator_sha256!==manifest.identity.validator_sha256 || record.rulebook_sha256!==manifest.identity.rulebook_sha256)throw new Error("Campaign job differs from sealed run");
    runs.push(record);
    for(const item of record.items)if(item.status==="valid") {
      const bytes=readRegularFile(path.join(progress.run_dir,"submissions",item.id+".json"));
      if(sha256(bytes)!==item.proof_bytes_sha256)throw new Error("Proof changed during publication export");
      publicBytes(path.join(path.dirname(outputFile),item.proof_file),bytes);
    }
    for(const event of record.improvements??[]) {
      const receipt=readJson<Json>(path.join(progress.run_dir,"candidate-receipts",event.item_id,event.import_id+".json"));
      const bytes=Buffer.from(receipt.proof_bytes_base64,"base64");
      if(sha256(bytes)!==event.proof_bytes_sha256)throw new Error("Checkpoint changed during publication export");
      publicBytes(path.join(path.dirname(outputFile),event.proof_file),bytes);
    }
  }
  const output={
    schema_version:"propbench-publication-v1",generated_at:new Date().toISOString(),
    set:{version:set.version,hash:set.hash,core_tag:set.core_tag,manifest_sha256:manifest.identity.set_manifest_sha256},
    evaluator:{scorer_version:"efficiency-v2",rulebook_sha256:digest(manifest.identity.rulebook_sha256),validator_sha256:digest(manifest.identity.validator_sha256)},
    campaign:{id:campaignId,created_at:manifest.created_at,model:safeId(manifest.model),effort:manifest.effort,
      client:{version:manifest.identity.runtime.version,sha256:digest(manifest.identity.runtime.sha256)},
      evaluator_hash:digest(manifest.identity.evaluator_hash),source_commit:manifest.identity.source_commit,
      status:planned.every(job=>job.status==="complete")?"complete":state.dispatch_stopped?"interrupted":"running",planned_jobs:planned.length,recorded_runs:runs.length,jobs:planned},
    items:set.items.map(item=>({id:item.id,par:item.par,theorem_sha256:item.theorem_sha256,
      theorem:item.theorem})),
    runs,
    notes:["Par is an achievable reference length, not a certified minimum.","Each run gets its own wall-clock allowance. Frontier cumulative inherits the corresponding fresh workspace and adds a new allowance.","Unaided has no computation tools or verifier feedback. Frontier has isolated execution and delegation.","Interrupted and pending evaluations are visible; interrupted results are excluded from comparative ranking.","Token usage is observed native-client usage and can be incomplete. Sessions are not exact inference-request counts.","The public v2 dataset is small and can be contaminated; these results do not establish general reasoning ability or human equivalence."],
  };
  fs.mkdirSync(path.dirname(outputFile),{recursive:true});
  const theoremDir=path.join(path.dirname(outputFile),"theorems");fs.mkdirSync(theoremDir,{recursive:true});
  for(const item of set.items)publicBytes(path.join(theoremDir,item.id+".json"),readRegularFile(path.join(PROJECT_ROOT,"golf/set/v2",item.id+".json")));
  publicBytes(path.join(path.dirname(outputFile),"theorems/manifest.json"),readRegularFile(path.join(PROJECT_ROOT,"golf/set/v2/manifest.json")));
  const rules=readRegularFile(path.join(PROJECT_ROOT,"rules.md"));
  if(sha256(rules)!==manifest.identity.rulebook_sha256)throw new Error("Rulebook differs from campaign; preserve its frozen version before export");
  publicBytes(path.join(path.dirname(outputFile),"rules.md"),rules);
  writeJson(outputFile,output);
  fs.chmodSync(outputFile,0o644);
  return output;
}

if(require.main===module) {
  const root=process.argv[2],out=process.argv[3]??path.join(PROJECT_ROOT,"publication/data/results.json");
  if(!root)throw new Error("Usage: export-publication CAMPAIGN_ROOT [OUTPUT_JSON]");
  exportPublication(path.resolve(root),path.resolve(out)).then(result=>console.log(JSON.stringify({output:path.resolve(out),runs:result.runs.length,planned:result.campaign.planned_jobs}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
