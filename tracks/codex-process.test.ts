import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { terminateCodexProcess } from "./codex-process";

const errno=(code:string)=>Object.assign(new Error(code),{code});
const child=()=>({pid:4242,exitCode:null as number|null,signalCode:null as NodeJS.Signals|null});

test("denied group signals fall back to the owned child and record confirmed termination",async()=>{
  const target=child(), records:any[]=[], calls:Array<[number,NodeJS.Signals|0]>=[];
  let present=true;
  await terminateCodexProcess(target,event=>records.push(event),{
    kill(pid,signal){calls.push([pid,signal]);if(pid<0){if(!present)throw errno("ESRCH");if(signal!==0)throw errno("EPERM");}
      else {target.signalCode=signal as NodeJS.Signals;present=false;}},
    wait:async()=>{},
  },100);
  assert.deepEqual(calls.filter(([,signal])=>signal!==0),[[-4242,"SIGTERM"],[4242,"SIGTERM"]]);
  assert.equal(records[0].termination_confirmed,true);
  assert.deepEqual(records[0].errors,[{target:"group",signal:"SIGTERM",code:"EPERM"}]);
});

test("unconfirmed group cleanup is a bounded promise rejection even if the child has exited",async()=>{
  const target=child(), records:any[]=[], calls:Array<[number,NodeJS.Signals|0]>=[];
  let waits=0;
  const cleanup=terminateCodexProcess(target,event=>records.push(event),{
    kill(pid,signal){calls.push([pid,signal]);if(pid<0)throw errno("EPERM");target.signalCode=signal as NodeJS.Signals;},
    wait:async()=>{waits++;},
  },100);
  await assert.rejects(cleanup,/cleanup failed.*unconfirmed/);
  assert.equal(waits,4);
  assert.deepEqual(calls.filter(([pid,signal])=>pid>0&&signal!==0),[[4242,"SIGTERM"]],"never signal the exited child PID again");
  assert.equal(records[0].termination_confirmed,false);
  assert(records[0].errors.some((entry:any)=>entry.signal===0&&entry.code==="EPERM"));
});

test("denied group and direct signals cannot escape cleanup synchronously",async()=>{
  const target=child(), records:any[]=[];
  let cleanup:Promise<void>|undefined;
  assert.doesNotThrow(()=>{cleanup=terminateCodexProcess(target,event=>records.push(event),{
    kill(){throw errno("EPERM");},wait:async()=>{},
  },50);});
  await assert.rejects(cleanup!,/termination.*unconfirmed/);
  assert.deepEqual(records[0].errors.filter((entry:any)=>entry.target==="child").map((entry:any)=>entry.signal),["SIGTERM","SIGKILL"]);
});

test("already exited groups receive no signals and evidence failure cannot prevent cleanup",async()=>{
  const target=child();target.exitCode=0;
  const signals:Array<NodeJS.Signals|0>=[];
  await assert.rejects(terminateCodexProcess(target,()=>{throw new Error("disk full");},{
    kill(_pid,signal){signals.push(signal);throw errno("ESRCH");},wait:async()=>{},
  },50),/cleanup completed.*evidence/);
  assert.deepEqual(signals,[0]);
});

test("termination evidence waits for stdio close and reports a bounded drain failure",async()=>{
  const target=child();target.exitCode=0;
  const control={kill(){throw errno("ESRCH");},wait:async()=>{}};
  const records:any[]=[];
  let close!:()=>void;
  const closed=new Promise<void>(resolve=>{close=resolve;});
  const cleanup=terminateCodexProcess(target,event=>records.push(event),control,50,closed);
  await Promise.resolve();assert.equal(records.length,0,"process exit alone cannot release the transcript");
  close();await cleanup;assert.equal(records[0].stdio_close_observed,true);
  await assert.rejects(terminateCodexProcess(target,event=>records.push(event),control,20,new Promise(()=>{})),/stdio close.*drain bound/);
  assert.equal(records[1].termination_confirmed,true);assert.equal(records[1].stdio_close_observed,false);
});

test("a real detached child ignoring TERM is killed and reaped within the cleanup bound",async()=>{
  const target=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{}); console.log('READY'); setInterval(()=>{},1000)"],{detached:true,stdio:["ignore","pipe","pipe"]});
  try {
    await new Promise<void>((resolve,reject)=>{target.stdout.once("data",()=>resolve());target.once("error",reject);});
    const records:any[]=[];
    await terminateCodexProcess(target,event=>records.push(event),undefined,100);
    assert.equal(target.signalCode,"SIGKILL");
    assert.equal(records[0].termination_confirmed,true);
    assert.throws(()=>process.kill(-target.pid!,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==="ESRCH");
  } finally {
    if(target.exitCode===null&&target.signalCode===null)target.kill("SIGKILL");
  }
});
