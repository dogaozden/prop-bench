# Publication claims and release checks

This release is a **partial engineering case study**: 43/96 planned jobs
completed, 40 accepted final proofs, three missing verdicts and 53 unstarted
jobs. [RESULTS.md](RESULTS.md) is the narrative authority; exact data and replay
receipts are in `publication/data/`. Two missing verdicts were affected by the
frozen submission-capture defect, as documented in [SUBMISSION-FAILURE.md](SUBMISSION-FAILURE.md).

| Claim | Evidence and boundary |
|---|---|
| 24 frozen synthetic items, eight per generation band | Supported by exact manifest and theorem hashes in the public bundle. |
| Valid entailments, satisfiable premises, non-tautologous conclusions | Supported by [semantic audit](SEMANTIC-AUDIT.md); a semantic property, not calibrated difficulty. |
| Reference pars are achievable | All 24 retained reference proofs replayed strictly at par: [receipt](provenance/retained-reference-replay.json). Not minimum lengths. |
| Unaided sessions had no external tools or verifier feedback | Supported for the 23 completed Unaided runs by the [terminal control audit](replacement-campaign-control-audit.md). Fresh does not mean training-unseen. |
| Frontier retained accepted checkpoint improvements | Public replay checks all 11 accepted checkpoint artifacts and final incumbents. The historical capture defect could reject a directory before accepting a candidate; do not claim every valid working proof was retained. |
| Generator commands were excluded from the contestant executable | Exact runtime-3 [isolation audit](validation-runtime-3-audit.md). Public seeds and unknown training exposure still prevent contamination-free claims. |
| All new recorded inference used Codex subscriptions | 43 prepared runs and 103 native control/thread receipts audited. No Claude or API-key fallback was used. Unstarted jobs are not executed evidence. |
| Completed-subset mean losses | Supported by [summary](../publication/data/summary.json), with condition-specific denominators and missing outcomes at loss 1. Full-census means remain unavailable. |
| A cumulative proof improved from 10 to 9 lines | Supported for `g1-2000013` by both exact proofs, lineage and captured improvement; the continuation had an additional allowance. |
| Tools generally improve performance | Not established. Nine valid three-way matches had fresh Frontier lengths within or tied with both Unaided results. The sample is small and condition means are affected by capture failures. |
| Globally shortest, human-equivalent, universally hard or contamination-free | Unsupported; do not make these claims. |
| Equal compute, exact model-request count or exact total charge | Unsupported. Report partial native usage observations and session-count limits. |
| Reproducible proof evidence | 51 public final/checkpoint artifacts independently replayed. Reproduction of hosted model behavior is a separate, stochastic operation. |
| Ready to copy to a static website | The exact 143-file ZIP passes asset hashes and nested-path desktop/mobile checks. This does not claim deployment to the owner's website. |

Completed release checks:

- [x] Preserve the frozen source, manifest, client/referee/runtime identities,
  source archive and exact runtime image; keep the earlier pilot separate.
- [x] Retain all 96 planned units, three missing outcomes and the observed-defect
  stopping amendment; no silent retries or rescoring of excluded bytes.
- [x] Independently replay 40 final proofs and 11 checkpoint artifacts and bind
  analysis/verification receipts to the exact public results bytes.
- [x] Include public-set limits, 12/24 subset entailments, 5/24 premise-equivalent
  conclusions, achievable-par meaning and unknown optima.
- [x] Document [asset provenance and exclusions](RELEASE-INVENTORY.md); preserve
  the existing MIT notice and exclude native clients, raw sessions and answer keys.
- [x] Scan new source/public artifacts for credentials and host paths. The only
  host-path-pattern hit was the packager's defensive regular expression.
- [x] Package only explicit public data assets; reject missing, changed or
  unreferenced evidence and unexpected metadata before writing the ZIP.
- [x] Inspect the extracted ZIP at `/research/propbench/` at 1280, 390 and 320px;
  exercise the nine-line cumulative proof, guide, exact downloads and pilot link.
- [x] Verify the post-campaign capture repair with 115 track tests (zero skips,
  real Docker runtime), 95 pipeline tests, 19 site tests and TypeScript.
- [ ] Record the targeted live native regression of the repaired capture path.
- [ ] Run the documented reduced-validator replay from a clean release checkout
  and record the final CI/source identity.

The last two checks are release follow-ups, not permission requests. Public
website deployment is outside this preparation task.
