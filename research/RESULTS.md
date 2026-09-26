# First Codex-only release: partial engineering case study

The replacement campaign completed **43 of 96 planned jobs**: 40 produced accepted valid proofs and 3 had missing or invalid official outcomes. There are 53 unstarted jobs, 0 interrupted jobs, and no active jobs in this export. This is a stopped partial experiment, not a completed v2 census or a model ranking.

All recorded new inference used **gpt-6-astra, xhigh, native Codex subscription authentication, normal service tier**. Unaided received no tools or verifier feedback. Frontier used an isolated validation-only runtime, scripts and native delegation. Each singleton job had a 900-second allowance; Frontier had 128 tool calls. Cumulative work inherited its own fresh archive and received an additional allowance.

## Observed outcomes

| Condition | Completed / planned | Valid | Missing or invalid | Completed-subset mean loss |
|---|---:|---:|---:|---:|
| Unaided 1 | 12 / 24 | 12 | 0 | 0.3678 |
| Unaided 2 | 11 / 24 | 11 | 0 | 0.3711 |
| Frontier fresh | 11 / 24 | 9 | 2 | 0.4699 |
| Frontier cumulative | 9 / 24 | 8 | 1 | 0.4143 |

These means describe the completed subset of each condition, which can contain different items. They include missing/invalid outcomes at loss 1. They are not full-census means and must not be used as a cross-condition ranking. Exact losses, all 96 planned units and matched item comparisons are in [summary.json](../publication/data/summary.json) and [jobs.csv](../publication/data/jobs.csv).

Among **9/24 theorems** with completed valid proofs from both Unaided trials and fresh Frontier, Frontier was shorter than both on 0, between or tied with their lengths on 9, and longer than both on 0. Among **8/24 valid fresh–cumulative pairs**, cumulative was shorter on 1, tied on 7, and longer on 0. These valid-length comparisons exclude nonvalid outcomes explicitly; the condition means above retain them. Differences in interfaces, observed compute, selection and inherited work prevent a causal tool-benefit claim.

For example, `g1-2000011` had an owner-captured Frontier improvement from 11 to 10 lines. Unaided trial 1 also returned 11 lines and trial 2 returned 10. `g2-2100023` reached five lines against par 23 in both Unaided trials and fresh Frontier. The cumulative continuation of `g1-2000013` did reduce its inherited proof from 10 to 9 lines: a two-line indirect proof replaced a three-line construction of the same negated contradiction. Both assumption and closing line are counted. This improvement used a separate additional allowance. Thus shortening the planted reference does not by itself demonstrate a benefit from tools. [Three sealed methods cases](FRONTIER-METHODS.md) describe actual executed searches and their limits.

## Why dispatch stopped

At 06:24 UTC on September 26, the owner stopped new dispatch after confirming a capture defect; all six active jobs were allowed to finish. The frozen harness rejected the entire submissions directory if it contained an extra draft JSON file. Both `g2-2100030` Frontier jobs retained official **missing, loss 1** verdicts despite timed local validation of 11-line canonical proofs. The fresh run's exact printed proof bytes were independently replayed and are published separately, **excluded from scored evidence**. The cumulative receipts do not preserve exact canonical bytes, so they support a narrower claim.

A separate fresh Frontier failure on `g1-2000021` had 19 timely checkpoints with empty submission lists and no capture-rejection marker, then reached the native session deadline. Both Unaided trials returned valid 11-line proofs. This failed attempt is not attributed to the extra-draft defect.

See the [forensic note](SUBMISSION-FAILURE.md), [stop receipt](campaign-stop.json), and [schedule amendment](CAMPAIGN-AMENDMENT.md). This stop was prompted by an observed engineering failure; it was not a prespecified statistical stopping rule. A later capture repair changes the evaluator identity and does not rescore these runs. The earlier September 25 pilot remains [separate](../publication/pilots/20260925/data/results.json), including its interruptions.

## Evidence and reproducibility

The public replay passed **51 proof artifacts**: 40 final incumbents and 11 accepted checkpoint artifacts. The same proof bytes can appear in both roles; these are replay counts, not distinct discoveries. Frozen theorem/rule bytes, final and checkpoint proofs, full planned denominators, source identities, budgets and cumulative lineage are downloadable from the site.

- Campaign: `f5718b6e-dc3e-4219-b823-cd62cb98023c`.
- Campaign source: [`64b2026`](https://github.com/dogaozden/prop-bench/tree/64b2026857d0dc9da54497eca50cf7a63534e95f).
- Results bytes SHA-256: `73cf5bdbf0aed3d8c203980b619c52806341687cb20c71b7d38476cbdfcca0c9`.
- [Replay receipt](../publication/data/verification.json), [control audit](replacement-campaign-control-audit.md), [runtime audit](validation-runtime-3-audit.md), and [offline reproduction](REPRODUCIBILITY.md).

The completed runs record 103 native sessions, 3,288,243 input-token observations and 386,465 output-token observations. Usage was present in 77 of 103 session receipts. These observations may be incomplete; reasoning/total-token coverage, exact inference requests and exact charges are unavailable. Native sessions are not equivalent to model requests.

The 24-item public synthetic set is small. Twelve items have redundant premises and five have a premise equivalent to the conclusion; all retained reference proofs replay at their stated pars. Reference lengths are achievable bounds, not minima, and model training exposure is unknown. This release establishes inspectable proof artifacts and engineering evidence under specified conditions, not human equivalence, global optimality or general reasoning ability. See [limitations](LIMITATIONS.md).
