# PROTOCOL — owner post-run checklist

Run this after a contestant branch hits its stop rule, or you decide to cut
a run short. Owner-only; contestants never see or run this.

1. **Referee the final sha.** `golf/referee.sh <final-sha>` from your own
   trusted checkout — never trust the contestant's local claim on its own,
   even a correctly quoted one. Confirm the SCORE yourself.
2. **Merge accepted proofs.** Copy the improved or new files from the
   contestant's `golf/proofs/` into master's `golf/proofs/` — only the
   files that actually improved something, not a wholesale overwrite.
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
