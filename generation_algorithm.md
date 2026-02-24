# Theorem Generation Algorithm

This document explains in detail how PropBench generates theorems of arbitrary difficulty. The core insight: start with a trivially valid argument, then apply semantics-preserving transformations until the original structure is unrecognizable. The result is always provable, but finding the proof becomes arbitrarily hard.

**Validity is verified at every step.** The Rust code checks that the formula remains a tautology after wrapping, after each individual equivalence transformation, and after each pass. If a transformation were to somehow break validity (it shouldn't — equivalence rules preserve truth by definition), the result is discarded and another subformula is tried. This means it is mathematically impossible for the generator to produce an unprovable theorem.

All rule references (e.g., "rule 1", "rule 15") refer to `rules.md`.

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Stage 1: Base Form Selection](#stage-1-base-form-selection)
3. [Stage 2: Atom Substitution](#stage-2-atom-substitution)
4. [Stage 3: Wrap as Tautology](#stage-3-wrap-as-tautology)
5. [Stage 4: Equivalence Transformation Passes](#stage-4-equivalence-transformation-passes)
6. [Stage 5: Negation Simplification](#stage-5-negation-simplification)
7. [Configurable Parameters](#configurable-parameters)
8. [Difficulty Tier Presets](#difficulty-tier-presets)
9. [Safety Guards](#safety-guards)
10. [Worked Example](#worked-example)

---

## Pipeline Overview

The generation pipeline lives in `crates/logic-proof-trainer-lib/src/services/obfuscate_gen.rs`. The entry point is `run_spec_pipeline()`, which takes a `DifficultySpec` and produces a single tautological formula.

```
Input: DifficultySpec { variables, passes, transforms_per_pass, base_complexity,
                        substitution_depth, bridge_atoms, max_formula_nodes }

Stage 1: Pick a base argument form (one of rules 1-8, or a compound variant)
     ↓
Stage 2: Substitute atoms with compound formulas (if substitution_depth > 0)
     ↓
Stage 3: Wrap premises + conclusion into a single conditional tautology
     ↓
Stage 4: For each pass (1..passes):
            Apply transforms_per_pass random equivalence transformations
     ↓
Stage 5: Simplify excessive negations (collapse ~~~~P → ~~P → P)
     ↓
Output: A single tautological formula with no premises
```

The key invariant: **the formula is a tautology at every stage**. Equivalence transformations preserve truth tables by definition, so if the formula is a tautology before a transformation, it remains one after. This is verified by `debug_assert!` calls after every stage.

---

## Stage 1: Base Form Selection

The generator picks one of 10 hardcoded argument forms. These correspond to the inference rules (1-8) from `rules.md`, plus 3 compound forms that require multi-step proofs.

### Simple Forms (`base_complexity = "simple"`)

These 7 forms are the standard valid argument forms of inference:

| Form | Rule | Argument |
|------|------|----------|
| Modus Ponens | 1 (MP) | `p, p ⊃ q ⊢ q` |
| Modus Tollens | 2 (MT) | `p ⊃ q, ~q ⊢ ~p` |
| Disjunctive Syllogism | 3 (DS) | `p ∨ q, ~p ⊢ q` |
| Simplification | 4 (Simp) | `p · q ⊢ p` |
| Conjunction | 5 (Conj) | `p, q ⊢ p · q` |
| Hypothetical Syllogism | 6 (HS) | `p ⊃ q, q ⊃ r ⊢ p ⊃ r` |
| Constructive Dilemma | 8 (CD) | `p ∨ q, p ⊃ r, q ⊃ s ⊢ r ∨ s` |

### Complex Forms (`base_complexity = "complex"`)

When `base_complexity` is set to `"complex"`, the generator draws **only** from these 3 harder forms:

| Form | Argument | Why it's harder |
|------|----------|-----------------|
| Constructive Dilemma Full | `p ∨ q, p ⊃ r, q ⊃ r ⊢ r` | Forces case analysis (3 premises) |
| Nested CP | `p ⊃ (q ⊃ r), p, q ⊢ r` | Requires nested conditional unpacking |
| Chain4 | `p ⊃ q, q ⊃ r, r ⊃ s, p ⊢ s` | Requires 4 sequential modus ponens steps |

Complex forms exist because simple forms like Simplification (`p · q ⊢ p`) produce trivially short proofs even after heavy obfuscation. Complex forms impose a structurally harder proof skeleton before obfuscation begins.

### Atom Assignment

The first atoms from the pool are assigned to the base form's variables:
- `p` = 1st atom (e.g., P)
- `q` = 2nd atom (e.g., Q)
- `r` = 3rd atom if available (e.g., R)
- `s` = 4th atom if available (e.g., S)

Chain4 requires at least 4 atoms. NestedCP and ConstructiveDilemmaFull require at least 3. If there aren't enough atoms for a complex form, the generator falls back to standard forms.

### Selection Logic

The form is chosen **randomly** from the available pool (uniform distribution). The available pool depends on:
- `base_complexity`: `"simple"` uses the 7 standard forms; `"complex"` uses only the 3 complex forms
- Atom count: forms requiring more atoms than available are filtered out

---

## Stage 2: Atom Substitution

When `substitution_depth > 0`, each base atom (P, Q, R, ...) is replaced with a compound formula built from the remaining atoms in the pool. This is what makes the `variables` parameter matter beyond just the base form.

### Partitioning

1. **Identify base atoms**: collect all unique atoms used in the base form (e.g., {P, Q, R} for HS)
2. **Identify remaining atoms**: the atoms in the pool not used by the base form (e.g., if `variables = 5`, remaining = {S, T})
3. **Separate bridge atoms**: randomly select `bridge_atoms` count from the remaining pool. These will be shared across groups.
4. **Partition non-bridge atoms**: distribute the remaining atoms evenly across base atoms, one group per base atom. Each group also includes the base atom it replaces (so P's replacement formula still contains P).
5. **Add bridges**: each bridge atom is added to 2 randomly-chosen groups, creating shared dependencies.

### Building Replacement Formulas

For each base atom, `random_formula(rng, substitution_depth, group)` builds a replacement:

1. **Seed**: shuffle the atom group and build a balanced binary tree — pair atoms left-to-right with random connectives (`·`, `∨`, or `⊃`) until one formula remains. This guarantees every atom in the group appears at least once.
2. **Growth**: run `depth * 2` growth passes. Each pass picks a random leaf in the tree and expands it by either:
   - Wrapping it with negation: `A → ~A`
   - Combining it with another random atom from the group: `A → A · B`, `A → B ∨ A`, `A → A ⊃ ~B`

### Effect of Depth Levels

| Depth | Replacement complexity | Example |
|-------|----------------------|---------|
| 0 | No substitution — atoms stay as-is | `P` stays `P` |
| 1 | Simple 2-atom formula (1-2 operators) | `P → (S ∨ T)` |
| 2 | Moderate nesting (2-4 operators) | `P → (S ⊃ T) · ~S` |
| 3 | More nested (4-8 operators) | `P → ~(S · T) ⊃ (S ∨ ~T)` |
| 4 | Complex (8+ operators) | Deeply nested multi-operator formulas |
| 10 | Extreme (Mind tier) | Very deeply nested formulas with many growth passes |

Substitution is applied **uniformly**: every occurrence of atom P in the formula is replaced by the same compound formula. This means the formula can grow dramatically — a Chain4 base with 4 premises, where each atom is replaced by a depth-4 formula, can go from ~9 AST nodes to hundreds.

### Bridge Atoms

Without bridge atoms, each base atom's replacement uses a completely disjoint set of variables. The P-zone and Q-zone are semantically isolated — a solver could reason about them independently.

Bridge atoms break this isolation. If atom T is a bridge appearing in both P's group and R's group, the replacement formulas for P and R both contain T. This creates semantic entanglement: the truth value of T simultaneously constrains both zones, and a solver cannot reason about either zone in isolation.

---

## Stage 3: Wrap as Tautology

The premises and conclusion are combined into a single conditional formula:

```
(premise1 · premise2 · ... · premiseN) ⊃ conclusion
```

For Modus Ponens (`p, p ⊃ q ⊢ q`), this produces:

```
[p · (p ⊃ q)] ⊃ q
```

This formula is a **tautology** — true under every truth assignment — because the base argument form is valid. The antecedent (premises conjoined) logically entails the consequent (conclusion).

This is the critical insight: since the formula is a tautology, it will remain a tautology through any number of equivalence transformations.

---

## Stage 4: Equivalence Transformation Passes

This is where the formula becomes unrecognizable. The generator runs a multi-pass loop:

```
for each pass (0 to passes-1):
    if formula exceeds size limits: break
    apply transforms_per_pass successful transformations
    (verify tautology still holds)
```

### Within a Single Pass

The transformation loop attempts to apply `transforms_per_pass` successful equivalence rewrites. It allows up to `transforms_per_pass * 10` total attempts (since some subformulas may have no applicable rules):

```
while successful < transforms_per_pass AND attempts < transforms_per_pass * 10:
    attempts++
    try to apply a random equivalence at a random subformula position
    if successful: successful++
```

### How a Single Transformation Works

1. **Enumerate all subformulas with positions**: walk the formula tree and collect every subformula tagged with its positional path (e.g., `[left, right, inner_of_negation]`). Two structurally identical subformulas at different positions get different paths.

2. **Shuffle the subformula list** randomly.

3. **For the first subformula with applicable rules**:
   a. Call `find_applicable_rules()` to get all `(rule, result)` pairs
   b. Apply **weighted random selection** among the applicable rules
   c. Replace the subformula at that exact position with the chosen result
   d. Verify the result is still a tautology (sanity check)

4. **Position-targeted replacement**: only the selected subformula is transformed. Other identical subformulas elsewhere in the tree are left untouched. This allows structurally identical subtrees to diverge across multiple transformations.

### Available Equivalence Rules

These correspond to rules 9-18 in `rules.md`. Each rule is bidirectional — the generator can apply it in either direction:

| # | Rule | Transformation | Notes |
|---|------|----------------|-------|
| 9 | Double Negation (DN) | `p :: ~~p` | Throttled: introduction blocked if ≥2 leading negations already exist |
| 10 | DeMorgan's (DeM) | `~(p · q) :: (~p ∨ ~q)` and `~(p ∨ q) :: (~p · ~q)` | Pushes/pulls negation through connectives |
| 11 | Commutation (Comm) | `(p ∨ q) :: (q ∨ p)` and `(p · q) :: (q · p)` | Swaps operands |
| 12 | Association (Assoc) | `[p ∨ (q ∨ r)] :: [(p ∨ q) ∨ r]` and same for `·` | Re-brackets |
| 13 | Distribution (Dist) | `[p · (q ∨ r)] :: [(p · q) ∨ (p · r)]` and vice versa | **Down-weighted to 0.2** — duplicates subtrees |
| 14 | Contraposition (Contra) | `(p ⊃ q) :: (~q ⊃ ~p)` | Flips and negates |
| 15 | Implication (Impl) | `(p ⊃ q) :: (~p ∨ q)` | Converts between conditional and disjunction |
| 16 | Exportation (Exp) | `[(p · q) ⊃ r] :: [p ⊃ (q ⊃ r)]` | Curries/uncurries conjunction |
| 17 | Tautology (Taut) | `p :: (p · p)` and `p :: (p ∨ p)` | **Expansion blocked entirely** — only contraction allowed |
| 18 | Equivalence (Equiv) | `(p ≡ q) :: [(p ⊃ q) · (q ⊃ p)]` | **Down-weighted to 0.2** — duplicates subtrees; rarely fires in practice since no base form introduces biconditionals |

### Weighted Selection

Not all rules are equally likely to be chosen:

| Rule | Weight | Reason |
|------|--------|--------|
| DN, DeM, Comm, Assoc, Contra, Impl, Exp | **1.0** | Standard weight |
| Distribution | **0.2** | Duplicates one operand across both branches; exponential growth risk |
| Equivalence | **0.2** | Unfolds biconditional into two copies of each sub-formula |
| Tautology (expansion) | **blocked** | Would double the entire subtree every application with zero structural benefit |
| Tautology (contraction) | 1.0 | Allowed but rare — requires `p · p` or `p ∨ p` to exist naturally |
| DN (introduction when ≥2 negations) | **blocked** | Only elimination allowed to prevent gratuitous negation stacking |

### Why Multiple Passes Matter

A formula with more nodes has more subformulas, which means more sites available for transformation. Passes compound:

- **Pass 1**: Implication converts `p ⊃ q` → `~p ∨ q`. This creates a new `~p` subformula.
- **Pass 2**: DeMorgan can now target that `~p` in combination with surrounding structure — a site that didn't exist before pass 1.

Without multiple passes, transformations are limited to the initial flat structure. With 20 passes (Cosmic tier) or 50 passes (Mind tier), transformations cascade: a single atom in the original can end up buried under many layers of connectives, each introduced by a different pass.

### Gnarly Combos (Nightmare+ only)

For difficulty ≥ 85 (all tiers from Nightmare through Mind), before the random transformation loop, 2-3 specific two-rule sequences are forced. These are hand-picked combinations that create particularly hard-to-unwind patterns:

| Combo | Rules | Effect |
|-------|-------|--------|
| 1 | Contraposition + DeMorgan | Negates a conditional, then distributes the negation — creates buried negations |
| 2 | Implication + Distribution | Converts a conditional to a disjunction, then distributes — creates case splits |
| 3 | Exportation + Double Negation | Curries a conjunction then double-negates — adds structural depth |
| 4 | Equivalence + DeMorgan | Unpacks a biconditional (if one exists) then applies DeMorgan |

The number of combos applied:
- Difficulty 85-95 (Nightmare, Marathon): 2 combos
- Difficulty 96+ (Absurd, Cosmic, Mind): 3 combos

---

## Stage 5: Negation Simplification

After all transformation passes complete, a final `simplify_negations()` pass runs. It walks the entire formula tree and collapses consecutive negation pairs:

```
~~~~P → ~~P → P
~~~P → ~P
~~P → P
```

This prevents the formula from having gratuitous chains of 4+ negations that would be trivially reducible by DN and don't add real difficulty.

---

## Configurable Parameters

These are the fields of `DifficultySpec`, which control every aspect of generation:

### `variables` (2-20)

**What it controls**: the size of the atom pool.

The first 5 positions use P, Q, R, S, T. Positions 6+ extend with A, B, C, D, E, ..., Z.

The atom pool serves two roles:
1. **Base form atoms** — the first 2-4 atoms are assigned to the base argument form
2. **Substitution ingredients** — the remaining atoms become building blocks for replacement formulas when `substitution_depth > 0`

More variables means: more distinct propositions the solver must track, and (with substitution) more complex replacement formulas.

**The sweet spot is around 7 variables.** Counter-intuitively, more variables does not always mean harder. With too many variables, each one appears in fewer places throughout the formula, making it easier to isolate and reason about any single variable without having to disentangle a whole mess. With ~7 variables, the formula is dense enough that every variable is deeply entangled with the others, forcing the solver to reason about the entire structure holistically. This is why all the hardest tiers (Absurd, Cosmic, Mind) cap at 7.

### `passes` (1+)

**What it controls**: how many times the entire transformation loop runs. There is no upper limit — 50 is the highest preset (Mind tier), but you can set it arbitrarily high. In practice, the formula will hit the `max_formula_nodes` or `MAX_FORMULA_DEPTH` safety ceiling and remaining passes will be skipped.

Each pass takes the output of the previous pass as input. Passes compound — later passes can target structural patterns created by earlier passes, leading to cascading complexity.

### `transforms_per_pass` (1+)

**What it controls**: the target number of successful equivalence rule applications within a single pass.

Each transform picks a random subformula (subject to weighting), finds applicable equivalence rules, chooses one by weighted random selection, and applies it at that exact position. Up to `transforms_per_pass * 10` attempts are made to reach the target count.

### `base_complexity` ("simple" or "complex")

**What it controls**: which pool of base argument forms to draw from.

- `"simple"`: all 7 standard forms (MP, MT, DS, Simp, Conj, HS, CD)
- `"complex"`: only 3 multi-step forms (ConstructiveDilemmaFull, NestedCP, Chain4)

Complex base forms impose a harder proof skeleton before any obfuscation, ensuring difficulty is consistent within a tier.

### `substitution_depth` (0-10)

**What it controls**: how deep the replacement formulas grow when base atoms are swapped out.

- `0`: no substitution; atoms stay as-is
- `1+`: each base atom is replaced by a compound formula. Depth controls the number of "growth passes" (`depth * 2`) applied to the replacement formula's seed tree.

Higher depth = more operators per replacement formula = dramatically larger final formula.

### `bridge_atoms` (0-5)

**What it controls**: how many atoms are shared across multiple substitution groups.

- `0`: each base atom's replacement uses a completely disjoint set of variables (zones are semantically isolated)
- `1+`: bridge atoms appear in 2 groups simultaneously, coupling those zones and preventing independent reasoning

### `max_formula_nodes` (default: 20,000)

**What it controls**: the maximum number of AST (Abstract Syntax Tree) nodes allowed. This is effectively a ceiling on formula complexity. The pass loop checks node count between passes and bails out if the formula has grown past the limit, preventing runaway growth from Distribution and other subtree-duplicating rules.

An AST node is every "piece" of the formula represented as a tree — each atom, each operator, and each negation counts as one node. For example, `~(P · Q) ∨ R` has 6 nodes:

```
        ∨              1 node (Or)
       / \
      ~   R            1 node (Not) + 1 node (Atom)
      |
      ·                1 node (And)
     / \
    P   Q              1 node (Atom) + 1 node (Atom)
```

A Baby-tier theorem might have 10-20 nodes. A Mind-tier theorem could approach the 20,000 default cap.

---

## Difficulty Tier Presets

Each tier maps to a specific `DifficultySpec`. These are defined in `tier-presets.json`:

| Tier | variables | passes | transforms/pass | base_complexity | substitution_depth | bridge_atoms |
|------|-----------|--------|-----------------|-----------------|-------------------|--------------|
| **Baby** | 2 | 1 | 2 | simple | 0 | 0 |
| **Easy** | 3 | 1 | 5 | simple | 0 | 0 |
| **Medium** | 4 | 1 | 10 | complex | 0 | 0 |
| **Hard** | 5 | 1 | 15 | complex | 2 | 0 |
| **Expert** | 5 | 2 | 15 | complex | 3 | 0 |
| **Nightmare** | 6 | 3 | 15 | complex | 4 | 1 |
| **Marathon** | 6 | 5 | 20 | complex | 4 | 1 |
| **Absurd** | 7 | 10 | 20 | complex | 4 | 1 |
| **Cosmic** | 7 | 20 | 24 | complex | 4 | 2 |
| **Mind** | 7 | 50 | 50 | complex | 10 | 2 |

### Progression Pattern

The tiers escalate along multiple axes simultaneously:

- **Baby → Easy → Medium**: more atoms, more transforms, switch to complex base forms
- **Medium → Hard**: substitution begins (depth 2), increasing formula surface area
- **Hard → Expert**: multiple passes begin (2), substitution deepens (3)
- **Expert → Nightmare**: bridge atoms appear (1), gnarly combos activate, passes increase (3)
- **Nightmare → Marathon → Absurd**: more atoms, more passes, more transforms per pass
- **Absurd → Cosmic → Mind**: maximum atoms (7), extreme pass counts (20-50), double bridge atoms (2), Mind tier has substitution depth 10

---

## Safety Guards

Several mechanisms prevent the generator from producing degenerate or excessively large formulas:

### Size Limits

- **`MAX_FORMULA_NODES = 20,000`**: if the formula exceeds this node count between passes, remaining passes are skipped
- **`MAX_FORMULA_DEPTH = 100`**: same check for tree depth
- **`max_formula_nodes` parameter**: user-configurable override for the node limit

### Transformation Throttles

- **Distribution weight = 0.2**: 80% less likely to be chosen; prevents the `p · (q ∨ r) → (p · q) ∨ (p · r)` expansion from dominating
- **Equivalence weight = 0.2**: same rationale; `(p ≡ q) → (p ⊃ q) · (q ⊃ p)` duplicates both subtrees
- **Tautology expansion blocked**: `p → p · p` would double a subtree with zero structural benefit; only contraction (`p · p → p`) allowed
- **DN introduction capped**: if a formula already has 2+ leading negations, only elimination (`~~p → p`) is allowed

### Validity Verification

- **`debug_assert!(is_tautology(...))`** after wrapping, after each pass, and at the end — catches bugs in equivalence rule implementations
- **Tautology check after each individual transformation**: if a transformation somehow breaks tautology-hood (should never happen with correct equivalence rules), it's silently discarded and another subformula is tried

### Attempt Budget

The transformation loop allows at most `transforms_per_pass * 10` attempts per pass. If the formula has too few applicable subformulas to reach the target count, the pass terminates gracefully rather than looping forever.

---

## Worked Example

Given: `DifficultySpec { variables: 5, passes: 2, transforms_per_pass: 3, base_complexity: "complex", substitution_depth: 1, bridge_atoms: 1 }`

### Stage 1: Base Form

Atom pool: `[P, Q, R, S, T]`

Complex mode selects Chain4 (requires 4 atoms, we have 5):

```
Premises: P ⊃ Q, Q ⊃ R, R ⊃ S, P
Conclusion: S
```

### Stage 2: Atom Substitution

Base atoms: {P, Q, R, S}. Remaining: {T}.

With `bridge_atoms = 1`, T becomes a bridge atom added to 2 groups (say P's group and R's group):

```
P's group: [P, T]    →  random_formula(depth=1)  →  (P · T)
Q's group: [Q]       →  random_formula(depth=1)  →  Q  (single atom, stays as-is)
R's group: [R, T]    →  random_formula(depth=1)  →  (T ⊃ R)
S's group: [S]       →  random_formula(depth=1)  →  S
```

After substitution:
```
Premises:
  (P · T) ⊃ Q
  Q ⊃ (T ⊃ R)
  (T ⊃ R) ⊃ S
  (P · T)
Conclusion: S
```

Note: T appears in both the P-zone and R-zone — bridge atom at work.

### Stage 3: Wrap as Tautology

```
{[(P · T) ⊃ Q] · [Q ⊃ (T ⊃ R)] · [(T ⊃ R) ⊃ S] · (P · T)} ⊃ S
```

This is a tautology.

### Stage 4: Transformation Passes

**Pass 1** (3 transforms):

1. Pick subformula `(P · T) ⊃ Q`. Apply **Implication** (rule 15):
   → `~(P · T) ∨ Q`

2. Pick subformula `~(P · T)`. Apply **DeMorgan** (rule 10):
   → `(~P ∨ ~T)`

3. Pick subformula `Q ⊃ (T ⊃ R)`. Apply **Exportation** (rule 16, reverse):
   → `(Q · T) ⊃ R`

After pass 1:
```
{(~P ∨ ~T) ∨ Q] · [(Q · T) ⊃ R] · [(T ⊃ R) ⊃ S] · (P · T)} ⊃ S
```

**Pass 2** (3 more transforms on the result of pass 1):

4. Pick subformula `(T ⊃ R) ⊃ S`. Apply **Contraposition** (rule 14):
   → `~S ⊃ ~(T ⊃ R)`

5. Pick subformula `(Q · T) ⊃ R`. Apply **Implication** (rule 15):
   → `~(Q · T) ∨ R`

6. Pick subformula `~(Q · T)`. Apply **DeMorgan** (rule 10):
   → `(~Q ∨ ~T)`

After pass 2:
```
{[(~P ∨ ~T) ∨ Q] · [(~Q ∨ ~T) ∨ R] · [~S ⊃ ~(T ⊃ R)] · (P · T)} ⊃ S
```

### Stage 5: Negation Simplification

No excessive negation chains to simplify in this example.

### Output

The final formula is a tautology that looks nothing like the original Chain4 argument. The solver must figure out, using the same 18 rules + CP/IP, how to prove this is true — essentially unwinding the obfuscation.
