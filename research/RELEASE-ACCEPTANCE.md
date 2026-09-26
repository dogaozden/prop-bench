# Publication release acceptance

The static website and public evidence are ready to copy to a website directory.
External deployment has not been performed. This is a **partial engineering case
study**, with 43/96 completed jobs, 40 accepted final proofs, three missing
outcomes and 53 unstarted jobs. See [RESULTS.md](RESULTS.md) for interpretation.

## Accepted source and package

- Application, harness and public data source: `a171d05836888c35c68bcc24564cfe1661c74231`.
- Frozen experiment source: `64b2026857d0dc9da54497eca50cf7a63534e95f`. The repaired harness does not rescore the frozen experiment.
- Ready-to-upload archive: `dist/propbench-publication.zip`, 143 files.
- ZIP SHA-256: `0c1140bb1028776ea00b0eee04ce5d7eb4d25f134545b858f3c54f2a44b42be6`.
- Public results SHA-256: `73cf5bdbf0aed3d8c203980b619c52806341687cb20c71b7d38476cbdfcca0c9`.

Extract the ZIP's contents into the intended static website directory, keeping
its relative paths intact. It works at a nested path such as
`/research/propbench/`; no build, backend, account or provider credentials are
needed. See [PUBLISHING.md](../PUBLISHING.md). The local preview is served at
`http://localhost:8769/`.

## Acceptance evidence

- **Exact archive:** all 142 assets listed by `release.json` matched their byte hashes after extraction.
- **Browser:** the extracted archive passed at 1280, 390 and 320px under `/research/propbench/`, with no console errors or horizontal overflow. All 24 theorem rows appeared; the nine-line cumulative proof, notation guide, exact proof download, JSON/CSV/rule assets and archived pilot link worked.
- **Local checks:** TypeScript, 115 track tests (zero skips, actual Docker), 95 campaign/export/replay/package tests and 19 publication tests passed.
- **CI:** the full Linux/Node 22 workflow [passed for accepted source `a171d05`](https://github.com/dogaozden/prop-bench/actions/runs/36224566507), including Rust, real Docker, all test suites, primary/pilot replay, static packaging, GUI build and adversarial referee checks. The workflow also provides a downloadable publication artifact; its independently regenerated receipt and ZIP may differ from the local archive's exact bytes.
- **Native regression:** one actual Codex subscription session proved the capture repair accepts a canonical proof beside a benign draft and retains it after a later overwrite. Strict replay and process cleanup passed. This [supplied-answer canary](capture-repair-canary.md) is unscored and excluded from the experiment.
- **Independent replay:** a fresh checkout built its own reduced validator and replayed all 51 primary and 17 pilot artifacts with network and original-checkout access denied. [Receipt and limits](clean-release-replay.md).
- **Privacy:** reviewed public assets exclude raw sessions, account credentials, host paths and private answer keys. Packaging uses an explicit asset allowlist and rejects unexpected or altered evidence.

Machine-readable package and browser evidence is in
[publication-acceptance.json](publication-acceptance.json). Subsequent changes
that only add these acceptance documents do not alter the accepted source,
experiment bytes or ZIP.

The observed capture defect, stopped schedule and unknown proof optima remain
disclosed. Successful tests and replay do not establish a full-census model
ranking, human equivalence, contamination freedom or identical hosted-model
replication.
