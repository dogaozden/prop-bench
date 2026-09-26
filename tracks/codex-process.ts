import type { ChildProcess } from "node:child_process";

type NativeChild = Pick<ChildProcess,"pid"|"exitCode"|"signalCode">;
interface ProcessControl {
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  wait(ms: number): Promise<void>;
}
const systemControl: ProcessControl = {
  kill: (pid,signal) => { process.kill(pid,signal); },
  wait: ms => new Promise(resolve=>setTimeout(resolve,ms)),
};

export class CodexProcessCleanupError extends Error {}

/** Bounded cleanup of only the detached native child and its original group. */
export async function terminateCodexProcess(child: NativeChild, record: (value: unknown)=>void,
  control: ProcessControl = systemControl, graceMs = 1000, closed?: Promise<void>): Promise<void> {
  if (!child.pid) return;
  const pid=child.pid;
  const errors: Array<{target:"group"|"child";signal:NodeJS.Signals|0;code:string}> = [];
  let recordFailed=false;
  const log=(event:unknown)=>{ try {record(event);} catch {recordFailed=true;} };
  const alive=()=>child.exitCode===null && child.signalCode===null;
  const absent=()=>{
    try {control.kill(-pid,0);return false;}
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if(code==="ESRCH")return true;
      // EPERM means unknown, never proof that a process has exited.
      if(!errors.some(e=>e.target==="group" && e.signal===0 && e.code===code))errors.push({target:"group",signal:0,code});
      return false;
    }
  };
  const send=(signal:NodeJS.Signals)=>{
    try {control.kill(-pid,signal);}
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if(code!=="ESRCH")errors.push({target:"group",signal,code});
      // Never signal a recycled leader PID after the owned child has exited.
      if(alive()) {
        try {control.kill(pid,signal);}
        catch(fallback) {
          const directCode=(fallback as NodeJS.ErrnoException).code ?? "UNKNOWN";
          if(directCode!=="ESRCH")errors.push({target:"child",signal,code:directCode});
        }
      }
    }
  };
  const stopped=()=>absent() && !alive();
  let confirmed=stopped();
  for(const signal of ["SIGTERM","SIGKILL"] as const) {
    if(confirmed)break;
    send(signal);
    for(let elapsed=0;elapsed<graceMs;elapsed+=50) {
      await control.wait(Math.min(50,graceMs-elapsed));
      if(stopped()){confirmed=true;break;}
    }
  }
  let stdioClosed: boolean | undefined;
  if (closed) {
    stdioClosed = await new Promise<boolean>(resolve=>{
      const timer=setTimeout(()=>resolve(false),graceMs);
      void closed.then(()=>{clearTimeout(timer);resolve(true);},()=>{clearTimeout(timer);resolve(false);});
    });
  }
  log({type:"native_process_cleanup",pid,process_group:pid,termination_confirmed:confirmed,stdio_close_observed:stdioClosed,errors});
  if(!confirmed)throw new CodexProcessCleanupError(`Codex process cleanup failed: termination of native process/group ${pid} is unconfirmed`);
  if(stdioClosed===false)throw new CodexProcessCleanupError("Codex process cleanup failed: native stdio close was not observed within the drain bound");
  if(recordFailed)throw new CodexProcessCleanupError("Codex process cleanup completed but its evidence could not be recorded");
}
