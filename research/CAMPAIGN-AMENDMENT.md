# Campaign schedule amendment — 2026-09-25

This amendment is recorded before dispatch of a new full census. It changes the
**order of jobs**, not the 24-item set, model, effort, four conditions, singleton
900-second allowances, tool limits, scoring rule, or fresh-to-cumulative
lineage. The new campaign must receive its own immutable manifest, campaign ID,
source commit, and owner/contestant directories after the protocol repair is
verified and the original process has finished.

## Why the first campaign stopped

The original owner campaign at `track-runs/publication-20260925` used source
commit `6ba4637874fea00475276543545bc7876bff1f2e`. Its native Codex adapter
rejected a Frontier `exec` call with an extra timeout argument as invalid tool
arguments. The controller stopped new dispatch after protocol interruptions.
Twelve jobs were dispatched. The controller later exited with `kill EPERM` in
`NativeRpc.stop` while one job still appeared as running in campaign state.
After independent confirmation that no PropBench native child remained, an
explicit recovery preserved the original state, lock, log, and a SHA-256
inventory of 2,117 owner run files (including 1,587 proof/receipt files).
Recovery changed that one started job to interrupted without dispatch, grading,
or finalization. The pilot is now **8 complete, 4 interrupted, 84 queued**;
the 84 queued jobs were left unchanged, and the stale lock remains as evidence.
Its recovery receipt is under `track-runs/publication-20260925/recovery/`.
An immutable digest clarification beside that receipt distinguishes the
canonical inventory digest from the inventory file's byte digest; the original
receipt and inventory were not edited.
No interrupted job is silently retried or converted to a scored model failure.
The original campaign is a **retained pilot**, separate from the replacement
census.

## Prespecified replacement order

The replacement campaign is planned for owner root
`track-runs/publication-20260926-v2` and a separate contestant-bundle root.
Within each generation band, preserve the frozen v2 manifest order. Interleave
the eight items in deterministic band order:

`g1[0], g2[0], g3[0], g1[1], g2[1], g3[1], …, g1[7], g2[7], g3[7]`.

For each item, queue these four jobs together in order:

1. Unaided repeat 1: fresh, zero tools, 900 seconds.
2. Frontier fresh: blank workspace, 128 tool calls, 900 seconds.
3. Unaided repeat 2: independent fresh session, zero tools, 900 seconds.
4. Frontier cumulative: that item's own accepted fresh owner archive, a new
   128-call and 900-second allowance. Dispatch waits for its fresh job to
   complete; if the fresh job is interrupted, the dependent job stays queued.

The scheduler scans this fixed manifest order for eligible queued jobs. At most
six jobs are in flight by default. Completion times may alter the actual
dispatch interleaving, which the progress ledger records, but they cannot alter
the manifest order, dependency, or condition definitions. This ordering reaches
all three generation bands and both repeats and Frontier phases earlier if a
quota or infrastructure stop truncates the campaign. It is fixed **before**
seeing replacement-campaign outcomes.

## Analysis boundary

The new campaign plans all 96 jobs: 24 per condition, including every v2 item.
It is a fresh full census, not a selection of successful jobs from the pilot.
Pilot results and resource use remain inspectable under their original IDs and
source identity, but must not be pooled with the replacement's primary 24-item
condition means or paired comparisons. Pending and interrupted denominators
remain visible. The replacement manifest's frozen source commit, native client
hash, evaluator/rulebook/referee/set hashes, and final source identity are the
authority for that campaign; this document does not claim those future values.
