# Runtime 3 validation audit

Audited at `2026-09-26T05:48:28.621364+00:00` against source commit `64b2026857d0dc9da54497eca50cf7a63534e95f`. The scoped checks passed. No provider inference was invoked.

The inspected immutable image is `sha256:b86705d37917c9e9cdcd98c139b4a052bb77cad812e6f80c03f461db0bce9859` (`linux/arm64`), tagged `propbench-frontier:3`, with label `org.propbench.frontier-runtime=3`. Its reported size is 268,851,044 bytes. The Linux validation executable has SHA-256 `3c72cfa0c5f72ae5dcafcf8f492f848d4cb162184729cc9cc4ca764845e21c01` and mode `0555`.

The Dockerfile pins the builder to `rust:1.92.0-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2` and the runtime base to `debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251`. The inspected runtime layers begin with the locally inspected pinned Debian base. The Rust builder is a separate build stage; this observation is not a signed build attestation. Dockerfile SHA-256: `6228b1b4b6f8684a0c128e3ac30328fffe535bcc599c5588c9c942de51935c4e`.

| Strict fixture | Exit | Result | Host stdout/stderr/exit comparison |
|---|---:|---|---|
| valid_mp | 0 | valid, 1 derived lines | exact |
| valid_cp | 0 | valid, 2 derived lines | exact |
| invalid_formula | 0 | invalid proof JSON verdict | exact |
| forged_depth | 0 | invalid proof JSON verdict | exact |
| bad_numbering | 1 | protocol error | exact |

Four direct command checks returned exit 2 with an unrecognized-subcommand error: the known seeded `golf plant` command through both `/opt/propbench/validator` and `./validator`, plus direct `generate` and `analyze`. Help exposed validation, and the selected generator/solver symbol and string checks returned no matches. No regeneration outputs appeared.

| Runtime command | Observed version |
|---|---|
| bash | GNU bash, version 5.2.15(1)-release (aarch64-unknown-linux-gnu) |
| cc | cc (Debian 12.2.0-14+deb12u1) 12.2.0 |
| clang | Debian clang version 14.0.6 |
| node | v18.20.4 |
| npm | 9.2.0 |
| python3 | Python 3.11.2 |
| jq | jq-1.6 |
| rg | ripgrep 13.0.0 |

The [JSON audit](validation-runtime-3-audit.json) records exact installed versions and architectures for 22 selected Debian packages, image layers, help/error receipts, and every parity result. `codex` and `claude` were not found on the image PATH. A separate read-only owner inspection confirmed `/build`, `/usr/local/cargo`, and `/root/.cargo` were absent.

The validation checks used uid/gid `65534:65534`, a read-only root filesystem and fixture mount, no network or IPC, all capabilities dropped, no-new-privileges, a 64-process limit, 256 MiB memory, and a 0.25-CPU cap. Kernel process status reported effective capabilities zero and `NoNewPrivs=1`; opening the validator for writing was denied. Production contestant workspaces are writable by design, so the audit fixture mount does not stand in for every production mount or checkpoint test.

A 268,861,952-byte Docker archive was retained locally under ignored `track-runs/runtime3/`. Archive SHA-256: `2f1264d14c1d86d6ea2fee64897090a59018bc5a772318dd4ac733ada0b692b3`. Its OCI index references the requested image digest, and its config architecture and rootfs layers match inspection. No additional compression was applied. The archive is not published, and no native provider client was exported. Owner receipts remain in that ignored directory.

Source and binary hashes, HEAD, the runtime 3 tag identity, and the existing runtime 2 audit stayed unchanged. This audit covers five small proofs and the known generator exposure. It is not a universal sandbox proof, a general escape/egress/deadline test, a resource stress test, or a claim that mutable package repositories reproduce the same image bit for bit.
