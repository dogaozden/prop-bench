# PropBench public evidence

This export records **43/96 completed jobs**, 3 completed nonvalid outcomes, 0 interrupted jobs and 53 unstarted jobs. The campaign is stopped; no live inference runs in this website. It is a partial engineering case study, not a completed census.

The frozen harness had a known proof-folder capture defect. Affected official outcomes remain missing/loss 1; see the [results report](https://github.com/dogaozden/prop-bench/blob/master/research/RESULTS.md) and [forensic note](https://github.com/dogaozden/prop-bench/blob/master/research/SUBMISSION-FAILURE.md). Subsequent code repairs do not alter these scores.

- `results.json`: exact theorem descriptions, terminal runs, all planned jobs, proof/download hashes and lineage.
- `summary.json`: condition coverage, completed-subset losses and matched comparisons; bound to the exact results hash.
- `jobs.csv`: all 96 planned jobs, including missing and unstarted work.
- `verification.json`: independent strict replay receipt; 51 final/checkpoint artifacts replayed. This proves internal consistency and proof validity, not hosted execution authenticity.
- `theorems/`, `rules.md`, `proofs/`: exact public evidence bytes.

Campaign source: `64b2026857d0dc9da54497eca50cf7a63534e95f`. Results SHA-256: `73cf5bdbf0aed3d8c203980b619c52806341687cb20c71b7d38476cbdfcca0c9`.

[Reproduce offline](https://github.com/dogaozden/prop-bench/blob/master/research/REPRODUCIBILITY.md). Proof replay needs no provider login, account data or owner run directory. The original engineering pilot is retained separately under `pilots/20260925/` in the website.
