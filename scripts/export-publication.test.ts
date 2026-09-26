import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonical, prepareRun, PROJECT_ROOT, sha256, writeJson } from "../tracks/core";
import { publicRun } from "./export-publication";

const proof=[{line_number:3,formula:"Q",justification:"MP 1,2",depth:0}];
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"propbench-public-export-"));
  const ctx=prepareRun({root,setDir:path.join(PROJECT_ROOT,"golf/set/rehearsal"),track:"unaided",mode:"unaided",provider:"codex-subscription",model:"gpt-6-astra",
    subscription:{effort:"xhigh",max_tool_calls:0},temperature:0.2,budget:{wall_seconds:900,max_generations:1,max_output_tokens:8192,max_thinking_tokens:8192},validator:path.join(PROJECT_ROOT,"target/release/propbench")});
  fs.mkdirSync(path.join(ctx.dir,"sessions"));fs.mkdirSync(path.join(ctx.dir,"tool-events"));
  const at=new Date().toISOString();
  writeJson(path.join(ctx.dir,"subscription.json"),{status:"complete",started_at:at,completed_at:at,email:"PRIVATE_ACCOUNT_SENTINEL"});
  writeJson(path.join(ctx.dir,"sessions/000001.json"),{started_at:at,completed_at:at,model:"gpt-6-astra",backend:"codex-subscription:test",raw_response:"PRIVATE_REASONING_SENTINEL",dispatch_state:"response_confirmed",usage:{input_tokens:12,output_tokens:6}});
  writeJson(path.join(ctx.dir,"submissions/r1.json"),proof);
  writeJson(path.join(ctx.dir,"report.json"),{score:-999,private_path:"/private/PRIVATE_PATH_SENTINEL",api_key:"PRIVATE_KEY_SENTINEL"});
  return {root,ctx,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test("public export replays the real proof and excludes cached scores, account data, paths and native responses",async()=>{
  const f=fixture();
  try {
    const out=await publicRun(f.ctx.dir,{id:"publication-test",condition:"unaided-1"});
    assert.equal(out.score,0.5);assert.equal(out.items[0].line_count,1);
    assert.equal(out.items[0].proof_sha256,sha256(canonical(proof)));
    assert.equal(out.items[0].independently_replayed,true);
    assert.deepEqual(out.returned_models,["gpt-6-astra"]);
    assert.doesNotMatch(JSON.stringify(out),/PRIVATE_|\/Users\/|\/private\/|raw_response|api_key/);
    writeJson(path.join(f.ctx.dir,"submissions/r1.json"),[{...proof[0],formula:"R"}]);
    const tampered=await publicRun(f.ctx.dir,{id:"publication-test",condition:"unaided-1"});
    assert.equal(tampered.valid_count,0);assert.equal(tampered.score,1);
    assert.equal(tampered.items[0].proof,undefined);
  } finally {f.cleanup();}
});

test("active and injected sessions cannot masquerade as completed live publications",async()=>{
  const f=fixture();
  try {
    writeJson(path.join(f.ctx.dir,"subscription.json"),{status:"running"});
    await assert.rejects(publicRun(f.ctx.dir,{id:"publication-test",condition:"unaided-1"}),/active/);
    writeJson(path.join(f.ctx.dir,"subscription.json"),{status:"complete",started_at:new Date().toISOString(),completed_at:new Date().toISOString()});
    writeJson(path.join(f.ctx.dir,"test-injection.json"),{subscriptionClient:true});
    await assert.rejects(publicRun(f.ctx.dir,{id:"publication-test",condition:"unaided-1"}),/Synthetic/);
  } finally {f.cleanup();}
});
