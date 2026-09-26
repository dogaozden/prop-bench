# Clean checkout release replay

**Passed** on 2026-09-26T06:44:25.683819+00:00. A fresh `git clone --no-local` contained only tracked source/public files at commit `a171d05836888c35c68bcc24564cfe1661c74231`. The clone had no owner run directory and its tracked checkout stayed clean after dependency installation, a new clone-local validator build, and both replays.

| Public bundle | Recorded runs | Final-proof replays | Checkpoint replays | Total proof replays | Census complete |
|---|---:|---:|---:|---:|---|
| Replacement | 43 | 40 | 11 | 51 | No |
| Archived pilot | 11 | 11 | 6 | 17 | No |

Commands executed in the fresh clone:

```sh
npm ci
cargo build --locked --release --no-default-features --bin propbench-validate --jobs 2
sandbox-exec -f replay.sb npm run publication:verify -- --data publication/data/results.json
sandbox-exec -f replay.sb npm run publication:verify -- --data publication/pilots/20260925/data/results.json
```

All four commands exited successfully. Dependency installation preceded network denial; package/download caches may have been reused, but the validator was compiled into the clone's own fresh target directory. The resulting binary SHA-256 was `01d38d59044ec390be368dbd1b9d6648b3856a405833c8a20ee8d37270c396a2`. Each replay reports that binary identity separately from its original owner referee.

The macOS profile used `(allow default)` with `(deny network*)` and explicit read denial for the original checkout and provider-login directories. Before replay, an owned loopback TCP connection succeeded without the profile and failed with permission error `1` under it. A read of the original checkout's package metadata was likewise denied. Both replay commands then ran under that same profile. Provider credential variables were excluded from their environment; no authentication files or provider inference were used.

This verifies saved public proofs and metadata, not regeneration of hosted-model behavior or completion of either campaign. The network test establishes the observed loopback denial under the applied policy; it is not an exhaustive network test. Host paths, account details and raw provider records are omitted.

Machine-readable evidence: [clean-release-replay.json](clean-release-replay.json).
