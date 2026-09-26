import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Maximum combined output retained from an untrusted contestant process. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 60 * 60;
const DOCKER_IMAGE = "propbench-frontier:2";
const DOCKER_IMAGE_LABEL = "org.propbench.frontier-runtime=2";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface SandboxRuntime {
  backend: "docker";
  image_id: string;
  architecture: string;
}

export interface SandboxRunOptions {
  timeoutSeconds?: number;
  /** Expected immutable image identity recorded by the owner for this run. */
  imageId?: string;
  /** Shared monotonic controller cutoff; includes sandbox setup time. */
  deadline?: number;
  signal?: AbortSignal;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runtime: SandboxRuntime;
}

/** Invalid contestant input is a consumed attempt, not a runtime outage. */
export class SandboxInputError extends Error {}

/** Raised when the dedicated Docker isolation runtime cannot be used. */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE" as const;
  readonly runtime = "docker" as const;
  readonly evidence: string;

  constructor(evidence: string) {
    super(`Isolated execution unavailable (docker): ${evidence}`);
    this.name = "SandboxUnavailableError";
    this.evidence = evidence;
  }
}

interface CapturedProcess {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputLimited: boolean;
}

interface DockerImageInspection {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Labels?: Record<string, string> | null } | null;
}

function pathIsWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertPathInside(base: string, candidate: string, label: string): void {
  if (!pathIsWithin(base, candidate)) {
    throw new SandboxInputError(`${label} escapes sandbox bundle: ${candidate}`);
  }
}

async function assertSafeTree(root: string): Promise<void> {
  const visit = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in sandbox bundle: ${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(current)) await visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Special file is not allowed in sandbox bundle: ${current}`);
    }
  };
  await visit(root);
}

async function assertBundle(bundleDir: string): Promise<string> {
  if (!path.isAbsolute(bundleDir)) {
    throw new Error("Sandbox bundle directory must be an absolute path");
  }
  const requested = path.resolve(bundleDir);
  const rootStat = await fs.lstat(requested).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Error(`Sandbox bundle does not exist: ${requested}`);
    throw err;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Sandbox bundle must be a real directory: ${requested}`);
  }
  const real = await fs.realpath(requested);
  await assertSafeTree(real);
  if (real.includes(",")) {
    throw new Error("Sandbox bundle path cannot contain a comma (Docker bind-mount limitation)");
  }
  return real;
}

async function ensureRuntimeHome(bundleDir: string): Promise<void> {
  const home = path.join(bundleDir, ".sandbox-home");
  try {
    const stat = await fs.lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Sandbox runtime path must be a real directory: ${home}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await fs.mkdir(home, { recursive: false, mode: 0o700 });
  }
  await fs.chmod(home, 0o700);
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
): { bytes: number; limited: boolean } {
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  if (remaining <= 0) return { bytes: currentBytes, limited: true };
  if (chunk.byteLength <= remaining) {
    chunks.push(chunk);
    return { bytes: currentBytes + chunk.byteLength, limited: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { bytes: MAX_OUTPUT_BYTES, limited: true };
}

/** Capture one owner-side process without ever signalling a host process group. */
function captureProcess(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; onTerminate?: () => void },
): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let outputLimited = false;
    let timedOut = false;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | null = null;

    const hardKillCli = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const terminateCli = (): void => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      options.onTerminate?.();
      if (!hardKillTimer) {
        hardKillTimer = setTimeout(hardKillCli, 150);
        hardKillTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateCli();
    }, options.timeoutMs);
    timer.unref();
    const abort = (): void => { timedOut = true; terminateCli(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdout.on("data", (chunk: Buffer | string) => {
      const result = appendOutput(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), outputBytes);
      outputBytes = result.bytes;
      outputLimited ||= result.limited;
      if (result.limited) terminateCli();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const result = appendOutput(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), outputBytes);
      outputBytes = result.bytes;
      outputLimited ||= result.limited;
      if (result.limited) terminateCli();
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      hardKillCli();
      reject(err);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const signalCode = signal ? 128 + (os.constants.signals[signal] ?? 1) : 0;
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: timedOut || outputLimited ? 124 : code ?? signalCode,
        timedOut,
        outputLimited,
      });
    });
  });
}

function dockerExecutable(): string {
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"]
    : ["/usr/bin/docker", "/usr/local/bin/docker"];
  for (const candidate of candidates) {
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Continue to the next conventional installation location.
    }
  }
  return "docker";
}

function explicitDockerSocket(bundleDir?: string): string | undefined {
  const configured = process.env.PROPBENCH_DOCKER_HOST;
  if (configured === undefined || configured === "") return undefined;
  if (!configured.startsWith("unix://")) {
    throw new SandboxUnavailableError("PROPBENCH_DOCKER_HOST must name a local unix:///absolute/path socket");
  }
  const socketPath = configured.slice("unix://".length);
  if (!path.isAbsolute(socketPath) || socketPath.includes("\0") || socketPath.includes("?") || socketPath.includes("#")) {
    throw new SandboxUnavailableError("PROPBENCH_DOCKER_HOST must name a local unix:///absolute/path socket");
  }
  let realSocket: string;
  try {
    realSocket = fsSync.realpathSync(socketPath);
    if (!fsSync.statSync(realSocket).isSocket()) throw new Error("path is not a Unix socket");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SandboxUnavailableError(`configured Docker socket is unavailable: ${detail}`);
  }
  if (bundleDir && pathIsWithin(bundleDir, realSocket)) {
    throw new SandboxUnavailableError("configured Docker socket must remain outside the contestant bundle");
  }
  return `unix://${realSocket}`;
}

function dockerEnvironment(configDir: string, bundleDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: configDir,
    DOCKER_CONFIG: configDir,
    LANG: "C",
    LC_ALL: "C",
  };
  const host = explicitDockerSocket(bundleDir);
  if (host) env.DOCKER_HOST = host;
  return env;
}

function mapDockerExecutable(bundleDir: string, executable: string): string {
  if (!path.isAbsolute(executable)) {
    if (!executable.includes("/")) return executable;
    const candidate = path.resolve(bundleDir, executable);
    assertPathInside(bundleDir, candidate, "Command executable");
    return `/workspace/${path.relative(bundleDir, candidate).split(path.sep).join("/")}`;
  }
  const resolved = path.resolve(executable);
  if (pathIsWithin(bundleDir, resolved)) {
    return `/workspace/${path.relative(bundleDir, resolved).split(path.sep).join("/")}`;
  }
  const allowedRoots = ["/workspace", "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"];
  if (allowedRoots.some(root => pathIsWithin(root, resolved)) || resolved === "/opt/propbench/validator") {
    return resolved;
  }
  throw new SandboxInputError(`Docker sandbox command is outside bundle/system roots: ${executable}`);
}

async function inspectDockerImage(
  docker: string,
  env: NodeJS.ProcessEnv,
  reference: string,
): Promise<SandboxRuntime> {
  const inspected = await captureProcess(docker, ["image", "inspect", reference], { env, timeoutMs: 5000 });
  if (inspected.exitCode !== 0) {
    const hint = reference === DOCKER_IMAGE
      ? `required local image ${DOCKER_IMAGE} is unavailable; build tracks/Dockerfile explicitly`
      : `recorded Frontier image ${reference} is unavailable`;
    throw new SandboxUnavailableError(`${hint} (exit ${inspected.exitCode}): ${inspected.stderr.trim() || inspected.stdout.trim()}`);
  }
  let images: DockerImageInspection[];
  try {
    images = JSON.parse(inspected.stdout) as DockerImageInspection[];
  } catch {
    throw new SandboxUnavailableError(`Docker returned invalid inspection data for ${reference}`);
  }
  const image = images[0];
  const [labelKey, labelValue] = DOCKER_IMAGE_LABEL.split("=", 2);
  if (!image || typeof image.Id !== "string" || !IMAGE_ID.test(image.Id) || image.Os !== "linux" ||
      typeof image.Architecture !== "string" || image.Config?.Labels?.[labelKey] !== labelValue) {
    throw new SandboxUnavailableError(`${reference} is not the labeled Linux Frontier runtime (${DOCKER_IMAGE_LABEL})`);
  }
  if (IMAGE_ID.test(reference) && image.Id !== reference) {
    throw new SandboxUnavailableError(`Docker resolved ${reference} to unexpected image ${image.Id}`);
  }
  return { backend: "docker", image_id: image.Id, architecture: image.Architecture };
}

async function assertDockerDaemon(docker: string, env: NodeJS.ProcessEnv): Promise<void> {
  const info = await captureProcess(docker, ["info", "--format", "{{.ServerVersion}}"], { env, timeoutMs: 5000 });
  if (info.exitCode !== 0 || !info.stdout.trim()) {
    throw new SandboxUnavailableError(
      `Docker daemon unavailable (exit ${info.exitCode}): ${info.stderr.trim() || info.stdout.trim() || "no server version"}`,
    );
  }
}

/** Inspect the already-built local runtime. This never pulls, builds, or starts a VM. */
export async function inspectRuntime(): Promise<SandboxRuntime> {
  const docker = dockerExecutable();
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "propbench-docker-config-"));
  try {
    const env = dockerEnvironment(configDir);
    await assertDockerDaemon(docker, env);
    return await inspectDockerImage(docker, env, DOCKER_IMAGE);
  } catch (err) {
    if (err instanceof SandboxUnavailableError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new SandboxUnavailableError(`Docker inspection failed: ${detail}`);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeContainer(docker: string, env: NodeJS.ProcessEnv, containerName: string): Promise<void> {
  const unavailable = (err: unknown): CapturedProcess => ({
    stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 125,
    timedOut: false, outputLimited: false,
  });
  const removed = await captureProcess(docker, ["container", "rm", "-f", containerName], {
    env, timeoutMs: 5000,
  }).catch(unavailable);
  const checked = await captureProcess(docker, ["container", "inspect", containerName], {
    env, timeoutMs: 5000,
  }).catch(unavailable);
  if (checked.exitCode === 0) {
    throw new SandboxUnavailableError(`failed to remove isolated container ${containerName}: ${removed.stderr.trim() || removed.stdout.trim()}`);
  }
  if (removed.exitCode !== 0 && !/No such (object|container)/i.test(removed.stderr + removed.stdout)) {
    throw new SandboxUnavailableError(`could not confirm cleanup of isolated container ${containerName}: ${removed.stderr.trim() || removed.stdout.trim()}`);
  }
}

async function containerStarted(
  docker: string,
  env: NodeJS.ProcessEnv,
  containerName: string,
): Promise<boolean> {
  const inspected = await captureProcess(
    docker,
    ["container", "inspect", "--format", "{{.State.StartedAt}}", containerName],
    { env, timeoutMs: 5000 },
  ).catch(() => null);
  if (!inspected || inspected.exitCode !== 0) return false;
  const startedAt = inspected.stdout.trim();
  return startedAt !== "" && startedAt !== "0001-01-01T00:00:00Z";
}

async function runDocker(
  bundleDir: string,
  command: string[],
  timeoutMs: number,
  expectedImageId?: string,
  deadline?: number,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  const docker = dockerExecutable();
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "propbench-docker-config-"));
  try {
    const env = dockerEnvironment(configDir, bundleDir);
    await assertDockerDaemon(docker, env);
    const runtime = await inspectDockerImage(docker, env, expectedImageId ?? DOCKER_IMAGE);
    const remainingMs = deadline === undefined ? timeoutMs : Math.min(timeoutMs, Math.floor(deadline - performance.now()));
    if (signal?.aborted || remainingMs <= 0) throw new Error("Frontier wall-clock budget exhausted");
    const mapped = [mapDockerExecutable(bundleDir, command[0]), ...command.slice(1)];
    const containerName = `propbench-frontier-${randomUUID()}`;
    const uid = typeof process.getuid === "function" ? process.getuid() : 65534;
    const gid = typeof process.getgid === "function" ? process.getgid() : 65534;
    const args = [
      "run", "--pull=never", "--name", containerName,
      "--init", "--network=none", "--ipc=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=64", "--memory=512m", "--cpus=1",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
      "--mount", `type=bind,src=${bundleDir},dst=/workspace`,
      "--workdir", "/workspace",
      "--user", `${uid}:${gid}`,
      "--env", "HOME=/workspace/.sandbox-home",
      "--env", "TMPDIR=/tmp",
      "--env", "LANG=C",
      "--env", "LC_ALL=C",
      "--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      runtime.image_id,
      ...mapped,
    ];

    let result: CapturedProcess | undefined;
    let executionError: unknown;
    let terminationCleanup: Promise<void> | undefined;
    const stopWriters = (): void => {
      // Killing only the Docker CLI does not stop container descendants.
      // Start forced removal at the owner cutoff, without an inspection wait.
      terminationCleanup ??= removeContainer(docker, env, containerName);
      void terminationCleanup.catch(() => undefined);
    };
    try {
      result = await captureProcess(docker, args, { env, timeoutMs: remainingMs, signal, onTerminate: stopWriters });
    } catch (err) {
      executionError = err;
    }
    const started = result?.exitCode === 125 ? await containerStarted(docker, env, containerName) : false;
    if (terminationCleanup) await terminationCleanup.catch(() => undefined);
    // Repeat removal after the CLI settles if cancellation raced creation.
    // No caller can inspect submissions until absence is independently checked.
    await removeContainer(docker, env, containerName);
    if (executionError) throw executionError;
    if (!result) throw new Error("Docker execution ended without a result");
    // Docker reserves 125 for its own launch/runtime errors. Preserve 125 only
    // when inspection proves that the contestant process actually started.
    if (result.exitCode === 125 && !started) {
      throw new SandboxUnavailableError(
        `Docker could not start the isolated container: ${result.stderr.trim() || result.stdout.trim() || "exit 125"}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, runtime };
  } finally {
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Execute a command inside the dedicated, pre-built Docker runtime.
 *
 * The command is never run directly on the host. The execution path neither
 * builds nor pulls an image and has no native or unsandboxed fallback.
 */
export async function runSandbox(
  bundleDir: string,
  command: string[],
  options: SandboxRunOptions = {},
): Promise<SandboxRunResult> {
  if (!Array.isArray(command) || command.length === 0 || command.length > 256 ||
      command.some(arg => typeof arg !== "string" || arg.length > 100000 || arg.includes("\0")) ||
      command[0].length === 0) {
    throw new SandboxInputError("Sandbox command must be a non-empty argv array of strings");
  }
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error("Sandbox timeout must be a positive integer number of seconds");
  }
  if (options.imageId !== undefined && !IMAGE_ID.test(options.imageId)) {
    throw new Error("Sandbox imageId must be a full sha256 image ID");
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new Error("Sandbox deadline must be finite");
  if (options.signal?.aborted || (options.deadline !== undefined && options.deadline <= performance.now())) throw new Error("Frontier wall-clock budget exhausted");
  const timeoutMs = Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000;
  const realBundle = await assertBundle(bundleDir);
  // Validate contestant-controlled executable paths before entering the
  // infrastructure error boundary, so bad argv is never reported as a Docker
  // outage (and therefore never mistaken for a skippable acceptance gate).
  mapDockerExecutable(realBundle, command[0]);
  await ensureRuntimeHome(realBundle);
  try {
    return await runDocker(realBundle, command, timeoutMs, options.imageId, options.deadline, options.signal);
  } catch (err) {
    if (err instanceof SandboxUnavailableError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new SandboxUnavailableError(`Docker execution failed before an isolated result was available: ${detail}`);
  }
}
