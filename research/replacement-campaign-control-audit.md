# Replacement campaign provenance audit

This read-only snapshot at 2026-09-26T06:38:49.960Z found 0 material control or identity mismatches in the inspected evidence. This is a terminal snapshot of stopped dispatch; queued and interrupted jobs do not count as completed. The original pilot audit is unchanged.

- Campaign: `f5718b6e-dc3e-4219-b823-cd62cb98023c`
- Source: `64b2026857d0dc9da54497eca50cf7a63534e95f`
- Manifest canonical SHA-256: `0b33c6651516db06150b6de830ac7bb59a0101d0c9c07852bebc2ec2bda93331`
- Evaluator SHA-256: `934a19358db98ad8fa5aa61b4a3048b957230ecb371f08507a24fa5ba2249c83`
- Owner referee SHA-256: `90c4b05d1c1f1a2be9294fe19184276ab20584a28660ea35bfbb954f65891f97`
- Native client: codex-cli 0.158.0-alpha.2, SHA-256 `c3e30211bd454da70ceb4d9cbc2e05fe6466812ab05c311c3bbff6addeb14202`
- Frontier runtime: `sha256:b86705d37917c9e9cdcd98c139b4a052bb77cad812e6f80c03f461db0bce9859` (arm64, label 3)
- Protocol: gpt-6-astra/xhigh, native Codex subscription, normal service tier; all 96 planned singleton jobs retain 900-second allowances, with 0 Unaided or 128 Frontier tool calls.

The independently reconstructed schedule contains 24 jobs per condition, follows the prespecified round-robin generation-band order, and ties each cumulative job only to its own fresh run. Source files match the committed freeze. Manifest/state bindings, theorem/rule/referee bytes, run seals and condition identities, blank fresh archives, available native tool catalogs, normal-speed settings, and available runtime receipts passed the checks in the companion JSON.

At the state cutoff: 43 complete, 0 interrupted, 0 running, and 53 queued. Inspected 43 prepared runs, 103 native control audits, 103 native thread receipts, and 438 completed Docker execution receipts. 0 live containers were sampled for network/IPC isolation, read-only root, bounded CPU/memory/processes, nonroot user and the sole contestant workspace mount.

These are provenance and control consistency checks, not proof-quality rankings or authentication of provider internals. Snapshot times are not atomic across files. No new inference, provider calls, runtime mutations, or source changes were performed. Sensitive native contents and local paths are omitted.

Machine-readable evidence: [replacement-campaign-control-audit.json](replacement-campaign-control-audit.json).
