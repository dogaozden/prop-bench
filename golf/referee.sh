#!/usr/bin/env bash
# The official measurement. Contestant-runnable, but the number it prints is
# never the contestant's own build: it checks out the pinned harness commit
# (golf/PIN) into a fresh worktree and pulls in only golf/proofs/ from the
# sha being scored. Edits anywhere else in the contestant's tree — the
# scorer, the set, the manifest, this script's own copy — physically cannot
# reach the measurement.
set -euo pipefail
SHA="${1:?usage: golf/referee.sh <contestant-sha> [set-dir]}"
SET_DIR="${2:-golf/set/v1}"
ROOT="$(git rev-parse --show-toplevel)"
if [ ! -f "$ROOT/golf/PIN" ]; then
  echo "golf/referee.sh: $ROOT/golf/PIN not found — the contest harness isn't pinned yet" >&2
  exit 1
fi
PIN="$(cat "$ROOT/golf/PIN")"
git -C "$ROOT" cat-file -e "$SHA^{commit}"
TMP="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT
git -C "$ROOT" worktree add --detach "$TMP" "$PIN" >/dev/null
git -C "$ROOT" archive "$SHA" -- golf/proofs | tar -x -C "$TMP"
OFFLINE="--offline"; [ "${GOLF_ALLOW_NET:-0}" = "1" ] && OFFLINE=""
echo "REFEREE sha=$SHA pin=$PIN $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# shellcheck disable=SC2086 # intentional: an empty OFFLINE must vanish as
# zero arguments, not get passed to cargo as a literal empty-string arg.
( cd "$TMP" && CARGO_TARGET_DIR="$ROOT/target" cargo run --release $OFFLINE -- golf score --set "$SET_DIR" --proofs golf/proofs )
