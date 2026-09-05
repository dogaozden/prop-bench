# PROTOCOL — owner post-run checklist

Run this after a contestant branch hits its stop rule, or you decide to cut
a run short. Owner-only; contestants never see or run this.

1. **Referee the final sha, from a separate clone.** The official referee
   run happens in a clone of this repo the contestant cannot write to —
   never the checkout whose `.git` the contestant's sandbox/worktree
   shares (a shared `.git` lets a contestant-installed hook or `core.*`
   config reach the referee's own worktree; see `SANDBOX.md`). From that
   separate clone: `git fetch <sandbox-repo> <branch>` — a fetch transfers
   objects only, never hooks or config, so nothing the contestant set up in
   their own `.git` follows — then `golf/referee.sh <final-sha>`. Never
   trust the contestant's local claim on its own, even a correctly quoted
   one. Confirm the SCORE yourself.
2. **Merge accepted proofs.** Copy the improved or new files from the
   contestant's `golf/proofs/` into master's `golf/proofs/` — only the
   files that actually improved something, not a wholesale overwrite. A
   proof whose id isn't in the current set's manifest (stale id from a
   superseded set, a typo, anything `manifest.json` doesn't declare) is
   archived under `golf/runs/<run>/proofs/` instead — it never merges into
   the live `golf/proofs/`.
3. **Archive the journal.** Move `golf/LOG.md` and `golf/DEBRIEF.md` from
   the branch to `golf/runs/<branch>/` on master, verbatim.
4. **Accept tooling.** Pull anything worth keeping from the branch's
   `golf/tools/` into master's `golf/tools/`.
5. **Curate `golf/METHODS.md`.** Distill this run's LOG.md/DEBRIEF.md into
   the pool notebook — hard cap 400 lines, every entry cites its source run
   (`golf/runs/<branch>/`). Methodology, not logic technique: what agents
   *did*, what it cost, what it yielded.
6. **Append a `golf/LEDGER.md` row:**
   `| date | model+harness | mode | hours | ~$ | SCORE before→after | items proven/improved | cutoff note |`
   Every field comes from the referee's own output or your own tracking —
   never estimated.
7. **Tear down.** `git worktree remove` the contestant's worktree, delete
   the branch. The run survives in `golf/runs/<branch>/` and the ledger
   row; the worktree and branch don't need to.
