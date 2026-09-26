# PropBench Frontier and Unaided

Frontier asks how much a fully equipped agent can improve short proofs. Unaided
asks how well a model can construct those proofs without external computation.
New runs use the owner's **Codex/ChatGPT subscription** through the installed
native Codex client. They share the Rust replay verifier, the
[rulebook](rules.md), and the same selected theorems. Historical golf and Elo
runs remain separate. The Tracks page does not offer paid API-key runs.

## Shared proof and scoring contract

A proof is a JSON array of derived lines. The verifier inserts premises as lines
1 through N; submit consecutive line numbers starting at N+1. Each object has
`line_number`, `formula`, `justification`, and `depth`. New tracks use `validate --strict-protocol`: claimed depths and
CP/IP ranges must match the engine-derived scope. Legacy replay retains its
original behavior. For the rehearsal theorem
`P > Q, P ⊢ Q`, submit:

```json
[{"line_number":3,"formula":"Q","justification":"MP 1,2","depth":0}]
```

Premises are free. Every submitted assumption, derived line, and CP/IP closing
line counts. Scope and validity are decided by Rust, including closed-scope
access and contradiction checks. The contestant's claimed length never counts.

New track runs use **efficiency-v2**: a valid proof of L lines on an item with
par P has loss `L / (L + P)`. Missing or invalid answers have loss 1. A run's
score is the mean loss, lower is better. Every finite valid proof beats omission;
removing a line improves its loss. Par scores 0.5. Coverage and raw verified
lengths are shown alongside this score. This fixes the legacy golf omission
incentive without changing old scores or data.

Par is a known achievable length, never a certified optimum. `rehearsal` is a
one-item integration set; `v2` is the existing 24-item frozen golf set. Select
subsets with `--ids ID,ID`. Selection, original theorem bytes, pars, and core
version contribute to the set identity. Calibrate harder selections empirically;
bounded search failure alone establishes neither hardness nor optimality.

## Subscription runs

The live client is `--provider codex-subscription`. Authenticate through
`codex login` if needed. New runs refuse Claude and API-key providers; historical
records retain their original labels. PropBench checks the native subscription login and
refuses API-key authentication; it never extracts OAuth tokens to call a model
endpoint, uses OpenRouter as a fallback, or changes your global client settings.

Use the Tracks page to choose a subscription, explicit model, reasoning effort,
and selected theorems. Or prepare a run from the CLI:

```sh
npm run tracks -- prepare --track unaided --set v2 --ids g1-2000001,g2-2100023,g3-2200607 --provider codex-subscription --model gpt-6-astra --effort xhigh --seconds 900
npm run tracks -- run-unaided --run '/printed/run/path'

npm run tracks -- prepare --track frontier --mode fresh --set v2 --ids g1-2000001,g2-2100023,g3-2200607 --provider codex-subscription --model gpt-6-astra --effort xhigh --seconds 900 --tool-calls 96
npm run tracks -- run-frontier --run '/printed/run/path'
```

Use an installed, subscription-supported model and effort. Unsupported choices,
login failures, or quota exhaustion produce retained errors rather than silently
switching models or billing methods. Usage comes out of the existing subscriptions.

**Unaided** starts one fresh native-client session per selected theorem. Its
enforced tool surface is empty: no filesystem, shell, scripts, browser, MCP,
skills, delegation, or verifier feedback. The owner grades only after the client
returns its final proof. A malformed or invalid proof is final; the harness
never gives it back to the model for repair.

**Frontier** provides only two workspace capabilities to the native agent:
`exec` for arbitrary commands/scripts/solvers and verifier checks inside the
isolated Linux container, and `delegate` for fresh assistants sharing that
workspace. Parent and children share one wall clock and tool allowance, at most
eight client sessions and depth four. Native host shell/filesystem tools are
removed. The contestant cannot access the owner checkout, keys, run records,
or neighboring bundles. Fresh and cumulative history retain their meanings below.

Subscription clients control their own inference loop and transport behavior.
PropBench enforces the wall clock and Frontier tool allowance and records the
requested effort, client version, actual returned model, tool catalog, events,
and available token usage. **It does not claim numeric output/thinking-token
caps or exact model-request counts for subscription sessions.** Legacy numeric
API controls are not part of subscription comparison cohorts. Reports show
client-session counts separately, and SDK cost estimates are not reported as
API charges. Subscription protocols and evidence are separate from API and
fixture runs. Quota/auth/transport failures stop new session dispatch and keep
partial evidence; there is no automatic rerun.

The native adapter discovers Codex in a standard desktop application bundle or
PATH, or uses an explicit absolute `PROPBENCH_CODEX_PATH`. It currently accepts
only audited version `0.158.0-alpha.2` with binary SHA-256
`c3e30211bd454da70ceb4d9cbc2e05fe6466812ab05c311c3bbff6addeb14202`.
A different build fails closed pending a control audit. This is a current macOS
execution boundary, not a claim that every installed Codex version is supported.
The Docker verifier and published proof replay are independent of native model
client availability.

The app-server does not expose a complete resolved tool-catalog RPC. Evidence
therefore records the installed binary hash, native-resolved model metadata,
effective configuration, empty environment selection and explicit dynamic tools.
The adapter checks exact returned model, effort and normal service tier. It
disables inherited skills, plugins, MCP, memory and host execution, denies global
instruction files for the child process, and audits all streamed/terminal items
and tool calls. Account authentication stays in the real native login directory;
credentials are never copied and global configuration is unchanged.

Frontier subscription protocol v2 captures valid proof improvements after each
isolated command, before the shared deadline. Captured bytes are independently
replayed and can replace an incumbent only when shorter. Tools and journals are
also frozen before cutoff for cumulative inheritance. Snapshot/verification work
is part of the scaffolding and consumes wall time while the contestant waits;
final grading can finish after execution stops. Late working-file mutations are
never incorporated into a sealed v2 result. Earlier v1 results retain their
original identities and are not pooled with v2.

The preview stores subscription runs durably under
`track-runs/subscription-live/runs`; public Frontier workspaces are under the
sibling `propbench-contestants/subscription-live` directory. Session events,
exact prompts, tool receipts, final proofs, and independent referee reports are
retained, including interrupted attempts. Runtime identity is sealed, and
controlled finalization imports only captured bytes from the registered bundle.

## Setup and local fixture example


Run from the `propbench` directory using Node 22 or later. Install and run with
the same Node version, because the existing GUI database dependency is native.

```sh
cargo build --release
npm ci
npm run tracks -- sets
npm run tracks -- prepare --track unaided --set rehearsal --provider fixture --model fixture --generations 1 --tokens 256 --thinking 0 --seconds 30
```

The command prints the owner-side `run` directory. Set `RUN` to that printed
path, then:

```sh
RUN='/absolute/path/printed/as/run'
npm run tracks -- run-unaided --run "$RUN" --fixture-responses tracks/fixtures/unaided-rehearsal.json
npm run tracks -- grade --run "$RUN"
npm run tracks -- compare
```

The deterministic fixture produces one valid derived line, coverage 1/1, and
loss 0.5. It is explicitly labeled a fixture and never ranked in a provider
cohort. Re-running a populated Unaided run is rejected. Prepare a new run for
another attempt; every run remains visible.

## Historical API adapters

The earlier OpenRouter/Gemini adapters remain in the source for compatibility
with old records and tests. They are not used by subscription runs or exposed
as run choices on the Tracks page. Old API results retain their original
protocol and comparison cohorts.

## Frontier: controlled execution

Frontier uses a dedicated Linux container with shell, Python, Node, a compiler,
and the shared Rust validator. Build the runtime deliberately; evaluation never
pulls an image or falls back to host execution:

```sh
docker build -t propbench-frontier:2 -f tracks/Dockerfile .
```

The build context is restricted by `.dockerignore` to the Rust sources and
runtime recipe. It excludes repository history, keys, answer keys, and run data.
The image supplies a validation-only Linux executable without generator or planted-proof reconstruction commands; `./validator` in each bundle launches it.
The owner keeps a separate native referee snapshot for official grading.
Before the first generation, the driver records the image's immutable ID and
architecture. Every command uses that ID, and different runtime images form
separate comparison cohorts.

On this Mac the dedicated Colima profile can be selected without changing your
default Docker context:

```sh
colima start --profile propbench --activate=false --ssh-config=false
export PROPBENCH_DOCKER_HOST="unix://$HOME/.colima/propbench/docker.sock"
docker --host "$PROPBENCH_DOCKER_HOST" build -t propbench-frontier:2 -f tracks/Dockerfile .
```

Run the deterministic rehearsal with a parent agent, one delegated context,
a sandbox command, and independent owner grading:

```sh
npm run tracks -- prepare --track frontier --mode fresh --set rehearsal --provider fixture --model frontier-fixture --generations 4 --tokens 256 --thinking 0 --seconds 60
RUN='/absolute/owner/run/path'
npm run tracks -- run-frontier --run "$RUN" --fixture-responses tracks/fixtures/frontier-rehearsal.json
npm run tracks -- grade --run "$RUN"
```

For a live evaluation, select `codex-subscription`
as described above. The deterministic fixture continues to exercise the older
controller protocol with synthetic generations. Both paths expose only `exec`
and `delegate`, record execution, and independently grade final proofs.

Fresh includes selected problems, the rulebook, validator launcher, and blank
working areas. It inherits no previous proofs, tools, or methodology. It still
permits building and using tools. The controller rejects changes to the bundle
made between preparation and its first session. Unaided has no execution
capability.

The container receives only the explicit contestant bundle. It has no network,
owner repository, private keys, referee state, host history, or neighboring
runs. Each command is limited to one CPU, 512 MiB of memory, 64 processes,
8 MiB of combined output, and the remaining wall allowance (at most one hour
per command). Its root filesystem is read-only and temporary space is bounded.
Container cleanup includes detached descendants. Native macOS `sandbox-exec`
is not used because it could not reliably enforce that process lifetime.

The agent leaves proof JSON in `proofs/`, reusable tools in `tools/`, and its
methodology, experiments, and debrief in `METHODS.md`, `LOG.md`, and `DEBRIEF.md`.
The owner independently imports candidates and retains valid improvements;
invalid or longer submissions cannot erase a shorter valid incumbent. Candidate
receipts preserve submitted bytes and verdicts. Owner archives preserve accepted
proofs and methodology, including runs that submitted no proof.

A controlled v2 run retains timely verified checkpoints and seals that result once.
Later public submissions are rejected, so new off-budget work cannot improve
an old metered score. To continue, prepare a cumulative run with a new budget.
External handoffs support repeated monotonic imports and remain unmetered.

To inherit previous work, name its bundle or an owner archive explicitly:

```sh
npm run tracks -- prepare --track frontier --mode cumulative --snapshot '/previous/bundle/or/archive' --set v2 --provider codex-subscription --model gpt-6-astra --effort xhigh --seconds 3600 --tool-calls 96
npm run tracks -- run-frontier --run '/printed/run/path'
```

The snapshot identifies exact inherited proofs, tools, and methodology by
content. Run different agents from the same snapshot and budget to compare
incremental progress. Valid inherited proofs form the new owner's baseline.

## External Frontier handoff

You can also use an existing agent client through the stdio MCP bridge:

```sh
npm run tracks -- prepare --track frontier --mode fresh --set v2 --provider external --model AGENT_ID
RUN='/absolute/owner/run/path'
npm run tracks -- handoff --run "$RUN"
npm run tracks -- sandbox --run "$RUN" -- /bin/sh -c 'ls; cat GOAL.md'
npm run tracks -- submit --run "$RUN" --proofs '/printed/bundle/path/proofs'
```

Start a fresh client with the printed MCP server as its **only** filesystem and
execution capability, and configure subagents with the same boundary. Giving
an ordinary host agent a folder or prompt does not remove its other tools or
old conversation. Model communication stays controller-side.

The external bridge enforces its execution wall clock and records commands, but
cannot meter another client's model calls. These runs are labeled
`external-unmetered`, preserve independently verified proofs and methodology,
and are excluded from the controlled leaderboard. Their generation/token
budgets are declarations, not enforced measurements. Use the controlled driver
for comparable evaluations.

## Results and GUI

```sh
npm run tracks -- compare --root track-runs
cd gui
npm ci
npm run dev
```

Open the Tracks page at `http://localhost:3000/tracks`. Select a track, frozen
set or subset, model, and budgets; inspect prepared runs, handoff instructions,
and verified results. The legacy dashboard and benchmark runner retain their
historical data and scoring.

Run records under `track-runs/<id>/` include model/provider, mode, set and scorer
versions, selected item IDs, starting snapshot, resource configuration,
verifier/rulebook/evaluator hashes, attempts and outcomes. Comparisons group
matching protocols, budgets, selections, snapshots, and evidence type. Changing
the evaluator or rulebook requires a new run for further generation. Grading
uses the retained native referee and sealed preparation metadata; comparisons
regrade the proof files rather than trusting cached scores. Do not compare fixture results with
actual model evaluations or mix fresh and cumulative runs.

## Verification

With the Rust binary, Node dependencies, and Frontier image installed, one
command exercises Unaided, fresh and cumulative Frontier, external handoff,
sealed-result rejection, and separate comparison cohorts:

```sh
export PROPBENCH_DOCKER_HOST="unix://$HOME/.colima/propbench/docker.sock"
npm run rehearsal:tracks
```

It makes no paid provider calls, requires a working sandbox, and prints the
directory containing its exact run records. [Acceptance evidence](TRACKS-VERIFICATION.md)
records the completed local checks and remaining live-provider limits.

```sh
npm run test:tracks
npx tsc --noEmit
cargo test --offline --test strict_protocol --test validator_regression --test replay_roundtrip --test golf_score
cd gui
npm run build
```

Local fixtures establish protocol, bookkeeping, grading, and integration.
Physical sandbox tests are a separate gate and explicitly skip when no runtime
is available. Live provider output quality, billing, and deployment-specific
isolation need their own observations; deterministic fixtures do not establish
those results. No paid benchmark campaign is necessary to exercise the local
workflows.
