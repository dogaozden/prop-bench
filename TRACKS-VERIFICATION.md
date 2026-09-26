# Local acceptance — September 7, 2026

The two-track implementation passed local acceptance. No paid model generations
were launched. Frontier isolation was exercised in real Linux containers on
this Mac; provider responses were deterministic fixtures or injected test
responses, not live model-quality measurements.

## Completed checks

| Check | Observed result |
|---|---|
| Complete TypeScript tracks suite | **49 passed, 0 failed, 0 skipped**, 13.278 seconds |
| Rust strict protocol + existing validator/replay/golf suites | **22 passed**: 4 strict, 6 validator, 3 replay, 9 golf |
| Root TypeScript check | Passed |
| GUI TypeScript and production build | Passed; Vite built 73 modules |
| Deterministic CLI rehearsal | Passed Unaided, fresh Frontier, cumulative Frontier, external handoff/import, sealing, and comparisons |
| Actual GUI interaction | Unaided and fresh Frontier completed through the Tracks form; result tables and separate rankings visually inspected |
| Historical compatibility | No changes to `golf/`, Cargo manifest/lock, existing golf/replay/validator test files; adjacent `logic-core` checkout clean |

The tracks suite covers proof validity/counting, malformed proofs, scope/range
checks, scoring against omission, frozen set identity, verifier/config drift,
cached-score regrading, single-attempt accounting, concurrent duplicate
prevention, uncertain transport, provider request shapes, no Unaided tools,
shared Frontier delegation budgets, invalid tool calls, sealed finalization,
fresh exports, explicit cumulative snapshots, and monotonic external imports.

Physical checks exercised shell, Python, Node, a C compiler, ripgrep, jq, and
the real Linux validator. They verified denied reads/writes outside the mounted
bundle, denied network and Docker-socket access, absent owner secrets, a
read-only validator, bounded output, and removal of detached `setsid` children
after both normal completion and timeout. Absolute `/workspace` executables
were tested as well as relative paths. No test sandbox containers remained
after the dedicated physical suite.

## Rehearsal results and retained records

The final rehearsal used the `rehearsal` set and `efficiency-v2` scorer:

| Run | Generations | Sandbox commands | Valid lines | Loss | Ranking |
|---|---:|---:|---:|---:|---|
| Unaided fixture | 1 | none | 1 | 0.5 | Own fixture cohort |
| Fresh Frontier fixture | 4, including delegate | 1 | 1 | 0.5 | Own fixture cohort |
| Cumulative Frontier fixture | 1 | 0 | 1 inherited | 0.5 | Separate snapshot cohort |
| External submission | Unknown | none | 1 | 0.5 | Excluded: unmetered |

Exact records, requests, proof receipts, archives, and reports were copied to
[the final acceptance archive](track-runs/acceptance-final-20260907/result.json).
Its `result.json` retains the original temporary run paths. The archive contains
the complete `runs/` and `bundles/` trees, plus named command outputs such as
`frontier-report.json`, `cumulative-report.json`, and `comparison.json`.
Fixture-reported token counts are synthetic bookkeeping evidence.

The GUI used a separate database and run root under
`/private/tmp/propbench-ui-acceptance-lfwZvL`, preserving historical SQLite data.
The observed fresh Frontier GUI run was `92b1b85b-4b6…`: four generations,
one execution command, one valid line, loss 0.5000, and the runtime below.

## Runtime and reproduction

Owner runtime: Node **25.2.1**, macOS. The installed SQLite binding uses this
Node ABI; install dependencies with the Node version used to run the GUI.

Dedicated Colima profile: `propbench`, 2 CPUs and 2 GiB memory. The existing
default profile was not activated or modified. Image platform: `linux/arm64`.

```text
sha256:daf0978d5c55d5cc5a9a2d1c4a7011432fa7023b7a1030c1bcbcc45c5a22c459
```

From this repository, with the built Rust validator and installed dependencies:

```sh
export PROPBENCH_DOCKER_HOST="unix://$HOME/.colima/propbench/docker.sock"
npm run rehearsal:tracks
npm run test:tracks
npm run typecheck
cargo test --offline --test strict_protocol --test validator_regression --test replay_roundtrip --test golf_score
cd gui
npm run build
```

The image was built from the restricted context with `tracks/Dockerfile`.
Evaluations never build/pull images automatically and pin the inspected local
image ID for the entire run. See [the track guide](TRACKS.md) for setup and
individual prepare/run/grade/compare commands.

## Review repairs and limits

Independent review prompted repairs for cached score trust, missing inference
metering in external handoffs, mutable image tags, contestant/infrastructure
failure classification, response metadata misclassified as tools, and
post-completion proof imports. Regression tests cover these repaired contracts.
Default historical Rust replay remains unchanged; the new tracks opt into
strict depth and subproof-range validation.

Intermediate checks exposed a TypeScript compiler-startup timeout in the MCP
test, legacy Docker incompatibility with `COPY --chmod`, and an invalid bind
mount option. These were repaired before acceptance. A rehearsal started during
a sandbox source edit correctly rejected evaluator drift; its failed evidence
was retained, and a new run on frozen source passed. The abandoned native
macOS sandbox could not guarantee detached-process cleanup; Docker is the sole
execution backend.

Live provider compatibility for a chosen model, actual reasoning-token behavior,
billing, proof quality, and difficulty calibration remain empirical follow-up
work. Other hosts must run the physical checks themselves. No minimum-proof,
universal-hardness, human-equivalence, or saturation-resistance claim follows
from these fixtures. No files were committed or pushed.

## September 8: native subscription correction and scored Codex pilot

The owner clarified that inference must use the existing Claude and Codex
subscriptions. The Tracks UI and API now select native subscription clients;
CLI preparation defaults to Codex subscription. Existing API adapters remain
legacy code. No OpenRouter inference was performed for this correction, and
neither subscription adapter falls back to an API key.

Codex uses the installed native 0.153.4 client and its ChatGPT login. The exact
requested model and effort are checked before dispatch. Claude uses the native
Claude Code 2.1.263 client and its claude.ai subscription login. Neither adapter
extracts credentials, replaces HOME, or alters global user configuration.

Actual v2 pilot, theorem `g1-2000001`, reference length 13:

| Track | Requested and observed model | Effort | Valid lines | Loss | Elapsed | Sessions | Tool calls |
|---|---|---|---:|---:|---:|---:|---:|
| Unaided | gpt-6-astra | xhigh | 6 | 0.315789 | 53.987 s | 1 | 0 |
| Frontier, fresh | gpt-6-astra | xhigh | 6 | 0.315789 | 600.002 s | 4 | 24 |

Unaided run: `b97651c4-703c-47e4-aeb8-70f22d81c6a0`.
Frontier run: `f275fd7f-0e10-4009-a78e-3bfedf64c996`.
The Frontier calls comprise 21 actual Docker execution commands and three
delegation calls. Its shared ten-minute allowance expired normally; the last
saved proof was graded after execution stopped. Two of its four native sessions
have completed usage receipts, so full-run token usage is unknown. Unaided
reported 4,661 input and 1,438 output tokens. Native internal request/retry counts
are client-owned and not claimed as independently metered.

Both saved proofs were checked again directly with their own pinned Rust
referee binaries. Both independent verdicts are valid, six lines, zero errors.
This one-theorem pilot verifies operation; it does not establish relative model
strength, shortest possible proofs, or human equivalence. The tracks have
different tool/time conditions and remain separate comparison cohorts.

Claude's no-tool and Frontier MCP transport canaries passed with the native
Max subscription earlier. The first scored attempt exposed a macOS path-alias
comparison issue, repaired using canonical paths. Subsequent scored dispatches
stopped before inference because native `claude auth status` reported logged
out. These interrupted runs remain unranked. Native reauthentication was opened
and requires the owner's Cornell SSO; no credential or provider fallback was
used. Actual Claude proof performance remains unmeasured.

Final defensive audit bound Codex tool calls to the exact thread and turn,
rejected duplicate call IDs and unexpected namespaces, validated terminal-only
tool items, expanded environment/event credential filtering, and scoped native
Codex termination to its own process groups. Generic upstream timeouts are now
interrupted infrastructure outcomes, not completed benchmark budgets. Tests
also cover subscription cancellation, finalization ownership, quota stops,
tool leakage, and exclusion of injected clients from live evidence.

Final verification: **72 TypeScript tests passed, zero failures or skips**, in
6,132.105833 ms, with the real dedicated Docker runtime and MCP stdio process.
Root and server strict typechecks, GUI typecheck and production build passed.
After the audit, new native Astra canaries passed both no-tool READY and a single
Frontier exec callback. The latter is a transport check with a fixed callback;
the earlier scored Frontier pilot exercised actual Docker computation.
The unchanged Rust verifier's 22-test acceptance remains recorded above.

Scored pilots predate this final defensive audit. Their original evaluator
hashes remain in the reports; regrading records its own evaluator hash without
rewriting the original identity. A source snapshot from immediately before the
final audit and a snapshot of the final source are retained. The former includes
the Claude path-alias fix made after the Unaided pilot and is not represented
as a byte-exact snapshot of every earlier run.

The subscription form, results and interrupted-run labels were inspected in
the live UI during integration. The final visual revisit was unavailable
because the Mac was locked; the final build and HTTP checks passed. The existing
preview launchd jobs serve localhost:3000 and localhost:3001 using durable
run/database roots, without changing the historical database. Login-session
jobs may need bootstrapping again after a reboot.

Machine-readable results, complete per-run records, independent verdicts,
source snapshots, transport events, and the final test log are retained in
[the subscription evidence archive](track-runs/subscription-live/result.json).
No commits or pushes were made.

## September 25: Codex-only publication preparation

New live runs now use native Codex only, including both GUI and CLI entry points.
The preserved Claude/API adapters and earlier records are historical. The current
audited Codex build is 0.158.0-alpha.2, identified by exact executable hash and
checked for subscription auth, model, effort, normal service tier, instructions,
environment roots and exposed tool controls. Both live Unaided READY and native
Frontier READY through real Docker passed under those controls.

The full CLI previously available inside Frontier could regenerate a planted
answer key from an item's public seed. Independent reproduction took 138 seconds
and recovered a valid 13-line proof. The new runtime contains a validation-only
binary and no generator commands or source tree. Direct invocation of the former
exploit is rejected. Exact valid/invalid strict-replay parity was independently
checked in the immutable image; see the sanitized research audit records.

Frontier subscription v2 retains timely, independently verified proof improvements
and snapshots of tools/journals. Finalization and cumulative inheritance consume
only captured owner records. Real Docker tests covered a writer active at cutoff,
detached-child removal, later mutation rejection and checkpoint serialization.

Before campaign dispatch: 97 track tests, six campaign/export tests, four owner
HTTP tests and eight public-viewer tests passed, all with zero failures/skips.
Root/server typechecks and the GUI production build passed. The 26 targeted Rust
tests include four narrow-binary compatibility/isolation cases and 22 strict or
legacy replay/scoring cases. Native sessions and fixed callbacks are separately
labeled in local control evidence; they are not theorem-performance results.

The owner console rejects non-loopback binds, public browser origins and DNS
rebinding hosts. Campaign runs can be inspected without the GUI creating reports
for prepared or active jobs. The standalone public site uses an allowlisted
export and no model/backend access. Its desktop/mobile and website-subpath
checks passed; fixtures used for UI checks are not in published results.

The expanded experiment is prespecified in research/PROTOCOL.md: 24 singleton
items in four conditions, matched 900-second allowances, requested Astra xhigh,
128 Frontier tool calls, with exact source/runtime identities in the campaign
manifest. Completion and outcomes must come from that manifest/state and the
independently replayed publication export, not from this pre-campaign acceptance.

## September 25: repaired runtime and retained pilot

The first 96-job campaign stopped after eight completions and four interruptions;
84 jobs were never dispatched. Three malformed allowed-tool calls were treated
as fatal protocol violations, and a deadline cleanup signal raised an unhandled
EPERM error. The pilot, original artifacts and explicit recovery receipts are
preserved; it is not a completed census. The public archive contains 17
independently replayed final or checkpoint proof artifacts.

Allowed-tool argument errors now return a charged owner rejection without
execution. Capability and session violations remain fatal. Cleanup requires
confirmed process-group absence and stream closure, preserves infrastructure
errors and uses bounded termination. Two live native canaries verified recovery
from malformed exec input and deadline cleanup with two native sessions and a
Docker execution. Neither left owned processes or containers behind. EPERM
itself was covered by a simulated denied-signal regression, not reproduced
in the physical canary. See the sanitized native repair audit.

Post-repair checks: 110 track tests with real runtime-3 Docker, 51 script tests,
four server tests and 15 public-site tests passed with no failures or skips.
The full Rust release suite passed all 33 integration tests. Root typecheck and
GUI production build passed. Linux Cargo hardlink handling and the Node 22
legacy test fixture were separately repaired after the initial CI failure.
The new full campaign remains pending at this acceptance point.

The clean Ubuntu/Node 22 CI run for the frozen repair commit
[`64b2026`](https://github.com/dogaozden/prop-bench/commit/64b2026857d0dc9da54497eca50cf7a63534e95f)
completed successfully, including the full Rust suite, actual Docker runtime,
TypeScript/server/public-site checks, offline public proof replay, static ZIP
packaging, GUI build and legacy referee end-to-end tests:
[CI run 36221608551](https://github.com/dogaozden/prop-bench/actions/runs/36221608551).
That CI replay covered the retained pilot bundled at the freeze; the replacement
campaign receives a separate final export and replay after it terminates.

## Publication and capture repair, September 26

After the campaign closed, selected-proof checkpoint capture was repaired to
ignore harmless regular JSON drafts while retaining link, topology, size and
deadline checks. The default bench command now opens the subscription Tracks
CLI; historical API entrypoints and docs are explicitly labeled.

Local acceptance: TypeScript passes; 115 track tests pass with zero skips using
the actual runtime-3 Docker image; 95 campaign/export/replay/package tests pass;
19 publication tests pass. The original campaign export independently replays
40 final proofs and 11 checkpoint artifacts. Its frozen source and scores are
unchanged by the subsequent repair. A targeted native regression and clean
release checkout replay are recorded separately after execution.
