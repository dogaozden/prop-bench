# PropBench Documentation

An LLM benchmark that scores models on proof efficiency (fewest lines) for propositional logic natural deduction. Models receive tautologies and must produce Fitch-style proofs; the model with the fewest total proof lines wins.

## Recent Changes (v3.3+)

**Elo System Fix:** Both-failed matchups are now skipped (no-game) instead of counted as ties, preventing rating dilution when most models fail most theorems.

**Elo Chart Fix:** Bar heights now use fixed pixel sizing to prevent flex shrinking issues.

**Full Model Names:** Removed short aliases (gemini, claude, gpt). Only full model identifiers are now accepted. Direct Gemini models use names like `gemini-2.5-flash`; all other models use OpenRouter identifiers like `anthropic/claude-sonnet-4.5`.

**Run Completion Tracking:** Runs are dynamically classified as "Running", "Finished", or "Incomplete". Incomplete runs are excluded from combined/aggregate views.

**Run Resumption:** When `--force` is not set, the harness reuses the most recent run_id for the same set+model combo, allowing runs to accumulate results.

**Multiple Sequential Runs:** New `--runs N` flag runs the full benchmark N times back-to-back (each subsequent run uses force mode). GUI has "Sequential Runs" input.

**SSE Reconnection:** Browser tab switching no longer loses benchmark progress. Client auto-reconnects after 2 seconds.

**Combined View Deduplication:** Set-level and global summaries use `ROW_NUMBER()` CTE to keep only the latest result per theorem+model, preventing double-counting.

**Run Count Display:** Model scorecards now show how many runs exist for each model.

**Hardest Theorems:** Display limit increased from 15 to 30.

**Continue Incomplete Run:** New `--continue-run <id>` CLI flag and GUI feature to resume interrupted runs. Loads the original run's settings (model, theorem set, temperature, max tokens) from the DB and only processes theorems that don't already have results in that specific run. GUI provides a toggle with a dropdown of incomplete runs, auto-filling settings as read-only and allowing only the workers count to be changed.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Formula Notation](#formula-notation)
3. [Shared Types and Configuration (`config.ts`)](#shared-types-and-configuration-configts)
4. [Prompt Template Builder (`prompt.ts`)](#prompt-template-builder-promptts)
5. [LLM Output Parser (`parser.ts`)](#llm-output-parser-parserts)
6. [Benchmark Harness (`harness.ts`)](#benchmark-harness-harnessts)
7. [Model API Adapters (`models/`)](#model-api-adapters-models)
8. [Scorer (`scorer.ts`)](#scorer-scorerts)
9. [Logger (`logger.ts`)](#logger-loggerts)
10. [CLI Binary (`src/main.rs`)](#cli-binary-srcmainrs)

---

## Architecture Overview

```
prop-bench/
├── config.ts          # Shared TypeScript types and default parameters
├── prompt.ts          # Prompt template builder for LLM queries
├── parser.ts          # LLM output parser (text → structured proof)
├── harness.ts         # Benchmark orchestrator
├── scorer.ts          # Line counting + Elo ratings
├── logger.ts          # Structured JSON logging
├── models/            # Model API adapters (Gemini direct + OpenRouter)
│   ├── gemini.ts
│   └── openrouter.ts
├── src/
│   └── main.rs        # Rust CLI binary (generate + validate)
├── package.json       # TypeScript project config
├── tsconfig.json      # TypeScript compiler config
└── Cargo.toml         # Rust project config
```

**Data flow for a single benchmark run:**
```
Theorem (JSON)
    │
    ▼
buildPrompt(theorem)          ← prompt.ts
    │
    ▼
LLM API call                  ← harness.ts + models/*.ts
    │
    ▼
Raw text response
    │
    ▼
parseProof(rawOutput, theorem) ← parser.ts
    │
    ▼
toValidationJSON()             ← parser.ts
    │
    ▼
propbench validate --theorem ... --proof ...  ← src/main.rs (Rust CLI)
    │
    ▼
ProofResult { valid, line_count, errors }
    │
    ▼
Score + Log                    ← scorer.ts + logger.ts
```

---

## Formula Notation

PropBench uses two notation systems for formulas: **ASCII** (for LLM-facing output) and **logic notation** (for human display in the GUI).

### Dual Notation

| Operator | Prompt/JSON (LLM-facing) | Logic (GUI display) |
|----------|--------------------------|---------------------|
| AND | `.` | `·` |
| OR | `v` | `∨` |
| IMPLIES | `>` | `⊃` |
| BICONDITIONAL | `<>` | `≡` |
| NOT | `~` | `~` |
| CONTRADICTION | `#` | `⊥` |

**Why two notations?** The prompt-style symbols (`.`, `v`, `>`, `<>`, `#`) are used consistently in both the LLM prompt (`prompt.ts`) and the theorem JSON files, so the LLM sees the same notation it was taught. The GUI converts to standard logic notation for human readability. The Rust parser accepts both notations, so LLM responses using either symbol set are valid.

### Alternating Bracket Hierarchy

All formulas in theorem JSON files use explicit bracketing with alternating bracket styles by nesting depth to eliminate ambiguity. Every binary subexpression that appears as an operand of another binary operator is wrapped — there is no reliance on implicit operator precedence.

Bracket styles cycle by depth from inside out:
- **Innermost**: `( )`
- **Next level**: `[ ]`
- **Outermost**: `{ }`
- Deeper nesting cycles back to `( )`, then `[ ]`, then `{ }`, etc.

**Rules:**
- Negation of atoms is NOT bracketed: `~P`, not `~(P)`
- Negation of compound formulas IS bracketed: `~(P & Q)`
- The outermost formula is NOT wrapped in brackets

**Example:**

```
ASCII (in JSON):   {[(~B | ~A) -> C] & A} -> C
GUI display:       {[(~B ∨ ~A) ⊃ C] · A} ⊃ C
```

This uses `ascii_string_bracketed()` on the Rust `Formula` type, which mirrors the Logic Proof Trainer app's `display_string()` approach (local bracket depth) but emits ASCII operators.

### GUI Display Conversion

The GUI converts ASCII formulas to logic notation via `renderFormula()` (defined in `TheoremList.tsx`, `TheoremDetail.tsx`, and `ProofViewer.tsx`). The replacement order matters — longer patterns are replaced first to avoid partial matches:

1. `_|_` → `⊥`
2. ` <-> ` → ` ≡ `
3. ` -> ` → ` ⊃ `
4. ` & ` → ` · `
5. ` | ` → ` ∨ `

A `toDisplayNotation()` utility is also exported from `gui/src/types.ts`.

---

## Shared Types and Configuration (`config.ts`)

Central type definitions and default parameters used by all other modules.

### Interfaces

**`Theorem`** — A theorem to be proved:
```typescript
interface Theorem {
  id: string;
  premises: string[];       // empty for tautologies (Medium+ difficulty)
  conclusion: string;       // formula string
  difficulty: Difficulty;
  difficulty_value: number;  // 1-100
  difficulty_spec?: DifficultySpec; // present for spec-generated theorems
}
```

**`Difficulty`** — Ten difficulty tiers (plus Custom for spec-generated):
```typescript
type Difficulty = "Baby" | "Easy" | "Medium" | "Hard" | "Expert" | "Nightmare"
  | "Marathon" | "Absurd" | "Cosmic" | "Mind" | "Custom";
```

| Tier | Value Range | Generation Method |
|------|-------------|-------------------|
| Baby | — | DifficultySpec (2 vars, 1 pass, 0 bridges) |
| Easy | 1-25 | Legacy (difficulty_value) |
| Medium | 26-45 | Legacy |
| Hard | 46-70 | Legacy |
| Expert | 71-85 | Legacy |
| Nightmare | 86-95 | Legacy |
| Marathon | 96-100 | Legacy |
| Absurd | — | DifficultySpec (6 vars, 5 passes, 1 bridge) |
| Cosmic | — | DifficultySpec (7 vars, 10 passes, 2 bridges) |
| Mind | — | DifficultySpec (7 vars, 20 passes, 2 bridges) |

**`DifficultySpec`** — Fine-grained control over theorem generation:
```typescript
interface DifficultySpec {
  variables: number;           // 2-20
  passes: number;              // 1-20
  transforms_per_pass: number; // 1-24
  base_complexity: "simple" | "complex";
  substitution_depth: number;  // 0-4
  bridge_atoms?: number;       // 0-5, cross-zone atom sharing
}
```

The DifficultySpec system replaces the single `difficulty_value` for advanced tiers (Absurd, Cosmic, Mind) and custom generation. Each field directly controls:
- **variables**: Number of propositional atoms (>5 uses the dynamic truth table engine)
- **passes**: Multi-pass pipeline — each pass wraps the formula as a new tautology and applies transforms
- **transforms_per_pass**: Random equivalence transformations per pass (each transform targets a single AST node via positional path replacement, so structurally-identical subtrees diverge independently)
- **base_complexity**: `simple` uses 7 standard argument forms; `complex` adds ConstructiveDilemmaFull, NestedCP, Chain4
- **substitution_depth**: Replaces simple atoms with complex sub-formulas (0 = none, 4 = deeply nested)
- **bridge_atoms**: Number of atoms shared across multiple substitution partition groups (0 = none, 1 for Nightmare/Marathon/Absurd, 2 for Cosmic/Mind). During theorem obfuscation, bridge atoms are placed into 2 randomly-chosen distinct partition groups instead of a single group, creating shared variables across zones that force integrated reasoning and prevent LLMs from decomposing theorems into independent sub-problems. Safe because uniform substitution preserves tautologies.

**`ProofLine`** — A single line in a structured proof:
```typescript
interface ProofLine {
  line_number: number;
  formula: string;
  justification: string;  // e.g. "Assumption (CP)", "MP 1,2", "CP 3-7"
  depth: number;           // subproof nesting depth (0 = top level)
}
```

**`ProofResult`** — Validation result from the Rust CLI:
```typescript
interface ProofResult {
  valid: boolean;
  line_count: number;
  errors: string[];
}
```

**`BenchmarkResult`** — Full result for one theorem + one model:
```typescript
interface BenchmarkResult {
  theorem_id: string;
  model: string;
  proof_lines: ProofLine[];
  result: ProofResult;
  raw_response: string;
  raw_prompt: string;
  parse_errors: string[];
  timestamp: string;      // ISO 8601
  latency_ms: number;
}
```

Note: this `config.ts` shape is retained for shared typing compatibility. The harness/runtime result object is documented in the [Benchmark Harness](#benchmark-harness-harnessts) section and is the one written to JSON/SQLite during benchmark runs.

**`BenchmarkSummary`** — Aggregate results for one model across all theorems:
```typescript
interface BenchmarkSummary {
  model: string;
  total_theorems: number;
  valid_proofs: number;
  invalid_proofs: number;
  parse_failures: number;
  total_lines: number;     // sum of line_count for valid proofs
  average_lines: number;
  results: BenchmarkResult[];
}
```

**`ModelConfig`** — Configuration for an LLM API:
```typescript
interface ModelConfig {
  name: string;
  provider: "gemini" | "openrouter";
  model_id: string;
  api_key_env: string;    // environment variable name
  temperature: number;
  max_tokens: number;
  maxThinkingTokens?: number;  // thinking token budget (optional, default: 10000)
}
```

**`DifficultyDistribution`** — Theorem count per difficulty tier:
```typescript
interface DifficultyDistribution {
  easy: number;       // difficulty 1-25
  medium: number;     // difficulty 26-45
  hard: number;       // difficulty 46-70
  expert: number;     // difficulty 71-85
  nightmare: number;  // difficulty 86-100
}
```

**`ParsedLine`** — A parsed proof line with the original raw text retained:
```typescript
interface ParsedLine {
  line_number: number;
  formula: string;
  justification: string;
  depth: number;
  raw: string;           // original unparsed line
}
```

**`ParseResult`** — Complete parser output:
```typescript
interface ParseResult {
  lines: ParsedLine[];
  errors: ParseError[];
  unparsed_sections: string[];
}
```

**`ParseError`** — A line that could not be parsed:
```typescript
interface ParseError {
  line_number: number | null;  // null if line number could not be determined
  raw: string;
  message: string;
}
```

### Default Parameters

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_DISTRIBUTION` | `{ easy: 30, medium: 30, hard: 20, expert: 15, nightmare: 5 }` | 100-theorem benchmark distribution |
| `DEFAULT_TOTAL_THEOREMS` | `100` | Total theorems in v1 benchmark |
| `DEFAULT_MODEL_CONFIGS` | Gemini 2.5 Flash Lite (temp 0.2, 4096 tokens) | Initial model to test |

### Helper Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `difficultyFromValue` | `(value: number) => Difficulty` | Maps a 1-100 difficulty value to a Difficulty tier |
| `difficultyRange` | `(difficulty: Difficulty) => { min, max }` | Returns the value range for a Difficulty tier |

---

## Prompt Template Builder (`prompt.ts`)

Builds a complete LLM prompt containing the theorem, all rules, and strict output format requirements. The prompt is now tautology-only — all premise-related code has been removed.

### Function Signature

```typescript
function buildPrompt(theorem: Theorem): string
```

### Prompt Structure

Every prompt follows this fixed structure:

1. **System instruction** — Role assignment ("formal logic proof assistant") and the directive to minimize proof lines. Says "Given a theorem" (not "Given a tautology").
2. **Symbol reference** — ASCII symbols for all connectives (`>`, `v`, `.`, `~`, `≡`, `⊥`)
3. **Inference rules** — All 9 valid argument forms with number, name, abbreviation, and pattern
4. **Equivalence rules** — All 10 replacement rules with bidirectional equivalences
5. **Proof techniques** — CP and IP with step-by-step procedure
6. **Output format** — Exact line format specification
7. **Worked example** — Single tautology example with nested CP (no premise-based examples)
8. **Theorem section** — The specific theorem to prove
9. **Closing instruction** — "Output ONLY the numbered proof lines"

### Rules Included

**9 Inference Rules:**

| # | Name | Abbrev | Pattern |
|---|------|--------|---------|
| 1 | Modus Ponens | MP | p > q, p therefore q |
| 2 | Modus Tollens | MT | p > q, ~q therefore ~p |
| 3 | Disjunctive Syllogism | DS | p v q, ~p therefore q |
| 4 | Simplification | Simp | p . q therefore p (or q) |
| 5 | Conjunction | Conj | p, q therefore p . q |
| 6 | Hypothetical Syllogism | HS | p > q, q > r therefore p > r |
| 7 | Addition | Add | p therefore p v q |
| 8 | Constructive Dilemma | CD | p v q, p > r, q > s therefore r v s |
| 9 | Negation Elimination | NegE | p, ~p therefore contradiction |

**10 Equivalence Rules:**

| # | Name | Abbrev |
|---|------|--------|
| 10 | Double Negation | DN |
| 11 | DeMorgan's | DeM |
| 12 | Commutation | Comm |
| 13 | Association | Assoc |
| 14 | Distribution | Dist |
| 15 | Contraposition | Contra |
| 16 | Implication | Impl |
| 17 | Exportation | Exp |
| 18 | Tautology | Taut |
| 19 | Equivalence | Equiv |

**2 Proof Techniques:** Conditional Proof (CP), Indirect Proof (IP)

### Theorem Format

The prompt is now tautology-only. The `buildPrompt()` function has been simplified to a single code path with no branching for premises vs. tautologies. All helper functions like `formatTheoremWithPremises()` and `formatTautology()` have been removed.

The prompt instructs the model to use CP and/or IP to derive the theorem, since there are no premises to start from:

```
Prove the following theorem:
  (P > Q) v (Q > P)

Since there are no premises, you will need to use Conditional Proof (CP)
and/or Indirect Proof (IP) to derive the formula.
```

### Output Format Specification

The prompt specifies the exact format models should use:

```
N. FORMULA JUSTIFICATION
```

Where JUSTIFICATION is one of:
- `Assumption (CP)` or `Assumption (IP)` — opens a subproof
- `RULE LINE_NUMBERS` — e.g. `MP 1,2` or `Simp 3` or `DeM 5`
- `CP START-END` or `IP START-END` — closes a subproof (e.g. `CP 3-7`)

**Note:** The "Premise" justification type has been removed from the output format specification, since the prompt is now tautology-only.

### Worked Example

The prompt includes a single worked example showing a tautology proof with nested CP. The old "with premises" example has been removed.

### Design Decisions

- **ASCII symbols preferred**: The prompt and theorem JSON files use ASCII symbols (`&`, `|`, `->`, `<->`) rather than Unicode (`⊃`, `∨`, `·`, `≡`) to reduce the chance of models producing unusual Unicode variants. The Rust parser accepts both. The GUI converts to logic notation for human display (see [Formula Notation](#formula-notation)).
- **Minimization instruction**: Appears twice (opening system instruction and output format section) to reinforce the efficiency objective.
- **Single worked example**: The prompt includes one tautology example with nested CP to illustrate proper formatting and proof technique usage.
- **Fixed structure**: The rule reference is identical for every theorem. Only the theorem section varies. This ensures consistent prompting across the benchmark.

---

## LLM Output Parser (`parser.ts`)

Parses raw LLM text output into structured `ParsedLine[]` for validation by the Rust CLI. This is the most complex module because LLMs produce highly variable output formats.

### Function Signatures

```typescript
function parseProof(rawOutput: string, theorem: Theorem): ParseResult
function toValidationJSON(theorem: Theorem, parsed: ParseResult): string
```

### Parsing Pipeline

Each line goes through this pipeline:

```
Raw line from LLM
    │
    ▼
1. Skip if empty or commentary (isCommentary)
    │
    ▼
2. Strip subproof markers (|, │)
    │
    ▼
3. Measure indentation depth
    │
    ▼
4. Strip line number prefix
    │
    ▼
5. Check if it looks like proof content (looksLikeProofLine)
    │
    ▼
6. Parse formula + justification (parseJustification)
    │
    ▼
7. Normalize formula symbols (normalizeFormula)
    │
    ▼
8. Emit ParsedLine or ParseError
```

### Line Number Stripping

The parser recognizes 7 line number formats via ordered regex patterns:

| Format | Example | Regex |
|--------|---------|-------|
| Parenthesized | `(1)` | `/^\((\d+)\)\s*/` |
| Hash prefix | `#1.` or `#1)` or `#1:` | `/^#(\d+)[.):]\s*/` |
| Step prefix | `Step 1:` or `Step 1.` | `/^Step\s+(\d+)[.:]\s*/i` |
| Line prefix | `Line 1:` or `Line 1.` | `/^Line\s+(\d+)[.:]\s*/i` |
| Paren suffix | `1)` | `/^(\d+)\)\s*/` |
| Dot suffix | `1.` | `/^(\d+)\.\s*/` |
| Colon suffix | `1:` | `/^(\d+):\s*/` |

Patterns are tried in this order; the first match wins. If no line number is found, the parser assigns one automatically based on sequential counting (`autoLineNumber`).

### Subproof Depth Detection

Depth is determined by three methods, with explicit markers and CP/IP annotations taking priority over indentation:

**Method 1 — Vertical bar markers** (`|` or `│`):
The parser counts and strips leading vertical bar characters. Each bar increments the depth by 1. This handles Fitch-style notation where subproofs are marked with vertical lines.

**Method 2 — DW-1 Depth Reconstruction from CP/IP Justifications**:
For models that output flat (non-indented) proofs with correct CP/IP annotations, the parser reconstructs subproof depth by tracking justifications:
- `Assumption (CP)` or `Assumption (IP)` opens a new subproof (increments depth)
- `CP N-M` or `IP N-M` closes the most recent subproof (decrements depth)
- This allows correct parsing of flat proofs like those from DeepSeek-R1, which don't use indentation but do provide proper justification ranges

**Method 3 — Indentation**:
The parser measures leading whitespace (tabs count as 2 spaces). On a pre-scan pass, it detects:
- `baseIndent`: indentation of the first numbered line (subtracted from all measurements)
- `indentUnit`: minimum non-zero indentation difference between any two lines

Depth is computed as: `Math.round((indent - baseIndent) / indentUnit)`

Priority: DW-1 depth reconstruction > vertical bar markers > indentation.

### Rule Alias Mapping

The parser maps 80+ rule name variations to canonical names via three lookup tables. All lookups are case-insensitive.

**Multi-word Rule Name Matching:** The parser handles full rule names like "Negation Elimination 6, 7" or "Modus Ponens 1,3". It tries 3-word matches first, then 2-word, then 1-word to correctly identify rule names before splitting formula from justification.

**Dot-tolerant Rule Lookup:** The `canonicalizeRule()` function strips trailing dots from rule names before lookup, so `M.P.`, `D.S.`, `Simp.` are all recognized correctly.

**Inference Aliases (28 entries):**

| Canonical | Aliases |
|-----------|---------|
| MP | mp, modus ponens, modusponens, modus, ponens |
| MT | mt, modus tollens, modustollens, tollens |
| DS | ds, disjunctive syllogism, disjunctivesyllogism, disj, disjsyl |
| Simp | simp, simplification, simple |
| Conj | conj, conjunction, and |
| HS | hs, hypothetical syllogism, hypotheticalsyllogism, hyp, hypo, syl |
| Add | add, addition, or |
| CD | cd, constructive dilemma, constructivedilemma, dil, dilemma |
| NegE | nege, negation elimination, negationelimination, neg elim, contradiction, bottom intro |

**Equivalence Aliases (32 entries):**

| Canonical | Aliases |
|-----------|---------|
| DN | dn, double negation, doublenegation, double neg |
| DeM | dem, demorgan, de morgan, demorgans, de morgan's, morgan, dm |
| Comm | comm, commutation, com, commute |
| Assoc | assoc, association, associate |
| Dist | dist, distribution, distrib, distribute |
| Contra | contra, contraposition, contrap, contrapositive, trans, transposition |
| Impl | impl, implication, imp, material implication |
| Exp | exp, exportation, export |
| Taut | taut, tautology |
| Equiv | equiv, equivalence, eq, bicon, biconditional, material equivalence |

**Technique Aliases (16 entries):**

| Canonical | Aliases |
|-----------|---------|
| CP | cp, conditional proof, conditionalproof, conditional, cond |
| IP | ip, indirect proof, indirectproof, indirect, raa, reductio ad absurdum, reductio, ~i, ni, negintro, negation introduction |

The `canonicalizeRule(name)` function returns `{ canonical, kind }` where kind is `"inference"`, `"equivalence"`, or `"technique"`, or `null` if unrecognized. Technique aliases are checked first (highest priority), then inference, then equivalence.

### Symbol Normalization

The `normalizeFormula(formula)` function converts symbol variations to ASCII forms accepted by the Rust parser:

| Category | Input Variants | Normalized To |
|----------|---------------|---------------|
| Conditional | `→`, `⊃`, `=>`, `->` | `>` |
| Disjunction | `∨`, `\|\|` | `v` |
| Conjunction | `·`, `∧` (U+2227), `&&` | `.` |
| Negation | `¬`, `−` (em-dash) | `~` |
| Biconditional | `≡`, `↔`, `<=>`, `<->` | `<>` |
| Contradiction | `⊥`, `_\|_` | `#` |
| Whitespace | multiple spaces/tabs | single space |

### Justification Parsing

The `parseJustification(text)` function splits a line (after line number stripping) into formula + justification. It tries patterns in this priority order:

1. **Premise** — Matches `FORMULA Premise` (case-insensitive)
2. **Assumption** — Matches `FORMULA Assumption (CP)`, `FORMULA Assume (IP)`, `FORMULA Ass. CP`, etc. Technique name is canonicalized.
3. **Subproof close** — Matches `FORMULA CP 3-7` or `FORMULA IP 4-9` (en-dash also accepted)
4. **Rule + lines (rule first)** — Matches `FORMULA RULE N,N,N` where RULE is a known inference/equivalence rule (using known-rule-name matching)
5. **Rule + lines (lines first)** — Matches `FORMULA N,N RULE` (alternate ordering)
6. **Single line reference** — Matches `FORMULA RULE N` (common for equivalence rules)

**v2.5 Parser Fix:** The parser now uses `canonicalizeRule()` to identify known rule names before attempting to split formula from justification. This fixes a critical bug where formulas containing dots or spaces (e.g., `P . Q`) were incorrectly parsed when using greedy regex patterns. The new approach:
- First checks if any known rule name appears in the line
- Splits at the known rule boundary
- Prevents ambiguous splitting between formula and justification

All justifications are output in canonical form:
- `"Premise"`
- `"Assumption (CP)"` or `"Assumption (IP)"`
- `"MP 1,2"` or `"Simp 3"` (comma-separated, no spaces)
- `"CP 3-7"` or `"IP 4-9"` (hyphen-separated)

### Commentary Filtering

The `isCommentary(line)` function detects and skips common LLM preamble/postscript patterns:

| Pattern | Examples |
|---------|----------|
| Proof labels | `Proof:`, `Here is the proof`, `Here's my proof` |
| Planning text | `Let me`, `I will`, `I'll`, `We need`, `We can` |
| Annotations | `Note:`, `Note that`, `Explanation` |
| Conclusions | `Therefore`, `Thus`, `QED` |
| End markers | Tombstone symbol, `//`, `/*`, triple backticks |
| Dividers | Em-dashes, horizontal rules (`---`) |
| Commentary starters | `--`, `wait`, `let's`, `this is`, `let me`, `now`, `next`, `first`, `then`, `so`, `since`, `because`, `using`, `applying`, `from`, `to`, `by`, `finally`, `we should`, `we must`, `to prove` |

**Aggressive Trailing Commentary Stripping:** Before parsing each line, the parser:
- Strips `-- ...` style inline comments
- Loops to remove ALL trailing `(...)` groups (not just the last one), handling models that add multiple layers of parenthetical commentary

Lines that fail commentary detection are further checked by `looksLikeProofLine()`, which returns true if the line contains logical symbols, known rule names, or single uppercase letters (atom names).

### Validation JSON Output

The `toValidationJSON(theorem, parsed)` function produces a JSON string suitable for piping to the Rust CLI's `propbench validate` command:

```json
{
  "theorem": {
    "id": "theorem-001",
    "premises": ["P > Q", "P"],
    "conclusion": "Q",
    "difficulty": "Easy",
    "difficulty_value": 15
  },
  "proof": [
    {
      "line_number": 1,
      "formula": "P > Q",
      "justification": "Premise",
      "depth": 0
    },
    {
      "line_number": 2,
      "formula": "P",
      "justification": "Premise",
      "depth": 0
    },
    {
      "line_number": 3,
      "formula": "Q",
      "justification": "MP 1,2",
      "depth": 0
    }
  ]
}
```

### Edge Cases Handled

- **No line numbers**: If the LLM omits line numbers entirely, the parser assigns sequential numbers starting from 1.
- **Mixed formats**: Line numbers in different formats across the same proof (e.g., `1.` then `(2)` then `Step 3:`) are all handled.
- **Trailing commentary**: Commentary lines after the proof block are skipped without generating errors.
- **Variable indentation**: The parser auto-detects the indentation unit from the minimum non-zero indent difference rather than assuming a fixed 2-space unit.
- **En-dash in ranges**: `CP 3–7` (en-dash) is accepted alongside `CP 3-7` (hyphen).
- **Assumption variants**: `Assumption (CP)`, `Assume (CP)`, `Ass. CP`, and `Assume CP` are all recognized.
- **Rule ordering flexibility**: Both `FORMULA RULE LINES` and `FORMULA LINES RULE` orderings are accepted for rule applications.

---

## Benchmark Harness (`harness.ts`)

Main orchestrator that drives the entire benchmark. Iterates over theorems and models, coordinates the prompt-build / API-call / parse / validate / log pipeline, and supports resuming interrupted runs.

### CLI Interface

```bash
npx ts-node harness.ts --theorems <path> --models <list> [options]
```

**Required arguments:**

| Argument | Description |
|----------|-------------|
| `--theorems <path>` | Path to the theorems JSON file (e.g., `benchmarks/v1/theorems.json`) |
| `--models <list>` | Comma-separated model adapter names (e.g., `gemini,claude,gpt`) |

**Optional arguments:**

| Argument | Default | Description |
|----------|---------|-------------|
| `--output <dir>` | `results/` | Output directory for results and summary |
| `--start <n>` | `0` | Start at theorem index n (0-based) |
| `--count <n>` | all | Process only n theorems from the start index |
| `--propbench-bin <path>` | `propbench` | Path to the Rust CLI binary for validation |
| `--workers <n>` | `1` | Number of parallel API workers (concurrent theorem processing) |
| `--temperature <n>` | `0.2` | Temperature parameter passed to all models |
| `--max-tokens <n>` | `4096` | Max output tokens, tier-capped per difficulty (Baby/Easy=1024, Med/Hard=2048, Expert=4096, Mind=8192) |
| `--no-tier-budgets` | off | Disable tier-based output token budgets (use flat `--max-tokens` for all tiers) |
| `--tier-budgets <json>` | built-in defaults | Custom per-tier token budgets as JSON (e.g. `'{"baby":2048,"mind":8192}'`) |
| `--max-thinking-tokens <n>` | `10000` | Maximum thinking tokens for reasoning models (1000-128000) |
| `--force` | off | Force new run — don't skip completed theorems |
| `--runs <n>` | `1` | Run the full benchmark N times back-to-back (each subsequent run uses force mode) |
| `--no-retry-parse` | off | Don't retry parse errors — treat unparseable model output as a final result |
| `--continue-run <id>` | — | Continue an incomplete run by its DB run ID |

### Core Loop

For each theorem in the selected range, for each model adapter:

```
1. buildPrompt(theorem)          → prompt string
2. adapter.callModel(prompt)      → ModelResponse { raw_response, latency_ms, model, tokens_used }
3. parseModelResponse(raw_output) → ProofLine[] or parse error
4. validateProof(theorem, proof)  → { valid, line_count, errors } via Rust CLI subprocess
5. saveResult(result, outputDir)  → JSON file in output/<model>/raw/
```

Each step is wrapped in try/catch. If any step fails, the error is captured in the `BenchmarkResult`, saved to disk, and the harness continues to the next theorem/model pair.

### Parallel Execution

The harness supports concurrent API calls via the `--workers N` flag (default: 1, sequential). When workers > 1:

- All non-skipped theorem/model pairs are collected into a flat work queue
- N worker coroutines pull items from the queue concurrently
- Each worker independently builds prompts, calls the API, parses responses, and validates proofs
- Results are saved immediately as each worker completes a theorem
- Progress output remains compatible with the GUI's SSE parser
- Resume support is unaffected: already-completed pairs are filtered out before the work queue is built

This is safe because JavaScript is single-threaded — counter increments and array index advances are atomic. File writes use unique filenames (including timestamps) so concurrent saves don't conflict.

### Resume Support and Run Tracking

**Run resumption:** When `--force` is NOT set, the harness reuses the most recent existing run_id for the same set+model combo via `findOrCreateRun()`. Results accumulate under the same run. This means:
- Interrupted runs can be resumed with the same command
- Error results (API 429s, parse failures) are automatically retried on re-run without manual intervention
- To re-run a specific theorem/model pair, delete its result file from `output/<model>/raw/`
- The `--start` and `--count` flags work independently of resume state
- Use `--force` to bypass resume entirely and re-run all theorem/model pairs (useful for "best of N" analysis)

**Run completion tracking:** Runs are now dynamically classified as "Running", "Finished", or "Incomplete" based on whether result count matches theorem count. Incomplete runs are excluded from the combined/aggregate view (scorecards, Elo, head-to-head). Only models with at least one complete run appear in the combined view.

**Multiple sequential runs:** New `--runs N` flag runs the full benchmark N times back-to-back. Each subsequent run uses force mode.

**Continue incomplete runs:** The `--continue-run <id>` flag resumes a specific incomplete run by its database run ID. When set:
- Skips the sequential runs loop (only does 1 run)
- Uses the provided run ID directly (no `createRun`/`findOrCreateRun`)
- Resets `finished_at` to NULL so the run shows as "Running" during execution
- Loads completed theorems via `getRunCompletedTheorems()` and skips them
- At completion, marks the run as finished via `finishRun()`
- The GUI provides a "Continue incomplete run" toggle with a dropdown of incomplete runs

### Tier-Based Output Token Budgets

The harness automatically caps output tokens based on theorem difficulty. Analysis of 900+ cutoff responses showed that 0/900 produced valid proofs and more tokens universally correlate with worse outcomes (spiraling). Valid proofs are compact: ~1,400-1,750 output tokens for Gemini models.

| Difficulty | Max Output Tokens |
|-----------|------------------|
| Baby, Easy | 1,024 |
| Medium, Hard | 2,048 |
| Expert | 4,096 |
| Nightmare, Marathon | 6,144 |
| Absurd, Cosmic, Mind | 8,192 |

The `--max-tokens` flag sets the upper bound. For each theorem, the actual budget is `min(--max-tokens, tier ceiling)`. The effective budget is logged with each API call.

Tier budgets can be customized via `--tier-budgets <json>` or disabled entirely with `--no-tier-budgets`. The GUI provides a toggle and editable per-tier table (values saved to localStorage).

### Spiral Detection

After each API response, the harness checks for repeated proof lines (5+ occurrences, consecutive or distributed). This detects "death spiral" mode where models repeat identical invalid steps hundreds of times. When detected, a `SPIRAL DETECTED` warning is logged with the repeated line and count.

### Environment Configuration

**v2.5 dotenv support:** The harness now loads environment variables from a `.env` file in the prop-bench root directory using the `dotenv` package with `override: true`. This allows API keys to be stored in `.env` instead of shell environment:

```bash
# prop-bench/.env
GEMINI_API_KEY=your-key-here
OPENROUTER_API_KEY=your-key-here
```

The harness loads these at startup before any model adapters are instantiated.

### Dynamic Module Loading

The harness loads `prompt.ts` and `parser.ts` via runtime `require()` calls (`"./prompt"` and `"./parser"`). This keeps compatibility with the ts-node CommonJS execution path used by both CLI runs and the GUI server subprocess launcher.

### Result Storage

Each result is saved as an individual JSON file in `<output>/<model>/raw/` with the naming pattern:

```
<theorem_id>_<model>_<timestamp_ms>.json
```

**`BenchmarkResult` structure:**

```typescript
interface BenchmarkResult {
  theorem_id: string;
  model: string;             // adapter name (e.g., "gemini")
  model_name: string;        // actual model ID (e.g., "gemini-2.5-flash-lite-preview-09-2025")
  raw_response: string;      // full LLM output
  parsed_proof: ProofLine[] | null;
  parse_error: string | null;
  validation_result: "valid" | "invalid" | "error";
  validation_errors: string[];
  line_count: number | null;  // proof length (only if valid)
  latency_ms: number;
  tokens_used: number | undefined;
  timestamp: string;          // ISO 8601
}
```

Per-model summaries/reports are written to:
- `<output>/<model>/summary.json`
- `<output>/<model>/report.json` (written by harness for CLI use; GUI server recomputes reports instead of serving this file)

A combined cross-model summary/report is also written to:
- `<output>/summary.json`
- `<output>/report.json` (written by harness for CLI use; GUI server recomputes reports instead of serving this file)

### Validation via CLI

The harness invokes the Rust CLI binary as a subprocess:

```bash
propbench validate --theorem <theorem_json> --proof <proof_json>
```

- The theorem and proof are written to temporary JSON files and passed via `--theorem <path> --proof <path>`
- Subprocess timeout: 30 seconds
- The harness parses the CLI's stdout as JSON `{ valid: boolean, line_count: number, errors: string[] }`
- Subprocess errors (missing binary, timeout, crash) are caught and recorded as validation errors

### Progress Reporting

The harness prints progress to stdout during execution:

```
=== PropBench Harness ===
Theorems: benchmarks/v1/theorems.json
Models:   gemini, claude

Loaded 100 theorems
Processing theorems 0 to 99 (100 total)
Found 0 already-completed results

[1/200] theorem-001 x gemini — running...
  -> VALID (5 lines, 1823ms)
[2/200] theorem-001 x anthropic — running...
  -> INVALID: Scope error on line 4 (cited line 2 not accessible)
[3/200] theorem-002 x gemini — SKIPPED (already done)
...

=== Summary ===
Run:     198
Skipped: 2
Valid:   142
Invalid: 38
Errors:  18
```

### Error Handling and Auto-Retry

The harness automatically retries errors within the same run — up to 10 attempts per theorem/model pair. Retries use exponential backoff (1s, 2s, 4s, ...) capped at 30 seconds. If all 10 attempts fail, the error is saved and the harness moves to the next theorem. The harness never aborts on individual theorem/model failures. Only fatal errors (missing theorems file, unknown model adapter) cause an exit.

#### Error Categories

There are two distinct error types, tracked separately in the GUI as `ep` (parse errors) and `ea` (API errors):

| Category | Label | What Happened | Example |
|----------|-------|---------------|---------|
| **API error** | `ea` | Model never responded — infrastructure failure | 429 rate limit, network timeout, auth failure |
| **Parse error** | `ep` | Model responded, but output couldn't be parsed into proof lines | Model wrote prose, used unknown rules, produced garbled output |
| **Invalid** | `i` | Model responded, proof was parsed, but the proof is logically wrong | Wrong rule application, scope errors, conclusion doesn't match |
| **Valid** | `v` | Model responded, proof was parsed and validated | Correct proof |

#### Retry Policy

**Parse Error Retry Limit:** Parse errors now retry up to **3 total attempts** (reduced from 10). This reduces wasted API calls for models that consistently produce unparseable output while still allowing a few retries for formatting variability.

**API Error Retry Limit:** API errors (network, rate limit, auth failures) still retry up to **10 attempts** since these are infrastructure issues unrelated to the model's capabilities.

> **BENCHMARK DESIGN NOTE:** By default, both API errors and parse errors are retried, but with different limits. Parse errors retry up to 3 attempts (since the model's output is non-deterministic and may format correctly on retry), while API errors retry up to 10 attempts (since these are infrastructure failures). This means **parse errors give the model a few more chances** — the model gets re-prompted and can produce a different response. However, this policy is debatable — an alternative view is that parse errors are the model's fault for not following the output format, and should count as a final result (like invalid proofs). The `--no-retry-parse` flag (and the corresponding GUI checkbox "Don't retry parse errors") switches to this stricter mode: parse errors are saved immediately as final results without retrying. This makes the benchmark less lenient toward models that produce unparseable output.

| Stage | Error Type | Default | With `--no-retry-parse` | Rationale |
|-------|-----------|---------|------------------------|-----------|
| Prompt build | Exception in `buildPrompt()` | No retry | No retry | Deterministic — would fail identically every time |
| API call | Network/auth/rate limit failure | **Retried (up to 10)** | **Retried (up to 10)** | Infrastructure issue, not the model's fault |
| Parse | Output couldn't be parsed | **Retried (up to 3)** | **No retry** | Configurable — see design note above |
| Validation | Proof invalid | No retry | No retry | This is a real result — the model tried and the proof is wrong |

#### Error Replacement

When a retry succeeds, the previous error result is automatically replaced (deleted from both the database and JSON files). This ensures each theorem/model pair has exactly one result — the final outcome, not intermediate failures.

---

## Model API Adapters (`models/`)

### Shared Interface (`models/index.ts`)

All model adapters implement the `ModelAdapter` interface:

```typescript
interface ModelAdapter {
  name: string;
  callModel(prompt: string, config: ModelConfig): Promise<ModelResponse>;
}
```

**`ModelConfig`** — Parameters for the API call:

```typescript
interface ModelConfig {
  model: string;          // model ID override (empty string uses adapter default)
  temperature?: number;   // default: 0.2
  maxTokens?: number;     // default: 4096
  apiKey?: string;        // override for env var
}
```

**`ModelResponse`** — Standardized response from any model:

```typescript
interface ModelResponse {
  raw_response: string;   // full text output
  latency_ms: number;     // round-trip time in milliseconds
  model: string;          // actual model ID used
  tokens_used?: number;   // total tokens (prompt + completion)
}
```

### Model Registry (`getModel`)

```typescript
function getModel(name: string): ModelAdapter
```

Routes model names to adapters using a dual-routing strategy:

1. **Known Gemini names** (e.g., `gemini-2.5-flash`, `gemini-3-pro-preview`) are matched against a `GEMINI_ALIASES` lookup table and routed to `GeminiAdapter` using the direct Gemini API.
2. **Everything else** (e.g., `anthropic/claude-sonnet-4.5`, `openai/gpt-4o`, `deepseek/deepseek-r1`) falls through to `OpenRouterAdapter`.

**Direct Gemini model identifiers:**

| Model Identifier | Adapter |
|------------------|---------|
| `gemini-2.0-flash` | `GeminiAdapter` |
| `gemini-2.5-pro` | `GeminiAdapter` |
| `gemini-2.5-flash` | `GeminiAdapter` |
| `gemini-2.5-flash-lite-preview-09-2025` | `GeminiAdapter` |
| `gemini-3-flash-preview` | `GeminiAdapter` |
| `gemini-3-pro-preview` | `GeminiAdapter` |

Any other model identifier is routed to `OpenRouterAdapter`. This means any model available on OpenRouter can be used without code changes.

Each call to `getModel()` creates a new adapter instance (factory pattern). Adapters are stateless and safe to reuse across multiple calls.

### Gemini Adapter (`models/gemini.ts`)

| Property | Value |
|----------|-------|
| SDK | `@google/genai` (v1.0.0) |
| API key env var | `GEMINI_API_KEY` |
| Default model | `gemini-2.5-flash-lite-preview-09-2025` |
| Adapter name | `"gemini"` |
| Constructor | `new GoogleGenAI({ apiKey })` |

**SDK Migration (v2.5):** Switched from the deprecated `@google/generative-ai` SDK to the new `@google/genai` SDK. Key changes:
- Constructor: `new GoogleGenAI({ apiKey })` instead of `new GoogleGenerativeAI(apiKey)`
- Package name changed in package.json
- Response format unchanged

**Token tracking:** Uses `response.usageMetadata` to report `promptTokenCount + candidatesTokenCount`. Thinking tokens are tracked separately via `thinkingTokens` field in response.

**Thinking token budget:** Configurable via `config.maxThinkingTokens` (default: 10000). Used to control extended reasoning time for complex theorems.

**Retry behavior:** Exponential backoff with jitter on rate-limit errors:
- Max retries: 5
- Base delay: 1000ms
- Delay formula: `1000 * 2^attempt + random(0, 10% of delay)`
- Rate-limit detection: Error message contains `429`, `rate`, `quota`, or `resource_exhausted` (case-insensitive)
- Non-rate-limit errors on the first attempt are thrown immediately
- Non-rate-limit errors on subsequent attempts (after a rate-limit retry) are also thrown immediately

### OpenRouter Adapter (`models/openrouter.ts`)

| Property | Value |
|----------|-------|
| SDK | `openai` (targeting OpenRouter API) |
| API key env var | `OPENROUTER_API_KEY` |
| Base URL | `https://openrouter.ai/api/v1` |
| Adapter name | The model identifier passed to constructor (e.g., `"anthropic/claude-sonnet-4.5"`) |
| Request timeout | 300,000ms (5 minutes, for thinking models) |

The OpenRouter adapter accepts any model identifier and routes it through the OpenRouter API. It maintains a `DISPLAY_NAMES` lookup table for well-known models (e.g., `"anthropic/claude-sonnet-4.5"` displays as `"Claude Sonnet 4.5"`, `"anthropic/claude-opus-4-6"` displays as `"Claude Opus 4.6"`); unknown models use the raw identifier as display name.

**Token tracking:** Uses `completion.usage.prompt_tokens + completion.usage.completion_tokens` (undefined if usage data is missing). Thinking tokens are tracked separately via `finish_reason` and returned thinking token count when available.

**Thinking token budget:** Configurable via `config.maxThinkingTokens` (default: 10000). When set, passes `reasoning: { max_tokens: N }` to the API for extended reasoning support.

**Maximum effort mode:** Always passes `verbosity: "max"` on every API call. For Claude Opus 4.6, this enables maximum effort (highest quality responses). For other models, falls back to "high" automatically.

**Opus 4.6 support:** Added to `DISPLAY_NAMES` and `MODEL_PRICING` with pricing of $5.00 input / $25.00 output per million tokens.

**Response extraction:** `completion.choices[0]?.message?.content ?? ""`.

**Retry behavior:** Exponential backoff with jitter on transient errors (5 retries, 1s base delay, 2x exponential, 10% jitter). Transient errors include `fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `503`, `502`. Rate-limit errors (`429`, `rate`, `quota`) are thrown immediately for the harness to handle.

### Design Decisions

- **Dual routing (Gemini direct + OpenRouter):** Gemini models use the direct Google AI API for lowest latency and best thinking token tracking. All other models route through OpenRouter, providing access to any model on their platform without adding per-provider adapters.
- **API key via env var with override:** Each adapter reads its API key from a well-known environment variable (`GEMINI_API_KEY` or `OPENROUTER_API_KEY`) but also accepts an override in `ModelConfig.apiKey`. This supports both standard usage (keys in env) and testing (keys passed programmatically).
- **Stateless adapters:** Adapters create a fresh SDK client on each `callModel()` invocation. This avoids connection pooling complexity and ensures clean state for benchmarking.
- **Consistent retry logic:** Both adapters use identical retry parameters (5 retries, 1s base delay, 2x exponential, 10% jitter). This ensures that rate-limit handling does not vary across providers and does not skew benchmark results.
- **Immediate throw for non-transient errors:** Authentication failures, invalid model names, and other non-transient errors are thrown immediately without retrying, to fail fast and provide clear error messages.
- **Factory-based registry:** `getModel()` returns a new instance each time, allowing the harness to use multiple instances of the same adapter concurrently if needed in future parallelization.
- **Max verbosity for OpenRouter:** Always passes `verbosity: "max"` to enable maximum effort mode for Claude Opus 4.6 and other models that support it. This ensures the highest quality responses for complex proofs.
- **Configurable thinking budgets:** Both adapters support `maxThinkingTokens` for adaptive reasoning time, allowing models to spend more tokens on difficult theorems while staying within cost constraints.

---

## Scorer (`scorer.ts`)

Tracks per-theorem, per-model results and produces aggregate statistics, Elo ratings, and formatted reports. The scorer is stateful: results are accumulated via `recordResult()` and a full report is generated on demand via `generateReport()`.

### Types

**`TheoremResult`** — Result of a single theorem attempt by a single model:
```typescript
interface TheoremResult {
  theoremId: string;
  valid: boolean;
  parseSuccess: boolean;
  lineCount: number | null;       // null if proof invalid or parse failed
  difficulty: DifficultyTier;
  difficultyValue: number;
  failureStage?: "api_call" | "parse" | "validation";
}
```

**`DifficultyTier`** — Lowercase tier names used internally by the scorer:
```typescript
type DifficultyTier = "easy" | "medium" | "hard" | "expert" | "nightmare" | "marathon";
```

**`ModelStats`** — Aggregate statistics for one model:
```typescript
interface ModelStats {
  model: string;
  totalLines: number;                    // sum of lineCount for valid proofs
  validCount: number;
  invalidCount: number;
  totalAttempted: number;
  avgLinesPerValidProof: number | null;  // null if no valid proofs
  linesByDifficulty: Record<DifficultyTier, { total: number; count: number; avg: number | null }>;
  eloRating: number;
}
```

**`HeadToHead`** — Record of a single pairwise comparison on one theorem:
```typescript
interface HeadToHead {
  theoremId: string;
  modelA: string;
  modelB: string;
  winner: string | "tie";
  modelALines: number | null;
  modelBLines: number | null;
}
```

**`BenchmarkReport`** — Full output of `generateReport()`:
```typescript
interface BenchmarkReport {
  timestamp: string;                                          // ISO 8601
  models: ModelStats[];                                       // one entry per model
  headToHead: HeadToHead[];                                   // all pairwise comparisons
  perTheorem: Record<string, Record<string, TheoremResult>>;  // theoremId -> model -> result
  rankings: {
    rank: number;
    model: string;
    eloRating: number;
    totalLines: number;
    validRate: string;   // e.g. "85.0%"
  }[];
}
```

### Scorer Class

```typescript
class Scorer {
  recordResult(theoremId: string, model: string, result: TheoremResult): void;
  generateReport(): BenchmarkReport;
  printSummary(report: BenchmarkReport): void;
}
```

**`recordResult(theoremId, model, result)`** — Stores a single theorem result. Can be called multiple times for the same theorem/model pair (the latest call overwrites). Internally uses nested `Map<string, Map<string, TheoremResult>>` keyed by theoremId then model name.

**`generateReport()`** — Computes all aggregate statistics, runs the Elo algorithm, generates head-to-head records, and returns a complete `BenchmarkReport`. Can be called at any time (does not consume the stored results).

**`printSummary(report)`** — Prints a human-readable table to stdout with two sections:

1. **Rankings table** — Models ranked by Elo rating, showing rank, model name, Elo, valid/total, success rate, total lines, and average lines per valid proof.
2. **Lines by difficulty tier** — For each model, shows the average line count and number of valid proofs at each difficulty tier.

Example output:
```
=== PropBench Results ===

Rankings:
#   Model                       Elo     Valid     Rate    Lines   Avg Lines
----------------------------------------------------------------------------
1   gemini-2.5-flash-lite       1532    85/100    85.0%   612     7.2
2   claude-sonnet-4.5           1468    78/100    78.0%   702     9.0

Lines by Difficulty Tier:
Model                       easy        medium      hard        expert      nightmare   marathon
------------------------------------------------------------------------------------------------
gemini-2.5-flash-lite       4.2 (30)    6.8 (28)    9.1 (17)    12.3 (8)    18.0 (2)    -
claude-sonnet-4.5           5.1 (28)    7.9 (25)    10.4 (15)   14.2 (7)    22.0 (3)    -
```

### Elo Rating System

The scorer implements standard Elo with the following parameters:

| Parameter | Value |
|-----------|-------|
| Initial rating | 1500 |
| K-factor | 32 |
| Expected score formula | `1 / (1 + 10^((Rb - Ra) / 400))` |
| Rating update | `Ra_new = round(Ra + K * (Sa - Ea))` |

**Head-to-head scoring per theorem:**

| Model A | Model B | Score A | Score B |
|---------|---------|---------|---------|
| Valid (fewer lines) | Valid (more lines) | 1.0 | 0.0 |
| Valid | Invalid/failed | 1.0 | 0.0 |
| Invalid/failed | Valid | 0.0 | 1.0 |
| Both valid, same lines | Both valid, same lines | 0.5 | 0.5 |
| Both invalid/failed | Both invalid/failed | **no-game** | **no-game** |

Elo updates are applied sequentially for each theorem, iterating over all unique model pairs. If a model did not attempt a given theorem, that pair is skipped for that theorem. **Both-failed matchups are now skipped (no-game) instead of counted as ties.** This prevents rating dilution when most models fail most theorems. Ratings are rounded to integers after each update.

### Aggregate Statistics

For each model, the scorer computes:

- **totalLines**: Sum of `lineCount` across all valid proofs
- **validCount / invalidCount**: Count of valid vs. invalid (or failed) attempts
- **totalAttempted**: Total theorems attempted by this model
- **avgLinesPerValidProof**: `totalLines / validCount` (null if validCount is 0)
- **linesByDifficulty**: For each of the 6 difficulty tiers, tracks `total` lines, `count` of valid proofs, and `avg` lines per valid proof at that tier

### Design Decisions

- **Mutable accumulator pattern**: The `Scorer` stores results incrementally rather than accepting a batch. This allows the harness to feed results one at a time as they arrive, supporting streaming and resume scenarios.
- **Sequential Elo updates**: Elo ratings are computed in a single pass over all theorems in insertion order. This means the final ratings can vary slightly depending on the order theorems are processed, which matches real Elo behavior in tournaments.
- **Round-robin pairwise**: Every unique model pair is compared on every theorem where both models have results. Models that skip theorems are not penalized in Elo (they simply have fewer comparisons).
- **Integer Elo**: Ratings are rounded to integers after each update for clean display. The rounding does not compound significantly over typical benchmark sizes (100-200 theorems).

---

## Logger (`logger.ts`)

Structured JSONL logging for benchmark runs. Every API call attempt is logged with full context including raw prompts, responses, parse results, validation results, and errors. Failures are logged with equal detail to successes.

### Types

**`LogEntry`** — A single logged attempt (one theorem, one model):
```typescript
interface LogEntry {
  // Theorem info
  theoremId: string;
  formula: string;
  difficulty: string;
  difficultyValue: number;

  // Model info
  model: string;
  modelParameters?: Record<string, unknown>;

  // Prompt and response
  rawPrompt: string;
  rawResponse: string | null;           // null if API call failed

  // Parse results
  parsedProof: unknown | null;          // structured proof object, null if parse failed
  parseErrors?: string[];

  // Validation results
  validationResult: boolean | null;     // null if not reached
  validationErrors?: string[];

  // Metrics
  lineCount: number | null;             // null if proof invalid or not parsed
  latencyMs: number;
  timestamp: string;                    // ISO 8601

  // Failure tracking
  failureStage?: "api_call" | "parse" | "validation";
  errorMessage?: string;
}
```

**`RunSummary`** — Running totals maintained alongside the JSONL log:
```typescript
interface RunSummary {
  model: string;
  runTimestamp: string;
  totalTheorems: number;
  validProofs: number;
  invalidProofs: number;
  parseFailures: number;
  apiFailures: number;
  totalLines: number;
  avgLinesPerValidProof: number | null;
  avgLatencyMs: number;
  logFile: string;                      // filename of the JSONL log
}
```

**`Logger`** — Logger instance interface:
```typescript
interface Logger {
  logAttempt(entry: LogEntry): void;
  flush(): void;
  getSummary(): RunSummary;
}
```

### Factory Function

```typescript
function createLogger(outputDir: string, modelName: string): Logger
```

Creates a logger that writes to:
- **Log file**: `{outputDir}/{model-name}/run-{timestamp}.jsonl`
- **Summary file**: `{outputDir}/{model-name}/latest-summary.json`

The `model-name` directory component is sanitized: any character not matching `[a-zA-Z0-9._-]` is replaced with `_`. The timestamp in the filename uses ISO 8601 format with colons and dots replaced by hyphens (e.g., `2026-02-05T23-04-12-345Z`).

The output directory is created recursively on logger construction (`fs.mkdirSync` with `recursive: true`).

### JSONL Format

Each line in the log file is a single JSON object (one `LogEntry` per line, no trailing commas, no array wrapper). This format:
- Supports append-only writes (no need to read/modify existing data)
- Allows streaming processing with tools like `jq`
- Survives partial writes (each line is independently valid JSON)
- Is easy to parse line-by-line for analysis

Example:
```
{"theoremId":"t-001","formula":"P > Q","difficulty":"easy","difficultyValue":15,...}
{"theoremId":"t-002","formula":"(P v Q) > (Q v P)","difficulty":"medium","difficultyValue":30,...}
```

### Buffered Writes

The logger buffers entries in memory and flushes to disk in batches:

| Parameter | Value |
|-----------|-------|
| Buffer size | 10 entries |
| Write method | `fs.appendFileSync` |
| Flush trigger | Buffer reaches 10 entries, or explicit `flush()` call |

On each flush, the logger also updates `latest-summary.json` with the current running totals. The harness should call `flush()` at the end of a run to ensure all entries are written.

### Failure Categorization

The logger categorizes each attempt based on the `failureStage` field:

| `failureStage` | Counted As | Description |
|----------------|-----------|-------------|
| `"api_call"` | `apiFailures` | Network error, auth failure, rate limit exhaustion |
| `"parse"` | `parseFailures` | LLM output could not be parsed into proof lines |
| `"validation"` | `invalidProofs` | Proof parsed but failed Rust validator checks |
| `undefined` + `validationResult === true` | `validProofs` | Successful proof, `lineCount` added to `totalLines` |
| `undefined` + `validationResult === false` | `invalidProofs` | Validation returned false without explicit stage |
| Any other state | `invalidProofs` | Fallback categorization |

### Summary File

The `latest-summary.json` file is overwritten on each flush with the current `RunSummary`. This provides a quick view of run progress without parsing the full JSONL log. It is always updated atomically (write the full file in one `fs.writeFileSync` call).

### `getSummary()`

Returns the current `RunSummary` object programmatically, without writing to disk. Useful for the harness to access running totals without reading the summary file.

### File Structure Example

After a run with two models:
```
results/
├── gemini/
│   ├── run-2026-02-05T23-04-12-345Z.jsonl    # 100 lines, one per theorem
│   └── latest-summary.json                    # aggregate stats
└── anthropic/
    ├── run-2026-02-05T23-04-12-345Z.jsonl
    └── latest-summary.json
```

### Design Decisions

- **JSONL over JSON arrays**: JSONL supports append-only writes and survives crashes mid-run. A JSON array would require reading the entire file to append, and a partial write would corrupt the array.
- **Buffered writes with explicit flush**: Batching reduces I/O overhead during fast theorem processing. The flush threshold of 10 balances write frequency against data loss risk on crash.
- **`unknown` type for `parsedProof`**: The logger is agnostic to the proof structure. It accepts whatever the parser produces, serializing it as-is. This avoids coupling the logger to parser types.
- **Sanitized filenames**: Model names like `claude-sonnet-4.5` or `gemini/2.0-flash` may contain characters invalid in filenames. The sanitizer replaces anything outside `[a-zA-Z0-9._-]` with underscores.
- **Summary updated on every flush**: The summary file always reflects the latest state, even during long runs. Monitoring tools can poll this file for progress updates.
- **Synchronous I/O**: The logger uses `fs.appendFileSync` and `fs.writeFileSync` for simplicity and to guarantee write ordering. The benchmark is I/O-bound on API calls, not on disk writes, so async I/O would add complexity without meaningful performance benefit.

---

## GUI (`gui/`)

PropBench includes a web-based GUI for running benchmarks, viewing results, and exploring theorems. The GUI consists of a React frontend (Vite) and an Express backend that spawns the harness as a subprocess.

### Architecture

```
gui/
├── src/                    # React frontend (Vite)
│   ├── pages/
│   │   ├── Dashboard.tsx       # Results viewer, Elo rankings
│   │   ├── TheoremExplorer.tsx # Browse theorems, compare models
│   │   └── BenchmarkRunner.tsx # Configure and run benchmarks
│   └── components/
│       ├── ProofViewer.tsx     # Fitch-style proof display
│       ├── TheoremDetail.tsx   # Theorem detail view
│       └── RunConfig.tsx       # Benchmark configuration form
└── server/                 # Express backend
    ├── index.ts            # Express server, loads .env
    ├── cli.ts              # Spawns harness subprocess
    └── routes/
        ├── benchmark.ts    # /api/benchmark/* (start/status/stop)
        ├── results.ts      # /api/runs/* (runs + stats + details + delete)
        ├── theoremSets.ts  # /api/theorem-sets/* (list, delete)
        ├── generate.ts     # /api/generate
        └── validate.ts     # /api/validate
```

### Backend (Express Server)

**Results Stats API (`server/routes/results.ts`):** The results route exposes:
- `GET /api/runs/stats/overview` — dashboard rollup (sets, totals, per-model summary)
- `GET /api/runs/stats/head-to-head/:setName` — pairwise win matrix
- `GET /api/runs/stats/latency/:setName` and `GET /api/runs/stats/latency` — latency/token statistics
- `GET /api/runs/stats/avg-lines-by-difficulty/:setName` and `GET /api/runs/stats/avg-lines-by-difficulty`
- `GET /api/runs/stats/failures/:setName` and `GET /api/runs/stats/failures`

These stats endpoints require SQLite availability and return `503` if `propbench.db` is unavailable.

### Frontend (React + Vite)

**Environment Loading (`server/index.ts`):** The server loads environment variables from `prop-bench/.env` using dotenv with `override: true` before starting. This ensures API keys are available to spawned harness processes.

**Harness Spawning (`server/cli.ts`):** The `spawnHarness()` function:
- Uses local `node_modules/.bin/ts-node` directly instead of `npx` to avoid resolution issues
- Explicitly reads `.env` and injects variables into the child process environment
- Pre-spawn validation: checks that theorems file, propbench binary, and harness entry point exist
- Returns a `ChildProcess` for the benchmark route to stream output

**SSE Streaming (`server/routes/benchmark.ts`):** The benchmark endpoint:
- Accepts POST requests with benchmark configuration
- Spawns the harness as a subprocess via `spawnHarness()`
- Parses harness stdout line-by-line into structured progress events
- Sends Server-Sent Events (SSE) to the frontend with progress updates
- Event types: `progress` (completed, total, validCount, invalidCount, parseErrorCount, apiErrorCount, skippedCount), `complete`, `error`
- Error events send `{type:"error", error:"..."}` (not `{type:"error", data:"..."}`)
- Includes detailed logging for debugging

**Results API (`server/routes/results.ts`):** Uses DB-first reads (`db.ts`) with filesystem fallback when DB is unavailable.

### Frontend (React + Vite)

**Dashboard (`pages/Dashboard.tsx`):**
- Main results viewer displaying Elo rankings, difficulty breakdowns, and model comparisons
- Multi-set support: dropdown selector for choosing benchmark theorem sets
- Auto-selects the theorem set that has the most recent benchmark run
- **Statistics sections:**
  - Elo Rankings Table — Models ranked by Elo rating, now includes run count per model
  - Difficulty Breakdown — Valid/invalid/error counts per model per difficulty tier
  - Elo Chart — Visual comparison of model ratings (fixed pixel-based bar heights to prevent flex shrinking)
  - Head-to-Head Wins Matrix — Pairwise win counts between models (excludes both-invalid matchups)
  - **Avg Proof Length by Difficulty** — Table showing average line count per model per difficulty tier (only valid proofs), with green highlighting for best (shortest) average per tier
  - Latency Comparison — API response time statistics
  - Failure Analysis — Parse errors, validation failures, API errors breakdown
- **Hardest Theorems** — Increased display limit from 15 to 30
- Fallback mode: supports manual JSON file upload when database unavailable

**Benchmark Runner (`pages/BenchmarkRunner.tsx`):**
- Fixed stale closure bug in SSE `onerror` handler using `useRef` for `isRunning` state
- Real-time progress tracking via SSE with auto-reconnection after tab switching (2-second reconnect delay)
- Displays validCount, invalidCount, parseErrorCount, apiErrorCount, skippedCount counters
- Progress bar and status messages
- Default max tokens changed from 4096 to 16384
- Numeric fields (max tokens, parallel workers, start index, max thinking tokens) use nullable types and can be fully cleared/emptied, showing placeholder text when empty instead of forcing a value
- "Sequential Runs" input field for running benchmarks N times back-to-back
- "Max thinking tokens" input field (1000-128000, default: 10000) for controlling thinking token budget on reasoning models

**Proof Viewer (`components/ProofViewer.tsx`):**
- Displays Fitch-style proofs with indentation and line numbers
- **v2.5 feature:** Added collapsible "Show Raw Model Response" section showing full model output
- **v2.5 feature:** Displays latency in milliseconds

**Theorem Detail (`components/TheoremDetail.tsx`):**
- **v2.5 feature:** Passes `rawResponse` and `latencyMs` to ProofViewer for display

**Run Config (`components/RunConfig.tsx`):**
- Model selection dropdown with `MODEL_OPTIONS` constant defining available models
- Maps full model identifiers to labels (e.g., `"gemini-2.5-flash-lite-preview-09-2025"` → label `Gemini 2.5 Flash Lite`)
- **Important:** When CLI model names/defaults change, this component must be updated per CLAUDE.md rules
- Includes a "Parallel Workers" field for configuring concurrent API calls
- "Sequential Runs" field for running benchmarks N times back-to-back
- "Max thinking tokens" field (1000-128000, default: 10000) for controlling thinking token budget on reasoning models
- "Force new run" checkbox: when enabled, passes `--force` to the harness to skip resume logic and run all theorems fresh
- "Don't retry parse errors" checkbox: when enabled, passes `--no-retry-parse` to the harness so unparseable model output is treated as a final result rather than retried (see [Retry Policy](#retry-policy) for design rationale)
- Numeric fields (max tokens, workers, start index, sequential runs, max thinking tokens) use nullable types (`number | null`) and can be fully cleared/emptied; placeholder text is shown when empty
- Auto-selects the theorem set that has the most recent benchmark run
- **Continue incomplete run:** Toggle to resume a previously interrupted run. When enabled, shows a dropdown of incomplete runs (fetched via `api.getIndividualRuns()`, filtered to `status === "Incomplete"`). Selecting a run displays its settings as read-only info (model, set, temperature, max tokens, progress) and disables all other config fields except workers. Start button text changes to "Continue Run".
- **OpenRouter preset auto-save:** Custom OpenRouter model identifiers typed into the text input are automatically saved to localStorage when a benchmark run starts. Saved models appear in the preset dropdown on subsequent visits, with built-in presets (Claude Opus 4.6, GPT-4o, Llama, DeepSeek, Mistral) always present.

**Avg Lines by Difficulty Table (`components/AvgLinesByDifficultyTable.tsx`):**
- Displays average proof line count per model per difficulty tier
- Data structure: models as rows, difficulty tiers (easy, medium, hard, expert, nightmare, marathon, absurd, cosmic, mind) as columns
- Each cell shows: average line count (1 decimal place) + count of valid proofs in parentheses
- Green highlighting (`color: var(--success)`) on the best (shortest) average per tier
- Empty cells displayed as `--` when no data available for that model/tier combination
- Tier ordering follows standard difficulty progression

**Generate Theorems (`components/GenerateTheorems.tsx`):**
- Modal for generating new theorem sets with three generation modes (distribution, tier preset, custom spec)
- **Distribution mode:** Supports all 9 difficulty tiers (Easy through Mind), allowing users to specify count for each tier
- **Default distribution:** All tier counts default to empty (0); total count field can be fully cleared/emptied and shows placeholder text when empty
- Distribution validation: Sum of all tier counts must equal the total count; displays sum status with color feedback (green if valid, red if invalid)
- Sum calculation: Uses `Object.values(dist).reduce((a, b) => a + b, 0)` to dynamically compute total from all tiers
- Distribution string builder: Dynamically constructs the distribution string from all tiers with count > 0 (e.g., `"20:easy,20:medium,20:hard,15:expert,10:nightmare,7:marathon,5:absurd,2:cosmic,1:mind"`)
- Modal interaction: Modal only closes via X button or Cancel button (clicking backdrop does not close)
- **Tier preset mode:** Generate all theorems using a single difficulty tier's preset spec
  - Loads tier configurations from `tier-presets.json` in the prop-bench root directory
  - GUI allows inline editing of preset parameters (variables, passes, transforms_per_pass, base_complexity, substitution_depth, bridge_atoms)
  - Changes can be saved back to the presets file via "Save Preset Changes" button
  - All 9 tiers have preset configurations including bridge_atoms values
- **Custom spec mode:** Full control over DifficultySpec parameters (variables, passes, transforms_per_pass, base_complexity, substitution_depth, bridge_atoms)

**Tier Presets Configuration (`tier-presets.json`):**
- JSON file in prop-bench root defining DifficultySpec for all 9 difficulty tiers
- Used by both CLI (via `server/cli.ts`) and GUI (via `GenerateTheorems.tsx`) for consistent generation
- Each tier includes all DifficultySpec fields: variables, passes, transforms_per_pass, base_complexity, substitution_depth, bridge_atoms
- Bridge atoms scaling: 0 for Easy-Expert, 1 for Nightmare/Marathon/Absurd, 2 for Cosmic/Mind
- Presets can be edited via the GUI's tier preset mode and changes persist to the file

**Theorem Explorer (`pages/TheoremExplorer.tsx`):**
- Browse and explore theorems in a selected theorem set
- Auto-selects the theorem set that has the most recent benchmark run
- **Delete theorem set:** Users can delete a theorem set via a delete button. A confirmation step prevents accidental deletion. Deleting a set removes it from both the database (cascading to all theorems, results, runs, and reports) and from disk.

**Theorem Set Picker (`components/TheoremSetPicker.tsx`):**
- Shared dropdown component used by Dashboard, Theorem Explorer, and Benchmark Runner for selecting a theorem set
- Auto-selects the theorem set with the most recent benchmark run on initial load
- Handles the case where a selected set is deleted by resetting to the new latest set

**Run Progress (`components/RunProgress.tsx`):**
- Displays real-time benchmark runner progress during a run
- Shows human-readable model display names instead of raw adapter slugs (e.g., "Gemini 2.5 Flash Lite" instead of "gemini")
- Uses a model display name mapping to translate CLI model identifiers to user-friendly labels
- Includes Claude Opus 4.6 in display name mappings

**Vite Proxy (`vite.config.ts`):**
- **v2.5 fix:** Added SSE buffering fix by setting `cache-control` and `x-accel-buffering` headers in proxy configuration
- Proxies `/api/*` requests to Express backend on port 3001

### GUI Running Instructions

```bash
# Development (runs both frontend and backend)
cd prop-bench/gui
npm install
npm run dev

# Backend only
npm run server

# Production build
npx vite build
```

The GUI requires the same `.env` file in `prop-bench/` root as the CLI harness.

### SQLite Storage Layer

PropBench uses SQLite (`propbench.db`) as the primary persistent storage layer for reports/rankings. The GUI server still supports filesystem fallback when the database is unavailable.

**Schema (4 tables):**
- `theorem_sets` — Benchmark theorem set metadata (name, path, theorem count)
- `theorems` — Individual theorems with premises, conclusion, difficulty tier, and difficulty value
- `results` — Model benchmark results (one row per theorem x model attempt, includes validation status, line count, latency, raw response)
- `reports_cache` — Exists for backward compatibility but is no longer used (reports are always recomputed to ensure current scorer code is applied)

**Concurrency:** The database uses WAL (Write-Ahead Logging) mode for safe concurrent reads and writes, allowing the GUI server to query results while the harness writes new ones.

**Dual-write approach:** The harness writes results to both JSON files (in `results/<set>/<model>/raw/`) and SQLite simultaneously. The GUI server queries SQLite when available and falls back to filesystem scanning if `propbench.db` is missing.

**Error result replacement:** When a new result is inserted for a theorem/model pair, any existing error results for that pair are automatically deleted (from both the database and JSON files). This ensures retried theorems replace their error records rather than accumulating duplicates. Valid and invalid results are never deleted — only errors.

**Report generation:** The GUI server always recomputes reports using the current scorer code rather than serving cached or pre-generated reports. This ensures that when the scorer changes (e.g., adding new difficulty tiers), reports immediately reflect the updated logic without requiring manual cache invalidation.

**Run completion tracking:** Run status is computed dynamically (no schema changes) by comparing each run's result count against the theorem count for its set. A run is "Running" if `finished_at IS NULL`, "Finished" if `finished_at IS NOT NULL` and result count equals the theorem count, or "Incomplete" if `finished_at IS NOT NULL` but result count is less than the theorem count. Incomplete runs are excluded from combined/aggregate views (set overview, dashboard overview, combined run detail for Elo ratings) but remain visible in the individual run detail view. This prevents partial runs from skewing aggregate statistics and Elo ratings.

**Migration:** Existing JSON results can be imported into the database via `npm run migrate`, which scans `benchmarks/` and `results/` directories. The migration is idempotent and safe to run multiple times.

**Query Functions (`db.ts`):**
- `getIndividualRuns(setName?)` — Returns individual run records with dynamically computed `status` field ("Running", "Finished", or "Incomplete"). Compares each run's result count against the theorem set's theorem count to determine completeness.
- `getSetOverview(setName)` — Per-set model summary statistics. Uses a `complete_runs` CTE to exclude results from incomplete runs in the combined view. Uses `ROW_NUMBER()` CTE to deduplicate results per theorem+model (keeps only latest result).
- `getDashboardOverview()` — Global dashboard statistics across all sets. Excludes results from incomplete runs in the model summaries. Uses `ROW_NUMBER()` CTE to deduplicate results per theorem+model.
- `getRunDetail(runId)` — When fetching combined results (no model slug), excludes results from incomplete runs. Individual model-level queries still show all results. Uses `ROW_NUMBER()` CTE to deduplicate results per theorem+model in the combined view.
- `getAvgLinesByDifficulty(setName?)` — Computes average proof line count per model per difficulty tier. Joins `results` with `theorems` to aggregate only valid proofs. Returns array of `{ model_slug, model_display, difficulty, avg_lines, count }`. Useful for analyzing which models produce shorter proofs at different difficulty levels.
- `deleteTheoremSet(setName)` — Deletes a theorem set and all associated data. Performs a cascading delete: removes all results, theorems, runs, and reports associated with the set from the database, then deletes the set's directory from disk. Returns success/failure status.
- `getHeadToHeadMatrix(setName?)` — Computes pairwise win matrix for head-to-head comparisons. **Skips both-invalid matchups** to prevent rating dilution.
- `findOrCreateRun(setName, modelSlug)` — Finds or creates a run for a given set+model combination. Returns existing run_id if found (for resuming), or creates a new run if none exists.
- `getRunSettings(runId)` — Returns `{ setName, modelSlug, temperature, maxTokens, setId }` for a given run ID. Used by the server to build harness opts when continuing an incomplete run.
- `getRunCompletedTheorems(runId)` — Returns `Set<string>` of theorem IDs that already have results in a specific run. Used by the harness to skip completed theorems when continuing.
- `resetRunFinished(runId)` — Resets `finished_at` to NULL for a run, so it shows as "Running" while being continued.

---

## CLI Binary (`src/main.rs`)

The Rust binary (`propbench`) provides the authoritative theorem generation and proof validation commands used by both CLI and GUI flows.

**Subcommands:**
- `generate` — Creates theorem sets as JSON (`BenchTheorem[]`)
- `validate` — Validates a proof JSON against a theorem JSON and emits:
  ```json
  { "valid": true|false, "line_count": <number>, "errors": ["..."] }
  ```

**Generate modes:**
- Distribution mode via `--difficulty-distribution` (or default distribution when omitted)
- Tier preset mode via `--tier <easy|...|mind>`
- Custom spec mode via `--variables --passes --transforms --base --substitution --bridge-atoms`

**Validation details:**
- Parses theorem/proof JSON inputs from file paths
- Replays proof lines with justification parsing (`Premise`, `Assumption`, `CP/IP`, inference/equivalence rules)
- Verifies each line with `ProofVerifier`
- Checks final completeness (closed scopes + conclusion at depth 0 + no invalid lines)

---

## Dependencies

### TypeScript (`package.json`)

**Runtime**:
- `@google/genai` ^1.0.0 (replaces deprecated `@google/generative-ai`)
- `dotenv` ^17.2.4 (for .env file support)
- `openai` ^4.77.0 (used by OpenRouter adapter)

**Dev**: typescript ^5.5.0, ts-node ^10.9.2, @types/node ^20.14.0

### Rust (`Cargo.toml`)

See `Cargo.toml` for Rust dependencies (shared with the existing Logic Proof Trainer backend).

---

## Building and Running

### TypeScript

```bash
cd prop-bench
npm install
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type-check without emitting
```

### Environment Setup

Create a `.env` file in the prop-bench root directory:

```bash
# prop-bench/.env
GEMINI_API_KEY=your-gemini-key-here
OPENROUTER_API_KEY=your-openrouter-key-here
```

The harness and GUI server will automatically load these environment variables on startup.

### Rust CLI

```bash
cd prop-bench
cargo build --release
# Binary at target/release/propbench
```

### Running a Benchmark

```bash
# 1. Generate theorem set
propbench generate --count 100 --difficulty-distribution "30:easy,40:medium,30:hard" --output theorems.json

# 2. Validate a single proof
propbench validate --theorem <theorem_json> --proof <proof_json>

# 3. Run harness (uses .env for API keys)
npx ts-node harness.ts --theorems theorems.json --models gemini
```
