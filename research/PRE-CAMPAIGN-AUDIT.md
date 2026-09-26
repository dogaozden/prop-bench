# Pre-campaign methodology audit

Audit date: 2026-09-25. This is a findings record, not certification that fixes
have landed. The campaign freeze record must link each applicable closure to
source changes and fresh evidence. The inspected starting checkout included
uncommitted Tracks implementation, so its HEAD alone does not identify it.

| Finding | Consequence | Minimum closure |
|---|---|---|
| Unaided uses a run-level deadline across a sequential item loop | Earlier items consume later items' allowance | Fixed-budget singleton dispatch and externally defined full-set aggregation |
| Controlled Frontier imports only at finalization | An intermediate valid proof can be overwritten/lost before the owner sees it | Capture exact candidate bytes after exec, independently validate, retain monotonic incumbents, then seal |
| Docker exposes the full `propbench` CLI as `validator`, including `golf plant`; IDs disclose seeds | Contestant can reconstruct planted keys within its advertised tool boundary | Ship a validation-only executable; direct `/opt` execution must not recover generation/analysis commands |
| Cohort configuration does not include native client executable identity | Records using different client implementations can pool | Bind campaign acceptance to one audited client version/hash and include them in published group keys |
| Native adapter records but does not explicitly compare returned thread effort | Requested effort may be mistaken for effective effort | Validate returned effort where the client reports it; preserve evidence/limitations otherwise |
| Docker base tags and apt packages are mutable at build time | A recipe alone cannot recreate the exact runtime | Archive the exact image/digest and tool/package versions; record build provenance |
| `CITATION.cff` used “Saturation-Proof” | Title claims an unproved property | Use the neutral proof-construction/proof-golf title |
| Dataset provenance lived in sibling-repo notes; keys are outside the repo | A clone does not contain the full freeze audit trail | Include a self-contained provenance account; archive lawful release inputs and exact command/log hashes |
| Fresh v2 is public, with seed-encoded IDs and historical solutions | Fresh-run isolation cannot establish training decontamination | Explicit public/development-set limitation; no “unseen” claim |

Relevant code: `tracks/subscription-runner.ts`, `tracks/core.ts`,
`tracks/frontier.ts`, `tracks/subscription-codex.ts`, `tracks/Dockerfile`,
`src/main.rs`, and `src/golf.rs`.

Existing strengths: theorem/manifest hashes, sealed preparation receipts,
independent pinned referee, strict scope replay, scored invalid final answers,
separate fixture/external/subscription evidence, explicit inheritance digests,
native tool guards, and retained interrupted records. These should be preserved.

## Concrete generator exposure reproduction

`generator-leak-audit.json` records a local owner-CLI reproduction. Calling
`golf plant` with the publicly encoded seed/band and documented generation
settings produced byte-identical `g1-2000001` and a strict-valid 13-line planted
proof in 138.075 seconds. No stored answer key or model was consulted, and the
temporary regenerated proof was removed after the check. The historical Docker
image exposed that same full CLI command surface; this establishes a concrete
in-budget recovery route for a 900-second allowance. It is not a new contestant
score or a runtime exploit test of the replacement image.

The replacement validation-only CLI received independent host checks in
`validation-only-audit.json` (debug) and `validation-only-release-audit.json`
(release): valid MP, invalid formula, claimed-depth mismatch, wrong numbering,
and empty proof had byte-exact stdout/stderr/exit parity with the owner CLI;
direct golf/generate/analyze commands were rejected. The release also contained
none of four generator-specific string patterns. These host checks do not
substitute for the final Docker image canary and hash.

That image check subsequently passed independently: see
`validation-runtime-audit.json` for immutable arm64 image
`sha256:711a221ecfe9e27b8d52f6f278a85dcbde9bea80a8bf2eb9d17d419e4d013a5e`.
The five strict parity cases passed in Docker; direct `/opt/propbench/validator`
golf/generate/analyze commands returned exit 2; root inspection confirmed
`/build`, `/usr/local/cargo`, and `/root/.cargo` absent; the four inspected
generator string patterns were absent. The Linux validator hash was
`929c320a0f029b5794f9a6ec94b6084ef70bdc65b998469cb3952318de99bee6`.
This closes the demonstrated bundled-CLI generation route in that image, not
the broader public-data contamination limitation.

## Checkpoint review

The revised Frontier subscription v2 path was independently reviewed and four
focused owner/fixture tests passed without skips; `checkpoint-audit.json`
records the source hashes, command, and test scope. The reviewed implementation
freezes proof and tool/journal bytes before cutoff, preserves shorter valid
incumbents across later overwrites/deletion, uses the latest timely owner
snapshot for cumulative inheritance, and forces interruption on owner-verifier
failure even if a client catches its tool error. It records elapsed and remaining
shared allowance at capture. These are source/fixture checks; final integrated
Docker/native checks remain the campaign acceptance gate.

Do not block the campaign on a wholesale scoring redesign, new dataset, or a
large statistical framework. Fix the concrete isolation/retention issues, freeze
the protocol, and report the exact limits of the resulting evidence.
