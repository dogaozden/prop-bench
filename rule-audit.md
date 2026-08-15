# Rule Audit — Card vs. Validator

This audit checks every rule taught by the LLM-facing card (`prompt.ts`'s
`INFERENCE_RULES` / `EQUIVALENCE_RULES` tables, mirrored in `rules.md`)
against what `logic-core`'s validator actually accepts. "Validator accepts"
and "Locked by test" are sourced directly from
`logic-core/tests/rule_behavior_lock.rs` — no claim below is made without a
named test backing it.

All 19 rules are listed. Where the card and validator already agreed, the
row says so plainly. Two rows needed a doc-only fix (the card was narrower
than the validator); one row reflects a genuine new validator behavior
(Equiv form 2, added and locked in this same round of work).

## Inference rules

| Rule | Card said | Validator accepts | Verdict | Locked by test |
|---|---|---|---|---|
| MP | `p > q, p => q` | same; premises citable in either order | matches (card silent on order; validator is a permissive superset) | `premise_order_agnostic` |
| MT | `p > q, ~q => ~p` | same; premises citable in either order | matches (card silent on order; validator is a permissive superset) | `premise_order_agnostic` |
| DS | `p v q, ~p => q` | both directions: `~p ∴ q` or `~q ∴ p` | **doc-only fix, ratified 2026-08-15** — card now shows `(or: p v q, ~q => p)` | `ds_both_directions` |
| Simp | `p . q => p (or q)` | both conjuncts extractable | matches | `simp_both_conjuncts` |
| Conj | `p, q => p . q` | p, q ∴ p.q | matches; no house-form ambiguity — not covered by this lock file | n/a (no dedicated test in `rule_behavior_lock.rs`) |
| HS | `p > q, q > r => p > r` | same; premises citable in either order | matches (card silent on order; validator is a permissive superset) | `premise_order_agnostic` |
| Add | `p => p v q` | `p ∴ p v q` OR `p ∴ q v p` — either side | **doc-only fix, ratified 2026-08-15** — card now shows `=> p v q  or  q v p`; this is the house rule | `add_house_rule_both_sides` |
| CD | `p v q, p > r, q > s => r v s` | same | matches; not covered by this lock file | n/a (no dedicated test in `rule_behavior_lock.rs`) |
| NegE | `p, ~p => #` | same | matches; not covered by this lock file | n/a (no dedicated test in `rule_behavior_lock.rs`) |

## Equivalence rules

| Rule | Card said | Validator accepts | Verdict | Locked by test |
|---|---|---|---|---|
| DN | `p :: ~~p` | bidirectional | matches | `impl_contra_exp_taut_dn_bidirectional` |
| DeM | `~(p.q) :: ~p v ~q`, `~(pvq) :: ~p.~q` | both forms, both directions | matches | `demorgan_both_forms_both_directions` |
| Comm | `p v q :: q v p`, `p . q :: q . p` | both connectives | matches | `comm_both_connectives` |
| Assoc | `p v (q v r) :: (p v q) v r`, `p . (q . r) :: (p . q) . r` | both connectives | matches | `assoc_both_connectives` |
| Dist | `p . (q v r) :: (p . q) v (p . r)`, `p v (q . r) :: (p v q) . (p v r)` | both forms | matches | `dist_both_forms` |
| Contra | `p > q :: ~q > ~p` | direction asserted in this file: `p>q → ~q>~p` | matches (card and test agree on the direction each states; `::` is bidirectional by the rule's own definition) | `impl_contra_exp_taut_dn_bidirectional` |
| Impl | `p > q :: ~p v q` | both directions | matches | `impl_contra_exp_taut_dn_bidirectional` |
| Exp | `(p.q) > r :: p > (q > r)` | both directions | matches | `impl_contra_exp_taut_dn_bidirectional` |
| Taut | `p :: p . p`, `p :: p v p` | both forms asserted from `p` in this file | matches | `impl_contra_exp_taut_dn_bidirectional` |
| Equiv | `p <> q :: (p > q) . (q > p)` (form 1 only, until this round) | form 1 both directions; **form 2** `p<>q :: (p.q) v (~p.~q)` both directions — now implemented | form 1: matches. Form 2: **behavior added, ratified 2026-08-15** — card now lists both forms | `equiv_form_one_both_directions`; `equiv_form_two_both_directions` |

## Doc-only fixes, behavior additions, and token additions this round

1. **DS (doc-only fix).** `prompt.ts` and the trainer card taught only
   `p v q, ~p ∴ q`. The validator has always accepted the symmetric case
   (`p v q, ~q ∴ p`) — confirmed by `ds_both_directions`. The card was
   narrower than the validator; the card is now corrected to show both
   directions. No validator change.
2. **Add (doc-only fix).** `prompt.ts` and the trainer card taught only
   `p ∴ p v q`. The validator has always accepted introducing the new
   disjunct on either side (`p v q` or `q v p`) — confirmed by
   `add_house_rule_both_sides`. This is a deliberate house rule (Hurley's
   textbook form is one-sided; this validator is intentionally more
   permissive). The card is now corrected to show both. No validator
   change.
3. **Equiv form 2 (behavior addition).** The validator previously accepted
   only `p <> q :: (p > q) . (q > p)` (form 1). It now also accepts
   Hurley's second biconditional form, `p <> q :: (p . q) v (~p . ~q)`,
   bidirectionally — confirmed by `equiv_form_two_both_directions`,
   ratified by Doğa 2026-08-15. `prompt.ts`'s Equiv row and `rules.md`'s
   Equivalence entry both now list form 2 alongside form 1. The trainer
   card (`logic-proof-trainer/src/types/index.ts`) does **not** get form 2
   yet — the trainer pins `logic-core` at tag `v0.1.0`, which predates this
   behavior; that row will be updated when a later task bumps the pinned
   version.
4. **`<>` diamond token (token addition, parser).** `prompt.ts`'s SYMBOL
   REFERENCE has always taught `<>` as the biconditional token. The parser
   now genuinely accepts it — confirmed by `biconditional_diamond_token_parses`
   (`P <> Q` parses identically to `P <-> Q`) and
   `biconditional_round_trips_through_bracketed_ascii` (a parsed
   biconditional survives an `ascii_string_bracketed()` round trip). The
   symbol table text was already correct and needed no edit; this is
   recorded here because it closes out the same card/validator gap as the
   other three items — the card taught it before the validator could back
   it up, and now the validator does.

## Coverage note

`rule_behavior_lock.rs` currently contains 13 tests. It locks the rules
with house-form or directional ambiguity (Add, DS, Simp, MP/MT/HS ordering,
Comm, Assoc, DeMorgan, Distribution, Impl/Contra/Exp/Taut/DN, Equiv forms
1 and 2) plus the two biconditional-token parser tests. Conj, CD, and NegE
have no house-form ambiguity to lock and are not covered by this file.

Principle: the card and the validator must agree, and the validator wins ties.
