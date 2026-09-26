# PropBench

**How short can a valid formal proof get—and how does tool access change the search?**

PropBench evaluates propositional-logic proof construction with a strict Rust
referee. It records verified proof lengths, validity, the available tools,
resource allowances, and inherited work. The public site lets readers inspect
every published proof and the conditions that produced it.

| Track | Contestant capabilities | What is measured |
|---|---|---|
| **Unaided** | One fresh session per theorem; no external computation, tools, scripts, or verifier feedback | The final proof constructed by the model |
| **Frontier** | Isolated shell, scripts, custom solvers, repeated validation, and delegation | The shortest valid proof captured within the allowance |

Frontier **fresh** starts without prior artifacts. Frontier **cumulative**
inherits an explicit, hashed snapshot and receives an additional allowance.
These are separate experimental conditions.

New live runs use **native Codex subscription authentication only**. There is no
API-key or Claude fallback. The public website is read-only; it has no model
access or endpoints for executing commands.

## Read the experiment

- [Public results explorer](publication/index.html) — portable static website;
  serve it over HTTP using the instructions below.
- [Observed results and known capture limitation](research/RESULTS.md)
- [Protocol and prespecified campaign](research/PROTOCOL.md)
- [Dataset construction and semantic audit](research/DATASET.md)
- [Limitations](research/LIMITATIONS.md)
- [Reproduction instructions](research/REPRODUCIBILITY.md)
- [Local runner guide](TRACKS.md) and [publication guide](PUBLISHING.md)

The frozen **v2** set contains 24 theorems. Its par lengths are known achievable
references, not certified minima or difficulty guarantees. The semantic audit
finds redundant premises in 12 items and premise-equivalent conclusions in five;
these facts limit claims about difficulty. The public set may also be present in
training data. PropBench does not claim human equivalence or general reasoning
ability from these results.

## Score

Premises are free. Submitted assumptions, derived lines, and subproof-closing
lines count. The referee checks rule applications, dependencies, and scope.
For a valid proof of length **L** against reference par **P**, loss is
**L / (L + P)**; missing or invalid answers have loss 1. Lower is better.
Always read the verified lengths and coverage alongside the aggregate.
Interrupted infrastructure runs remain visible and are excluded from comparative
ranking. Fixtures are never presented as live model results.

## Inspect the public site

The website needs no build step, account, API, or third-party assets:

```sh
python3 -m http.server 8769 --directory publication
```

Open `http://localhost:8769/`. Copy the contents of `publication/` to a static
website directory, including all files in `data/`. Relative URLs support hosting
under a subpath. See [PUBLISHING.md](PUBLISHING.md) before publishing an export.

## Run locally

`npm run bench` opens the current Tracks CLI help. The retained API harness is
explicitly named `npm run bench:legacy`; it is separate from these evaluations.

Requirements: Rust stable, Node 22 or later, and native Codex signed in through
ChatGPT. Use the same Node version to install and run native dependencies.
Frontier additionally requires Docker. The current native execution adapter is
audited for a specific macOS Codex build; unsupported clients fail closed until
their tool controls have been audited. See [TRACKS.md](TRACKS.md) for that boundary.

```sh
npm ci
npm ci --prefix gui
cargo build --release --locked
codex login

docker build -t propbench-frontier:3 -f tracks/Dockerfile .
npm run tracks -- sets
npm run tracks -- prepare --track unaided --set v2 --ids g1-2000001 --provider codex-subscription --model gpt-6-astra --effort xhigh --seconds 900
npm run tracks -- run-unaided --run '/path/printed/by/prepare'
```

The contestant image contains a **validation-only** executable. It excludes the
theorem generator and planted-proof reconstruction code. Frontier v2 captures
proofs and reusable artifacts before the deadline, verifies them independently,
and retains valid improvements even when later working files regress. The
owner's full CLI remains available for dataset construction and legacy work.

The local control panel runs with `npm run dev --prefix gui` at
`http://localhost:3000/tracks`. It is a loopback-only owner console. Publish the
static website, never this server.

## Reproduce the campaign

The September 25 design has four conditions over the same 24 items: two
independent Unaided repetitions, fresh Frontier, and cumulative Frontier from
each item's own fresh archive. Each singleton run gets 900 seconds; Frontier
gets 128 tool calls. The manifest pins model, effort, client binary, evaluator,
rulebook, referee, exact item selection, and dispatch order.

```sh
npm run campaign -- --dry-run
npm run campaign -- --root track-runs/my-campaign --bundles ../propbench-contestants/my-campaign
npm run publication:export -- track-runs/my-campaign publication/data/results.json
```

The controller stops new dispatch on infrastructure or quota failure and never
silently repeats an uncertain attempt. `--resume` continues queued work under
the original identities; it does not repair or rerun interrupted jobs. Export
independently replays proofs and excludes private sessions and account data.
Only recorded campaign artifacts establish what actually ran.

## Checks

```sh
npm run typecheck
npm run test:tracks
npm run test:campaign
npm run test:server
npm run test:publication
npm run build --prefix gui
cargo test --locked
```

Physical sandbox tests require the built image and Docker. Native client
compatibility additionally requires a real logged-in subscription canary;
fixtures do not establish live tool isolation.

## Source and license

The [logic-core](https://github.com/dogaozden/logic-core) crate supplies formula
parsing and natural-deduction rules and is pinned in Cargo. This repository is
[MIT licensed](LICENSE); see [dataset provenance](research/DATASET.md) and
[CITATION.cff](CITATION.cff). Historical Elo/API results use different protocols
and remain separate; their overview is retained in
[the legacy documentation](docs/legacy-harness.md).
