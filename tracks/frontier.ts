import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  PROJECT_ROOT,
  canonical,
  gradeRun,
  loadRun,
  loadSet,
  parseProof,
  prepareRun,
  readJson,
  sha256,
  validateCandidate,
  verifyRunIdentity,
  writeJson,
} from "./core";
import type {
  BenchmarkSet,
  PrepareOptions,
  RunContext,
  RunReport,
  Theorem,
  Verdict,
} from "./types";
export { runSandbox, SandboxUnavailableError } from "./sandbox";
export type { SandboxRunOptions, SandboxRunResult } from "./sandbox";

const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_PROOF_BYTES = 16 * 1024 * 1024;
const MAX_VALIDATOR_BYTES = 512 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECEIPT_NAME = /^\d{6}\.json$/;

interface SnapshotEntry {
  path: string;
  kind: "file" | "directory";
  mode: number;
  bytes?: number;
  sha256?: string;
}

interface SnapshotIndex {
  schema_version: "propbench-frontier-snapshot-v1";
  digest: string;
  entries: SnapshotEntry[];
}

interface SafeSourceFile {
  bytes: Buffer;
  mode: number;
}

interface SnapshotCollection {
  entries: SnapshotEntry[];
  totalBytes: number;
}

interface SnapshotMode {
  source: string | null;
  digest: string | null;
  index: SnapshotIndex | null;
}

interface FrontierMetadata {
  bundle_dir: string;
  starting_snapshot: string | null;
  /** Owner-only evaluator path; never emitted into the public GOAL.md. */
  validator_path?: string;
}

interface CandidateReceipt {
  schema_version: "propbench-frontier-candidate-v1";
  import_id: string;
  theorem_id: string;
  proof_sha256: string;
  proof_bytes_base64: string;
  verdict: Verdict;
  accepted: boolean;
  incumbent_before: {
    status: Verdict["status"] | "missing";
    line_count: number | null;
    proof_sha256: string | null;
  };
  snapshot_digest: string | null;
  created_at: string;
  checkpoint?: { checkpoint_id: string; execution_command: number; captured_at: string };
}

interface ArchiveReceipt {
  schema_version: "propbench-frontier-archive-v1";
  archive_id: string;
  created_at: string;
  source_bundle: string;
  trigger: "initial" | "import";
  theorem_id?: string;
  candidate_receipt?: string;
  snapshot: SnapshotIndex;
  files: Array<{ path: string; sha256: string; bytes: number; mode: number }>;
}

interface ControlledFinalizationMarker {
  schema_version: "propbench-frontier-controlled-finalization-v1";
  run_id: string;
  created_at: string;
  submissions: Array<{ name: string; kind: "file" | "directory" | "symlink" | "special"; bytes?: number; sha256?: string }>;
  contestant_rejection?: string;
}

export interface ControlledFinalizationResult {
  report: RunReport;
  contestant_rejection?: string;
}

interface ControlledCheckpoint {
  schema_version: "propbench-frontier-checkpoint-v1";
  checkpoint_id: string;
  execution_command: number;
  captured_at: string;
  capture_elapsed_ms: number;
  capture_remaining_ms: number;
  submissions: Array<{ id: string; proof_sha256: string; proof_bytes_base64: string }>;
  contestant_rejection?: string;
  artifact_snapshot?: string;
  artifact_rejection?: string;
}

interface CheckpointSeal {
  schema_version: "propbench-frontier-checkpoint-seal-v1";
  run_id: string;
  last_checkpoint: string | null;
  checkpoints: number;
  artifact_snapshot: string;
  closed_at: string;
}

/** Owner capability, never exposed as a contestant tool or CLI import command. */
export interface ControlledFrontierCheckpoints {
  afterExecution(executionCommand: number): Promise<void>;
  close(): void;
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve a path through its existing prefix while retaining the requested
 * suffix. macOS exposes /var as a symlink to /private/var; comparing a
 * canonical parent with a lexical /var child is therefore incorrect.
 */
function nearestExistingPath(target: string): string {
  const requested = path.resolve(target);
  let current = requested;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = fsSync.realpathSync(current);
      // `suffix` is built with unshift while walking upward, so it already
      // runs from the existing prefix down to the requested leaf.
      return path.resolve(real, ...suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Cannot resolve path parent: ${target}`);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertDisjoint(left: string, right: string, label: string): void {
  const resolvedLeft = nearestExistingPath(left);
  const resolvedRight = nearestExistingPath(right);
  if (isWithin(resolvedLeft, resolvedRight) || isWithin(resolvedRight, resolvedLeft)) {
    throw new Error(`${label} must be disjoint from ${right}: ${left}`);
  }
}

function lstatNoSymlink(file: string): fsSync.Stats {
  const stat = fsSync.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${file}`);
  // A hard link can expose bytes owned by a different tree while appearing to
  // be an ordinary file. Contestant and inherited files are copied by value,
  // so refusing multiply-linked files keeps that boundary explicit.
  if (stat.isFile() && stat.nlink > 1) throw new Error(`Hardlink is not allowed: ${file}`);
  return stat;
}

function assertDirectory(dir: string, label = "Directory"): fsSync.Stats {
  const stat = lstatNoSymlink(dir);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${dir}`);
  return stat;
}

function assertRegular(file: string, label = "File"): fsSync.Stats {
  const stat = lstatNoSymlink(file);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return stat;
}

function assertSafeTree(root: string): void {
  const visit = (current: string): void => {
    const stat = lstatNoSymlink(current);
    if (stat.isDirectory()) {
      for (const name of fsSync.readdirSync(current)) {
        if (name === "." || name === ".." || name.includes(path.sep)) {
          throw new Error(`Invalid path entry: ${current}/${name}`);
        }
        visit(path.join(current, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Special file is not allowed: ${current}`);
  };
  visit(root);
}

function readSafeFile(file: string, maxBytes: number): SafeSourceFile {
  const stat = assertRegular(file);
  if (stat.size > maxBytes) throw new Error(`File exceeds size cap (${maxBytes} bytes): ${file}`);
  // O_NOFOLLOW protects the final path component if it is replaced between
  // lstat and read. Explicit tree traversal validates parent components.
  const fd = fsSync.openSync(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1 || opened.size > maxBytes) {
      throw new Error(`File changed to an unsafe target: ${file}`);
    }
    return { bytes: fsSync.readFileSync(fd), mode: opened.mode & 0o7777 };
  } finally {
    fsSync.closeSync(fd);
  }
}

function writeExclusive(file: string, bytes: Buffer | string, mode = 0o644): void {
  const fd = fsSync.openSync(
    file,
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
    mode,
  );
  try {
    fsSync.writeFileSync(fd, bytes);
    fsSync.fchmodSync(fd, mode & 0o7777);
  } finally {
    fsSync.closeSync(fd);
  }
}

function mkdirExact(dir: string, mode = 0o755): void {
  fsSync.mkdirSync(dir, { recursive: false, mode });
  fsSync.chmodSync(dir, mode & 0o7777);
}

function copyExact(source: string, destination: string, maxBytes: number): Buffer {
  const value = readSafeFile(source, maxBytes);
  writeExclusive(destination, value.bytes, value.mode || 0o644);
  return value.bytes;
}

function selectedSetManifest(sourceManifestPath: string, set: BenchmarkSet): Record<string, unknown> {
  const source = readJson<Record<string, unknown>>(sourceManifestPath);
  const selected = new Set(set.items.map(item => item.id));
  const result: Record<string, unknown> = {
    set_version: set.version,
    core_tag: set.core_tag,
    items: set.items.map(({ theorem, ...item }) => item),
  };
  // Historical imputed_ratio is harmless set metadata. Exclude every other
  // source-manifest field so answer-key or host metadata cannot cross the
  // public boundary.
  if (typeof source.imputed_ratio === "number" && Number.isFinite(source.imputed_ratio)) {
    result.imputed_ratio = source.imputed_ratio;
  }
  if (!set.items.every(item => selected.has(item.id))) throw new Error("Selection identity changed while exporting");
  return result;
}

function relativeSnapshotPath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some(part => part === ".." || part === "" || part === ".")) {
    throw new Error(`Unsafe inherited snapshot path: ${value}`);
  }
  return normalized;
}

function assertSnapshotProofName(relative: string, selectedIds?: Set<string>): void {
  if (!relative.startsWith("proofs/")) return;
  const name = relative.slice("proofs/".length);
  if (name.includes("/")) return;
  if (name === ".gitkeep") return;
  if (!name.endsWith(".json")) throw new Error(`Inherited proofs may contain only theorem JSON files: ${name}`);
  const id = name.slice(0, -5);
  if (!ID.test(id) || (selectedIds && !selectedIds.has(id))) {
    throw new Error(`Unknown inherited proof: ${name}`);
  }
}

/**
 * Collect only the state explicitly allowed to cross a Frontier boundary.
 * Unknown top-level files are deliberately not traversed: a prior bundle may
 * contain owner metadata, but this operation never reads it.
 */
function collectSnapshotEntries(
  snapshotDir: string,
  selectedIds?: Set<string>,
  options: { skipProofContents?: boolean } = {},
): SnapshotCollection {
  assertDirectory(snapshotDir, "Snapshot");
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  const add = (relative: string, source: string): void => {
    if (entries.length >= MAX_SNAPSHOT_ENTRIES) throw new Error("Inherited snapshot has too many entries");
    const safeRelative = relativeSnapshotPath(relative);
    const stat = lstatNoSymlink(source);
    // Inspect the filesystem object before applying filename policy so a
    // symlink (including one with an unrecognised name) always fails closed as
    // a topology violation.
    assertSnapshotProofName(safeRelative, selectedIds);
    if (stat.isDirectory()) {
      entries.push({ path: safeRelative, kind: "directory", mode: stat.mode & 0o7777 });
      for (const name of fsSync.readdirSync(source).sort()) {
        if (name === "." || name === ".." || name.includes(path.sep)) throw new Error(`Invalid snapshot entry: ${name}`);
        add(`${safeRelative}/${name}`, path.join(source, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Special file is not allowed in inherited snapshot: ${source}`);
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES || totalBytes + stat.size > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new Error(`Inherited snapshot exceeds size cap: ${source}`);
    }
    const value = readSafeFile(source, MAX_SNAPSHOT_FILE_BYTES);
    totalBytes += value.bytes.byteLength;
    entries.push({
      path: safeRelative,
      kind: "file",
      mode: value.mode,
      bytes: value.bytes.byteLength,
      sha256: sha256(value.bytes),
    });
  };

  for (const root of ["proofs", "tools"]) {
    const rootPath = path.join(snapshotDir, root);
    if (root === "proofs" && options.skipProofContents) {
      // A controlled contestant may have removed or replaced the entire
      // proofs root. The rejection marker captures that topology; recovery
      // archives must not traverse or require it because the archive creates
      // a clean proofs root from accepted owner submissions below.
      continue;
    }
    assertDirectory(rootPath, `Snapshot ${root}`);
    add(root, rootPath);
  }
  for (const name of ["METHODS.md", "LOG.md", "DEBRIEF.md"]) {
    const source = path.join(snapshotDir, name);
    assertRegular(source, `Snapshot ${name}`);
    add(name, source);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, totalBytes };
}

function snapshotDigest(entries: SnapshotEntry[]): string {
  return sha256(canonical({ schema_version: "propbench-frontier-snapshot-v1", entries }));
}

function bundleDigest(bundle: string): string {
  const entries: Array<{path: string; mode: number; sha256?: string}> = [];
  const visit = (dir: string): void => {
    for (const name of fsSync.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = lstatNoSymlink(file);
      if (entries.length >= MAX_SNAPSHOT_ENTRIES) throw new Error("Bundle has too many entries");
      const item: {path: string; mode: number; sha256?: string} = { path: path.relative(bundle, file), mode: stat.mode & 0o7777 };
      if (stat.isFile()) item.sha256 = sha256(readSafeFile(file, MAX_SNAPSHOT_FILE_BYTES).bytes);
      else if (!stat.isDirectory()) throw new Error("Bundle contains a special file");
      entries.push(item);
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(bundle);
  return sha256(canonical(entries));
}

/** Reject inherited edits made after preparation and before controlled execution. */
export function verifyStartingBundle(ctx: RunContext): void {
  const metadata = safeFrontierMetadata(ctx.dir);
  if (metadata.starting_snapshot !== ctx.config.starting_snapshot) throw new Error("Frontier metadata snapshot differs from sealed run configuration");
  const initial = readJson<{sha256: string}>(path.join(ctx.dir, "bundle-initial.json"));
  if (bundleDigest(metadata.bundle_dir) !== initial.sha256) throw new Error("Frontier bundle changed before its first controlled generation; prepare a new explicit snapshot");
}

function copySnapshotEntry(sourceRoot: string, destinationRoot: string, entry: SnapshotEntry): void {
  const source = path.join(sourceRoot, ...entry.path.split("/"));
  const destination = path.join(destinationRoot, ...entry.path.split("/"));
  if (!isWithin(nearestExistingPath(destinationRoot), nearestExistingPath(destination))) {
    throw new Error(`Inherited snapshot destination escaped bundle: ${entry.path}`);
  }
  if (entry.kind === "directory") {
    mkdirExact(destination, entry.mode || 0o755);
    return;
  }
  const parent = path.dirname(destination);
  if (!fsSync.existsSync(parent)) fsSync.mkdirSync(parent, { recursive: true, mode: 0o755 });
  assertDirectory(parent, "Snapshot destination parent");
  const value = readSafeFile(source, MAX_SNAPSHOT_FILE_BYTES);
  if (value.bytes.byteLength !== entry.bytes || sha256(value.bytes) !== entry.sha256 || value.mode !== entry.mode) {
    throw new Error(`Inherited snapshot changed while exporting: ${entry.path}`);
  }
  writeExclusive(destination, value.bytes, entry.mode || 0o644);
}

/** Capture all permitted method/tool bytes synchronously while writers are stopped. */
function captureMethodState(bundle: string, selectedIds: Set<string>): Array<{ entry: SnapshotEntry; bytes?: Buffer }> {
  const snapshot = collectSnapshotEntries(bundle, selectedIds, { skipProofContents: true });
  return snapshot.entries.map(entry => {
    if (entry.kind === "directory") return { entry };
    const value = readSafeFile(path.join(bundle, ...entry.path.split("/")), MAX_SNAPSHOT_FILE_BYTES);
    if (value.bytes.length !== entry.bytes || sha256(value.bytes) !== entry.sha256 || value.mode !== entry.mode) {
      throw new Error(`Inherited snapshot changed while capturing: ${entry.path}`);
    }
    return { entry, bytes: value.bytes };
  });
}

function writeCapturedMethodState(destination: string, captured: ReturnType<typeof captureMethodState>): void {
  mkdirExact(destination, 0o700);
  // Entries sort lexically, with directory ancestors before their children.
  for (const { entry, bytes } of captured) {
    const target = path.join(destination, ...entry.path.split("/"));
    if (entry.kind === "directory") mkdirExact(target, entry.mode || 0o755);
    else writeExclusive(target, bytes!, entry.mode || 0o644);
  }
  const entries = captured.map(value => value.entry);
  const index: SnapshotIndex = { schema_version: "propbench-frontier-snapshot-v1", digest: snapshotDigest(entries), entries };
  writeExclusive(path.join(destination, "SNAPSHOT.json"), JSON.stringify(index, null, 2) + "\n", 0o400);
}

function buildGoal(ctx: RunContext, bundleSnapshot: string | null, validatorCopied = false): string {
  const lines = [
    "# Frontier contest bundle",
    "",
    "This directory is a public contestant bundle for one fixed Frontier run.",
    "The controller grades only proof JSON submitted in proofs/<theorem-id>.json.",
    ...(ctx.config.execution_protocol === "frontier-subscription-v2" ? [
      "After each exec stops, the owner captures proofs, tools, and journals before the shared deadline and retains each shortest independently valid proof.",
      "Snapshot capture and owner checking use the shared wall-clock allowance. Checks of already captured bytes may finish after cutoff; no later files are accepted.",
      "Checkpoint verdicts are not returned to you. Use ./validator for your own checks. Final cumulative archives inherit only the latest timely tools and journals.",
    ] : []),
    "The canonical theorem set is in set/; do not add or replace theorem files.",
    "",
    `Selected theorems: ${ctx.set.items.map(item => item.id).join(", ")}`,
    `Set identity: ${ctx.set.hash}`,
    `Mode: ${ctx.config.mode}`,
    `Starting snapshot digest: ${bundleSnapshot ?? "none (fresh run)"}`,
    "",
    "rules.md is the authoritative rulebook. Premise lines are free and are not counted in L.",
    "For a valid proof, the owner score contribution is L/(L+par); missing or invalid proofs score 1.",
    "par is an achievable reference target, not a minimum and not a claim of optimality.",
    "Each proof file is one JSON array of objects with exactly line_number, formula, justification, and depth.",
    "Submit derived lines only: premises are seeded automatically, every submitted line is counted in L, and line numbers continue after the premises.",
    "Use the rule names and justification syntax from rules.md. Assumptions and CP/IP ranges must be truthful; depth and cited ranges are checked by the strict validator.",
    "The proof must finish with the theorem conclusion at depth 0. Extra keys, prose, premise-justification lines, malformed JSON, and unknown rule text are rejected.",
    "",
    "Scripts, solvers, and subagents may be used only through the controller's restricted JSONL sandbox bridge.",
    "A normal agent checkout or shell is not an isolated Frontier runtime, and networking is denied in isolated execution.",
    validatorCopied
      ? "./validator launches the container's Linux verifier for local checks; the owner independently revalidates every import with its pinned native referee."
      : "No validator binary is copied into this bundle.",
    "Exact local validation command: ./validator validate --strict-protocol --theorem set/<theorem-id>.json --proof proofs/<theorem-id>.json",
    "",
    "Fresh bundles start with empty proofs, tools, and methodology journals.",
    "Cumulative bundles preserve the inherited methodology files byte-for-byte; those files are archived context and are never executed.",
    "Submit one bounded JSON proof array per theorem. Malformed, missing, or invalid proofs receive the common owner-side verdict.",
    "",
  ];
  return lines.join("\n");
}

function assertNewBundle(bundleDir: string, options: PrepareOptions, snapshotDir?: string): string {
  const absolute = path.resolve(bundleDir);
  try {
    fsSync.lstatSync(absolute);
    throw new Error(`Bundle directory must be new: ${absolute}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  assertDisjoint(absolute, PROJECT_ROOT, "Bundle directory");
  assertDisjoint(absolute, options.root, "Bundle directory");
  if (snapshotDir) {
    const snapshot = path.resolve(snapshotDir);
    assertDisjoint(absolute, snapshot, "Bundle directory");
    assertDirectory(snapshot, "Snapshot");
  }
  const parent = path.dirname(absolute);
  const parentResolved = nearestExistingPath(parent);
  // Compare canonical paths on both sides. This is the /var -> /private/var
  // case on macOS and is also the path-escape guard for symlinked parents.
  if (!isWithin(parentResolved, nearestExistingPath(absolute))) {
    throw new Error("Bundle parent resolution escaped its requested path");
  }
  if (!fsSync.existsSync(parent)) fsSync.mkdirSync(parent, { recursive: true, mode: 0o755 });
  return absolute;
}

function ensureSnapshotMode(
  options: PrepareOptions,
  snapshotDir: string | undefined,
  selectedIds: Set<string>,
): SnapshotMode {
  if (options.track !== "frontier") throw new Error("prepareFrontier requires the Frontier track");
  if (options.mode === "fresh") {
    if (snapshotDir || options.startingSnapshot) throw new Error("Fresh Frontier exports cannot inherit a snapshot");
    return { source: null, digest: null, index: null };
  }
  if (options.mode !== "cumulative") throw new Error("Frontier mode must be fresh or cumulative");
  if (!snapshotDir) throw new Error("Cumulative Frontier exports require a prior safe bundle snapshot");
  if (options.startingSnapshot) throw new Error("prepareFrontier derives starting_snapshot from snapshotDir");
  const source = path.resolve(snapshotDir);
  assertDirectory(source, "Snapshot");
  const collected = collectSnapshotEntries(source, selectedIds);
  const digest = snapshotDigest(collected.entries);
  return {
    source,
    digest,
    index: { schema_version: "propbench-frontier-snapshot-v1", digest, entries: collected.entries },
  };
}

function ensureValidator(options: PrepareOptions): { source: string; mode: number } {
  const source = path.resolve(options.validator);
  const stat = assertRegular(source, "Validator");
  const mode = stat.mode & 0o7777;
  if ((mode & 0o111) === 0) throw new Error(`Validator must be executable: ${source}`);
  return { source, mode };
}

function emptyVerdict(status: Verdict["status"], error?: string): Verdict {
  return { status, line_count: null, errors: error ? [error] : [] };
}

/**
 * Synchronous owner-side validation used only while establishing a cumulative
 * baseline. A validator that cannot be started leaves that inherited proof out
 * of the baseline; normal imports use core.validateCandidate and fail closed
 * on verifier infrastructure errors.
 */
function validateInheritedProof(validator: string, theorem: Theorem, bytes: Buffer): Verdict | null {
  let lines: unknown;
  try {
    lines = parseProof(bytes.toString("utf8"));
  } catch (err) {
    return emptyVerdict("parse_error", String(err));
  }
  const temp = fsSync.mkdtempSync(path.join(os.tmpdir(), "propbench-frontier-baseline-"));
  try {
    const theoremPath = path.join(temp, "theorem.json");
    const proofPath = path.join(temp, "proof.json");
    writeExclusive(theoremPath, JSON.stringify(theorem), 0o600);
    writeExclusive(proofPath, JSON.stringify(lines), 0o600);
    const result = spawnSync(
      validator,
      ["validate", "--strict-protocol", "--theorem", theoremPath, "--proof", proofPath],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (result.error || result.signal || result.status === null || result.status > 1) return null;
    const output = String(result.stdout ?? "").trim();
    try {
      const parsed = JSON.parse(output) as { valid?: unknown; line_count?: unknown; errors?: unknown };
      if (typeof parsed.valid !== "boolean" || !Array.isArray(parsed.errors)) return null;
      if (parsed.valid && (!Number.isSafeInteger(parsed.line_count) || (parsed.line_count as number) < 0)) return null;
      return {
        status: parsed.valid ? "valid" : "invalid",
        line_count: parsed.valid ? parsed.line_count as number : null,
        errors: parsed.errors.map(value => String(value)),
      };
    } catch {
      if (result.status === 1) return emptyVerdict("invalid", String(result.stderr || result.stdout || "invalid proof"));
      return null;
    }
  } finally {
    fsSync.rmSync(temp, { recursive: true, force: true });
  }
}

function safeFrontierMetadata(runDir: string, requireBundle = true): FrontierMetadata {
  const metadata = readJson<FrontierMetadata>(path.join(runDir, "frontier.json"));
  if (typeof metadata.bundle_dir !== "string" || !path.isAbsolute(metadata.bundle_dir) ||
      (metadata.starting_snapshot !== null && typeof metadata.starting_snapshot !== "string") ||
      metadata.validator_path !== path.join(runDir, "referee", "validator")) {
    throw new Error("Invalid Frontier metadata");
  }
  if (requireBundle) assertDirectory(metadata.bundle_dir, "Frontier bundle");
  assertRegular(metadata.validator_path, "Pinned validator");
  return metadata;
}

function ensureOwnerArchiveDirs(runDir: string): void {
  const receipts = path.join(runDir, "candidate-receipts");
  const archives = path.join(runDir, "archives");
  for (const dir of [receipts, archives]) {
    if (fsSync.existsSync(dir)) assertDirectory(dir, "Owner archive directory");
    else mkdirExact(dir, 0o700);
  }
}

function validProofPaths(runDir: string, set: BenchmarkSet): Array<{ id: string; bytes: Buffer; mode: number }> {
  const submissions = path.join(runDir, "submissions");
  assertDirectory(submissions, "Owner submissions");
  const output: Array<{ id: string; bytes: Buffer; mode: number }> = [];
  for (const item of set.items) {
    const file = path.join(submissions, item.id + ".json");
    if (!fsSync.existsSync(file)) continue;
    const value = readSafeFile(file, MAX_PROOF_BYTES);
    output.push({ id: item.id, bytes: value.bytes, mode: value.mode });
  }
  return output;
}

function nextArchiveId(archives: string): string {
  let maximum = -1;
  for (const name of fsSync.readdirSync(archives)) {
    const stat = lstatNoSymlink(path.join(archives, name));
    if (!stat.isDirectory() || !/^\d{6}$/.test(name)) throw new Error(`Unexpected owner archive entry: ${name}`);
    maximum = Math.max(maximum, Number(name));
  }
  return String(maximum + 1).padStart(6, "0");
}

/**
 * Archive the explicit public state and the currently accepted owner proofs.
 * Every archive directory is created once and every file is written with
 * O_EXCL, so later imports cannot rewrite historical method/tool/proof state.
 */
function archiveState(
  ctx: RunContext,
  bundleDir: string,
  trigger: "initial" | "import",
  theoremId?: string,
  candidateReceipt?: string,
  skipContestantProofs = false,
): string {
  ensureOwnerArchiveDirs(ctx.dir);
  const selectedIds = new Set(ctx.set.items.map(item => item.id));
  // This reads only the explicitly exportable paths. Unknown top-level owner
  // files in a contestant bundle remain outside the archive boundary.
  const publicState = collectSnapshotEntries(bundleDir, selectedIds, { skipProofContents: skipContestantProofs });
  const archives = path.join(ctx.dir, "archives");
  const archiveId = nextArchiveId(archives);
  const destination = path.join(archives, archiveId);
  mkdirExact(destination, 0o700);
  mkdirExact(path.join(destination, "proofs"), 0o700);
  mkdirExact(path.join(destination, "tools"), 0o700);

  const currentProofs = validProofPaths(ctx.dir, ctx.set);
  for (const proof of currentProofs) {
    writeExclusive(path.join(destination, "proofs", proof.id + ".json"), proof.bytes, proof.mode || 0o600);
  }
  if (!currentProofs.length) {
    writeExclusive(path.join(destination, "proofs", ".gitkeep"), Buffer.alloc(0), 0o644);
  }
  for (const entry of publicState.entries) {
    if (entry.path === "proofs" || entry.path.startsWith("proofs/") || entry.path === "tools") continue;
    copySnapshotEntry(bundleDir, destination, entry);
  }
  // The owner archive always has both explicit roots and all three journals,
  // even if the source bundle's proof directory had no accepted proof.
  const archived = collectSnapshotEntries(destination, selectedIds);
  const digest = snapshotDigest(archived.entries);
  const snapshot: SnapshotIndex = { schema_version: "propbench-frontier-snapshot-v1", digest, entries: archived.entries };
  writeExclusive(path.join(destination, "SNAPSHOT.json"), Buffer.from(JSON.stringify(snapshot, null, 2) + "\n"), 0o400);
  const receipt: ArchiveReceipt = {
    schema_version: "propbench-frontier-archive-v1",
    archive_id: archiveId,
    created_at: new Date().toISOString(),
    source_bundle: path.resolve(bundleDir),
    trigger,
    ...(theoremId ? { theorem_id: theoremId } : {}),
    ...(candidateReceipt ? { candidate_receipt: candidateReceipt } : {}),
    snapshot,
    files: archived.entries
      .filter(entry => entry.kind === "file")
      .map(entry => ({ path: entry.path, sha256: entry.sha256!, bytes: entry.bytes!, mode: entry.mode })),
  };
  writeExclusive(path.join(destination, "RECEIPT.json"), Buffer.from(JSON.stringify(receipt, null, 2) + "\n"), 0o400);
  return path.join(destination, "RECEIPT.json");
}

function describeSubmissionDirectory(proofsDir: string): ControlledFinalizationMarker["submissions"] {
  try {
    const stat = fsSync.lstatSync(proofsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [{ name: ".", kind: stat.isSymbolicLink() ? "symlink" : "special" }];
    return fsSync.readdirSync(proofsDir).sort().slice(0, MAX_SNAPSHOT_ENTRIES).map(name => {
      const file = path.join(proofsDir, name);
      const entry = fsSync.lstatSync(file);
      if (entry.isSymbolicLink()) return { name, kind: "symlink" as const };
      if (entry.isDirectory()) return { name, kind: "directory" as const };
      if (!entry.isFile()) return { name, kind: "special" as const };
      if (entry.size > MAX_PROOF_BYTES || entry.nlink > 1) return { name, kind: "file" as const, bytes: entry.size };
      const bytes = readSafeFile(file, MAX_PROOF_BYTES).bytes;
      return { name, kind: "file" as const, bytes: bytes.byteLength, sha256: sha256(bytes) };
    });
  } catch {
    return [];
  }
}

function knownContestantSubmissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:Proofs directory|Proofs \.gitkeep|Unknown submission item|Symlink is not allowed|Hardlink is not allowed|File exceeds size cap|File changed to an unsafe target)/.test(message);
}

function writeControlledFinalizationMarker(
  ctx: RunContext,
  proofsDir: string,
  contestantRejection?: string,
  captured?: Array<{ id: string; bytes: Buffer }>,
): void {
  const marker: ControlledFinalizationMarker = {
    schema_version: "propbench-frontier-controlled-finalization-v1",
    run_id: ctx.config.run_id,
    created_at: new Date().toISOString(),
    submissions: captured ? captured.map(entry => ({ name: entry.id + ".json", kind: "file", bytes: entry.bytes.length, sha256: sha256(entry.bytes) })) : describeSubmissionDirectory(proofsDir),
    ...(contestantRejection ? { contestant_rejection: contestantRejection } : {}),
  };
  const file = path.join(ctx.dir, "controlled-finalization.json");
  writeExclusive(file, Buffer.from(JSON.stringify(marker, null, 2) + "\n"), 0o400);
}

function readSubmissionEntries(proofsDir: string, selectedIds: Set<string>): Array<{ id: string; bytes: Buffer }> {
  assertDirectory(proofsDir, "Proofs directory");
  const entries: Array<{ id: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  const names = fsSync.readdirSync(proofsDir).sort();
  if (names.length > MAX_SNAPSHOT_ENTRIES) throw new Error("Proofs directory has too many entries");
  for (const name of names) {
    const source = path.join(proofsDir, name);
    const stat = lstatNoSymlink(source);
    if (name === ".gitkeep") {
      if (!stat.isFile()) throw new Error("Proofs .gitkeep must be a regular file");
      continue;
    }
    if (!stat.isFile() || !name.endsWith(".json")) {
      throw new Error(`Proofs directory may contain only theorem JSON files: ${name}`);
    }
    const id = name.slice(0, -5);
    if (!ID.test(id) || !selectedIds.has(id)) throw new Error(`Unknown submission item: ${name}`);
    const bytes = readSafeFile(source, MAX_PROOF_BYTES).bytes;
    totalBytes += bytes.length;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw new Error("Proofs directory exceeds total size cap");
    entries.push({ id, bytes });
  }
  return entries;
}

function installSubmission(runDir: string, id: string, bytes: Buffer): void {
  const submissions = path.join(runDir, "submissions");
  assertDirectory(submissions, "Owner submissions");
  const destination = path.join(submissions, id + ".json");
  if (fsSync.existsSync(destination)) {
    const stat = lstatNoSymlink(destination);
    if (!stat.isFile()) throw new Error(`Existing owner submission is not regular: ${destination}`);
  }
  const temporary = path.join(submissions, `.${id}.${randomUUID()}.tmp`);
  writeExclusive(temporary, bytes, 0o600);
  try {
    fsSync.renameSync(temporary, destination);
    fsSync.chmodSync(destination, 0o600);
  } finally {
    if (fsSync.existsSync(temporary)) fsSync.unlinkSync(temporary);
  }
}

function incumbentProof(runDir: string, id: string): { bytes: Buffer; sha256: string } | null {
  const file = path.join(runDir, "submissions", id + ".json");
  if (!fsSync.existsSync(file)) return null;
  const value = readSafeFile(file, MAX_PROOF_BYTES);
  return { bytes: value.bytes, sha256: sha256(value.bytes) };
}

function nextReceiptPath(runDir: string, id: string): string {
  const root = path.join(runDir, "candidate-receipts");
  ensureOwnerArchiveDirs(runDir);
  const itemDir = path.join(root, id);
  if (fsSync.existsSync(itemDir)) assertDirectory(itemDir, "Candidate receipt directory");
  else mkdirExact(itemDir, 0o700);
  let maximum = 0;
  for (const name of fsSync.readdirSync(itemDir)) {
    const stat = lstatNoSymlink(path.join(itemDir, name));
    if (!stat.isFile() || !RECEIPT_NAME.test(name)) throw new Error(`Unexpected candidate receipt entry: ${name}`);
    maximum = Math.max(maximum, Number(name.slice(0, -5)));
  }
  return path.join(itemDir, String(maximum + 1).padStart(6, "0") + ".json");
}

function executionLockPresent(runDir: string): boolean {
  const lock = path.join(runDir, "execution.lock");
  try {
    const stat = fsSync.lstatSync(lock);
    if (stat.isSymbolicLink()) throw new Error("execution.lock must not be a symlink");
    if (!stat.isFile()) throw new Error("execution.lock must be a regular file");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function assertPinnedOwnerReferee(ctx: RunContext): string {
  const validator = path.join(ctx.dir, "referee", "validator");
  const rules = path.join(ctx.dir, "referee", "rules.md");
  if (sha256(readSafeFile(validator, MAX_VALIDATOR_BYTES).bytes) !== ctx.config.validator_sha256) {
    throw new Error("Pinned verifier changed since preparation");
  }
  if (sha256(readSafeFile(rules, MAX_SNAPSHOT_FILE_BYTES).bytes) !== ctx.config.rulebook_sha256) {
    throw new Error("Pinned rulebook changed since preparation");
  }
  return validator;
}

function assertCanonicalDirectoryAncestry(directory: string): fsSync.Stats {
  const parsed = path.parse(directory);
  let current = parsed.root;
  let stat = assertDirectory(current);
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    stat = assertDirectory(current);
  }
  return stat;
}

/**
 * Activate once inside a running subscription controller. The bridge invokes
 * afterExecution while holding execution.lock, after all sandbox writers have
 * stopped. Capture is synchronous and must finish before the monotonic owner
 * deadline; validation may finish later against those immutable bytes. Nothing
 * from this capability is returned to the model.
 */
export function createControlledFrontierCheckpoints(
  ctx: RunContext,
  validator: string,
  deadline: number,
): ControlledFrontierCheckpoints {
  if (ctx.config.track !== "frontier" || ctx.config.execution_protocol !== "frontier-subscription-v2") {
    throw new Error("Checkpoint capture requires Frontier subscription protocol v2");
  }
  verifyRunIdentity(ctx, validator);
  const pinnedValidator = assertPinnedOwnerReferee(ctx);
  const metadata = safeFrontierMetadata(ctx.dir);
  const bundle = fsSync.realpathSync(metadata.bundle_dir);
  const bundleIdentity = assertCanonicalDirectoryAncestry(bundle);
  const proofsDir = path.join(bundle, "proofs");
  const selectedIds = new Set(ctx.set.items.map(item => item.id));
  const root = path.join(ctx.dir, "checkpoints");
  const started = performance.now();
  let closed = false;
  let busy = false;
  let lastCommand = 0;
  let count = 0;
  let lastCheckpoint: string | null = null;
  let lastArtifactSnapshot = "archives/000000";
  const assertActive = (): void => {
    if (closed || fsSync.existsSync(path.join(ctx.dir, "controlled-finalization.json")) ||
        fsSync.existsSync(path.join(ctx.dir, "checkpoint-seal.json"))) {
      throw new Error("Frontier checkpoint controller is closed");
    }
    assertRegular(path.join(ctx.dir, "subscription.lock"), "Active subscription lock");
    const state = readJson<{ status: string }>(path.join(ctx.dir, "controller.json"));
    if (state.status !== "running") throw new Error("Frontier checkpoints require an active subscription controller");
  };
  assertActive();
  if (!Number.isFinite(deadline) || deadline <= started) throw new Error("Frontier checkpoint deadline has expired");
  mkdirExact(root, 0o700);
  mkdirExact(path.join(ctx.dir, "checkpoint-artifacts"), 0o700);
  return {
    async afterExecution(executionCommand): Promise<void> {
      assertActive();
      if (!executionLockPresent(ctx.dir)) throw new Error("Frontier checkpoint requires the active execution.lock");
      if (busy) throw new Error("Frontier checkpoint capture is already active");
      if (!Number.isSafeInteger(executionCommand) || executionCommand <= lastCommand) throw new Error("Frontier checkpoint execution must advance");
      const execution = readJson<{ commands: number }>(path.join(ctx.dir, "execution.json"));
      const command = readJson<{ completed_at?: string }>(path.join(ctx.dir, `exec-${String(executionCommand).padStart(6, "0")}.json`));
      if (execution.commands !== executionCommand || !command.completed_at) throw new Error("Frontier checkpoint requires a completed isolated execution");
      lastCommand = executionCommand;
      // A late command never opens mutable contestant files. The prior owner
      // incumbent remains available even if that final command overwrote it.
      if (performance.now() >= deadline) return;
      busy = true;
      try {
        let captured: Array<{ id: string; bytes: Buffer }> = [];
        let rejection: string | undefined;
        let bundleSafe = false;
        try {
          const current = assertCanonicalDirectoryAncestry(bundle);
          if (current.dev !== bundleIdentity.dev || current.ino !== bundleIdentity.ino ||
              fsSync.realpathSync(metadata.bundle_dir) !== bundle) {
            throw new Error("Proofs directory bundle ancestry changed during execution");
          }
          bundleSafe = true;
          captured = readSubmissionEntries(proofsDir, selectedIds);
        } catch (error) {
          if (!knownContestantSubmissionError(error)) throw error;
          rejection = error instanceof Error ? error.message : String(error);
        }
        let artifacts: ReturnType<typeof captureMethodState> | undefined;
        let artifactRejection: string | undefined;
        if (bundleSafe && performance.now() < deadline) {
          try { artifacts = captureMethodState(bundle, selectedIds); }
          catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (!knownContestantSubmissionError(error) && !/^(?:Inherited snapshot|Snapshot|Special file)/.test(detail)) throw error;
            artifactRejection = detail;
          }
        }
        const capturedAt = new Date().toISOString();
        const capturedTime = performance.now();
        if (capturedTime >= deadline) return;
        const id = String(++count).padStart(6, "0");
        const artifactSnapshot = artifacts ? `checkpoint-artifacts/${id}` : undefined;
        const checkpoint: ControlledCheckpoint = {
          schema_version: "propbench-frontier-checkpoint-v1",
          checkpoint_id: id,
          execution_command: executionCommand,
          captured_at: capturedAt,
          capture_elapsed_ms: ctx.config.budget.wall_seconds * 1000 - (deadline - capturedTime),
          capture_remaining_ms: deadline - capturedTime,
          submissions: captured.map(entry => ({ id: entry.id, proof_sha256: sha256(entry.bytes), proof_bytes_base64: entry.bytes.toString("base64") })),
          ...(rejection ? { contestant_rejection: rejection } : {}),
          ...(artifactSnapshot ? { artifact_snapshot: artifactSnapshot } : {}),
          ...(artifactRejection ? { artifact_rejection: artifactRejection } : {}),
        };
        // Seal before awaiting the referee. Neither a later exec nor a host
        // edit can change the bytes that this checkpoint records and grades.
        writeExclusive(path.join(root, id + ".json"), JSON.stringify(checkpoint, null, 2) + "\n", 0o400);
        lastCheckpoint = id;
        if (artifactSnapshot && artifacts) {
          writeCapturedMethodState(path.join(ctx.dir, artifactSnapshot), artifacts);
          lastArtifactSnapshot = artifactSnapshot;
        }
        await acceptCapturedCandidates(ctx, captured, pinnedValidator, {
          checkpoint_id: id, execution_command: executionCommand, captured_at: capturedAt,
        });
      } finally {
        busy = false;
      }
    },
    close(): void {
      assertActive();
      if (busy || executionLockPresent(ctx.dir)) throw new Error("Cannot close Frontier checkpoints while execution is active");
      const seal: CheckpointSeal = {
        schema_version: "propbench-frontier-checkpoint-seal-v1", run_id: ctx.config.run_id,
        last_checkpoint: lastCheckpoint, checkpoints: count, artifact_snapshot: lastArtifactSnapshot, closed_at: new Date().toISOString(),
      };
      writeExclusive(path.join(ctx.dir, "checkpoint-seal.json"), JSON.stringify(seal, null, 2) + "\n", 0o400);
      closed = true;
    },
  };
}

/**
 * Prepare an owner-side Frontier run and a public contestant bundle. The
 * public export is assembled from selected set/rule files and explicit state;
 * no repository or owner-run directory is copied wholesale.
 */
export function prepareFrontier(options: PrepareOptions, bundleDir: string, snapshotDir?: string): RunContext {
  const bundle = assertNewBundle(bundleDir, options, snapshotDir);
  const validator = ensureValidator(options);
  assertDirectory(options.setDir, "Benchmark set");
  assertSafeTree(options.setDir);
  const set = loadSet(options.setDir, options.ids);
  const selectedIds = new Set(set.items.map(item => item.id));
  const snapshot = ensureSnapshotMode(options, snapshotDir, selectedIds);
  const setManifestPath = path.join(options.setDir, "manifest.json");
  const sourceManifest = selectedSetManifest(setManifestPath, set);
  const rulesPath = path.join(PROJECT_ROOT, "rules.md");
  assertRegular(rulesPath, "Rulebook");

  // Bind the derived snapshot identity before prepareRun so it becomes part of
  // the owner config and cohort identity.
  const runOptions: PrepareOptions = {
    ...options,
    startingSnapshot: snapshot.digest ?? undefined,
  };
  const ctx = prepareRun(runOptions);
  ensureOwnerArchiveDirs(ctx.dir);
  const pinnedValidator = path.join(ctx.dir, "referee", "validator");
  const pinnedRules = path.join(ctx.dir, "referee", "rules.md");

  mkdirExact(bundle, 0o755);
  try {
    const publicSet = path.join(bundle, "set");
    const publicProofs = path.join(bundle, "proofs");
    const publicTools = path.join(bundle, "tools");
    mkdirExact(publicSet, 0o755);

    for (const item of set.items) {
      copyExact(path.join(ctx.dir, "set", item.id + ".json"), path.join(publicSet, item.id + ".json"), MAX_SNAPSHOT_FILE_BYTES);
    }
    writeExclusive(path.join(publicSet, "manifest.json"), Buffer.from(JSON.stringify(sourceManifest, null, 2) + "\n"), 0o644);
    // Export the exact sealed owner copies. The source paths were hashed by
    // prepareRun, while these referee files remain immutable for regrading.
    copyExact(pinnedRules, path.join(bundle, "rules.md"), MAX_SNAPSHOT_FILE_BYTES);
    writeExclusive(path.join(bundle, "validator"), Buffer.from('#!/bin/sh\nexec /opt/propbench/validator "$@"\n'), 0o555);

    if (snapshot.source && snapshot.index) {
      for (const entry of snapshot.index.entries) copySnapshotEntry(snapshot.source, bundle, entry);
      writeExclusive(path.join(bundle, "SNAPSHOT.json"), Buffer.from(JSON.stringify(snapshot.index, null, 2) + "\n"), 0o644);
      // Only selected, owner-validated proofs become the new run's incumbent
      // baseline. Invalid inherited files remain in the public snapshot bytes,
      // but cannot influence owner grading.
      for (const entry of snapshot.index.entries) {
        if (entry.kind !== "file" || !entry.path.startsWith("proofs/") || !entry.path.endsWith(".json")) continue;
        const id = entry.path.slice("proofs/".length, -5);
        if (!selectedIds.has(id)) continue;
        const item = set.items.find(candidate => candidate.id === id);
        if (!item) continue;
        const bytes = readSafeFile(path.join(bundle, ...entry.path.split("/")), MAX_PROOF_BYTES).bytes;
        const verdict = validateInheritedProof(pinnedValidator, item.theorem, bytes);
        if (verdict === null) {
          throw new Error(`Verifier infrastructure failure while validating inherited proof: ${id}`);
        }
        if (verdict?.status === "valid") installSubmission(ctx.dir, id, bytes);
      }
    } else {
      mkdirExact(publicProofs, 0o755);
      mkdirExact(publicTools, 0o755);
      writeExclusive(path.join(publicProofs, ".gitkeep"), Buffer.alloc(0), 0o644);
      writeExclusive(path.join(publicTools, ".gitkeep"), Buffer.alloc(0), 0o644);
      for (const journal of ["METHODS.md", "LOG.md", "DEBRIEF.md"]) {
        writeExclusive(path.join(bundle, journal), Buffer.alloc(0), 0o644);
      }
    }
    writeExclusive(path.join(bundle, "GOAL.md"), Buffer.from(buildGoal(ctx, snapshot.digest, true) + "\n"), 0o644);

    writeJson(path.join(ctx.dir, "frontier.json"), {
      bundle_dir: path.resolve(bundle),
      starting_snapshot: snapshot.digest,
      // Owner-only metadata; the public bundle and GOAL intentionally contain
      // no host path or answer-key/history location.
      validator_path: path.resolve(pinnedValidator),
    });
    // Keep the initial method/tool/proof state in an owner-side immutable
    // archive before the contestant can edit the exported directory.
    archiveState(ctx, bundle, "initial");
    writeExclusive(path.join(ctx.dir, "bundle-initial.json"), JSON.stringify({sha256: bundleDigest(bundle)}) + "\n", 0o400);
  } catch (err) {
    // Retain the owner run for auditability if export fails after preparation;
    // callers must not treat the partial public bundle as safe.
    throw err;
  }
  return ctx;
}

/**
 * Import theorem proof JSON into the owner run. Each candidate is independently
 * revalidated with the frozen owner verifier, receives an immutable proof and
 * verdict receipt, and can replace an incumbent only when it is strictly
 * shorter and valid. Invalid or regressive candidates never erase a valid
 * incumbent.
 */
export async function submitFrontier(runDir: string, proofsDir: string, validator: string): Promise<RunReport> {
  const ctx = loadRun(runDir);
  if (ctx.config.track !== "frontier") throw new Error("submitFrontier requires a Frontier run");
  if (["frontier-controller-v1", "frontier-subscription-v1", "frontier-subscription-v2"].includes(ctx.config.execution_protocol)) {
    throw new Error("Controlled Frontier submissions are sealed and may be finalized only by the metered controller");
  }
  if (executionLockPresent(ctx.dir)) throw new Error("Cannot import Frontier submissions while execution.lock is present");
  const controllerFile = path.join(ctx.dir, "controller.json");
  if (fsSync.existsSync(controllerFile) && readJson<{status: string}>(controllerFile).status === "running") throw new Error("Cannot import while the Frontier controller is running");
  // Share the execution lock so neither another importer nor an external
  // command can race the incumbent comparison, installation, and archive.
  const lock = path.join(ctx.dir, "execution.lock");
  const fd = fsSync.openSync(lock, "wx", 0o600);
  try {
    return await importFrontierLocked(ctx, proofsDir, validator);
  } finally {
    fsSync.closeSync(fd);
    fsSync.unlinkSync(lock);
  }
}

/** One-shot owner import used only by the metered controller. */
export async function finalizeControlledFrontier(
  runDir: string,
  proofsDir: string,
  validator: string,
): Promise<ControlledFinalizationResult> {
  const ctx = loadRun(runDir);
  if (ctx.config.track !== "frontier" || !["frontier-controller-v1", "frontier-subscription-v1", "frontier-subscription-v2"].includes(ctx.config.execution_protocol)) {
    throw new Error("Controlled finalization requires a metered Frontier run");
  }
  if (executionLockPresent(ctx.dir)) throw new Error("Cannot finalize Frontier submissions while execution.lock is present");
  if (fsSync.existsSync(path.join(ctx.dir, "controlled-finalization.json"))) {
    throw new Error("Controlled Frontier run has already been finalized");
  }
  const controller = readJson<{status: string}>(path.join(ctx.dir, "controller.json"));
  if (controller.status === "running") throw new Error("Cannot finalize while the Frontier controller is running");

  const lock = path.join(ctx.dir, "execution.lock");
  const fd = fsSync.openSync(lock, "wx", 0o600);
  try {
    // Establish owner/referee integrity before classifying any contestant tree
    // problem. These failures are infrastructure failures and remain unranked.
    verifyRunIdentity(ctx, validator);
    assertPinnedOwnerReferee(ctx);
    const metadata = safeFrontierMetadata(ctx.dir, ctx.config.execution_protocol !== "frontier-subscription-v2");
    if (path.resolve(proofsDir) !== path.join(metadata.bundle_dir, "proofs")) throw new Error("Controlled finalization must use the registered contestant bundle proofs directory");
    if (ctx.config.execution_protocol === "frontier-subscription-v2") {
      const seal = readJson<CheckpointSeal>(path.join(ctx.dir, "checkpoint-seal.json"));
      if (seal.schema_version !== "propbench-frontier-checkpoint-seal-v1" || seal.run_id !== ctx.config.run_id ||
          !Number.isSafeInteger(seal.checkpoints) || seal.checkpoints < 0 ||
          (seal.last_checkpoint !== null && !/^\d{6}$/.test(seal.last_checkpoint)) ||
          !/^(?:archives\/000000|checkpoint-artifacts\/\d{6})$/.test(seal.artifact_snapshot)) {
        throw new Error("Invalid controlled Frontier checkpoint seal");
      }
      const checkpoint: ControlledCheckpoint | undefined = seal.last_checkpoint === null ? undefined
        : JSON.parse(readSafeFile(path.join(ctx.dir, "checkpoints", seal.last_checkpoint + ".json"), MAX_SNAPSHOT_TOTAL_BYTES * 2).bytes.toString("utf8"));
      const captured = (checkpoint?.submissions ?? []).map(entry => {
        const bytes = Buffer.from(entry.proof_bytes_base64, "base64");
        if (!ctx.set.items.some(item => item.id === entry.id) || sha256(bytes) !== entry.proof_sha256) {
          throw new Error("Controlled Frontier checkpoint bytes changed");
        }
        return { id: entry.id, bytes };
      });
      const rejection = checkpoint?.contestant_rejection;
      writeControlledFinalizationMarker(ctx, proofsDir, rejection, captured);
      // Accepted submissions were independently graded when frozen. Finalize
      // only owner bytes; live proofs may have been overwritten after cutoff.
      archiveState(ctx, path.join(ctx.dir, seal.artifact_snapshot), "import", undefined, undefined, true);
      return { report: await gradeRun(ctx.dir, validator), ...(rejection ? { contestant_rejection: rejection } : {}) };
    }
    let captured: Array<{ id: string; bytes: Buffer }>;
    try {
      captured = readSubmissionEntries(proofsDir, new Set(ctx.set.items.map(item => item.id)));
    } catch (error) {
      if (!knownContestantSubmissionError(error)) throw error;
      const rejection = error instanceof Error ? error.message : String(error);
      writeControlledFinalizationMarker(ctx, proofsDir, rejection);
      // Preserve methods/tools and accepted inherited proofs without traversing
      // a contestant-corrupted proofs directory.
      const metadata = safeFrontierMetadata(ctx.dir);
      archiveState(ctx, metadata.bundle_dir, "import", undefined, undefined, true);
      return { report: await gradeRun(ctx.dir, validator), contestant_rejection: rejection };
    }
    writeControlledFinalizationMarker(ctx, proofsDir, undefined, captured);
    return { report: await importFrontierLocked(ctx, proofsDir, validator, captured) };
  } finally {
    fsSync.closeSync(fd);
    fsSync.unlinkSync(lock);
  }
}

async function importFrontierLocked(ctx: RunContext, proofsDir: string, validator: string, captured?: Array<{ id: string; bytes: Buffer }>): Promise<RunReport> {
  verifyRunIdentity(ctx, validator);
  const pinnedValidator = assertPinnedOwnerReferee(ctx);
  const submissions = captured ?? readSubmissionEntries(proofsDir, new Set(ctx.set.items.map(item => item.id)));
  const metadata = safeFrontierMetadata(ctx.dir);
  await acceptCapturedCandidates(ctx, submissions, pinnedValidator);
  // Preserve method/tool/debrief work even when no proof was submitted.
  archiveState(ctx, metadata.bundle_dir, "import");
  return gradeRun(ctx.dir, validator);
}

async function acceptCapturedCandidates(
  ctx: RunContext,
  submissions: Array<{ id: string; bytes: Buffer }>,
  pinnedValidator: string,
  checkpoint?: CandidateReceipt["checkpoint"],
): Promise<void> {
  for (const submission of submissions) {
    const item = ctx.set.items.find(candidate => candidate.id === submission.id);
    if (!item) throw new Error(`Unknown submission item: ${submission.id}`);
    const before = incumbentProof(ctx.dir, submission.id);
    let incumbentVerdict: Verdict = emptyVerdict("missing");
    if (before) incumbentVerdict = await validateCandidate(pinnedValidator, item.theorem, before.bytes.toString("utf8"));
    const verdict = await validateCandidate(pinnedValidator, item.theorem, submission.bytes.toString("utf8"));
    const accepted = verdict.status === "valid" &&
      (incumbentVerdict.status !== "valid" ||
       (incumbentVerdict.line_count !== null && verdict.line_count !== null && verdict.line_count < incumbentVerdict.line_count));
    const receiptPath = nextReceiptPath(ctx.dir, submission.id);
    const receipt: CandidateReceipt = {
      schema_version: "propbench-frontier-candidate-v1",
      import_id: path.basename(receiptPath, ".json"),
      theorem_id: submission.id,
      proof_sha256: sha256(submission.bytes),
      proof_bytes_base64: submission.bytes.toString("base64"),
      verdict,
      accepted,
      incumbent_before: {
        status: before ? incumbentVerdict.status : "missing",
        line_count: before ? incumbentVerdict.line_count : null,
        proof_sha256: before?.sha256 ?? null,
      },
      snapshot_digest: ctx.config.starting_snapshot,
      created_at: new Date().toISOString(),
      ...(checkpoint ? { checkpoint } : {}),
    };
    // Receipt is created with O_EXCL before any incumbent mutation. It is the
    // durable record of the exact candidate bytes and owner verdict.
    writeExclusive(receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"), 0o400);
    if (accepted) installSubmission(ctx.dir, submission.id, submission.bytes);
  }
}
