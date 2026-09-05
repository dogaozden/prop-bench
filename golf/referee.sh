#!/usr/bin/env bash
# The official measurement. Contestant-runnable, but the number it prints is
# never the contestant's own build: it checks out the pinned harness commit
# (golf/PIN) into a fresh worktree and pulls in only golf/proofs/ from the
# sha being scored. Edits anywhere else in the contestant's tree — the
# scorer, the set, the manifest, this script's own copy — physically cannot
# reach the measurement.
#
# That guarantee is about sha content, not topology: this script still
# shares a .git with the contestant's own checkout when run from the owner's
# main clone, so a contestant-installed hook or config there could still
# reach the worktree built below. See PROTOCOL.md step 1 — the official
# referee run must happen from a separate clone the contestant cannot write
# to. The -c flags and private build dir here are defense in depth for that
# gap, not a substitute for the separate clone.
set -euo pipefail
usage() { echo "usage: golf/referee.sh <contestant-sha> [set-dir]" >&2; exit 1; }
case "${1:-}" in ""|-*) usage ;; esac
case "${2:-}" in -*) usage ;; esac
SHA="$1"
SET_DIR="${2:-golf/set/v1}"
ROOT="$(git rev-parse --show-toplevel)"
if [ ! -f "$ROOT/golf/PIN" ]; then
  echo "golf/referee.sh: $ROOT/golf/PIN not found — the contest harness isn't pinned yet" >&2
  exit 1
fi
PIN="$(cat "$ROOT/golf/PIN")"
git -C "$ROOT" cat-file -e "$SHA^{commit}"
TMP="$(mktemp -d)"
trap 'git -C "$ROOT" -c core.hooksPath=/dev/null worktree remove --force "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT
# Printed before anything below can fail, so a quoted failure is still
# self-describing: which sha, which pin, which set, when.
echo "REFEREE sha=$SHA pin=$PIN set=$SET_DIR $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# core.hooksPath=/dev/null: a hook installed in the shared .git (e.g.
# post-checkout) must not run against this worktree. core.fsmonitor=false:
# don't trust a contestant-configured fsmonitor for this checkout either.
git -C "$ROOT" -c core.hooksPath=/dev/null -c core.fsmonitor=false worktree add --detach "$TMP" "$PIN" >/dev/null
git -C "$ROOT" archive "$SHA" -- golf/proofs | tar -x -C "$TMP"
# A contestant sha can commit golf/proofs/ itself as a symlink (mode 120000,
# blob content an absolute path) or one of its entries as a symlink to a
# file elsewhere on this host — `git archive | tar -x` recreates either.
# Refuse both before any scoring runs; never print a SCORE line on this path.
if [ -L "$TMP/golf/proofs" ]; then
  echo "golf/referee.sh: golf/proofs in $SHA is a symlink, not a directory — refusing to score" >&2
  exit 2
fi
if find "$TMP/golf/proofs" ! -type f ! -type d | grep -q .; then
  echo "golf/referee.sh: golf/proofs in $SHA contains a non-regular-file entry (symlink or other) — refusing to score" >&2
  exit 2
fi
OFFLINE="--offline"; [ "${GOLF_ALLOW_NET:-0}" = "1" ] && OFFLINE=""
# Build into a private target dir under $TMP rather than the shared
# $ROOT/target: a contestant's own worktree build could otherwise poison the
# shared build cache the referee then reads from. Slower (no warm cache
# across referee runs), but unpoisonable — the shared ~/.cargo registry/git
# caches are untouched, so --offline still resolves from them.
# shellcheck disable=SC2086 # intentional: an empty OFFLINE must vanish as
# zero arguments, not get passed to cargo as a literal empty-string arg.
( cd "$TMP" && CARGO_TARGET_DIR="$TMP/target" cargo run --release $OFFLINE -- golf score --set "$SET_DIR" --proofs golf/proofs )
