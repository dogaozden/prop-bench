#!/usr/bin/env npx ts-node

import * as dotenv from "dotenv";
dotenv.config({ override: true });
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getModel } from "./models/index";
import type { ModelConfig, ModelResponse } from "./models/index";
import type { Theorem, ProofLine } from "./config";
import * as db from "./db";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Theorem as stored in the benchmark JSON (from Rust CLI output) */
interface BenchTheorem {
  id: string;
  premises: string[];
  conclusion: string;
  difficulty: string;
  difficulty_value: number;
}

export interface BenchmarkResult {
  theorem_id: string;
  model: string;
  model_name: string;
  raw_response: string;
  parsed_proof: ProofLine[] | null;
  parse_error: string | null;
  validation_result: "valid" | "invalid" | "error";
  validation_errors: string[];
  line_count: number | null;
  latency_ms: number;
  tokens_used: number | undefined;
  thinking_tokens?: number;
  finish_reason?: string;
  timestamp: string;
}

interface RunState {
  completed: Set<string>;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  theorems: string;
  models: string[];
  start: number;
  count: number | null;
  propbenchBin: string;
  temperature: number;
  maxTokens: number;
  maxThinkingTokens: number;
  workers: number;
  force: boolean;
  noRetryParse: boolean;
  retryApiErrors: boolean;
  runs: number;
  continueRunId: number | null;
  maxCost: number | null;
  tierBudgetsEnabled: boolean;
  tierBudgets: Record<string, number> | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: CliArgs = {
    theorems: "",
    models: [],
    start: 0,
    count: null,
    propbenchBin: "propbench",
    temperature: 0.2,
    maxTokens: 4096,
    maxThinkingTokens: 10000,
    workers: 1,
    force: false,
    noRetryParse: false,
    retryApiErrors: false,
    runs: 1,
    continueRunId: null,
    maxCost: null,
    tierBudgetsEnabled: true,
    tierBudgets: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--theorems":
        parsed.theorems = args[++i];
        break;
      case "--models":
        parsed.models = args[++i].split(",").map((m) => m.trim());
        break;
      case "--start":
        parsed.start = parseInt(args[++i], 10);
        break;
      case "--count":
        parsed.count = parseInt(args[++i], 10);
        break;
      case "--propbench-bin":
        parsed.propbenchBin = args[++i];
        break;
      case "--temperature":
        parsed.temperature = parseFloat(args[++i]);
        break;
      case "--max-tokens":
        parsed.maxTokens = parseInt(args[++i], 10);
        break;
      case "--max-thinking-tokens":
        parsed.maxThinkingTokens = parseInt(args[++i], 10);
        break;
      case "--workers":
        parsed.workers = parseInt(args[++i], 10);
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--no-retry-parse":
        parsed.noRetryParse = true;
        break;
      case "--retry-api-errors":
        parsed.retryApiErrors = true;
        break;
      case "--runs":
        parsed.runs = parseInt(args[++i], 10);
        break;
      case "--continue-run":
        parsed.continueRunId = parseInt(args[++i], 10);
        break;
      case "--max-cost":
        parsed.maxCost = parseFloat(args[++i]);
        break;
      case "--no-tier-budgets":
        parsed.tierBudgetsEnabled = false;
        break;
      case "--tier-budgets":
        try {
          parsed.tierBudgets = JSON.parse(args[++i]);
        } catch {
          console.error("Invalid JSON for --tier-budgets");
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  if (!parsed.theorems || parsed.models.length === 0) {
    printUsage();
    process.exit(1);
  }

  return parsed;
}

function printUsage(): void {
  console.log(`
Usage: npx ts-node harness.ts --theorems <path> --models <list> [options]

Required:
  --theorems <path>         Path to theorems JSON file
  --models <list>           Comma-separated model names (e.g., gemini-2.5-flash,anthropic/claude-sonnet-4.5)

Options:
  --start <n>               Start at theorem index n (default: 0)
  --count <n>               Process only n theorems (default: all)
  --propbench-bin <path>    Path to propbench CLI binary (default: propbench)
  --temperature <n>         Model temperature (default: 0.2)
  --max-tokens <n>          Max tokens for model response (default: 4096)
  --max-thinking-tokens <n> Max thinking/reasoning tokens per call (default: 10000)
  --workers <n>             Number of parallel API calls (default: 1)
  --force                   Force new run (don't skip completed theorems)
  --no-retry-parse          Don't retry parse errors (treat as final result)
  --retry-api-errors        With --continue-run: delete API error results and retry those theorems
  --runs <n>                Run the full benchmark N times sequentially (default: 1)
  --continue-run <id>       Continue an incomplete run by its DB run ID
  --max-cost <n>            Abort run when estimated cost exceeds $n (e.g. --max-cost 5)
  --no-tier-budgets         Disable tier-based output token budgets (use flat --max-tokens for all tiers)
  --tier-budgets <json>     Custom per-tier token budgets as JSON (e.g. '{"baby":2048,"easy":2048,"mind":8192}')
`);
}

// ---------------------------------------------------------------------------
// Model pricing (USD per million tokens)
// ---------------------------------------------------------------------------

// Approximate prices used only for --max-cost budget protection.
// OpenRouter may charge different rates; check openrouter.ai/models for current pricing.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Direct Gemini API
  "gemini-2.5-pro":                        { input: 1.25,  output: 10.00 },
  "gemini-2.5-flash":                      { input: 0.30,  output: 2.50  },
  "gemini-3-pro-preview":                  { input: 2.00,  output: 12.00 },
  "gemini-3-flash-preview":                { input: 0.50,  output: 3.00  },
  "gemini-2.0-flash":                      { input: 0.10,  output: 0.40  },
  "gemini-2.5-flash-lite-preview-09-2025": { input: 0.10,  output: 0.40  },
  // OpenRouter — Gemini (same pricing as direct)
  "google/gemini-2.5-pro":                 { input: 1.25,  output: 10.00 },
  "google/gemini-2.5-flash":               { input: 0.30,  output: 2.50  },
  "google/gemini-3-pro-preview":           { input: 2.00,  output: 12.00 },
  "google/gemini-3-flash-preview":         { input: 0.50,  output: 3.00  },
  "google/gemini-2.0-flash-001":           { input: 0.10,  output: 0.40  },
  // OpenRouter — Anthropic
  "anthropic/claude-opus-4-6":             { input: 5.00,  output: 25.00 },
  "anthropic/claude-sonnet-4.5":           { input: 3.00,  output: 15.00 },
  "anthropic/claude-haiku-3.5":            { input: 0.80,  output: 4.00  },
  // OpenRouter — OpenAI
  "openai/gpt-4o":                         { input: 2.50,  output: 10.00 },
  "openai/gpt-4o-mini":                    { input: 0.15,  output: 0.60  },
  "openai/o3-mini":                        { input: 1.10,  output: 4.40  },
  // OpenRouter — Other
  "deepseek/deepseek-r1":                  { input: 0.55,  output: 2.19  },
  "deepseek/deepseek-chat":                { input: 0.27,  output: 1.10  },
  "meta-llama/llama-4-maverick":           { input: 0.50,  output: 0.77  },
  "mistralai/mistral-large-2":             { input: 2.00,  output: 6.00  },
};

function estimateCallCost(modelSlug: string, totalTokens: number): number {
  const pricing = MODEL_PRICING[modelSlug];
  if (!pricing || !totalTokens) return 0;
  // Use output pricing for total tokens (conservative: thinking tokens are billed as output)
  return (totalTokens / 1_000_000) * pricing.output;
}

// ---------------------------------------------------------------------------
// Tier-based output token budgets
// ---------------------------------------------------------------------------
// Valid proofs are compact: ~1,400-1,750 output tokens for Gemini models,
// and models that use 10k+ output tokens are ALWAYS spiraling/invalid.
// These per-tier ceilings prevent wasting tokens on impossible problems.

const DEFAULT_TIER_BUDGETS: Record<string, number> = {
  baby:      1024,
  easy:      1024,
  medium:    2048,
  hard:      2048,
  expert:    4096,
  nightmare: 6144,
  marathon:  6144,
  absurd:    8192,
  cosmic:    8192,
  mind:      8192,
};

/**
 * Returns the max output tokens for a theorem, capped by its difficulty tier.
 * If the user's --max-tokens is lower than the tier ceiling, use the user's value.
 * When tier budgets are disabled, always returns userMaxTokens.
 */
function getMaxTokensForDifficulty(
  difficulty: string,
  userMaxTokens: number,
  enabled: boolean,
  customBudgets: Record<string, number> | null,
): number {
  if (!enabled) return userMaxTokens;
  const budgets = customBudgets ?? DEFAULT_TIER_BUDGETS;
  const tierBudget = budgets[difficulty.toLowerCase()] ?? userMaxTokens;
  return Math.min(userMaxTokens, tierBudget);
}

// ---------------------------------------------------------------------------
// Spiral detection
// ---------------------------------------------------------------------------
// Detects when a model repeats identical proof lines — a clear sign of
// failure. Returns the repeated line and count if detected, null otherwise.

function detectSpiral(rawResponse: string): { repeatedLine: string; count: number } | null {
  const lines = rawResponse.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 6) return null;

  // Count consecutive identical lines
  let maxRun = 1;
  let maxLine = "";
  let currentRun = 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === lines[i - 1]) {
      currentRun++;
      if (currentRun > maxRun) {
        maxRun = currentRun;
        maxLine = lines[i];
      }
    } else {
      currentRun = 1;
    }
  }

  // Also check for repeated patterns (same line appearing many times non-consecutively)
  const freq = new Map<string, number>();
  for (const line of lines) {
    freq.set(line, (freq.get(line) ?? 0) + 1);
  }
  for (const [line, count] of freq) {
    if (count > maxRun && count >= 5) {
      maxRun = count;
      maxLine = line;
    }
  }

  if (maxRun >= 5) {
    return { repeatedLine: maxLine.slice(0, 80), count: maxRun };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

function loadTheorems(filepath: string): BenchTheorem[] {
  const raw = fs.readFileSync(filepath, "utf-8");
  return JSON.parse(raw) as BenchTheorem[];
}

/** Convert BenchTheorem to the Theorem type expected by prompt/parser */
function toTheorem(bt: BenchTheorem): Theorem {
  return {
    id: bt.id,
    premises: bt.premises,
    conclusion: bt.conclusion,
    difficulty: bt.difficulty as Theorem["difficulty"],
    difficulty_value: bt.difficulty_value,
  };
}

function loadRunState(setName: string): RunState {
  const completed = new Set<string>();

  try {
    // Query DB for all completed results for this set
    const dbConn = db.getDb();
    const rows = dbConn.prepare(`
      SELECT r.theorem_id, r.model_slug
      FROM results r
      JOIN theorem_sets ts ON ts.id = r.set_id
      WHERE ts.name = ? AND (r.validation_result IN ('valid', 'invalid') OR (r.validation_result = 'error' AND r.parse_error IS NOT NULL))
    `).all(setName) as Array<{ theorem_id: string; model_slug: string }>;

    for (const row of rows) {
      completed.add(`${row.theorem_id}::${row.model_slug}`);
    }
  } catch (err) {
    // If DB query fails, return empty set (no resume support)
    console.warn(`Failed to load run state from DB: ${err instanceof Error ? err.message : err}`);
  }

  return { completed };
}

function resultKey(theoremId: string, modelName: string): string {
  return `${theoremId}::${modelName}`;
}

function promptForTheorem(theorem: Theorem): string {
  // Use the dedicated prompt builder from prompt.ts — returns only the
  // theorem-specific user prompt. The static system prompt is passed
  // separately via ModelConfig.systemPrompt for prompt caching.
  const { buildUserPrompt } = require("./prompt");
  return buildUserPrompt(theorem);
}

function getSystemPrompt(): string {
  const { SYSTEM_PROMPT } = require("./prompt");
  return SYSTEM_PROMPT;
}

function parseModelResponse(
  rawResponse: string,
  theorem: Theorem
): { proof: ProofLine[] | null; error: string | null } {
  try {
    const { parseProof } = require("./parser");
    const result = parseProof(rawResponse, theorem);
    if (result.errors && result.errors.length > 0) {
      return { proof: null, error: result.errors.map((e: any) => e.message).join("; ") };
    }
    // Convert ParsedLine[] to ProofLine[]
    const proof: ProofLine[] = result.lines.map((l: any) => ({
      line_number: l.line_number,
      formula: l.formula,
      justification: l.justification,
      depth: l.depth,
    }));
    return { proof, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { proof: null, error: `Parse error: ${msg}` };
  }
}

async function validateProof(
  benchTheorem: BenchTheorem,
  proof: ProofLine[],
  propbenchBin: string
): Promise<{ valid: boolean; line_count: number; errors: string[] }> {
  // The Rust CLI expects file paths, so write temp files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-"));
  const theoremFile = path.join(tmpDir, "theorem.json");
  const proofFile = path.join(tmpDir, "proof.json");

  try {
    fs.writeFileSync(theoremFile, JSON.stringify(benchTheorem), "utf-8");
    fs.writeFileSync(proofFile, JSON.stringify(proof), "utf-8");

    const { stdout, stderr } = await execFileAsync(propbenchBin, [
      "validate",
      "--theorem", theoremFile,
      "--proof", proofFile,
    ], { timeout: 30_000 });

    if (stderr && stderr.trim()) {
      return { valid: false, line_count: 0, errors: [stderr.trim()] };
    }

    const result = JSON.parse(stdout) as {
      valid: boolean;
      line_count: number;
      errors: string[];
    };
    return { valid: result.valid, line_count: result.line_count, errors: result.errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, line_count: 0, errors: [`Validation process error: ${msg}`] };
  } finally {
    // Clean up temp files
    try {
      fs.unlinkSync(theoremFile);
      fs.unlinkSync(proofFile);
      fs.rmdirSync(tmpDir);
    } catch { /* ignore cleanup errors */ }
  }
}


// ---------------------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------------------

interface WorkItem {
  theoremIndex: number;  // index into benchTheorems array
  adapterIndex: number;  // index into adapters array
  itemNumber: number;    // 1-based sequential number for progress display
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main orchestration loop
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs();

  console.log("=== PropBench Harness ===");
  console.log(`Theorems: ${args.theorems}`);
  console.log(`Models:   ${args.models.join(", ")}`);
  console.log(`Workers:  ${args.workers}`);
  console.log(`Thinking: ${args.maxThinkingTokens} tokens`);
  if (args.tierBudgetsEnabled) {
    const b = args.tierBudgets ?? DEFAULT_TIER_BUDGETS;
    console.log(`Output:   ${args.maxTokens} tokens (tier-capped: Baby/Easy=${b.baby ?? b.easy}, Med=${b.medium}, Hard=${b.hard}, Mind=${b.mind})`);
  } else {
    console.log(`Output:   ${args.maxTokens} tokens (flat — tier budgets disabled)`);
  }
  if (args.force) console.log(`Force:    YES (new run, skipping nothing)`);
  if (args.maxCost != null) console.log(`Max cost: $${args.maxCost.toFixed(2)}`);
  console.log();

  // Load theorems
  const allBenchTheorems = loadTheorems(args.theorems);
  console.log(`Loaded ${allBenchTheorems.length} theorems`);

  // Apply --start and --count
  const startIdx = args.start;
  const endIdx =
    args.count !== null
      ? Math.min(startIdx + args.count, allBenchTheorems.length)
      : allBenchTheorems.length;
  const benchTheorems = allBenchTheorems.slice(startIdx, endIdx);
  console.log(
    `Processing theorems ${startIdx} to ${endIdx - 1} (${benchTheorems.length} total)`
  );

  // Initialize SQLite DB
  let setName = "";
  let setId = 0;
  try {
    db.initSchema();
    setName = path.basename(path.dirname(args.theorems));
    if (!setName || setName === ".") {
      setName = path.basename(args.theorems, path.extname(args.theorems));
    }
    if (!setName || setName === ".") {
      throw new Error(
        `Could not derive a set name from --theorems path "${args.theorems}". ` +
          `Place the file in a named subdirectory (e.g. benchmarks/my-set/theorems.json) ` +
          `or use a descriptive filename (e.g. my-set.json).`
      );
    }
    setId = db.upsertTheoremSet(setName, args.theorems);
    for (const bt of allBenchTheorems) {
      db.upsertTheorem(setId, {
        id: bt.id,
        premises: bt.premises,
        conclusion: bt.conclusion,
        difficulty: bt.difficulty,
        difficulty_value: bt.difficulty_value,
      });
    }
    console.log(`SQLite DB initialized (set: ${setName}, id: ${setId})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`SQLite init failed: ${msg}`);
    process.exit(1);
  }

  // Load run state for resume support
  const state = loadRunState(setName);
  console.log(`Found ${state.completed.size} already-completed results`);
  console.log();

  // Initialize model adapters
  const adapters = args.models.map((name) => {
    try {
      return getModel(name);
    } catch (err) {
      console.error(
        `Failed to initialize model "${name}": ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  });

  // --continue-run mode: skip sequential runs loop, use existing run ID
  if (args.continueRunId !== null) {
    console.log(`Continuing incomplete run #${args.continueRunId}`);
    console.log();

    const continueRunId = args.continueRunId;

    // If retrying API errors, delete those results first so they'll be re-attempted
    if (args.retryApiErrors) {
      const deleted = db.deleteApiErrorResults(continueRunId);
      console.log(`Deleted ${deleted} API error result(s) from run #${continueRunId} — will retry those theorems`);
    }

    // Reset finished_at so it shows as "Running"
    db.resetRunFinished(continueRunId);

    // Load completed theorems for this specific run
    const completedTheorems = db.getRunCompletedTheorems(continueRunId);
    console.log(`Found ${completedTheorems.size} already-completed theorems in run #${continueRunId}`);

    // Create run IDs map (only one model in continue mode)
    const runIds = new Map<string, number>();
    for (const adapter of adapters) {
      runIds.set(adapter.name, continueRunId);
    }

    // Stats
    let totalRun = 0;
    let totalSkipped = 0;
    let totalValid = 0;
    let totalInvalid = 0;
    let totalErrors = 0;

    // Build flat list of work items, skipping completed theorems
    const workItems: WorkItem[] = [];
    let itemNumber = 0;
    for (let ti = 0; ti < benchTheorems.length; ti++) {
      for (let ai = 0; ai < adapters.length; ai++) {
        itemNumber++;
        if (completedTheorems.has(benchTheorems[ti].id)) {
          totalSkipped++;
          console.log(
            `[${itemNumber}/${benchTheorems.length * adapters.length}] ${benchTheorems[ti].id} x ${adapters[ai].name} — SKIPPED (already done)`
          );
          continue;
        }
        workItems.push({ theoremIndex: ti, adapterIndex: ai, itemNumber });
      }
    }

    const totalItems = benchTheorems.length * adapters.length;

    const MAX_ATTEMPTS = 10;
    const MAX_PARSE_ATTEMPTS = 3;
    let quotaAborted = false;

    async function processWorkItem(item: WorkItem): Promise<void> {
      if (quotaAborted) return;

      const benchThm = benchTheorems[item.theoremIndex];
      const adapter = adapters[item.adapterIndex];
      const theorem = toTheorem(benchThm);
      const progress = `[${item.itemNumber}/${totalItems}]`;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (quotaAborted) return;
        if (attempt > 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 2), 30_000);
          console.log(`${progress} ${benchThm.id} x ${adapter.displayName} — retrying (attempt ${attempt}) after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          console.log(`${progress} ${benchThm.id} x ${adapter.displayName} — running...`);
        }

        const result: BenchmarkResult = {
          theorem_id: benchThm.id,
          model: adapter.name,
          model_name: adapter.displayName,
          raw_response: "",
          parsed_proof: null,
          parse_error: null,
          validation_result: "error",
          validation_errors: [],
          line_count: null,
          latency_ms: 0,
          tokens_used: undefined,
          timestamp: new Date().toISOString(),
        };

        // Tier-based token budget: cap output tokens by difficulty
        const effectiveMaxTokens = getMaxTokensForDifficulty(benchThm.difficulty, args.maxTokens, args.tierBudgetsEnabled, args.tierBudgets);
        const modelConfig: ModelConfig = {
          model: "",
          temperature: args.temperature,
          maxTokens: effectiveMaxTokens,
          maxThinkingTokens: args.maxThinkingTokens,
          systemPrompt: getSystemPrompt(),
        };

        let prompt: string;
        try {
          prompt = promptForTheorem(theorem);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.validation_errors = [`Prompt build error: ${msg}`];
          try { db.insertResult(setName, result, continueRunId); } catch {}
          totalErrors++;
          console.log(`  -> PROMPT ERROR: ${msg}`);
          return;
        }

        let response: ModelResponse;
        try {
          response = await adapter.callModel(prompt, modelConfig);
          result.raw_response = response.raw_response;
          result.latency_ms = response.latency_ms;
          result.model_name = response.model;
          result.tokens_used = response.tokens_used;
          result.thinking_tokens = response.thinking_tokens;
          result.finish_reason = response.finish_reason;

          if (response.tokens_used) {
            const callCost = estimateCallCost(adapter.name, response.tokens_used);
            console.log(`  cost: +$${callCost.toFixed(4)} (${response.tokens_used} tokens${response.thinking_tokens ? `, ${response.thinking_tokens} thinking` : ""}, budget: ${effectiveMaxTokens})`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.validation_errors = [`API error: ${msg}`];

          // Detect unrecoverable quota errors (daily limits, limit: 0) — abort entire run
          const msgLower = msg.toLowerCase();
          if (msgLower.includes("per_day") || msgLower.includes("per_model_per_day") || (msgLower.includes("quota") && msgLower.includes("limit: 0"))) {
            quotaAborted = true;
            try { db.insertResult(setName, result, continueRunId); } catch {}
            totalErrors++;
            console.log(`  -> QUOTA EXHAUSTED — aborting run (daily limit reached)`);
            return;
          }

          if (attempt < MAX_ATTEMPTS) {
            console.log(`  -> API ERROR (will retry): ${msg}`);
            continue;
          }
          try { db.insertResult(setName, result, continueRunId); } catch {}
          totalErrors++;
          console.log(`  -> API ERROR (gave up after ${MAX_ATTEMPTS} attempts): ${msg}`);
          return;
        }

        // Spiral detection: warn if model is repeating itself
        const spiral = detectSpiral(response.raw_response);
        if (spiral) {
          console.warn(`  SPIRAL DETECTED: "${spiral.repeatedLine}" repeated ${spiral.count}x`);
        }

        const { proof, error: parseError } = parseModelResponse(response.raw_response, theorem);
        if (parseError || !proof) {
          result.parse_error = parseError;
          result.validation_result = "error";
          result.validation_errors = [parseError ?? "Unknown parse error"];
          if (!args.noRetryParse && attempt < MAX_PARSE_ATTEMPTS) {
            console.log(`  -> PARSE ERROR (will retry): ${parseError}`);
            continue;
          }
          try { db.insertResult(setName, result, continueRunId); } catch {}
          totalErrors++;
          console.log(`  -> PARSE ERROR: ${parseError}`);
          return;
        }
        result.parsed_proof = proof;

        const { valid, line_count, errors } = await validateProof(benchThm, proof, args.propbenchBin);
        result.validation_result = valid ? "valid" : "invalid";
        result.validation_errors = errors;
        result.line_count = valid ? line_count : null;

        try { db.insertResult(setName, result, continueRunId); } catch {}
        totalRun++;

        if (valid) {
          totalValid++;
          console.log(`  -> VALID (${proof.length} lines, ${result.latency_ms}ms)`);
        } else {
          totalInvalid++;
          console.log(`  -> INVALID: ${errors.slice(0, 2).join("; ")}${errors.length > 2 ? ` (+${errors.length - 2} more)` : ""}`);
        }
        return;
      }
    }

    await runWithConcurrency(workItems, args.workers, processWorkItem);

    // Mark run as finished
    try { db.finishRun(continueRunId); } catch {}

    console.log();
    console.log("=== Summary ===");
    console.log(`Run:     ${totalRun}`);
    console.log(`Skipped: ${totalSkipped}`);
    console.log(`Valid:   ${totalValid}`);
    console.log(`Invalid: ${totalInvalid}`);
    console.log(`Errors:  ${totalErrors}`);
    console.log();

    return; // Done — skip the normal sequential runs loop
  }

  const totalRuns = args.runs;
  if (totalRuns > 1) {
    console.log(`Sequential runs: ${totalRuns}`);
    console.log();
  }

  for (let runIteration = 1; runIteration <= totalRuns; runIteration++) {
    if (totalRuns > 1) {
      console.log(`\n=== Sequential Run ${runIteration}/${totalRuns} ===\n`);
    }

    // For the first run, use normal behavior (resume if not forced).
    // For runs 2+, always force (create new run records).
    const forceThisRun = runIteration === 1 ? args.force : true;

    // Create or resume run records for each model
    const runIds = new Map<string, number>();
    for (const adapter of adapters) {
      const runId = forceThisRun
        ? db.createRun(setName, adapter.name, args.temperature, args.maxTokens)
        : db.findOrCreateRun(setName, adapter.name, args.temperature, args.maxTokens);
      runIds.set(adapter.name, runId);
    }

    // Stats (reset for each sequential run)
    let totalRun = 0;
    let totalSkipped = 0;
    let totalValid = 0;
    let totalInvalid = 0;
    let totalErrors = 0;

    // Cost tracking
    let runCostUsd = 0;
    let costAborted = false;

    // Load run state for resume support (only for first run when not forcing)
    const currentState = (runIteration === 1 && !args.force) ? state : { completed: new Set<string>() };

    // Build flat list of all work items
    const workItems: WorkItem[] = [];
    let itemNumber = 0;
    for (let ti = 0; ti < benchTheorems.length; ti++) {
      for (let ai = 0; ai < adapters.length; ai++) {
        itemNumber++;
        const key = resultKey(benchTheorems[ti].id, adapters[ai].name);
        if (!forceThisRun && currentState.completed.has(key)) {
          totalSkipped++;
          console.log(
            `[${itemNumber}/${benchTheorems.length * adapters.length}] ${benchTheorems[ti].id} x ${adapters[ai].name} — SKIPPED (already done)`
          );
          continue;
        }
        workItems.push({ theoremIndex: ti, adapterIndex: ai, itemNumber });
      }
    }

    const totalItems = benchTheorems.length * adapters.length;

    const MAX_ATTEMPTS = 10; // retry API errors up to 10 times before giving up
    const MAX_PARSE_ATTEMPTS = 3; // retry parse errors up to 3 times before giving up

    // Process work items with concurrency limiter
    async function processWorkItem(item: WorkItem): Promise<void> {
      if (costAborted) return;

      const benchThm = benchTheorems[item.theoremIndex];
      const adapter = adapters[item.adapterIndex];
      const theorem = toTheorem(benchThm);
      const runTag = totalRuns > 1 ? `(run ${runIteration}/${totalRuns}) ` : "";
      const progress = `${runTag}[${item.itemNumber}/${totalItems}]`;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (costAborted) return;
        if (attempt > 1) {
          // Exponential backoff capped at 30s
          const delay = Math.min(1000 * Math.pow(2, attempt - 2), 30_000);
          console.log(`${progress} ${benchThm.id} x ${adapter.displayName} — retrying (attempt ${attempt}) after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          console.log(
            `${progress} ${benchThm.id} x ${adapter.displayName} — running...`
          );
        }

        const result: BenchmarkResult = {
          theorem_id: benchThm.id,
          model: adapter.name,
          model_name: adapter.displayName,
          raw_response: "",
          parsed_proof: null,
          parse_error: null,
          validation_result: "error",
          validation_errors: [],
          line_count: null,
          latency_ms: 0,
          tokens_used: undefined,
          timestamp: new Date().toISOString(),
        };

        // Tier-based token budget: cap output tokens by difficulty
        const effectiveMaxTokens = getMaxTokensForDifficulty(benchThm.difficulty, args.maxTokens, args.tierBudgetsEnabled, args.tierBudgets);
        const modelConfig: ModelConfig = {
          model: "",
          temperature: args.temperature,
          maxTokens: effectiveMaxTokens,
          maxThinkingTokens: args.maxThinkingTokens,
          systemPrompt: getSystemPrompt(),
        };

        // Step 1: Build prompt
        let prompt: string;
        try {
          prompt = promptForTheorem(theorem);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.validation_errors = [`Prompt build error: ${msg}`];
          // Prompt errors are deterministic — no point retrying
          try { db.insertResult(setName, result, runIds.get(adapter.name)); } catch {}
          totalErrors++;
          console.log(`  -> PROMPT ERROR: ${msg}`);
          return;
        }

        // Step 2: Call model API
        let response: ModelResponse;
        try {
          response = await adapter.callModel(prompt, modelConfig);
          result.raw_response = response.raw_response;
          result.latency_ms = response.latency_ms;
          result.model_name = response.model;
          result.tokens_used = response.tokens_used;
          result.thinking_tokens = response.thinking_tokens;
          result.finish_reason = response.finish_reason;

          // Track running cost
          if (response.tokens_used) {
            const callCost = estimateCallCost(adapter.name, response.tokens_used);
            runCostUsd += callCost;
            console.log(`  cost: $${runCostUsd.toFixed(4)} (+$${callCost.toFixed(4)}, ${response.tokens_used} tokens${response.thinking_tokens ? `, ${response.thinking_tokens} thinking` : ""}, budget: ${effectiveMaxTokens})`);

            if (args.maxCost != null && runCostUsd >= args.maxCost) {
              costAborted = true;
              console.log(`  COST LIMIT REACHED: $${runCostUsd.toFixed(4)} >= $${args.maxCost.toFixed(2)} — aborting run`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.validation_errors = [`API error: ${msg}`];

          // Detect unrecoverable quota errors (daily limits, limit: 0) — abort entire run
          const msgLower = msg.toLowerCase();
          if (msgLower.includes("per_day") || msgLower.includes("per_model_per_day") || (msgLower.includes("quota") && msgLower.includes("limit: 0"))) {
            costAborted = true;
            try { db.insertResult(setName, result, runIds.get(adapter.name)); } catch {}
            totalErrors++;
            console.log(`  -> QUOTA EXHAUSTED — aborting run (daily limit reached)`);
            return;
          }

          if (attempt < MAX_ATTEMPTS) {
            console.log(`  -> API ERROR (will retry): ${msg}`);
            continue;
          }
          try { db.insertResult(setName, result, runIds.get(adapter.name)); } catch {}
          totalErrors++;
          console.log(`  -> API ERROR (gave up after ${MAX_ATTEMPTS} attempts): ${msg}`);
          return;
        }

        // Spiral detection: warn if model is repeating itself
        const spiral = detectSpiral(response.raw_response);
        if (spiral) {
          console.warn(`  SPIRAL DETECTED: "${spiral.repeatedLine}" repeated ${spiral.count}x`);
        }

        // Step 3: Parse response
        const { proof, error: parseError } = parseModelResponse(
          response.raw_response,
          theorem
        );
        if (parseError || !proof) {
          result.parse_error = parseError;
          result.validation_result = "error";
          result.validation_errors = [parseError ?? "Unknown parse error"];
          if (!args.noRetryParse && attempt < MAX_PARSE_ATTEMPTS) {
            console.log(`  -> PARSE ERROR (will retry): ${parseError}`);
            continue;
          }
          try { db.insertResult(setName, result, runIds.get(adapter.name)); } catch {}
          totalErrors++;
          console.log(`  -> PARSE ERROR: ${parseError}`);
          return;
        }
        result.parsed_proof = proof;

        // Step 4: Validate via CLI
        const { valid, line_count, errors } = await validateProof(
          benchThm,
          proof,
          args.propbenchBin
        );
        result.validation_result = valid ? "valid" : "invalid";
        result.validation_errors = errors;
        result.line_count = valid ? line_count : null;

        try { db.insertResult(setName, result, runIds.get(adapter.name)); } catch {}
        totalRun++;

        if (valid) {
          totalValid++;
          console.log(`  -> VALID (${proof.length} lines, ${result.latency_ms}ms)`);
        } else {
          // Invalid proofs are final results, NOT errors — don't retry
          totalInvalid++;
          console.log(
            `  -> INVALID: ${errors.slice(0, 2).join("; ")}${errors.length > 2 ? ` (+${errors.length - 2} more)` : ""}`
          );
        }
        return; // Got a result (valid or invalid) — done
      }
    }

    await runWithConcurrency(workItems, args.workers, processWorkItem);

    // Mark all runs as finished
    for (const runId of runIds.values()) {
      try { db.finishRun(runId); } catch {}
    }

    // Summary
    console.log();
    if (totalRuns > 1) {
      console.log(`=== Summary (Run ${runIteration}/${totalRuns}) ===`);
    } else {
      console.log("=== Summary ===");
    }
    console.log(`Run:     ${totalRun}`);
    console.log(`Skipped: ${totalSkipped}`);
    console.log(`Valid:   ${totalValid}`);
    console.log(`Invalid: ${totalInvalid}`);
    console.log(`Errors:  ${totalErrors}`);
    console.log(`Cost:    $${runCostUsd.toFixed(4)}`);
    if (costAborted) {
      console.log(`*** RUN ABORTED — cost limit ($${args.maxCost!.toFixed(2)}) reached ***`);
    }
    console.log();
  } // end of sequential runs loop
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
