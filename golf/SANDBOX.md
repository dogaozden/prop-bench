# SANDBOX — Mac mini checklist

Manual owner setup, done once per contestant sandbox, before a run starts.
Nothing in this repo automates it.

## Host isolation

The sandbox is a different machine from the referee host — or, at an
absolute minimum, a different OS user on the same machine. The two must
never share a `.git` (see `PROTOCOL.md` step 1: the official referee runs
from a separate clone the contestant can't write to) or a build cache.
Concretely:

- The answer key (`/Users/dogaozden/AI_Projects/logic/golf-answer-key/`)
  must not exist on, or be readable from, the sandbox.
- The sandbox has no write access to the referee host's repository (no
  shared `.git`, no shared worktree) or its build cache (no shared
  `CARGO_TARGET_DIR`/`target/`).

Verify before every run, not just the first:

- [ ] From the sandbox: `ls /Users/dogaozden/AI_Projects/logic/golf-answer-key` must fail (no such file/directory, or permission denied).
- [ ] From the sandbox: confirm there is no writable path back into the
      referee host's checkout or `target/` — a different machine settles
      this automatically; a same-machine different-user setup needs the
      filesystem permissions actually checked, not assumed.
- [ ] `github.com` is unreachable from the sandbox (see Firewall allowlist
      below).

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
firewall above has no cargo network access either — but the referee build
never runs on the sandbox; it runs on the referee host, from the pinned
`golf/PIN` commit. What has to resolve offline is **that PIN's own**
`Cargo.lock`, not whatever the mainline tree currently has. Before a run
starts, on the referee host:

```
cargo build --release
```

...once, with network still open, on a checkout at (or including) the
current `golf/PIN` commit. That populates the local registry and git caches
cargo needs, so every later `--offline` referee build resolves from cache
instead of failing closed. A later **mainline** dependency bump (past the
PIN) does **not** invalidate this — the PIN's `Cargo.lock` doesn't change
just because mainline's does. A `cargo cache clean` (or equivalent) **does**
invalidate it and needs a re-warm.

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
