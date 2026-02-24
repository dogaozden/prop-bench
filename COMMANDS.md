# PropBench Commands

### Development server

```bash
cd gui
npm run dev
# Runs both Vite frontend (http://localhost:3000) and Express backend (http://localhost:3001) concurrently
```

## Setup

```bash
# 1. Install TypeScript dependencies
npm install

# 2. Build the Rust CLI binary
cargo build --release
```

## CLI Binary (Rust)

### Generate a theorem set

The generate command supports three modes: **distribution** (legacy), **tier preset**, and **custom spec**.

```bash
# Legacy distribution mode (default if no --tier/--spec flags)
./target/release/propbench generate --output benchmarks/v1/theorems.json

# Custom distribution (counts must sum to --count)
./target/release/propbench generate \
  --count 50 \
  --difficulty-distribution "20:easy,20:medium,10:hard" \
  --output my_theorems.json

# Distribution with extended tiers (absurd/cosmic/mind use spec-based generation)
./target/release/propbench generate \
  --count 10 \
  --difficulty-distribution "3:easy,3:absurd,4:cosmic" \
  --output extended.json

# Tier preset mode — all theorems use one tier's DifficultySpec
./target/release/propbench generate --tier nightmare --count 20 --output nightmare.json
./target/release/propbench generate --tier absurd --count 5 --output absurd.json

# Custom spec mode — full control over generation parameters
./target/release/propbench generate \
  --variables 10 --passes 3 --transforms 15 \
  --base complex --substitution 3 --bridge-atoms 1 \
  --count 20 --output custom.json
```

### Difficulty tiers

| Tier       | Vars | Passes | Transforms/pass | Base    | Substitution | Bridge Atoms |
|------------|------|--------|-----------------|---------|-------------|--------------|
| Easy       | 3    | 1      | 5               | simple  | 0           | 0            |
| Medium     | 4    | 1      | 10              | complex | 0           | 0            |
| Hard       | 5    | 1      | 15              | complex | 2           | 0            |
| Expert     | 5    | 2      | 15              | complex | 3           | 0            |
| Nightmare  | 5    | 3      | 15              | complex | 4           | 1            |
| Marathon   | 6    | 5      | 20              | complex | 4           | 1            |
| Absurd     | 7    | 10     | 20              | complex | 4           | 1            |
| Cosmic     | 7    | 20     | 24              | complex | 4           | 2            |
| Mind       | 7    | 50     | 50              | complex | 10          | 2            |

### DifficultySpec fields

| Field               | Range | Description |
|---------------------|-------|-------------|
| `variables`         | 2-20  | Number of propositional variables |
| `passes`            | 1-20  | Number of transform passes (re-wrapping between each) |
| `transforms_per_pass` | 1-24 | Random equivalence transforms applied per pass |
| `base_complexity`   | simple/complex | `simple` = standard base forms, `complex` = includes ConstructiveDilemmaFull, NestedCP, Chain4 |
| `substitution_depth` | 0-4  | Depth of atom-to-formula substitutions (0 = none) |
| `bridge_atoms`      | 0-5   | Number of bridge atoms for cross-zone interdependencies (0 = none) |

### Validate a proof

```bash
# Validate a proof against a theorem (both are JSON files)
./target/release/propbench validate --theorem theorem.json --proof proof.json
```

**Note:** The current benchmark uses tautology-only theorems (empty premises). The examples below show the data structure format, which still supports theorems with premises for validation purposes, but the benchmark prompt no longer generates premise-based theorems.

**theorem.json** format (formulas use ASCII with alternating brackets):
```json
{
  "id": "v1-001",
  "premises": ["P | Q", "~P"],
  "conclusion": "Q",
  "difficulty": "Easy",
  "difficulty_value": 8
}

// Tautology example (current benchmark format):
{
  "id": "v1-042",
  "premises": [],
  "conclusion": "[(P -> Q) & ~Q] -> ~P",
  "difficulty": "Medium",
  "difficulty_value": 39
}
```

**proof.json** format:
```json
[
  { "line_number": 1, "formula": "P | Q", "justification": "Premise", "depth": 0 },
  { "line_number": 2, "formula": "~P", "justification": "Premise", "depth": 0 },
  { "line_number": 3, "formula": "Q", "justification": "DS 1,2", "depth": 0 }
]
```

**Output** (stdout, JSON):
```json
{
  "valid": true,
  "line_count": 1,
  "errors": []
}
```

## Benchmark Harness (TypeScript)

### Run a benchmark

```bash
# Run against a single model
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-2.5-flash-lite-preview-09-2025 \
  --propbench-bin ./target/release/propbench

# Run against multiple models (mixed direct Gemini + OpenRouter)
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-2.5-flash,anthropic/claude-sonnet-4.5,openai/gpt-4o \
  --propbench-bin ./target/release/propbench

# Run a subset of theorems (e.g., first 10)
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-2.5-flash-lite-preview-09-2025 \
  --start 0 --count 10 \
  --propbench-bin ./target/release/propbench

# Custom output directory
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-2.5-flash-lite-preview-09-2025 \
  --output my_results/ \
  --propbench-bin ./target/release/propbench

# Run with parallel workers
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-2.5-flash-lite-preview-09-2025 \
  --workers 5 \
  --propbench-bin ./target/release/propbench

# Run multiple sequential runs (best of N)
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-2.5-flash-lite-preview-09-2025 \
  --runs 3 \
  --propbench-bin ./target/release/propbench

# Adjust model parameters (OpenRouter model)
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models anthropic/claude-sonnet-4.5 \
  --temperature 0.0 \
  --max-tokens 8192 \
  --propbench-bin ./target/release/propbench
```

### Harness CLI arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--theorems <path>` | Yes | — | Path to theorem set JSON |
| `--models <list>` | Yes | — | Comma-separated full model identifiers (see Model Identifiers table below) |
| `--output <dir>` | No | `results/` | Output directory for results |
| `--start <n>` | No | `0` | Start at theorem index n |
| `--count <n>` | No | all | Process only n theorems |
| `--propbench-bin <path>` | No | `propbench` | Path to the Rust CLI binary |
| `--workers <n>` | No | `1` | Number of parallel API workers |
| `--runs <n>` | No | `1` | Run the full benchmark N times back-to-back (each subsequent run uses force mode) |
| `--temperature <n>` | No | `0.2` | Model temperature |
| `--max-tokens <n>` | No | `4096` | Max output tokens (tier-capped: Baby/Easy=1024, Med/Hard=2048, Expert=4096, Mind=8192) |
| `--max-thinking-tokens <n>` | No | `10000` | Max thinking/reasoning tokens per API call (Gemini thinkingBudget, OpenRouter reasoning.max_tokens) |
| `--force` | No | off | Force new run — don't skip completed theorems |
| `--no-retry-parse` | No | off | Don't retry parse errors — treat unparseable model output as a final result |
| `--retry-api-errors` | No | off | With `--continue-run`: delete API error results and retry those theorems |
| `--continue-run <id>` | No | — | Continue an incomplete run by its DB run ID |
| `--max-cost <n>` | No | no limit | Abort run when estimated cost exceeds $n (e.g. `--max-cost 5`) |
| `--no-tier-budgets` | No | off | Disable tier-based output token budgets (use flat `--max-tokens` for all tiers) |
| `--tier-budgets <json>` | No | built-in defaults | Custom per-tier token budgets as JSON (e.g. `'{"baby":2048,"mind":8192}'`) |

### Resume interrupted runs

The harness automatically detects completed theorem+model pairs in the output directory and skips them. Just re-run the same command to resume.

### Continue incomplete runs

If a run was interrupted (rate limits, tab switching, etc.), you can resume it by its database run ID using `--continue-run`. This loads the run's original settings and only processes theorems that don't already have results.

```bash
# Continue run #42 with 3 parallel workers
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-3-pro-preview \
  --continue-run 42 \
  --workers 3 \
  --propbench-bin ./target/release/propbench
```

The `--theorems` and `--models` flags are still required (passed by the GUI server from the run's DB record). The `--workers` flag can be changed. All other settings (temperature, max tokens) are loaded from the original run record.

### Retry API errors

If a run finished but had API errors (e.g., rate limits, timeouts), use `--retry-api-errors` with `--continue-run` to delete those error results and retry just the affected theorems:

```bash
npx ts-node harness.ts \
  --theorems benchmarks/v1/theorems.json \
  --models gemini-3-pro-preview \
  --continue-run 25 \
  --retry-api-errors \
  --workers 3 \
  --propbench-bin ./target/release/propbench
```

In the GUI, runs with API errors show as **"Finished with API Errors"** (purple). These appear in the Continue Run dropdown alongside incomplete runs — selecting one automatically enables `--retry-api-errors`.

## Environment Variables

**Recommended: Use `.env` file** (v2.5+)

Create a `.env` file in the prop-bench root directory:

```bash
# prop-bench/.env
GEMINI_API_KEY=your-key-here
OPENROUTER_API_KEY=your-key-here
```

The harness and GUI server will automatically load these on startup using the `dotenv` package.

**Alternative: Shell environment**

```bash
# Set before running
export GEMINI_API_KEY="your-key-here"
export OPENROUTER_API_KEY="your-key-here"
```

| Variable | Required for | Description |
|----------|-------------|-------------|
| `GEMINI_API_KEY` | Direct Gemini models (`gemini-*`) | Google AI API key |
| `OPENROUTER_API_KEY` | All non-Gemini models (via OpenRouter) | OpenRouter API key |

## Model Identifiers

**IMPORTANT:** When changing model names, defaults, or CLI arguments, always update the GUI to match. See `CLAUDE.md` for the "PropBench: Keep GUI in sync with CLI" rule.

PropBench uses two adapters: **direct Gemini** (via `GEMINI_API_KEY`) and **OpenRouter** (via `OPENROUTER_API_KEY`) for everything else. Known `gemini-*` names route to the direct Gemini adapter; all other model identifiers route through OpenRouter.

### Direct Gemini Models

| Model Identifier | Display Name |
|------------------|-------------|
| `gemini-2.0-flash` | Gemini 2.0 Flash |
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-2.5-flash` | Gemini 2.5 Flash |
| `gemini-2.5-flash-lite-preview-09-2025` | Gemini 2.5 Flash Lite |
| `gemini-3-flash-preview` | Gemini 3 Flash |
| `gemini-3-pro-preview` | Gemini 3 Pro |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro |

### OpenRouter Models

Any model available on [OpenRouter](https://openrouter.ai/models) can be used. Pass the OpenRouter model identifier directly. Examples:

| Model Identifier | Description |
|------------------|-------------|
| `anthropic/claude-sonnet-4.5` | Claude Sonnet 4.5 |
| `openai/gpt-4o` | GPT-4o |
| `deepseek/deepseek-r1` | DeepSeek R1 |
| `meta-llama/llama-4-maverick` | Llama 4 Maverick |

**Note:** Any valid OpenRouter model identifier works -- the table above is just a sample.

**Effort level:** All OpenRouter models run with maximum effort (`verbosity: "max"`). For Claude Opus 4.6, this enables the highest quality responses. Other models fall back to high effort automatically.

### Example CLI Usage

```bash
# Direct Gemini model
--models gemini-2.5-flash

# OpenRouter model
--models anthropic/claude-sonnet-4.5

# Mixed (direct Gemini + OpenRouter)
--models gemini-2.5-flash,anthropic/claude-sonnet-4.5
```

**Recent Changes:**
- **OpenRouter migration**: Replaced separate Anthropic and OpenAI adapters with a single OpenRouter adapter. All non-Gemini models now route through OpenRouter. Requires `OPENROUTER_API_KEY` instead of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.
- Gemini: migrated from `@google/generative-ai` to `@google/genai` SDK
- Gemini: constructor changed from `new GoogleGenerativeAI(apiKey)` to `new GoogleGenAI({ apiKey })`

## Output Structure

```
results/
└── <set-name>/                    # e.g. v1
    ├── <model-slug>/              # e.g. gemini, anthropic, openai
    │   ├── raw/
    │   │   ├── v1-001_gemini_1738800000.json
    │   │   └── ...
    │   ├── summary.json           # per-model aggregate counts
    │   └── report.json            # per-model report (Scorer output)
    ├── summary.json               # combined cross-model summary
    └── report.json                # combined cross-model report
propbench.db                       # SQLite database (all data)
```

## Database (SQLite)

PropBench uses SQLite (`propbench.db`) for storing benchmark results alongside the traditional JSON filesystem. The database uses WAL mode for safe concurrent access.

### Migration

To migrate existing JSON results into the database:

```bash
npm run migrate
```

This scans `benchmarks/` and `results/` directories and populates the SQLite database. The migration is idempotent — running it multiple times is safe.

### Database location

The database file `propbench.db` is created in the `prop-bench/` root directory.

### Dual-write mode

The harness writes results to both JSON files and SQLite simultaneously. The GUI server queries SQLite when available and falls back to filesystem scanning if the database is missing.

### Schema

- `theorem_sets` — Benchmark theorem set metadata
- `theorems` — Individual theorems with difficulty ratings
- `results` — Model benchmark results (one row per theorem × model)
- `reports_cache` — Cached Elo reports for fast serving

### Database queries

The PropBench database includes several query functions for retrieving aggregate statistics:

#### Average lines by difficulty

```typescript
getAvgLinesByDifficulty(setName?: string): Promise<AvgLinesByDifficultyRow[]>
```

Computes the average proof line count for each model across difficulty tiers. Only valid proofs are included in the calculation. Results include the count of valid proofs per model per tier.

**Parameters:**
- `setName` (optional) — Filter results to a specific theorem set

**Returns:**
Array of objects containing:
- `model` — Model alias (e.g., "gemini", "claude", "gpt")
- `difficulty` — Difficulty tier name
- `avg_lines` — Average line count for valid proofs
- `valid_count` — Number of valid proofs used in calculation

## GUI

### Setup

```bash
cd gui
npm install
```

### Development server

```bash
cd gui
npm run dev
# Runs both Vite frontend (http://localhost:3000) and Express backend (http://localhost:3001) concurrently
```

### Run backend only

```bash
cd gui
npm run server
# Starts Express backend on http://localhost:3001
```

### Production build

```bash
cd gui
npx vite build
# Output in gui/dist/
```

### Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | Load results JSON, view Elo rankings, difficulty breakdown, aggregate stats, average lines by difficulty, head-to-head wins, latency comparison |
| `/theorems` | Theorem Explorer | Browse 100 theorems, filter by difficulty, view Fitch-style proofs, compare models side-by-side |
| `/runner` | Benchmark Runner | Configure benchmark parameters, generate CLI command, track run history |

### Dashboard features

#### Avg Lines by Difficulty

Displays a table showing the average proof line count for each model across difficulty tiers. Features:
- **Rows:** Models (gemini, claude, gpt, etc.)
- **Columns:** Difficulty tiers (Easy, Medium, Hard, Expert, Nightmare, etc.)
- **Cells:** Average line count with valid proof count in parentheses, e.g., "12.5 (8)"
- **Highlighting:** Green background on the shortest (best) average for each difficulty tier
- **Data source:** Only valid proofs are included; invalid/failed proofs are excluded

The table helps identify which models produce more concise proofs at different difficulty levels.

#### API endpoints

- `GET /api/runs/stats/avg-lines-by-difficulty` — Get avg lines by difficulty for all theorem sets
- `GET /api/runs/stats/avg-lines-by-difficulty/:setName` — Filter by specific theorem set

## Development

```bash
# Type-check harness TypeScript
npx tsc --noEmit

# Build harness TypeScript to dist/
npm run build

# Type-check GUI TypeScript
cd gui && npx tsc --noEmit

# Build GUI for production
cd gui && npx vite build

# Run Rust tests (from prop-bench/)
cargo test

# Build Rust in debug mode
cargo build
```

## Recent Improvements (v5+)

### v5.1 — Token Budget & Spiral Detection

**Tier-based output token budgets:** Instead of a flat `--max-tokens` for all theorems, the harness now caps output tokens per difficulty tier. This prevents wasting tokens on spiraling responses (models repeating identical invalid lines). Token ceilings:
- Baby/Easy: 1,024
- Medium/Hard: 2,048
- Expert: 4,096
- Nightmare/Marathon: 6,144
- Absurd/Cosmic/Mind: 8,192

The `--max-tokens` flag now sets the upper bound — the actual budget for each theorem is `min(--max-tokens, tier ceiling)`. The effective budget is logged for each API call.

**Spiral detection:** The harness now detects when a model repeats proof lines 5+ times (consecutively or across the response) and logs a `SPIRAL DETECTED` warning. Based on analysis of 900+ cutoff responses where 0/900 produced valid proofs and more tokens universally correlated with worse outcomes.

**OpenRouter data loss fix:** Fixed a bug where the OpenRouter adapter silently returned empty strings when the API returned `null` content on cutoff responses. The adapter now logs a warning when this occurs.

## Recent Improvements (v4+)

### v4.50 — Cost Protection

**Thinking token tracking:** Gemini thinking models (2.5 Pro, 2.5 Flash, 3 Pro, 3 Flash) generate invisible "thinking tokens" billed as output but previously untracked. The adapter now uses `totalTokenCount` (which includes thinking tokens) and records `thinking_tokens` separately in the DB.

**Thinking budget cap:** Gemini adapter sets `thinkingConfig: { thinkingBudget: 10000 }` to cap thinking tokens per call. Prevents runaway 365K+ thinking token calls that cost ~$3.65 each on 2.5 Pro.

**Cost tracking:** Each API call now logs its estimated cost. The summary prints total run cost.

**`--max-cost` flag:** New CLI flag to abort a run when estimated spending exceeds a budget (e.g. `--max-cost 5` for $5 limit). Also available in the GUI.

**DB migration:** Added `thinking_tokens` column to the `results` table.

## Recent Improvements (v3+)

### v3.3+ Changes

**Elo system fix:** "Both failed" matchups are now skipped (no-game) instead of counted as ties. This prevents rating dilution when most models fail most theorems. Changed in `scorer.ts` (`matchScore` returns `null` for both-invalid) and `db.ts` (`getHeadToHeadMatrix` skips both-invalid).

**Elo bar chart fix:** EloChart.tsx now uses pixel-based bar heights within a fixed 170px bar area, preventing flex shrinking from making bars appear the same height.

**Full model names:** Removed short aliases (gemini, claude, gpt, etc.) from `models/index.ts`. Only full model identifiers accepted now, including both direct Gemini names (e.g., `gemini-2.5-flash`, `gemini-3-pro-preview`) and OpenRouter model IDs (e.g., `anthropic/claude-sonnet-4.5`, `openai/gpt-4o`). Adapter `name` fields updated to match.

**Run completion tracking:** Runs are now dynamically classified as "Running", "Finished", or "Incomplete" based on whether result count matches theorem count. Incomplete runs are excluded from the combined/aggregate view (scorecards, Elo, head-to-head). Only models with at least one complete run appear in the combined view.

**Run resumption:** When `--force` is NOT set, the harness reuses the most recent existing run_id for the same set+model combo via `findOrCreateRun()`. Results accumulate under the same run.

**Multiple Sequential Runs:** New `--runs N` flag runs the full benchmark N times back-to-back. Each subsequent run uses force mode. GUI has a "Sequential Runs" input.

**SSE reconnection:** Browser tab switching no longer loses benchmark progress. Client auto-reconnects SSE after 2 seconds, server resumes streaming from current state.

**Combined view deduplication:** Set-level and global model summaries now use a CTE with `ROW_NUMBER()` to keep only the latest result per theorem+model, preventing double-counting from multiple runs.

**Run count in scorecards:** Model scorecards now show how many runs exist for each model.

**Hardest theorems limit:** Increased from 15 to 30.

## Recent Improvements (v2.5)

### Parser Fixes
- Fixed formula parsing for formulas containing dots/spaces (e.g., `P . Q Conj 1,2`)
- Parser now uses known-rule-name matching instead of ambiguous regex
- Result: Benchmark accuracy improved from 50% to 100% on first 10 theorems

### Prompt Improvements
- **Tautology-only:** All premise-related code removed from `buildPrompt()` — no more `hasPremises` branching, `formatTheoremWithPremises()`, or `formatTautology()` helper functions
- Single code path: `buildPrompt()` now has a unified structure for all theorems
- System instruction says "Given a theorem" (not "Given a tautology")
- "Premise" justification type removed from output format specification
- Worked example section now has only ONE example (tautology with nested CP) — the old "with premises" example was removed
- Simplified and streamlined prompt structure

### SDK Migration
- Gemini adapter migrated from deprecated `@google/generative-ai` to new `@google/genai` SDK
- Constructor syntax changed: `new GoogleGenAI({ apiKey })` instead of `new GoogleGenerativeAI(apiKey)`
- Default model updated to `gemini-2.5-flash-lite-preview-09-2025`

### Environment Configuration
- Added `.env` file support via `dotenv` package
- Both harness and GUI server load `.env` from prop-bench root with `override: true`
- API keys can now be stored in `.env` instead of shell environment

### GUI Backend Fixes
- `cli.ts`: Uses local `node_modules/.bin/ts-node` instead of npx
- `cli.ts`: Explicitly injects `.env` vars into child process
- `cli.ts`: Pre-spawn validation (checks files exist)
- `benchmark.ts`: Rewrote SSE handler with structured progress events
- `benchmark.ts`: Fixed error event format
- `results.ts`: Fixed to use RESULTS_DIR instead of BENCHMARKS_DIR
- `index.ts`: Loads dotenv on startup

### GUI Frontend Fixes
- `BenchmarkRunner.tsx`: Fixed stale closure bug using useRef
- `ProofViewer.tsx`: Added "Show Raw Model Response" collapsible section
- `ProofViewer.tsx`: Added latency display
- `TheoremDetail.tsx`: Passes rawResponse and latencyMs to ProofViewer
- `theorems.css`: Added styles for raw response viewer
- `vite.config.ts`: Added SSE proxy buffering fix

### Parallel Execution
- Added `--workers N` flag for concurrent API calls (default: 1, sequential)
- GUI: Added "Parallel Workers" field in benchmark configuration
- Significantly reduces total benchmark time when running many theorems

### Formula Notation & Bracketing
- Theorem JSON uses ASCII operators (`&`, `|`, `->`, `<->`) for LLM compatibility
- GUI displays logic notation (`·`, `∨`, `⊃`, `≡`) via `renderFormula()` conversion
- All formulas use alternating bracket hierarchy: `()` innermost, `[]` next, `{}` outermost
- Every binary subexpression is explicitly bracketed — no implicit precedence
- Added `ascii_string_bracketed()` method to Formula (Rust)
- Added `toDisplayNotation()` utility to `gui/src/types.ts`
- Fixed `renderFormula()` replacement order bug in GUI components (was replacing `->` before `<->`)

### Import Fixes
- Removed `.js` extensions from all TypeScript imports (was breaking ts-node in CommonJS mode)
- Affects: `models/index.ts`, `models/gemini.ts`, `models/openrouter.ts`

### Dashboard Statistics
- Added "Avg Lines by Difficulty" table showing average proof line counts per model per difficulty tier
- New database query `getAvgLinesByDifficulty()` joins results with theorems to compute averages
- Only valid proofs are included in the calculation
- Table highlights the shortest (best) average per difficulty tier in green
- Valid proof counts shown in parentheses for each cell
- New API endpoints: `/api/runs/stats/avg-lines-by-difficulty` and `/api/runs/stats/avg-lines-by-difficulty/:setName`
- Component integrated into Dashboard between Head-to-Head Wins and Latency Comparison sections
