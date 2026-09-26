import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import test, { TestContext } from "node:test";
import {
  inspectRuntime,
  runSandbox,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRuntime,
  SandboxUnavailableError,
} from "./sandbox";

const OUTPUT_LIMIT = 8 * 1024 * 1024;

function makeBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "propbench-sandbox-test-"));
}

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

async function runtimeOrSkip(t: TestContext): Promise<SandboxRuntime | null> {
  try {
    return await inspectRuntime();
  } catch (err) {
    if (err instanceof SandboxUnavailableError) {
      t.skip(err.message);
      return null;
    }
    throw err;
  }
}

async function runOrSkip(
  t: TestContext,
  bundle: string,
  command: string[],
  options?: SandboxRunOptions,
): Promise<SandboxRunResult | null> {
  try {
    return await runSandbox(bundle, command, options);
  } catch (err) {
    if (err instanceof SandboxUnavailableError) {
      t.skip(err.message);
      return null;
    }
    throw err;
  }
}

test("Frontier runtime supports shell, Python, Node, compiler, rg, jq, and the real validator", async (t) => {
  const runtime = await runtimeOrSkip(t);
  if (!runtime) return;
  const base = makeBase();
  const bundle = path.join(base, "bundle");
  const ownerSecret = path.join(base, "owner-secret");
  const outsideWrite = path.join(base, "outside-write");
  fs.mkdirSync(bundle);
  fs.writeFileSync(ownerSecret, "owner-only\n");
  fs.writeFileSync(path.join(bundle, "visible.txt"), "bundle-readable\n");
  const ownerSecretReal = fs.realpathSync(ownerSecret);
  const dataVolumeAlias = `/System/Volumes/Data${ownerSecretReal}`;
  const configuredSocket = process.env.PROPBENCH_DOCKER_HOST?.replace(/^unix:\/\//, "") ?? "/var/run/docker.sock";
  const previousSecret = process.env.PROPBENCH_SECRET;
  const previousAws = process.env.AWS_SECRET_ACCESS_KEY;
  const previousSsh = process.env.SSH_AUTH_SOCK;
  process.env.PROPBENCH_SECRET = "must-not-cross";
  process.env.AWS_SECRET_ACCESS_KEY = "must-not-cross";
  process.env.SSH_AUTH_SOCK = "/must/not/cross";
  try {
    fs.writeFileSync(path.join(bundle, "canary.py"), [
      "import json, os, socket",
      `owner_secret = ${JSON.stringify(ownerSecretReal)}`,
      `data_alias = ${JSON.stringify(dataVolumeAlias)}`,
      `outside_write = ${JSON.stringify(outsideWrite)}`,
      `docker_socket = ${JSON.stringify(configuredSocket)}`,
      "def denied_read(target):",
      "    try:",
      "        open(target, 'rb').read(1)",
      "        return False",
      "    except OSError:",
      "        return True",
      "def denied_write(target):",
      "    try:",
      "        open(target, 'wb').write(b'escape')",
      "        return False",
      "    except OSError:",
      "        return True",
      "sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
      "try:",
      "    sock.sendto(b'network-canary', ('1.1.1.1', 53))",
      "    network_denied = False",
      "except OSError:",
      "    network_denied = True",
      "finally:",
      "    sock.close()",
      "result = {",
      "  'bundle_read': open('visible.txt').read().strip(),",
      "  'sibling_denied': denied_read(owner_secret),",
      "  'private_denied': denied_read('/private/etc/passwd'),",
      "  'data_alias_denied': denied_read(data_alias),",
      "  'outside_write_denied': denied_write(outside_write),",
      "  'docker_socket_denied': denied_read(docker_socket),",
      "  'network_denied': network_denied,",
      "  'secret_env_absent': all(k not in os.environ for k in ('PROPBENCH_SECRET', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'PROPBENCH_DOCKER_HOST', 'DOCKER_HOST', 'HISTFILE')),",
      "  'home': os.environ.get('HOME', ''),",
      "}",
      "open('python-result.json', 'w').write(json.dumps(result))",
      "open('python-write.txt', 'w').write('python-ok')",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(bundle, "node-canary.js"), "require('node:fs').writeFileSync('node-write.txt', 'node-ok')\n");
    fs.writeFileSync(path.join(bundle, "compiled-canary.c"), [
      "#include <stdio.h>",
      "int main(void) { puts(\"compiler-ok\"); return 0; }",
      "",
    ].join("\n"));
    writeExecutable(path.join(bundle, "validator"), '#!/bin/sh\nexec /opt/propbench/validator "$@"\n');
    writeExecutable(path.join(bundle, "run.sh"), [
      "#!/bin/sh",
      "set -eu",
      "cat visible.txt",
      "python3 canary.py",
      "node node-canary.js",
      "cc compiled-canary.c -o compiled-canary",
      "./compiled-canary",
      "rg -q bundle-readable visible.txt",
      "printf '{\"jq\":\"ok\"}' | jq -e '.jq == \"ok\"' >/dev/null",
      "./validator --help | grep -q validate",
      "if printf x >> /opt/propbench/validator 2>/dev/null; then exit 91; fi",
      "printf shell-ok > shell-write.txt",
      "",
    ].join("\n"));

    const result = await runOrSkip(t, bundle, ["/workspace/run.sh"], { timeoutSeconds: 20, imageId: runtime.image_id });
    if (!result) return;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.runtime, runtime);
    assert.match(result.stdout, /bundle-readable/);
    assert.match(result.stdout, /compiler-ok/);
    assert.equal(fs.readFileSync(path.join(bundle, "python-write.txt"), "utf8"), "python-ok");
    assert.equal(fs.readFileSync(path.join(bundle, "node-write.txt"), "utf8"), "node-ok");
    assert.equal(fs.readFileSync(path.join(bundle, "shell-write.txt"), "utf8"), "shell-ok");
    const canary = JSON.parse(fs.readFileSync(path.join(bundle, "python-result.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(canary, {
      bundle_read: "bundle-readable",
      sibling_denied: true,
      private_denied: true,
      data_alias_denied: true,
      outside_write_denied: true,
      docker_socket_denied: true,
      network_denied: true,
      secret_env_absent: true,
      home: "/workspace/.sandbox-home",
    });
    assert.equal(fs.existsSync(outsideWrite), false);
  } finally {
    if (previousSecret === undefined) delete process.env.PROPBENCH_SECRET;
    else process.env.PROPBENCH_SECRET = previousSecret;
    if (previousAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousAws;
    if (previousSsh === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousSsh;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const DETACHED_CHILD = [
  "import os, sys, time",
  "pid = os.fork()",
  "if pid == 0:",
  "    os.setsid()",
  "    os.close(1)",
  "    os.close(2)",
  "    time.sleep(1.5)",
  "    open('descendant-survived', 'w').write('unsafe')",
  "    os._exit(0)",
  "if sys.argv[1] == 'timeout':",
  "    time.sleep(60)",
  "",
].join("\n");

for (const scenario of ["normal", "timeout"] as const) {
  test(`Frontier runtime removes a setsid descendant after ${scenario} exit`, async (t) => {
    const base = makeBase();
    const bundle = path.join(base, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, "detached-child.py"), DETACHED_CHILD);
    try {
      const result = await runOrSkip(
        t,
        bundle,
        ["python3", "detached-child.py", scenario],
        { timeoutSeconds: scenario === "timeout" ? 1 : 10 },
      );
      if (!result) return;
      assert.equal(result.exitCode, scenario === "normal" ? 0 : 124, result.stderr);
      await new Promise(resolve => setTimeout(resolve, 1800));
      assert.equal(fs.existsSync(path.join(bundle, "descendant-survived")), false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

test("Frontier runtime caps combined contestant output and removes the container", async (t) => {
  const base = makeBase();
  const bundle = path.join(base, "bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, "output.py"), "import os\nb=b'x'*65536\nfor _ in range(160): os.write(1,b)\n");
  try {
    const result = await runOrSkip(t, bundle, ["python3", "output.py"], { timeoutSeconds: 10 });
    if (!result) return;
    assert.equal(result.exitCode, 124);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= OUTPUT_LIMIT);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("sandbox rejects unsafe bundles and argv before selecting a runtime", async () => {
  const base = makeBase();
  const bundle = path.join(base, "bundle");
  fs.mkdirSync(bundle);
  try {
    await assert.rejects(() => runSandbox("relative-bundle", ["true"]), /absolute path/);
    await assert.rejects(() => runSandbox(bundle, []), /non-empty argv/);
    await assert.rejects(() => runSandbox(bundle, [""]), /non-empty argv/);
    await assert.rejects(() => runSandbox(bundle, ["printf", "bad\0arg"]), /non-empty argv/);
    await assert.rejects(() => runSandbox(bundle, ["true"], { timeoutSeconds: 0 }), /positive integer/);
    await assert.rejects(() => runSandbox(bundle, ["true"], { deadline: NaN }), /deadline must be finite/);
    await assert.rejects(() => runSandbox(bundle, ["true"], { deadline: performance.now() - 1 }), /wall-clock budget exhausted/);
    await assert.rejects(() => runSandbox(bundle, ["true"], { signal: AbortSignal.abort() }), /wall-clock budget exhausted/);
    await assert.rejects(() => runSandbox(bundle, ["true"], { imageId: "latest" }), /full sha256 image ID/);
    await assert.rejects(
      () => runSandbox(bundle, ["/opt/owner-only"]),
      (err: unknown) => !(err instanceof SandboxUnavailableError) &&
        err instanceof Error && /outside bundle\/system roots/.test(err.message),
    );
    fs.symlinkSync("../outside", path.join(bundle, "escape"));
    await assert.rejects(() => runSandbox(bundle, ["true"]), /Symlink is not allowed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the monotonic owner cutoff removes active sandbox writers and prevents later mutation", async t => {
  const runtime = await runtimeOrSkip(t);
  if (!runtime) return;
  const base = makeBase();
  const bundle = path.join(base, "bundle");
  fs.mkdirSync(bundle);
  try {
    fs.writeFileSync(path.join(bundle, "writer.py"), [
      "import time",
      "while True:",
      "    open('writer-marker', 'w').write(str(time.time()))",
      "    time.sleep(0.02)",
      "",
    ].join("\n"));
    const cancellation = new AbortController();
    const deadline = performance.now() + 1500;
    const timer = setTimeout(() => cancellation.abort(), 1500);
    try {
      const result = await runSandbox(bundle, ["python3", "writer.py"], { imageId: runtime.image_id, timeoutSeconds: 30, deadline, signal: cancellation.signal });
      assert.equal(result.exitCode, 124, result.stderr);
    } finally { clearTimeout(timer); }
    const marker = path.join(bundle, "writer-marker");
    const stopped = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null, stopped);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("sandbox accepts only an explicit local Unix Docker socket", async () => {
  const base = makeBase();
  const bundle = path.join(base, "bundle");
  fs.mkdirSync(bundle);
  const previous = process.env.PROPBENCH_DOCKER_HOST;
  process.env.PROPBENCH_DOCKER_HOST = "tcp://127.0.0.1:2375";
  try {
    await assert.rejects(
      () => runSandbox(bundle, ["true"]),
      (err: unknown) => err instanceof SandboxUnavailableError && /local unix/.test(err.evidence),
    );
  } finally {
    if (previous === undefined) delete process.env.PROPBENCH_DOCKER_HOST;
    else process.env.PROPBENCH_DOCKER_HOST = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
