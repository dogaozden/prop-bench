# Strict replay and scoring audit

Audit completed on 2026-09-26 UTC against frozen source `6ba4637874fea00475276543545bc7876bff1f2e` and the actual Cargo dependency `logic-core` v0.3.4, commit `1f751542095232eefaa3f8fc3d80e81c3ea1c3a0`. The neighboring development checkout was not used as evaluator authority.

**Result:** no accepted truth-table-invalid conclusion, scope escape, or incorrect accepted line count was found in the checked cases. A reproducible Unicode-whitespace parser panic was found. This is an infrastructure-classification defect, not an accepted-proof soundness counterexample. The active campaign source and binaries remain unchanged.

The detailed, sanitized record is [strict-replay-audit.json](strict-replay-audit.json). All examples and proof inputs in that record are synthetic audit fixtures. No contestant answers, provider calls, or private answer keys were used.

## Evidence and method

| Check | Result |
|---|---:|
| Deterministic synthetic replay cases | 355 |
| Accepted synthetic cases | 180 |
| Accepted conclusions false under an independent truth-table check | 0 |
| Accepted line counts differing from the number of submitted lines | 0 |
| Owner CLI versus validation-only CLI verdict differences | 0 / 355 |
| Proof-input Unicode-whitespace cases panicking in both binaries | 6 |
| Additional theorem-input Unicode-whitespace cases panicking in both binaries | 12 |
| Owner adapter boundary probes | 8 |
| Score formula, monotonicity, missing-result, and invalid-input checks | 1,094; no failures |

The deterministic test program used three substitutions, including compound formulas and contradiction, across every inference rule and every declared equivalence family. It tested both directions of the listed equivalences, reversed citation order where supported, every CD citation permutation, and complemented incorrect conclusions. An independent Python AST evaluator enumerated the truth assignments of the small synthetic formulas; it did not call the dependency's truth-table implementation.

Additional cases covered CP/IP nesting, immediate closure, wrong techniques, forged depths and ranges, closed-scope and sibling-scope references, future/self/zero/oversized references, integer overflow, numbering aliases, malformed rule names, parser boundaries, completion, and replacement granularity. These are bounded deterministic checks, not exhaustive proof search or a formal verification of the Rust implementation.

The temporary driver was `/tmp/propbench-strict-replay-audit.py`, SHA-256 `36bacecedc9a4b42bc3ebe3dc879f332c9623dccb8eb4da84a382c570d3343cd`. The JSON preserves each synthetic input and both binary outcomes, so individual cases can be replayed independently with `validate --strict-protocol`.

## Concrete defect: multibyte whitespace panics

A synthetic theorem with premises `P > Q`, `P` and conclusion `Q` should never crash the evaluator because of formatting in a submitted formula. Both frozen native binaries exit **101**, without a verdict, for this proof:

```json
[{"line_number":3,"formula":"Q\u00a0","justification":"MP 1,2","depth":0}]
```

`U+00A0` is a non-breaking space. Leading and trailing `U+00A0`, `U+2003`, and `U+202F` reproduced the problem. The same characters in theorem premises or conclusions also panic before replay starts.

The pinned dependency's `models/formula.rs:696–710` advances `pos` by one byte when `char::is_whitespace()` succeeds. A later slice starts inside a multibyte UTF-8 character. The error includes `byte index 2 is not a char boundary` for `Q\u00a0`. The owner adapter in `tracks/core.ts:171–176` correctly treats exit 101 as an evaluator infrastructure failure; consequently, a formatting accident or malicious input can interrupt a run instead of receiving an ordinary invalid verdict. This audit did not inspect campaign answers to determine whether a campaign attempt used these characters.

### Repair proposal at the time of the audit

Two local patch files are prepared:

- `/tmp/propbench-strict-whitespace-guard.patch` — a strict-only guard at the replay formula boundary, plus the earlier theorem-formula boundary in the shared CLI adapter.
- `/tmp/propbench-strict-whitespace-regression.patch` — proof and theorem whitespace regressions plus preservation checks for ASCII whitespace and Unicode logical operators.

The guard rejects only characters satisfying both `is_whitespace()` and `!is_ascii()`. It does not normalize formulas, rewrite the dependency parser, or reject Unicode operators such as `⊃`, `·`, and `¬`. Malformed proof formulas produce a normal `valid:false` verdict; malformed theorem formulas fail with exit 1. Legacy replay behavior is preserved. The repair therefore narrows strict malformed-input behavior without adding any accepted proof.

Both patches pass `git apply --check`. They were applied only to a temporary source copy, with a separate temporary build directory. An offline, single-job build passed **7 strict-protocol tests**. The patched owner and validation-only binaries were then checked on all **355 cases each**: acceptance and accepted line counts were unchanged; all 12 proof-panic binary runs became ordinary invalid verdicts. All 24 theorem-panic binary runs became controlled exit-1 failures. Patch hashes and these results are in the JSON evidence. No production source, rulebook, frozen binary, or campaign identity was changed. Integrating this repair requires a new evaluator/runtime identity after the frozen campaign.

## Verified semantics and qualifications

**Conclusion and empty proofs.** Completion requires every submitted line to be valid, every scope to be closed, and the conclusion to appear at depth zero. The dependency checks for the conclusion anywhere in the proof, including seeded premises; it does not require the final line to be the conclusion. Empty proofs were rejected for premise-free theorems, even for `P > P`. Empty proofs were accepted with line count zero when the conclusion was already a premise. That is logically sound and receives loss zero under the declared score. Adding valid lines after a derived conclusion was accepted and counted, so this does not create a line-count discount. The contestant instruction to “finish” with the conclusion is stricter than the engine's actual completion predicate.

**Scopes.** Replay opens and closes the engine's innermost scope, verifies the actual CP/IP conclusion, and in strict mode compares supplied ranges and depths with the engine-derived values. Tested references to closed assumptions, sibling scopes, and closed inner scopes were rejected. A conclusion already among the premises did not permit an unfinished scope. CP/IP assumption and closing lines each counted once.

**Replacement.** Equivalence rules may operate on a structural subformula at any depth, replacing all identical occurrences together. `P & P` to `~~P & ~~P` by one DN line was accepted; changing only one identical occurrence was rejected. Applying an inference rule inside a larger cited formula was rejected. The additional backward right-factoring form of Dist was accepted, while its unlisted mirror forward form was rejected; callers should not infer support for every semantically equivalent variant from the word “bidirectional.”

**Numbering and scoring.** Replay checks the next engine-assigned line number before insertion; reference checks require earlier accessible lines. Tested zero, self, future, negative, maximum-`usize`, overflow, extra-reference, and fractional-reference forms were rejected without an accepted alias. Harmless spellings such as `MP1,2`, `MP 01,002`, lowercase rule names, and `MP +1,+2` were accepted. Every accepted count equaled the submitted array length; seeded premises are free. `proofLoss` returned `L/(L+par)` for valid counts and 1 for missing results, increased strictly with L in the tested domain, and rejected invalid score arguments.

**Other format differences.** The strict Rust CLI ignores extra JSON object fields, while the owner TypeScript boundary rejects them. Thus a contestant's local `valid:true` can still become an owner `parse_error`; this is not an owner scoring bypass. The replay justification parser also accepts broad assumption prefixes such as `Assumexyz` as CP assumptions. Scope and conclusion checks still apply, so the tested permissive spelling did not establish an invalid theorem. These differences merit a separately versioned format-alignment follow-up, not a silent change to the active campaign.

## Limits and preservation

The audit covered the named files, actual pinned dependency implementations, existing strict-protocol tests, and deterministic synthetic cases. It did not prove universal soundness, certify proof optimality, exhaust large formulas or arbitrarily long scopes, stress resource-exhaustion limits, or inspect model-generated campaign proofs. Native owner and validation-only binary parity was checked; no new semantic run was launched inside a campaign container.

SHA-256 hashes of the two binaries, replay/adapter source, rulebook, core scoring adapter, and Cargo lockfile were recorded before testing and checked again afterward. All were unchanged; HEAD remained `6ba4637`. Only the two research audit artifacts were added to the working tree by this audit.

## Integration after the interrupted pilot

After preserving and closing the first campaign, the guard and regression
patches were integrated into the owner and validation-only binaries. The full
Rust release suite passed (33 integration tests). Runtime 3 was rebuilt with
image identity `sha256:b86705d37917c9e9cdcd98c139b4a052bb77cad812e6f80c03f461db0bce9859`.
The new owner binary SHA-256 is
`90c4b05d1c1f1a2be9294fe19184276ab20584a28660ea35bfbb954f65891f97`;
the validation-only binary SHA-256 is
`a2a0d4858cf19d6cd94ef1d2d385dd1bd7c325381fab7f65927f3372ad327d97`.
The earlier audit identities and pilot artifacts remain unchanged. The
replacement campaign records the new evaluator and runtime identities.
