# Historical harness overview

This is the earlier project overview, retained for the legacy generator, Elo/API harness and September 8 subscription prototype. Provider examples and operational paths below are historical. Use the root README and TRACKS.md for current Codex-only execution.

# PropBench

A benchmark for constructing short, valid propositional-logic proofs using Fitch-style natural deduction.

## Why PropBench?

PropBench asks two separate questions. **Frontier** measures how much fully equipped agents can shorten known proofs, using scripts, solvers, repeated validation, and an explicit fresh or cumulative starting point. **Unaided** measures how well a model constructs proofs with no external computation, tools, or verifier feedback during generation.

Both tracks use the same Rust verifier and line-count convention. Validity and length are reported separately. New evaluations use the versioned `efficiency-v2` score; historical golf ratios and Elo results retain their original interpretation.

Live Tracks runs use your **Claude and Codex subscriptions** through the installed native clients. Select a model and reasoning effort; Unaided has no tools, and Frontier gets an isolated workspace with execution and delegation. No OpenRouter or other paid API key is used in this flow.

Generating larger theorems and searching for shorter proofs gives room for further experiments. It does not establish universal hardness or resistance to saturation. A set's **par** is a known achievable proof length, not a certified minimum; failure of a bounded solver search does not prove optimality.

See [the track guide](TRACKS.md) for runnable commands, isolation requirements, budgets, and deterministic examples.

## Legacy harness

1. **Generate theorems** — The Rust CLI produces tautologies at configurable difficulty tiers (Baby → Mind), controlling variables, transformation passes, substitution depth, and bridge atoms.
2. **Prompt LLMs** — The TypeScript harness sends each theorem to one or more models with the full set of 19 inference/equivalence rules, conditional proof, and indirect proof techniques.
3. **Parse & validate** — LLM output is parsed into structured proof lines, written to temp files, and validated by the Rust CLI (`propbench validate`).
4. **Score** — Valid proofs are scored by line count. Models are ranked using an Elo rating system with head-to-head matchups.

## Subscription clients

- **Claude Code** with Claude subscription authentication.
- **Codex** with ChatGPT authentication.

Model and effort availability are checked by the installed client. Subscription reports preserve the returned model and available usage without claiming exact internal request counts or API token caps.

### Historical API adapters

- **Gemini** (direct API) — `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-3-pro-preview`, etc.
- **OpenRouter** (any model) — `anthropic/claude-sonnet-4.5`, `openai/gpt-4o`, `deepseek/deepseek-r1`, etc.

## Difficulty Tiers

| Tier | Variables | Passes | Transforms/Pass |
|------|-----------|--------|-----------------|
| Baby | 2 | 1 | 2 |
| Easy | 3 | 1 | 5 |
| Medium | 4 | 1 | 10 |
| Hard | 5 | 1 | 15 |
| Expert | 5 | 2 | 15 |
| Nightmare | 5 | 3 | 15 |
| Marathon | 6 | 5 | 20 |
| Absurd | 7 | 10 | 20 |
| Cosmic | 7 | 20 | 24 |
| Mind | 7 | 50 | 50 |

## Setup

### Prerequisites

- **Rust** — [rustup.rs](https://rustup.rs) (stable toolchain)
- **Node.js 22+** and **npm** (use the same Node version for dependency installation and execution)
- For live Tracks: installed `claude` and/or `codex`, signed in through your subscriptions. Frontier also requires the isolated Docker runtime described in [TRACKS.md](TRACKS.md). Local fixtures require no model login.

### 1. Build the Rust binary

```bash
cargo build --release
```

This produces `target/release/propbench`, which both the CLI harness and the GUI server depend on.

### 2. Install Node dependencies

```bash
# Root (harness + shared tooling)
npm install

# GUI (React + Express dev server)
cd gui && npm install && cd ..
```

### 3. Use your subscription logins

```bash
claude auth login --claudeai
codex login
```

Skip either login when that native client is already signed in. Tracks does not
need an `.env` file or API keys. Existing `.env` keys are stripped from contestant
client environments. The historical API harness is separate from Tracks.

### 4. Run the GUI

```bash
cd gui && npm run dev
```

Opens a web UI at `localhost:3000` with:

- **Tracks** — Prepare Frontier or Unaided runs, inspect verified proof lengths, and compare matching evaluation cohorts
- **Dashboard** — Elo rankings, difficulty breakdown, head-to-head matrix, latency comparison, failure analysis
- **Benchmark Runner** — Configure models, theorem sets, token budgets, parallelism, cost limits; watch live progress via SSE
- **Theorem Explorer** — Browse theorems by difficulty, view side-by-side proof comparisons across models

## Project Structure

```
prop-bench/
├── src/main.rs          # Rust CLI: generate theorems & validate proofs
├── harness.ts           # Main orchestrator: LLM calls → parse → validate → score
├── parser.ts            # LLM output → structured proof lines
├── prompt.ts            # Prompt builder (rules, techniques, format spec)
├── scorer.ts            # Elo rating system
├── config.ts            # Shared types & difficulty tiers
├── db.ts                # SQLite storage layer (results saved to propbench.db)
├── models/              # LLM adapters (Gemini direct, OpenRouter)
├── tracks/              # Versioned Frontier/Unaided runners and referee records
├── gui/                 # React + Express web interface
└── benchmarks/          # User-generated theorem sets
```

The proof engine itself — formula parsing, the natural-deduction rule set,
verification, and theorem generation — lives in
[logic-core](https://github.com/dogaozden/logic-core), a separate crate shared
with the [Logic Proof Trainer](https://github.com/dogaozden/logic-proof-trainer)
app. Cargo fetches it automatically, so `git clone` followed by `cargo build`
is all you need.
## Theorem Generation Algorithm Simplified

(1) Pick a base argument form using one of the inference forms (1-8 in rules.md).

Looks like:
p ⊃ q
p  /∴  q

(2) Wrap it as a tautology.

Looks like:
[(p ⊃ q) . p] ⊃ q

(3) Substitute atoms with compound formulas (if substitution_depth > 0).

Replace each simple atom with a formula built from fresh atoms:
  p  →  (R . T)
  q  →  (S ∨ ~T)

Now it looks like:
{[(R . T) ⊃ (S ∨ ~T)] · (R . T)} ⊃ (S ∨ ~T)

(4) Apply equivalence rules (9-18 in rules.md) at random positions, in random directions, repeatedly.
 Equivalence rules are selected randomly with weighted probability. Distribution is down-weighted (0.2) to keep theorem size more predictable. Tautology expansion is blocked entirely because it bloats formula size without adding much in terms of difficulty.

For example, apply Implication (rule 15) to the inner ⊃:
(R . T) ⊃ (S ∨ ~T)  →  ~(R . T) ∨ (S ∨ ~T)
Then DeMorgan (rule 10) on ~(R . T):
  ~(R . T)  →  (~R ∨ ~T)

Then Commutation (rule 11), Association (rule 12), more Implication,
Contraposition... dozens of times across multiple passes.

The formula becomes unrecognizable, but it's still the same tautology—every equivalence rule preserves truth by definition!

(5) Output: A single formula the LLM must prove is a tautology, using the same 18 rules + CP/IP that were used to obfuscate it.

See *generation_algorithm.md* for more details.

## Hierarchy of brackets
1. (P v Q)
2. [(P v Q) . R]
3. {[(P v Q) . R] ⊃ S}
4. {{[(P v Q) . R] ⊃ S} . T} ⊃ A

  And so on. Curly brackets are stacked on top of each other after we run out of parentheses and square brackets.

### Screenshots

Theorem Generation Screen:


![PropBench Theorem Generation Algo Settings](./assets/gui_screenshot.png)

Example Theorems:


![Example Theorems](./assets/example_theorems.png)
