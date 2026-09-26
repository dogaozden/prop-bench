import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUDITED_CODEX_RUNTIMES, assertAuditedCodexRuntime, codexRuntimeCandidates, resolveCodexRuntime } from "./codex-runtime";

test("native runtime selection respects explicit paths and never searches past an explicit failure",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"propbench-runtime-test-"));
  try {
    const first=path.join(root,"first"),second=path.join(root,"second"),alias=path.join(root,"alias");
    fs.writeFileSync(first,"first",{mode:0o700}); fs.writeFileSync(second,"second",{mode:0o700}); fs.symlinkSync(first,alias);
    assert.equal(resolveCodexRuntime({},[alias,second]).path,fs.realpathSync(first));
    assert.deepEqual(codexRuntimeCandidates({PROPBENCH_CODEX_PATH:first,PATH:root}),[first]);
    assert.throws(()=>codexRuntimeCandidates({PROPBENCH_CODEX_PATH:"codex"}),/absolute/);
    assert.throws(()=>resolveCodexRuntime({PROPBENCH_CODEX_PATH:path.join(root,"missing")}),/not an accessible executable/);
    assert.throws(()=>resolveCodexRuntime({},[]),/No native/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("runtime audit rejects other versions and same-version replacements",()=>{
  const [version,hashes]=Object.entries(AUDITED_CODEX_RUNTIMES)[0];
  assert.doesNotThrow(()=>assertAuditedCodexRuntime(version,hashes[0]));
  assert.throws(()=>assertAuditedCodexRuntime(version,"0".repeat(64)),/audit required/);
  assert.throws(()=>assertAuditedCodexRuntime("codex-cli 0.149.0",hashes[0]),/no runtime fallback/);
  assert.throws(()=>assertAuditedCodexRuntime("codex-cli 99.0.0",hashes[0]),/audit required/);
});

test("desktop discovery precedes PATH and excludes relative PATH entries",()=>{
  const paths=codexRuntimeCandidates({PATH:".:/usr/bin:relative"},"/test-home");
  assert.match(paths[0],/codex-cli\/CodexCLI.app/);
  assert.equal(paths.at(-1),"/usr/bin/codex");
  assert.ok(paths.every(entry=>path.isAbsolute(entry)));
});
