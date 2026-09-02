# SANDBOX — Mac mini checklist

Manual owner setup, done once per contestant sandbox, before a run starts.
Nothing in this repo automates it.

## Firewall allowlist

The sandbox should reach the model API and nothing else — no GitHub, no
general web. Two options, pick one:

- **pf** (`pfctl`): an allowlist rule set scoped to the model provider's API
  endpoint(s) only; default-deny everything else outbound.
- **Little Snitch**: a rule group scoped the same way — allow the provider
  API, deny `github.com` and general egress by default.

Either way, the actual domain(s) to allow depend on which provider/harness
is running in the sandbox (Claude API, Codex, etc.) — fill those in per run;
they aren't fixed here. Verify the block before starting a run: try reaching
`github.com` from inside the sandbox and confirm it fails.

## Cargo cache pre-warm

`golf/referee.sh` builds `--offline` by default, and a sandbox with the
firewall above has no cargo network access either. Before a run starts:

```
cargo build --release
```

...once, on the mainline checkout, with network still open. That populates
the local registry and git caches cargo needs, so every later `--offline`
referee build resolves from cache instead of failing closed. Re-run this
after any `Cargo.lock` change (a core version bump, a new dependency) — a
stale cache means a stale `--offline` build.

## Worktree layout

`golf/setup-run.sh --clean|--assisted <branch>` creates
`../propbench-<branch>` next to the main checkout, on its own branch off
`master`. One worktree per contestant/run. Point the sandboxed agent at that
directory; it never needs to see the main checkout.

## Recording hours and API-$ for the ledger

`golf/LEDGER.md` (via `PROTOCOL.md` step 6) needs wall-clock hours and an
approximate API-equivalent dollar figure per run. Track both while the run
is live — start/end timestamps for hours, the harness's own usage/cost
reporting (or the provider console) for the dollar figure. Neither is
reconstructable with any precision after the fact, so don't defer this to
teardown.
