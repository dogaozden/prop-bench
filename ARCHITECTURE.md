# PropBench Architecture

## System Overview

PropBench is an LLM benchmark that measures proof efficiency in propositional logic natural deduction. Unlike traditional benchmarks that only check correctness, PropBench scores models on the fewest proof lines needed to prove tautologies using Fitch-style natural deduction. This creates a non-saturating benchmark: theorems can be arbitrarily difficult, every proof is mechanically verifiable, and the metric captures reasoning quality, not just binary correctness. PropBench reuses the robust Rust infrastructure from the Logic Proof Trainer app (theorem generation, formula parsing, truth table validation, and proof verification) and wraps it with a TypeScript harness that orchestrates LLM API calls, parses model outputs, validates proofs, and computes Elo ratings.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                   PropBench Benchmark System                     │
└─────────────────────────────────────────────────────────────────┘

                           TypeScript Layer
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  Theorem JSON (from CLI)                                         │
│        │                                                          │
│        ▼                                                          │
│  ┌─────────────┐                                                 │
│  │ harness.ts  │  Orchestrator (main loop)                       │
│  └─────────────┘                                                 │
│        │                                                          │
│        ├──► prompt.ts ──────────► buildPrompt()                  │
│        │                                   │                      │
│        │                                   ▼                      │
│        │                          Complete Prompt String         │
│        │                                   │                      │
│        │                                   ▼                      │
│        ├──► models/index.ts ───► ModelAdapter.callModel()        │
│        │           │                       │                      │
│        │           ├─► gemini.ts           │                      │
│        │           └─► openrouter.ts       │                      │
│        │                                   │                      │
│        │                                   ▼                      │
│        │                          LLM API Response               │
│        │                           (raw text)                     │
│        │                                   │                      │
│        ▼                                   ▼                      │
│  ┌─────────────┐                  ┌──────────────┐               │
│  │ parser.ts   │◄─────────────────│ Raw Response │               │
│  └─────────────┘                  └──────────────┘               │
│        │                                                          │
│        ▼                                                          │
│  ParsedLine[] (structured proof)                                 │
│        │                                                          │
│        ▼                                                          │
│  toValidationJSON() ──────► JSON payload                         │
│                                    │                              │
└────────────────────────────────────┼──────────────────────────────┘
                                     │
                                     ▼
                         Temp files: theorem.json
                                    proof.json
                                     │
                                     ▼
        ┌────────────────────────────────────────────────┐
        │             Rust CLI (subprocess)              │
        │                                                │
        │  $ propbench validate                          │
        │      --theorem theorem.json                    │
        │      --proof proof.json                        │
        │                                                │
        │  ┌──────────────────────────────────────────┐ │
        │  │  src/main.rs (CLI entry)                 │ │
        │  │      │                                    │ │
        │  │      ▼                                    │ │
        │  │  Parse theorem + proof JSON              │ │
        │  │      │                                    │ │
        │  │      ▼                                    │ │
        │  │  logic-proof-trainer crate (via path)    │ │
        │  │      │                                    │ │
        │  │      ├─► Formula::parse()                │ │
        │  │      ├─► Proof::new()                    │ │
        │  │      ├─► Proof::add_line()               │ │
        │  │      ├─► Proof::open_subproof()          │ │
        │  │      ├─► Proof::close_subproof()         │ │
        │  │      └─► ProofVerifier::verify_line()    │ │
        │  │                │                          │ │
        │  │                ▼                          │ │
        │  │     { valid, line_count, errors }        │ │
        │  └──────────────────────────────────────────┘ │
        │                                                │
        └────────────────────────────────────────────────┘
                         │
                         ▼
                  JSON to stdout
                         │
                         ▼
        ┌────────────────────────────────────────────────┐
        │          TypeScript Layer (cont'd)             │
        │                                                │
        │  Parse CLI output                              │
        │        │                                       │
        │        ▼                                       │
        │  BenchmarkResult                               │
        │        │                                       │
        │        ├──► logger.ts ──► JSONL log           │
        │        └──► scorer.ts ──► Elo ratings         │
        │                                                │
        └────────────────────────────────────────────────┘

      Relationship to Logic Proof Trainer Crate
┌───────────────────────────────────────────────────┐
│  crates/logic-proof-trainer-lib/                  │
│     (vendored Rust library)                       │
│                                                   │
│  ├─ models/                                       │
│  │    ├─ formula.rs      (parser, symbol aliases) │
│  │    ├─ proof.rs        (Proof, ProofLine)       │
│  │    ├─ theorem.rs      (Theorem, Difficulty)    │
│  │    └─ rules/          (19 rules + CP/IP)       │
│  │                                                 │
│  ├─ services/                                     │
│  │    ├─ generator.rs    (TheoremGenerator)       │
│  │    ├─ verifier.rs     (ProofVerifier)          │
│  │    ├─ truth_table.rs  (tautology checking)     │
│  │    └─ obfuscate_gen.rs (difficulty engine)     │
│  │                                                 │
│  └─ lib.rs              (public API)              │
│                                                   │
│  Cargo.toml: name = "logic-proof-trainer"         │
│                                                   │
└───────────────────────────────────────────────────┘
                    ▲
                    │ path dependency
                    │
┌───────────────────────────────────────────────────┐
│  prop-bench/                                      │
│                                                   │
│  Cargo.toml:                                      │
│    [dependencies]                                 │
│    logic-proof-trainer = {                        │
│      path = "crates/logic-proof-trainer-lib"      │
│    }                                              │
│                                                   │
│  src/main.rs  (CLI binary wrapping lib calls)     │
│                                                   │
└───────────────────────────────────────────────────┘
```

## Component Overview

| Component | Responsibility |
|-----------|---------------|
| **harness.ts** | Orchestrates the entire benchmark loop: load theorems, call models, parse responses, validate proofs, log results; loads `.env` for API keys; supports parallel workers via `--workers N` |
| **prompt.ts** | Builds complete LLM prompts with theorem, all 19 rules + CP/IP, symbol reference, and output format spec; v2.5: added CRITICAL section clarifying FORMULA field |
| **parser.ts** | Parses raw LLM text output into structured proof lines: strips line numbers, detects subproof depth, normalizes symbols, canonicalizes rule names; v2.5: fixed formula parsing using known-rule-name matching |
| **models/index.ts** | Model adapter registry and shared interfaces (ModelAdapter, ModelConfig, ModelResponse); v2.5: removed `.js` extensions from imports |
| **models/gemini.ts** | Gemini API adapter with retry logic and token tracking; v2.5: migrated to `@google/genai` SDK, default model `gemini-2.5-flash-lite-preview-09-2025` |
| **models/openrouter.ts** | OpenRouter API adapter — routes any non-Gemini model through OpenRouter (uses openai SDK with custom baseURL) |
| **scorer.ts** | Computes Elo ratings, aggregates line counts, tracks per-difficulty statistics |
| **logger.ts** | Structured JSONL logging of all API calls, responses, parse results, validation results, and errors |
| **config.ts** | Shared TypeScript types and default benchmark parameters |
| **src/main.rs** | Rust CLI binary with two commands: `generate` (theorem sets) and `validate` (proof checking) |
| **gui/** | Web-based GUI for running benchmarks and viewing results; v2.5: many backend and frontend fixes; v2.10: auto-select latest set, delete theorem sets, clearable numeric inputs, model display names in runner progress |
| **db.ts** | SQLite database layer; provides query functions for results, stats, and theorem set management including cascading deletes |

## Data Flow

A single benchmark run follows this pipeline:

1. **Load theorems**: Harness reads the pre-generated theorem JSON file (produced by `propbench generate`)
2. **For each theorem, for each model**:
   - **Build prompt**: `prompt.ts` formats the theorem with the complete rule reference and output format instructions
   - **Call LLM API**: Model adapter sends the prompt to Gemini/Claude/GPT and receives raw text response
   - **Parse response**: `parser.ts` extracts proof lines, normalizing symbols and rule names into canonical forms
   - **Write temp files**: Harness writes theorem + parsed proof to temporary JSON files
   - **Validate via CLI**: Harness spawns `propbench validate` subprocess, which:
     - Parses the JSON files
     - Calls `logic-proof-trainer` library functions to build and verify the proof
     - Returns `{ valid, line_count, errors }` as JSON to stdout
   - **Clean up**: Delete temp files
   - **Log result**: `logger.ts` writes a JSONL entry with full context (prompt, response, parse result, validation result)
   - **Score result**: `scorer.ts` records the line count and validity for Elo calculation
3. **Generate report**: After all theorem/model pairs complete, scorer computes Elo ratings and outputs rankings

## Key Design Decisions

### Separate Rust CLI vs Embedding in TypeScript

The Rust proof verifier is complex (scope tracking, subproof validation, rule pattern matching) and well-tested (209+ tests). Rather than rewrite this logic in TypeScript or embed Rust via WASM, PropBench treats the existing Rust backend as a black-box subprocess. This approach:

- Reuses proven, stable verification logic
- Isolates the TypeScript orchestration layer from verification complexity
- Allows independent evolution of the benchmark harness and the proof verifier
- Avoids WASM build complexity and ensures identical verification behavior to the main app

### Temp Files for Validation

The Rust CLI reads theorem + proof from JSON files rather than stdin because:

- The existing `logic-proof-trainer` API expects structured types (Theorem, Formula), not raw strings
- File paths are simpler to pass via CLI args than multi-line JSON on stdin
- Temp files allow inspection/debugging of exact inputs sent to the validator
- The overhead is negligible (< 10ms per validation on typical systems)

### Type System: BenchTheorem vs Theorem

The Rust CLI emits theorems as `BenchTheorem` (serializable, string-based formulas) while TypeScript modules use `Theorem` (from `config.ts`). This separation:

- Keeps the CLI output format stable and language-agnostic (pure JSON)
- Allows TypeScript types to evolve independently (e.g., adding display metadata)
- Matches the existing Tauri command pattern where the frontend receives serialized theorems from Rust

### Two Theorem Formats: Premises + Conclusion vs Standalone Tautology

Easy theorems (difficulty 1-25) are generated via templates with explicit premises and conclusions (e.g., `P>Q, P ∴ Q`). Medium+ theorems (26-100) use the obfuscation pipeline and are standalone tautologies with no premises. The prompt template handles both cases:

- **With premises**: Prompt lists premises and instructs the model to begin with them justified as "Premise"
- **No premises**: Prompt instructs the model to use CP/IP since there are no given starting points

This dual format reflects the existing generator's two-mode design (template-based for pedagogy, obfuscation-based for difficulty scaling).

### Parallel API Calls

The harness supports concurrent API calls via `--workers N`. The implementation uses a simple worker pool pattern: N async workers pull from a shared work queue (a flat array of theorem/model pairs with an atomic index). This is safe in Node.js because:

- JavaScript is single-threaded: counter increments are atomic
- Each work item writes to a unique file (filename includes timestamp)
- The concurrency limiter is implemented without external dependencies

Default is 1 (sequential) for backward compatibility. The GUI exposes this as a "Parallel Workers" field.

## Environment and Configuration

**dotenv support (v2.5):** Both the harness (`harness.ts`) and GUI server (`gui/server/index.ts`) load environment variables from a `.env` file in the prop-bench root directory using the `dotenv` package with `override: true`. This allows API keys to be stored in a file instead of shell environment:

```bash
# prop-bench/.env
GEMINI_API_KEY=your-key-here
OPENROUTER_API_KEY=your-key-here
```

The `.env` file is loaded before any model adapters are instantiated, ensuring keys are available throughout the application lifecycle.

**Import fixes (v2.5):** All TypeScript import statements in model files (`models/index.ts`, `models/gemini.ts`, `models/openrouter.ts`) had `.js` extensions removed. The `.js` extensions were breaking `ts-node` in CommonJS mode. Imports now use bare module names (e.g., `"./index"` not `"./index.js"`).

## Parser Improvements (v2.5)

The parser (`parser.ts`) was significantly improved to handle formulas containing dots and spaces correctly:

**Problem:** The original parser used greedy/non-greedy regex patterns to split lines into `FORMULA + JUSTIFICATION`. This failed when formulas themselves contained dots or spaces (e.g., `P . Q Conj 1,2`), causing ambiguous splits.

**Solution:** The parser now uses `canonicalizeRule()` to identify known rule names before splitting:
1. Scan the line for any known rule name (inference, equivalence, or technique)
2. Split at the known rule boundary
3. Extract formula on the left, justification on the right
4. Apply this to all three parsing patterns (A, B, C)

This eliminates ambiguity and allows formulas like `P . Q`, `P v Q`, or formulas with spaces to parse correctly.

**Result:** Benchmark accuracy improved from 50% valid to 100% valid on first 10 theorems after parser fix.

## Prompt Improvements (v2.5)

The prompt template (`prompt.ts`) was improved to reduce common LLM errors:

**CRITICAL section added:** The output format specification now includes explicit examples showing that the FORMULA field must contain ONLY the derived result, not the premises used to derive it.

Example (CORRECT):
```
1. P > Q Premise
2. ~Q Premise
3. ~P MT 1,2          ← formula is just "~P", not "P > Q, ~Q"
```

This prevents models from including premise formulas in the derived formula field, which was a common error pattern.

## GUI Architecture (v2.5)

The GUI (`gui/`) provides a web interface for running benchmarks and viewing results. It consists of a React frontend (Vite) and an Express backend.

### Backend Improvements

**CLI Spawning (`gui/server/cli.ts`):**
- Now uses local `node_modules/.bin/ts-node` directly instead of `npx ts-node`/`npx tsx` to avoid npx resolution issues
- Explicitly reads `.env` file and injects environment variables into child process environment
- Pre-spawn validation: checks that theorems file, propbench binary, and harness entry point exist before spawning
- Returns `ChildProcess` for streaming output

**SSE Handler (`gui/server/routes/benchmark.ts`):**
- Completely rewrote SSE (Server-Sent Events) handler to parse harness stdout into structured progress events
- Parses stdout line-by-line and extracts: `completed`, `total`, `validCount`, `invalidCount`, `errorCount`, `skippedCount`
- Sends structured `SSEProgressEvent` objects matching frontend `SSEProgressEvent` type
- Fixed error event format: sends `{type:"error", error:"..."}` not `{type:"error", data:"..."}`
- Added detailed logging for debugging

**Results Route (`gui/server/routes/results.ts`):**
- Fixed to use `RESULTS_DIR` instead of `BENCHMARKS_DIR` when listing result files

**Environment Loading (`gui/server/index.ts`):**
- Loads dotenv with `override: true` from prop-bench root before starting server
- Ensures API keys are available to spawned harness processes

### Frontend Improvements

**Benchmark Runner (`gui/src/pages/BenchmarkRunner.tsx`):**
- Fixed stale closure bug in SSE `onerror` handler by using `useRef` for `isRunning` state instead of stale captured state
- Prevents race conditions when SSE connection errors occur

**Proof Viewer (`gui/src/components/ProofViewer.tsx`):**
- Added collapsible "Show Raw Model Response" section that displays full model output
- Added latency display in milliseconds
- Updated styling in `gui/src/styles/theorems.css`

**Theorem Detail (`gui/src/components/TheoremDetail.tsx`):**
- Now passes `rawResponse` and `latencyMs` props to ProofViewer for display

**Vite Config (`gui/vite.config.ts`):**
- Added SSE proxy buffering fix: sets `cache-control` and `x-accel-buffering` headers to prevent proxy buffering of SSE streams

### GUI Improvements (v2.10)

**Auto-Select Latest Theorem Set:**
All three main pages (Dashboard, Theorem Explorer, Benchmark Runner) now auto-select the theorem set that has the most recent benchmark run. The `TheoremSetPicker` component handles this by sorting sets by latest run timestamp and selecting the first one on initial load. When a selected set is deleted, the picker resets to the new latest set.

**Delete Theorem Set (`pages/TheoremExplorer.tsx`):**
Users can delete a theorem set from the Theorem Explorer page. The delete operation cascades through all associated data:
- Database: deletes the set, all theorems, results, runs, and reports via `deleteTheoremSet()` in `db.ts`
- Disk: deletes the set's directory and all files within it
- A two-step confirmation prevents accidental deletion
- The DELETE endpoint is exposed via `server/routes/theoremSets.ts` and called by `deleteTheoremSet()` in `api/client.ts`
- New CSS styles for danger buttons and delete confirmation UI added to `styles/main.css`

**Clearable Numeric Inputs:**
Numeric input fields across the GUI now use nullable types (`number | null`) and can be fully cleared/emptied:
- Benchmark Runner: max tokens (default 16384, changed from 4096), parallel workers, start index
- Generate Theorems: total count and all difficulty distribution tier counts (which now default to empty/0 instead of preset values)
- When empty, fields show placeholder text indicating the default value

**Model Display Names in Runner Progress (`components/RunProgress.tsx`):**
The benchmark runner progress display now shows human-readable model names (e.g., "Gemini 2.5 Flash Lite" instead of "gemini") using a display name mapping that translates CLI model adapter slugs to user-friendly labels.

## Relationship to Logic Proof Trainer

PropBench is a path-dependent crate that imports `logic-proof-trainer` from the vendored library at `crates/logic-proof-trainer-lib/`. The entire proof generation and verification infrastructure lives in that crate:

| Module | Functionality Reused by PropBench |
|--------|-----------------------------------|
| **models/formula.rs** | Parses formula strings with 40+ symbol aliases (>, ⊃, ->, => all map to conditional) |
| **models/theorem.rs** | Theorem type with difficulty tiers, premise/conclusion structure |
| **models/proof.rs** | Proof and ProofLine types, subproof stack management |
| **models/rules/** | All 19 rules (9 inference, 10 equivalence) + CP/IP, with pattern matching and bidirectional equivalence checking |
| **services/generator.rs** | Dual-mode theorem generation (template-based for Easy, obfuscation-based for Medium+) |
| **services/obfuscate_gen.rs** | 3-layer obfuscation (base form → atom substitution → wrap + transform) with difficulty scaling |
| **services/truth_table.rs** | 32-bit tautology validation (currently supports 5 variables P, Q, R, S, T; expandable to 64/128 bits or BigInt for more variables) |
| **services/verifier.rs** | Line-by-line validation: checks justifications, scope accessibility, rule pattern matching, and subproof closure |

PropBench's Rust CLI (`src/main.rs`) is a thin wrapper around these library functions. It does not reimplement any logic; it only handles CLI argument parsing, JSON serialization, and subprocess stdout formatting.

The Cargo.toml dependency declaration:

```toml
[dependencies]
logic-proof-trainer = { path = "crates/logic-proof-trainer-lib" }
```

This path dependency means:

- The library is vendored inside the repo and requires no sibling directory checkout
- Theorem generation uses the exact same difficulty engine as the app
- Proof verification uses the identical rule checking logic as the interactive trainer
- Any improvements to the verifier automatically apply to the benchmark
