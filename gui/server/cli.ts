import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Root of the prop-bench project (one level up from gui/) */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Path to the compiled propbench binary */
const PROPBENCH_BIN = path.join(PROJECT_ROOT, "target", "release", process.platform === "win32" ? "propbench.exe" : "propbench");

/** Path to the harness entry point */
const HARNESS_PATH = path.join(PROJECT_ROOT, "harness.ts");

/** Path to the local ts-node binary (avoids npx resolution issues) */
const TS_NODE_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", process.platform === "win32" ? "ts-node.cmd" : "ts-node");

/** Path to the .env file in the project root */
const DOT_ENV_PATH = path.join(PROJECT_ROOT, ".env");

/** Benchmarks directory */
export const BENCHMARKS_DIR = path.join(PROJECT_ROOT, "benchmarks");

/** Path to the tier presets configuration file */
const TIER_PRESETS_PATH = path.join(PROJECT_ROOT, "tier-presets.json");

// ---------------------------------------------------------------------------
// Tier preset management
// ---------------------------------------------------------------------------

export function loadTierPresets(): Record<string, DifficultySpec> {
  // Read from file, fall back to hardcoded defaults if file doesn't exist
  try {
    return JSON.parse(fs.readFileSync(TIER_PRESETS_PATH, "utf-8"));
  } catch {
    // Hardcoded defaults matching the JSON file
    return {
      baby: { variables: 2, passes: 1, transforms_per_pass: 2, base_complexity: "simple", substitution_depth: 0, bridge_atoms: 0, gnarly_combos: false },
      easy: { variables: 3, passes: 1, transforms_per_pass: 5, base_complexity: "simple", substitution_depth: 0, bridge_atoms: 0, gnarly_combos: false },
      medium: { variables: 4, passes: 1, transforms_per_pass: 10, base_complexity: "complex", substitution_depth: 0, bridge_atoms: 0, gnarly_combos: false },
      hard: { variables: 5, passes: 1, transforms_per_pass: 15, base_complexity: "complex", substitution_depth: 2, bridge_atoms: 0, gnarly_combos: false },
      expert: { variables: 5, passes: 2, transforms_per_pass: 15, base_complexity: "complex", substitution_depth: 3, bridge_atoms: 0, gnarly_combos: true },
      nightmare: { variables: 5, passes: 3, transforms_per_pass: 15, base_complexity: "complex", substitution_depth: 4, bridge_atoms: 1, gnarly_combos: true },
      marathon: { variables: 6, passes: 5, transforms_per_pass: 20, base_complexity: "complex", substitution_depth: 4, bridge_atoms: 1, gnarly_combos: true },
      absurd: { variables: 7, passes: 10, transforms_per_pass: 20, base_complexity: "complex", substitution_depth: 4, bridge_atoms: 1, gnarly_combos: true },
      cosmic: { variables: 7, passes: 20, transforms_per_pass: 24, base_complexity: "complex", substitution_depth: 4, bridge_atoms: 2, gnarly_combos: true },
      mind: { variables: 7, passes: 50, transforms_per_pass: 50, base_complexity: "complex", substitution_depth: 10, bridge_atoms: 2, gnarly_combos: true },
    };
  }
}

export function saveTierPresets(presets: Record<string, DifficultySpec>): void {
  fs.writeFileSync(TIER_PRESETS_PATH, JSON.stringify(presets, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Generate theorems
// ---------------------------------------------------------------------------

export interface DifficultySpec {
  variables: number;
  passes: number;
  transforms_per_pass: number;
  base_complexity: "simple" | "complex";
  substitution_depth: number;
  bridge_atoms?: number;
  max_formula_nodes?: number;
  max_formula_depth?: number;
  gnarly_combos?: boolean;
}

export interface GenerateOpts {
  count: number;
  name: string;
  distribution?: string;   // legacy distribution mode
  tier?: string;            // tier preset mode
  spec?: DifficultySpec;    // custom spec mode
  maxNodes?: number;        // max AST node count for obfuscation pipeline
  maxDepth?: number;        // max formula nesting depth for obfuscation pipeline
  gnarlyCombos?: boolean;   // explicit gnarly combos override (false = disable)
}

export async function generate(opts: GenerateOpts): Promise<{ path: string; theorems: unknown[] }> {
  if (!fs.existsSync(PROPBENCH_BIN)) {
    throw new Error(`propbench binary not found: ${PROPBENCH_BIN}`);
  }

  const outDir = path.join(BENCHMARKS_DIR, opts.name);
  const outFile = path.join(outDir, "theorems.json");

  fs.mkdirSync(outDir, { recursive: true });

  const presets = loadTierPresets();

  // Helper to build spec args
  const specArgs = (spec: DifficultySpec): string[] => {
    const args = [
      "--variables", String(spec.variables),
      "--passes", String(spec.passes),
      "--transforms", String(spec.transforms_per_pass),
      "--base", spec.base_complexity,
      "--substitution", String(spec.substitution_depth),
    ];
    if (spec.bridge_atoms !== undefined && spec.bridge_atoms > 0) {
      args.push("--bridge-atoms", String(spec.bridge_atoms));
    }
    if (spec.max_formula_nodes !== undefined) {
      args.push("--max-nodes", String(spec.max_formula_nodes));
    }
    if (spec.max_formula_depth !== undefined) {
      args.push("--max-depth", String(spec.max_formula_depth));
    }
    if (spec.gnarly_combos === false) {
      args.push("--no-gnarly-combos");
    } else if (spec.gnarly_combos === true) {
      args.push("--gnarly-combos");
    }
    return args;
  };

  // Helper to run one generation call.
  // When skipGnarlyOverride is true, the global gnarlyCombos from opts is NOT
  // appended — the spec's own gnarly_combos (set via specArgs) takes precedence.
  const generateBatch = async (count: number, extraArgs: string[], tmpFile: string, skipGnarlyOverride = false): Promise<unknown[]> => {
    const args = ["generate", "--count", String(count), "--output", tmpFile, ...extraArgs];
    if (opts.maxNodes !== undefined) {
      args.push("--max-nodes", String(opts.maxNodes));
    }
    if (opts.maxDepth !== undefined) {
      args.push("--max-depth", String(opts.maxDepth));
    }
    if (!skipGnarlyOverride) {
      if (opts.gnarlyCombos === false) {
        args.push("--no-gnarly-combos");
      } else if (opts.gnarlyCombos === true) {
        args.push("--gnarly-combos");
      }
    }
    const { stderr } = await execFileAsync(PROPBENCH_BIN, args, {
      timeout: 120_000,
      cwd: PROJECT_ROOT,
    });
    if (stderr) console.log("[generate]", stderr.trim());
    return JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
  };

  let allTheorems: unknown[] = [];

  // Helper to apply gnarlyCombos override from opts to a spec
  const applyGnarlyOverride = (spec: DifficultySpec): DifficultySpec => {
    if (opts.gnarlyCombos !== undefined) {
      return { ...spec, gnarly_combos: opts.gnarlyCombos };
    }
    return spec;
  };

  if (opts.tier) {
    // Tier mode: resolve from config
    const tierSpec = presets[opts.tier];
    if (tierSpec) {
      const effectiveSpec = applyGnarlyOverride(tierSpec);
      allTheorems = await generateBatch(opts.count, specArgs(effectiveSpec), outFile, true);
      // Fix difficulty label (CLI sets it to "Custom" when using spec args)
      const label = opts.tier.charAt(0).toUpperCase() + opts.tier.slice(1);
      for (const t of allTheorems as any[]) {
        (t as any).difficulty = label;
        (t as any).difficulty_spec = effectiveSpec;
      }
    } else {
      // Fallback to CLI's hardcoded tier
      allTheorems = await generateBatch(opts.count, ["--tier", opts.tier], outFile);
    }
  } else if (opts.spec) {
    // Custom spec mode: pass directly
    const effectiveSpec = applyGnarlyOverride(opts.spec);
    allTheorems = await generateBatch(opts.count, specArgs(effectiveSpec), outFile, true);
    // Stamp each theorem with the effective spec (including gnarly override)
    for (const t of allTheorems as any[]) {
      (t as any).difficulty_spec = effectiveSpec;
    }
  } else if (opts.distribution) {
    // Distribution mode: parse and resolve each tier from config
    const segments = opts.distribution.split(",").map(s => {
      const parts = s.trim().split(":");
      return { count: parseInt(parts[0], 10), tier: parts[1].trim() };
    });

    let batchIdx = 0;
    for (const seg of segments) {
      const tmpFile = path.join(outDir, `_tmp_batch_${batchIdx}.json`);
      const tierSpec = presets[seg.tier];
      let extraArgs: string[];
      if (tierSpec) {
        // Distribution mode: use the tier's own gnarly_combos, no global override
        extraArgs = specArgs(tierSpec);
      } else {
        // Fallback for unknown tiers
        extraArgs = ["--tier", seg.tier];
      }
      const batch = await generateBatch(seg.count, extraArgs, tmpFile, true);

      // Set difficulty label and spec on each theorem
      const label = seg.tier.charAt(0).toUpperCase() + seg.tier.slice(1);
      for (const t of batch as any[]) {
        (t as any).difficulty = label;
        if (tierSpec) {
          (t as any).difficulty_spec = tierSpec;
        }
      }

      allTheorems.push(...batch);
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch {}
      batchIdx++;
    }

    // Renumber IDs after merging
    allTheorems.forEach((t: any, i: number) => {
      t.id = `v1-${String(i + 1).padStart(3, '0')}`;
    });
  } else {
    // No mode specified: use default distribution
    const defaultDist = "30:easy,30:medium,20:hard,15:expert,5:nightmare";
    // Parse and resolve the default distribution too
    const segments = defaultDist.split(",").map(s => {
      const parts = s.trim().split(":");
      return { count: parseInt(parts[0], 10), tier: parts[1].trim() };
    });

    let batchIdx = 0;
    for (const seg of segments) {
      const tmpFile = path.join(outDir, `_tmp_batch_${batchIdx}.json`);
      const tierSpec = presets[seg.tier];
      let extraArgs: string[];
      if (tierSpec) {
        // Default distribution: use the tier's own gnarly_combos, no global override
        extraArgs = specArgs(tierSpec);
      } else {
        extraArgs = ["--tier", seg.tier];
      }
      const batch = await generateBatch(seg.count, extraArgs, tmpFile, true);

      // Set difficulty label and spec on each theorem
      const label = seg.tier.charAt(0).toUpperCase() + seg.tier.slice(1);
      for (const t of batch as any[]) {
        (t as any).difficulty = label;
        if (tierSpec) {
          (t as any).difficulty_spec = tierSpec;
        }
      }

      allTheorems.push(...batch);
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch {}
      batchIdx++;
    }

    // Renumber IDs after merging
    allTheorems.forEach((t: any, i: number) => {
      t.id = `v1-${String(i + 1).padStart(3, '0')}`;
    });
  }

  // Write final (possibly patched) theorems to disk
  fs.writeFileSync(outFile, JSON.stringify(allTheorems, null, 2), "utf-8");

  return { path: outFile, theorems: allTheorems };
}

// ---------------------------------------------------------------------------
// Validate a proof
// ---------------------------------------------------------------------------

export interface ValidateResult {
  valid: boolean;
  line_count: number;
  errors: string[];
}

export async function validate(
  theorem: unknown,
  proof: unknown[]
): Promise<ValidateResult> {
  if (!fs.existsSync(PROPBENCH_BIN)) {
    throw new Error(`propbench binary not found: ${PROPBENCH_BIN}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-"));
  const theoremFile = path.join(tmpDir, "theorem.json");
  const proofFile = path.join(tmpDir, "proof.json");

  try {
    fs.writeFileSync(theoremFile, JSON.stringify(theorem), "utf-8");
    fs.writeFileSync(proofFile, JSON.stringify(proof), "utf-8");

    const { stdout, stderr } = await execFileAsync(PROPBENCH_BIN, [
      "validate",
      "--theorem", theoremFile,
      "--proof", proofFile,
    ], { timeout: 30_000 });

    if (stderr && stderr.trim()) {
      return { valid: false, line_count: 0, errors: [stderr.trim()] };
    }

    return JSON.parse(stdout) as ValidateResult;
  } finally {
    try {
      fs.unlinkSync(theoremFile);
      fs.unlinkSync(proofFile);
      fs.rmdirSync(tmpDir);
    } catch { /* ignore cleanup errors */ }
  }
}

// ---------------------------------------------------------------------------
// Spawn harness process
// ---------------------------------------------------------------------------

export interface HarnessOpts {
  theoremSet: string;
  models: string[];
  temperature: number;
  maxTokens: number;
  maxThinkingTokens?: number;
  workers?: number;
  start?: number;
  count?: number;
  force?: boolean;
  noRetryParse?: boolean;
  retryApiErrors?: boolean;
  runs?: number;
  continueRunId?: number;
  maxCost?: number;
  tierBudgetsEnabled?: boolean;
  tierBudgets?: Record<string, number>;
}

export function spawnHarness(opts: HarnessOpts): ChildProcess {
  const theoremsPath = path.join(BENCHMARKS_DIR, opts.theoremSet, "theorems.json");

  // Validate that required files exist before spawning
  if (!fs.existsSync(theoremsPath)) {
    throw new Error(`Theorems file not found: ${theoremsPath}`);
  }
  if (!fs.existsSync(PROPBENCH_BIN)) {
    throw new Error(`propbench binary not found: ${PROPBENCH_BIN}`);
  }
  if (!fs.existsSync(HARNESS_PATH)) {
    throw new Error(`Harness entry point not found: ${HARNESS_PATH}`);
  }

  const args = [
    HARNESS_PATH,
    "--theorems", theoremsPath,
    "--models", opts.models.join(","),
    "--temperature", String(opts.temperature),
    "--max-tokens", String(opts.maxTokens),
    "--propbench-bin", PROPBENCH_BIN,
  ];

  if (opts.maxThinkingTokens !== undefined) {
    args.push("--max-thinking-tokens", String(opts.maxThinkingTokens));
  }
  if (opts.workers !== undefined && opts.workers > 1) {
    args.push("--workers", String(opts.workers));
  }
  if (opts.start !== undefined) {
    args.push("--start", String(opts.start));
  }
  if (opts.count !== undefined) {
    args.push("--count", String(opts.count));
  }
  if (opts.force) {
    args.push("--force");
  }
  if (opts.noRetryParse) {
    args.push("--no-retry-parse");
  }
  if (opts.runs !== undefined && opts.runs > 1) {
    args.push("--runs", String(opts.runs));
  }
  if (opts.retryApiErrors) {
    args.push("--retry-api-errors");
  }
  if (opts.continueRunId !== undefined) {
    args.push("--continue-run", String(opts.continueRunId));
  }
  if (opts.maxCost !== undefined) {
    args.push("--max-cost", String(opts.maxCost));
  }
  if (opts.tierBudgetsEnabled === false) {
    args.push("--no-tier-budgets");
  }
  if (opts.tierBudgets !== undefined) {
    args.push("--tier-budgets", JSON.stringify(opts.tierBudgets));
  }

  // Build child env: inherit process.env and also load .env from project root
  // to ensure API keys are available even if the server's dotenv didn't load them.
  const childEnv = { ...process.env };
  if (fs.existsSync(DOT_ENV_PATH)) {
    const envContent = fs.readFileSync(DOT_ENV_PATH, "utf-8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      childEnv[key] = val;
    }
  }

  // Use local ts-node binary directly — avoids npx resolution issues (npx may
  // prompt for install, fail to locate the package, or add startup latency).
  // ts-node is a devDependency of the root prop-bench package and its binary
  // lives at node_modules/.bin/ts-node.
  const bin = TS_NODE_BIN;
  if (!fs.existsSync(bin)) {
    throw new Error(`ts-node binary not found at ${bin}. Run 'npm install' in ${PROJECT_ROOT}`);
  }

  console.log(`[spawnHarness] bin: ${bin}`);
  console.log(`[spawnHarness] cwd: ${PROJECT_ROOT}`);
  console.log(`[spawnHarness] theorems: ${theoremsPath}`);

  const child = spawn(bin, args, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  return child;
}
