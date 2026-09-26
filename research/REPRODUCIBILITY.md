# Reproduction and release evidence

Two distinct operations must be reproducible. **Replay** checks saved theorem
and proof bytes with the pinned verifier and regenerates scores. **Replication**
dispatches new hosted-model sessions under a recorded protocol and will not
necessarily yield identical proofs. Exact proof replay is a stronger and more
achievable promise than exact regeneration of a hosted model's behavior.

## Offline verification from a clean checkout

Check out the release containing the public evidence bundle. With Node 22 or
later and the repository's Rust toolchain available, run:

```sh
npm ci
cargo build --locked --release --no-default-features --bin propbench-validate
npm run publication:verify
```

Dependency installation and the first build may need network access. The
verification command itself is offline: it uses only
`publication/data/results.json`, its public theorem/rule/proof assets, and the
local strict verifier. It does not use `track-runs/`, a Codex login, native-client
events, private answer keys, or model inference. The reduced validator has the
same strict replay implementation as the owner CLI; it excludes generation.

To replay a separately downloaded public bundle, pass its results file:

```sh
npm run publication:verify -- --data /path/to/data/results.json
```

The verifier checks the exact frozen v2 manifest/theorem bytes, embedded formulas,
rulebook hash, exact proof-file bytes, canonical proof hashes, proof protocol,
and every published valid proof with `validate --strict-protocol`. It recomputes
losses, singleton set identities and cohort hashes, checks all 96 planned units,
condition budgets and terminal statuses, and validates cumulative parent links
and snapshot inventories. It rejects altered bytes, invented scores, omitted
completed jobs, unsafe asset paths, mismatched cohorts, and invalid proofs even
when their declared hashes have been recomputed.

When a Frontier run includes an `improvements` sequence, replay also checks every
accepted checkpoint's exact proof bytes, strict validity, previous-incumbent
length, decreasing proof length, increasing checkpoint/import/exec order, and
recorded capture within the 900-second allowance. Its last proof must match the
final incumbent. Cumulative sequences begin with the same item's inherited
incumbent. Older exports may omit the sequence; the verification output reports
how many Frontier runs include or omit it. Canonical ordering explicitly uses
the campaign machine's `en-US` collation, independent of the reader's locale.

The JSON result explicitly reports `census_complete: false` for a partial
campaign. An internally consistent partial export may verify successfully;
that does not assert all planned jobs ran. `job_counts` distinguishes scheduled,
active, completed, and interrupted units. `independently_replayed_proofs` is the
number actually passed to the strict referee, including visible proofs from
interrupted runs; those runs remain excluded from completed-run counts. It
includes checkpoint proofs and final incumbents separately, even when the last
checkpoint and final incumbent contain identical bytes. Their counts appear as
`independently_replayed_checkpoint_proofs` and
`independently_replayed_incumbents`.

The local validator's SHA is reported separately from the original owner's
SHA. Another platform, compiler, or the reduced CLI can produce a different
binary while replaying the same formal proof. The normal command verifies the
proof semantics under the supplied local build and **does not claim original
binary identity**. To require that additional identity check when the exact
original executable is available, use:

```sh
npm run publication:verify -- --validator /path/to/original/referee \
  --require-exact-binary
```

Use the released source and pinned `Cargo.lock` for a source rebuild. Passing
an arbitrary executable cannot authenticate its implementation. The output
states the actual local binary hash so independently reproduced verdicts can
be attributed correctly.

For an authenticated download, obtain the expected `results.json` SHA-256 from
a separately trusted release record, then pass it as
`--expected-results-sha256 THE_64_HEX_DIGEST`. This pins the metadata that in turn
pins the theorem, rule and proof assets. Without that external anchor the tool
checks internal integrity, not publisher authenticity: a consistently rewritten
bundle is not a signed execution record. It also cannot prove hosted inference
or tool isolation from public summaries alone. Snapshot inventories bind
declared lineage, but unpublished tool/journal bytes are not independently
replayed or authenticated by this command.
Checkpoint capture times and execution order are consistency checks on
owner-recorded metadata; proof replay does not authenticate the owner's clock.

Tamper tests run without provider access:

```sh
node --require ts-node/register --test scripts/verify-publication.test.ts
```

## Freeze before the scored campaign

Create a clean source commit after the isolation, checkpoint, and native-client
changes and required tests. Record commit ID and SHA-256s of the evaluator
sources, rules, lockfiles, owner validator, contestant validation-only binary,
dataset manifest, exact prompts, and campaign plan. Preserve source archives:
the historical September pilots do not have a byte-exact source snapshot for
every original run and cannot substitute for this freeze.

Record OS/architecture, Node and Rust versions, native Codex version/executable
hash, returned model/effort metadata, Docker runtime version, exact image ID and
architecture, CPU/memory/process limits, and host concurrency. The Dockerfile's
base tags and apt repository are mutable; save the exact built image or a
retrievable content-addressed image plus package inventory. A future rebuild
from the same Dockerfile is not automatically the same experimental runtime.

The acceptance log should include current source/typechecks, strict replay and
adversarial protocol tests, deterministic rehearsals, native empty-tool canary,
actual isolated exec canary, network/host-access denial, generator-command
denial, deadline cancellation, checkpoint monotonicity, and finalization sealing.
Passing source tests alone does not establish live native-client isolation.

## Executable unit commands

These commands illustrate one unit of the frozen schedule, not permission to
change the schedule after seeing results. Use `node --require ts-node/register`
to obtain JSON output directly. The campaign driver should retain prepare/run
stdout, stderr, exit status, and job-to-run mapping rather than discover only
successful reports after the fact.

```sh
node --require ts-node/register tracks/cli.ts prepare \
  --track unaided --set v2 --ids g1-2000001 \
  --provider codex-subscription --model gpt-6-astra --effort xhigh \
  --seconds 900 --tool-calls 0 --run-root track-runs/CAMPAIGN/runs

# PROPBENCH_RUN is the exact `run` path from the preparation JSON.
node --require ts-node/register tracks/cli.ts run-unaided --run "$PROPBENCH_RUN"
node --require ts-node/register tracks/cli.ts grade --run "$PROPBENCH_RUN"

node --require ts-node/register tracks/cli.ts prepare \
  --track frontier --mode fresh --set v2 --ids g1-2000001 \
  --provider codex-subscription --model gpt-6-astra --effort xhigh \
  --seconds 900 --tool-calls 128 --run-root track-runs/CAMPAIGN/runs
node --require ts-node/register tracks/cli.ts run-frontier --run "$PROPBENCH_RUN"

# PROPBENCH_ARCHIVE names that item's accepted owner archive from its fresh run.
node --require ts-node/register tracks/cli.ts prepare \
  --track frontier --mode cumulative --snapshot "$PROPBENCH_ARCHIVE" \
  --set v2 --ids g1-2000001 \
  --provider codex-subscription --model gpt-6-astra --effort xhigh \
  --seconds 900 --tool-calls 128 --run-root track-runs/CAMPAIGN/runs
node --require ts-node/register tracks/cli.ts run-frontier --run "$PROPBENCH_RUN"
```

After **each** preparation, use its newly printed run path; never reuse a
started run. Execute both Unaided repeats and all 24 manifest IDs through the
frozen campaign schedule. The examples above are not a one-item result to be
extrapolated to 24. On quota/auth failure, retain the job status; do not switch
provider, lower effort, or create a hidden retry.

## Campaign index and aggregation

The campaign manifest/index must map every planned unit to: configuration;
arm; repeat number; item ID; attempt ordinal; execution order; run ID; source
freeze; expected budget; status; starting archive digest; and any replacement
or parent run. Keep planned-but-not-started jobs too. Store an ordered append-only
event ledger for dispatch, completion, interruption, and amended plans.

For each unit retain `run.json`, `preparation.json`, frozen theorem/rule bytes,
final proof and strict verdict, report, subscription state, session receipts,
tool receipts, checkpoint/candidate bytes and verdicts, finalization marker,
and initial/final artifact snapshot indexes. Preserve invalid final responses
and unsuccessful candidates as evidence, subject to the release review below.

Aggregate by the prespecified arm/configuration/repeat, not by taking the
best available report for each theorem. Singleton runs intentionally have
different set/cohort hashes. Verify that their source, protocol, budgets,
client, rules, scorer, runtime, and complete set union match the campaign;
then compute the 24-item mean from verified item rows. Do not use the ordinary
per-run comparator as if it already produces a full-census aggregate.

For cumulative arms, verify parent/archive links, independent baseline validity,
and deltas from that exact baseline. A common tool snapshot, or a union of
proofs from multiple runs, requires its own lineage and seeded/cumulative label.
Report the number of source attempts used to build a portfolio.

## Public evidence bundle

Publish a manifest with relative file paths, byte lengths, SHA-256s, format
versions, provenance, and release status. At minimum include source/version
links; protocol; dataset; proof/rule formats; selected IDs/pars; saved accepted
proofs; strict verdicts; all-item outcome tables; campaign/run indexes; declared
budgets and observed usage coverage; and analysis commands. Preserve original
report identities when regrading and label the regrader's own source identity.

Review the export instead of publishing `track-runs/` wholesale. Native events
can contain account metadata, local paths, user-generated text, and content
unnecessary for scoring. Keep private originals immutable; create a separately
hashed public redacted export with a documented field-removal policy. Never
include authentication state, credentials, environment dumps, or private data.
Recheck the actual exported bytes for secrets and external content permissions.

Accepted proof replay should work offline using the saved validator for its
platform or a source-built strict validator from the frozen commit. A clean
reproducer should verify every hash, revalidate every proof, reconstruct every
denominator, and regenerate aggregate numbers without native-model access.
For portability, preserve both binary identities and source/build instructions;
matching source does not imply matching binary hashes across architectures.

Finally run the documented reproduction from a clean checkout and inspect the
public artifact directory. Record which steps passed, which need online model
access, and which historical evidence remains unavailable. A paper/site link is
publication only after the destination exists and the linked bundle is verified.
