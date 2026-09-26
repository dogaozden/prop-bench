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
gate. The [generator at the freeze commit](https://github.com/dogaozden/prop-bench/blob/ea5775353a2eb0c3575809bf1bf6bfa1755996f2/src/golf.rs#L294-L300)
configures at most the planted par in lines, 1,000,000 search nodes, and 128
equivalence moves per state. The historical records report no failed selected
freeze attempt and no seed discarded for taking too long. These search results
were not rerun in the current audit; bounded search failure does not prove a
lower bound, minimality, or universal hardness.

The [public provenance archive](provenance/README.md) contains selected factual
excerpts from `2026-08-24-proof-golf-MEASUREMENTS.md` and the Task 15/16 reports
and reviews. Its [source manifest](provenance/historical-sources.json) records
full source hashes, exact excerpt hashes and byte offsets, and every omitted
line range. The source documents were local working records outside Git:
these hashes identify the inspected snapshots, not authenticated historical
timestamps or independent human review. Private workflow material, host paths,
and proof contents are omitted. No additional license grant is inferred.

The retained planted answer key remains outside this repository. On
2026-09-26 UTC, a [current strict replay](provenance/retained-reference-replay.json)
checked all 24 retained proofs without regeneration or search: all passed both
the strict CLI and the Tracks owner wrapper, and all counts equaled manifest
par (475 total lines). The report records exact proof-byte hashes and lengths,
validator/source identity, and per-item verdicts. Reference pars are therefore
currently verified achievable upper bounds. Proof bytes are withheld, so this
public record identifies the checked artifacts but cannot by itself support
independent replay. A separately generated temporary single-item proof was used
to test the full-CLI regeneration leak; see the pre-campaign audit.
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
- OpenAI's [individual Terms of Use](https://openai.com/policies/row-terms-of-use/)
  (effective 2026-01-01; checked 2026-09-26 UTC) assign its rights in output to
  the user to the extent law permits, excluding other users' and third-party
  output. Its [Sharing & Publication Policy](https://openai.com/policies/sharing-publication-policy/)
  calls for attribution, clear AI disclosure, and manual review before sharing.
  These are narrow source facts, not general legal clearance or an assertion
  that a human reviewed every output. Private authentication/account records
  are excluded from the public archive.

The [release inventory](RELEASE-INVENTORY.md) records the shipped artifacts,
the existing MIT notice included with the package, and excluded materials.
This section records observable provenance and license facts.
