# Native repair control rehearsals

Both unscored physical rehearsals passed using native Codex subscription, `gpt-6-astra` at `xhigh`, normal tier, and the pinned Frontier image 3. The integrated adapter and owner checks passed 40 targeted tests and TypeScript checking.

The argument rehearsal produced an actual `exec` call containing the unsupported `timeout` field. The owner recorded one charged rejection without execution; the model then made a valid Docker `echo READY` call and returned `READY`. There were two tool calls and one execution.

The deadline rehearsal used a native root, a real native delegate, and an isolated Docker `sleep 90` command under a shared 45-second budget. A sample approximately one second before cutoff observed both native processes and one running owned container. The run completed as `budget_exhausted` after 45.102 seconds. Process-group absence and child stdio close were confirmed, and no owned native processes or containers remained afterward. The two cutoff sessions have no complete final usage receipts; their usage is unknown.

The physical rehearsals did not reproduce `EPERM`. Simulated tests separately verify denied group signals, direct-child fallback, escalation, bounded unconfirmed-cleanup errors, and preservation of delegated cleanup failure through owner finalization.

The JSON companion records exact run IDs, evaluator/client/image hashes, control digests, timings, usage coverage, scope, and limitations. These custom-prompt rehearsals are explicitly marked and excluded from scored campaign data. The identity checks are client-reported service provenance, not cryptographic proof of provider internals.
