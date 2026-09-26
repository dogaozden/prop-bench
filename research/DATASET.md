# Dataset provenance and license facts

## Frozen public set

The evaluated set is `golf/set/v2`, introduced by PropBench commit
`ea5775353a2eb0c3575809bf1bf6bfa1755996f2` on 2026-09-06. Its manifest declares
`set_version: v2` and `core_tag: v0.3.4`; it includes exactly 24 items, eight in
each generation band. `Cargo.lock` pins logic-core to
`1f751542095232eefaa3f8fc3d80e81c3ea1c3a0`. Each theorem's exact bytes have a
SHA-256 in the manifest. `research/v2-semantic-audit.json` records the manifest
hash and an independent current semantic check.

The public files contain synthetic propositional formulas, difficulty metadata,
and seed-based IDs; no human-subject data. The set is produced by planted proof
generation, with rule-based transformations and rejection filters. The inspected
generator uses four atoms, at most five premises, maximum formula length 90,
one level of subproofs for this freeze, and two obfuscation passes. Band-specific
pre-obfuscation par targets are 7–11, 14–19, and 19–26. These differ from the
final reference lengths and are not calibrated test difficulty.

The historical freeze record reports the first eight freeze survivors in seed
order per band. The public ID `gB-S` records band B and seed S. The following
facts are transcribed from the contemporaneous measurement record rather than
claimed as a new regeneration of all 24 items:

| Band | Probe range scanned | Probe passers | Shipped items | Actual par range |
|---|---|---:|---:|---:|
| 1 | 2,000,000–2,000,199 | 40 | 8 | 11–19 |
| 2 | 2,100,000–2,100,199 | 9 | 8 | 17–23 |
| 3 | 2,200,000–2,205,899 | 10 | 8 | 23–29 |

All 24 selected candidates reportedly survived the additional bounded search
gate: at most the planted par in lines, 1,000,000 search nodes, and 128
equivalence moves per state. No selected freeze attempt failed and no seed was
discarded for taking too long. The generator then replayed each planted proof
and required its count to equal par. These are achieved upper bounds; bounded
search failure does not prove a lower bound, minimality, or universal hardness.

Provenance source in the surrounding development workspace:
`docs/superpowers/plans/2026-08-24-proof-golf-MEASUREMENTS.md`, “Addendum (Task 15):
Set v2 (v0.3.4) frozen” and “Par softness” subsections. Supporting records are
`docs/superpowers/reviews/2026-08-24-proof-golf/task-15-report.md`,
`task-15-review.md`, `task-16-report.md`, and `task-16-review.md`. These are
sibling-workspace records, not automatically present in a PropBench clone.
A public release must include a lawful source/provenance archive or a permanent
link and hash for the historical records it relies upon.

The historical planted answer key is stored outside this repository. This audit
did not inspect that key. A separately generated temporary single-item proof
was used to test the full-CLI regeneration leak; see the pre-campaign audit.
Reproducible generation and key-withholding during evaluation are distinct
requirements. Public seeds and generator availability prevent treating v2 as a
secret held-out set even after the contestant runtime is fixed.

## Semantic checks and superseded data

The current independent truth-table audit checks all 24 v2 items: premises are
satisfiable, the premises entail the conclusion, and the conclusion is not a
tautology. Twelve items admit a proper sufficient subset of premises (3/8, 4/8,
5/8 by band); five have a premise equivalent to the conclusion (2/8, 3/8, 0/8).
Those five are `g1-2000001`, `g1-2000035`, `g2-2100023`, `g2-2100030`, and
`g2-2100067`. They are retained as frozen benchmark facts, not silently filtered
after observing a model's performance.

V1 is superseded and excluded from new scoring. Its retained README identifies
two inconsistent-premise items (`g1-1000043`, `g2-1100090`) and one tautologous
conclusion (`g3-1200381`). `rehearsal` is a one-item integration fixture and is
not part of the v2 evidence denominator. Historical golf's `imputed_ratio: 1.5`
does not define the Tracks `efficiency-v2` loss.

## License and ownership record

- Repository `LICENSE` contains the MIT text and “Copyright (c) 2026 Doğa Özden.”
  Its stated subject is the software and associated documentation. The frozen
  set is included in the repository, but no separate dataset license or
  dataset-specific ownership declaration was found in the inspected files.
- Pinned logic-core `Cargo.toml` declares `license = "MIT"`. Its tagged tree
  contains no separate LICENSE/COPYING file. Preserve that factual distinction
  when assembling dependency notices; do not invent copyright text.
- The generator's formulas and local provenance do not by themselves establish
  ownership or permission for every upstream dependency, historical prompt,
  provider event, model-generated proof/tool, or included transcript. Those
  materials need an explicit release inventory and applicable provenance.
- No current provider contractual permissions or output-redistribution terms
  were verified in this repository audit. Do not describe subscription access
  as publication permission, and do not copy private authentication/account
  records into a public research archive.

This section records observable repository facts, not a legal clearance. A
release owner should state the intended scope of the existing MIT grant for
the new dataset/research artifacts and preserve applicable upstream notices.
