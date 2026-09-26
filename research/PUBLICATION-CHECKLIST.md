# Publication claims checklist

Status legend: **supported** means directly evidenced by inspected source/data;
**pending** needs campaign or release evidence; **unsupported** must not appear
as a result claim. Update this file with exact evidence links at release time.

| Proposed statement | Status and required wording/evidence |
|---|---|
| “V2 contains 24 frozen synthetic items, eight per generation band.” | Supported by manifest and independent hash check. |
| “All v2 premises are satisfiable and all items are valid entailments with non-tautologous conclusions.” | Supported by `SEMANTIC-AUDIT.md` and `v2-semantic-audit.json`; semantic property only. |
| “Reference lengths are achievable.” | Historically supported by freeze replay records; for release, provide exact strict replay or reproducible generation evidence if claiming current strict-protocol achievability for every reference. |
| “The evaluator independently verifies proof validity and counted length.” | Supported by design/tests; each reported result still needs its own pinned strict verdict. |
| “Unaided used one fresh, tool-free session per item.” | Pending per-run native audit/tool evidence and complete campaign index. Fresh does not mean training-unseen. |
| “Frontier retained its best verified proof throughout the run.” | Current v2 design and focused retention/deadline tests support retention at completed exec checkpoints; each scored run needs its own receipts. Historical final-file-only runs cannot support this claim. |
| “The bundled CLI generation route was removed.” | Supported for the exact image in `validation-runtime-audit.json`, with direct-executable rejection and source-cache absence checks. Historical full-CLI runtime fails this boundary. Do not generalize this check into a contamination-free claim. |
| “The campaign used only Codex subscriptions.” | Pending all planned-run provider/auth receipts; current protocol requires it. Historical Claude/API results remain labeled separately. |
| “Model A achieved loss X on v2.” | Pending full 24-item denominator, fixed configuration/budget, accepted run statuses, exact proof replay, and aggregate script. State repetitions and valid count. |
| “Tools improve performance.” | Needs the conditions, effect size, repeated matched design, and uncertainty. Initial same-wall-time comparison covers full interfaces, not pure equal-compute tool causality. |
| “Cumulative work improved loss by X.” | Needs exact baseline/archive, final replay, per-item deltas, and total prior/current resource accounting. Inherited results are not new discoveries. |
| “This is the best known proof in the released evidence.” | Possible with a defined evidence collection, cutoff, and exhaustive comparison of its accepted candidates; do not imply globally best known. |
| “This proof is optimal/the shortest possible.” | Unsupported without a separate sound lower-bound certificate under precisely the same rule semantics. |
| “Saturation-proof”, “universally hard”, or “solver-proof”. | Unsupported. A bounded solver's failure and planted par do not establish these properties. |
| “Held-out”, “unseen”, or “contamination-free v2”. | Unsupported: public source/seeds, historical evaluations, and unknown training exposure. |
| “Equal compute”, “exact model requests”, or “exact total token cost”. | Unsupported by a subscription wall/effort budget; report recorded native usage and its missing coverage. |
| “Reproducible results.” | Specify offline proof/score replay versus stochastic service-dependent replication; clean-checkout reproduction is pending. |
| “Ready for worldwide publication.” | Pending artifact availability, license/provenance inventory, sanitized release review, reproducibility, and verification of the actual public destination. |

Release checks:

- [ ] Freeze the corrected source and protocol before scored dispatch; preserve
  hashes, dependency locks, runtime image, and native-client identity.
- [ ] Close the generator exposure, checkpoint, and effort/client identity
  findings with code and runtime evidence.
- [ ] Retain every planned unit and all interruptions; link declared replacement
  attempts and plan amendments; publish complete denominators.
- [ ] Recompute accepted proofs and summary tables with the pinned referee;
  keep legacy ratio/Elo, fixtures, old pilots, fresh, and cumulative reports
  distinguishable.
- [ ] Include the 12/24 subset-entailment and 5/24 premise-equivalence facts,
  public-set contamination limits, reference-length meaning, and small-n limits.
- [ ] Confirm source/dataset/research-artifact license scope and dependency
  notices; document permissions or exclusions for model/client event exports.
- [ ] Verify that sanitized release bytes contain no secrets/account data and
  still reproduce the advertised scores.
- [ ] Run the documented offline reproduction from a clean checkout.
- [ ] Replace draft metadata/date/version links with the actual release, check
  `CITATION.cff`, and verify that public links resolve to the intended artifacts.

Use a descriptive title such as **PropBench: Valid Proof Construction and
Agentic Proof Golf**. A useful initial release can present a verifier, benchmark,
controlled case study, and reusable tooling with explicit limits; it need not
claim a new general ranking or solved proof-optimality problem.
