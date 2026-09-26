import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/** Each entry requires a fresh protocol/control audit and live canaries. */
export const AUDITED_CODEX_RUNTIMES: Readonly<Record<string, readonly string[]>> = {
  "codex-cli 0.158.0-alpha.2": ["c3e30211bd454da70ceb4d9cbc2e05fe6466812ab05c311c3bbff6addeb14202"],
};

export function assertAuditedCodexRuntime(version: string, sha256: string): void {
  if (!AUDITED_CODEX_RUNTIMES[version]?.includes(sha256)) {
    throw new Error(`Codex native control audit required for ${version} (sha256 ${sha256}); no runtime fallback allowed`);
  }
}

export function codexRuntimeCandidates(env: NodeJS.ProcessEnv, home = os.homedir()): string[] {
  if (env.PROPBENCH_CODEX_PATH !== undefined) {
    if (!path.isAbsolute(env.PROPBENCH_CODEX_PATH)) throw new Error("PROPBENCH_CODEX_PATH must be an absolute executable path");
    return [env.PROPBENCH_CODEX_PATH];
  }
  return [...new Set([
    ...["/Applications", path.join(home,"Applications")].flatMap(root =>
      ["ChatGPT.app","Codex.app"].flatMap(app => [
        path.join(root,app,"Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
        path.join(root,app,"Contents/Resources/codex"),
      ])),
    ...(env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir,"codex")),
  ])];
}

/** Resolve once. An incompatible selected client never causes a retry on another. */
export function resolveCodexRuntime(env = process.env, candidates = codexRuntimeCandidates(env)): {path: string; source: string} {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate,fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return {path:fs.realpathSync(candidate),source:env.PROPBENCH_CODEX_PATH !== undefined ? "PROPBENCH_CODEX_PATH" : "desktop bundle then PATH discovery"};
    } catch (error) {
      if (env.PROPBENCH_CODEX_PATH !== undefined) throw new Error(`PROPBENCH_CODEX_PATH is not an accessible executable: ${candidate}`);
      if (!["ENOENT","ENOTDIR","EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("No native Codex client found; set PROPBENCH_CODEX_PATH to an audited absolute executable path");
}

/** Read-only preflight for campaign manifests. No auth data or inference is read. */
export function inspectCodexRuntime(env = process.env) {
  const runtime = resolveCodexRuntime(env);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(runtime.path)).digest("hex");
  const version = execFileSync(runtime.path,["--version"],{
    encoding:"utf8",timeout:10000,maxBuffer:65536,stdio:["ignore","pipe","pipe"],
    env:Object.fromEntries(["HOME","CODEX_HOME","PATH","TMPDIR","LANG"].filter(key=>env[key]!==undefined).map(key=>[key,env[key]])),
  }).trim();
  assertAuditedCodexRuntime(version,sha256);
  return {...runtime,version,sha256};
}
