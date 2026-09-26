# Native campaign control audit

Status: **final_interrupted_pilot**. Cutoff: 2026-09-26T05:34:31.793417+00:00. Campaign: `5b02fde5-91a6-4c8d-923b-956fee47bc57`.

This audit covers 12 dispatched jobs, 36 native session archives, 36 control-audit receipts, and 21 completed native results. 21 completed results contain usage receipts. It found **0 control or provenance mismatches** and 3 malformed tool inputs rejected by the guard. 4 jobs are interrupted and excluded from completed-result comparisons. Current job states: {"complete": 8, "interrupted": 4, "queued": 84}.

Requested model and effort are `gpt-6-astra` / `xhigh` through native Codex subscription. The audited native client is `codex-cli 0.158.0-alpha.2` with SHA-256 `c3e30211bd454da70ceb4d9cbc2e05fe6466812ab05c311c3bbff6addeb14202`. The frozen campaign source is `6ba4637874fea00475276543545bc7876bff1f2e`. Normal tier is enforced; no fast tier is accepted. Unaided exposes no tools. Frontier exposes only `exec` and `delegate`; execution receipts are checked against the pinned Docker image.

The JSON companion contains per-run identifiers, counts, configuration/catalog digests, usage coverage, findings, and exact check scope. It deliberately excludes raw transcripts, generated reasoning, account information, local filesystem paths, and native session identifiers.

These checks establish consistency with the audited native client and adapter. Client-reported model identity, tool availability, and token usage are service provenance, not cryptographic proof of provider-side internals. Interrupted or pending sessions can lack final usage receipts; their unknown usage must not be treated as zero. The interrupted pilot is finalized for the dispatched jobs only; queued jobs were not run. This audit makes no benchmark-quality or model-strength claim.
