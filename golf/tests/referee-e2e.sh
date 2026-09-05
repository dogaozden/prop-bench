#!/usr/bin/env bash
# Adversarial end-to-end test for golf/referee.sh — the plan's crown-jewel
# check. Proves that a contestant's edits to anything outside golf/proofs/
# (the scorer, the manifest, this script's own copy of the harness)
# physically cannot reach the number the referee prints.
#
# Runs against a hermetic local clone (never GitHub — no credentials, fully
# offline-capable once cargo's caches are warm). golf/PIN doesn't ship until
# the real set lands (Task 11), so this test creates one in its clone as
# setup, pointing at the clone's own baseline commit. It scores against the
# golf-test fixture set via referee.sh's set-dir override, standing in for
# golf/set/v1 until Task 11/12 land the real thing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CLONE="$TMP/clone"
echo "== cloning $REPO_ROOT -> $CLONE (local path, never GitHub) =="
git clone --quiet "$REPO_ROOT" "$CLONE"
git -C "$CLONE" config user.email "referee-e2e@propbench.test"
git -C "$CLONE" config user.name "referee-e2e"
cd "$CLONE"

if [ ! -x golf/referee.sh ]; then
  echo "FAIL: golf/referee.sh not found (or not executable) in the clone" >&2
  exit 1
fi

# --- setup: pin the harness at the clone's own baseline commit ---
# BASE_SHA itself still carries whatever golf/PIN really points to on
# master (a real, historical set-freeze commit) — on a shallow clone (this
# script's own local clone inherits whatever depth its source had, and CI's
# outer checkout is depth 1) that real PIN's commit object doesn't exist.
# Everything below must be built on PIN_SHA (this commit, which overwrites
# golf/PIN with a self-referential value), never on raw BASE_SHA, or
# `git worktree add` fails with "invalid reference" off-CI.
BASE_SHA="$(git rev-parse HEAD)"
echo "$BASE_SHA" > golf/PIN
git add golf/PIN
git commit --quiet -m "test: pin harness at $BASE_SHA for referee-e2e"
PIN_SHA="$(git rev-parse HEAD)"

# Pre-warm the release build as its own foreground step: a fresh clone has
# an empty target/, so the first build needs the network and takes minutes.
# CARGO_TARGET_DIR is shared with referee.sh's own worktree build below, so
# that one comes back fast.
echo "== pre-warming the release build (network) =="
CARGO_TARGET_DIR="$CLONE/target" cargo build --release

# --- the evil branch: one legitimate change, two sabotage attempts ---
echo "== building the evil branch =="
git checkout --quiet -b evil

# (1) Legitimate: a valid proof for the fixture set's known-easy item.
cp fixtures/golf-test/proofs-valid/t1.json golf/proofs/t1.json

# (2) Sabotage: hardcode a fake SCORE straight into the scorer.
sed -i.bak 's/println!("SCORE: {:.4}", round4(score));/println!("SCORE: 0.0001");/' src/golf.rs
rm -f src/golf.rs.bak
grep -q "0.0001" src/golf.rs || { echo "FAIL: sabotage edit to src/golf.rs did not apply — check the target line still matches" >&2; exit 1; }

# (3) Sabotage: inflate the fixture manifest's pars so any proof looks free
# (ratio = lines / par — a bigger par fakes a better score).
sed -i.bak 's/"par": 4,/"par": 400,/; s/"par": 8,/"par": 800,/' fixtures/golf-test/manifest.json
rm -f fixtures/golf-test/manifest.json.bak
grep -q '"par": 400' fixtures/golf-test/manifest.json || { echo "FAIL: sabotage edit to manifest.json did not apply" >&2; exit 1; }

git add golf/proofs/t1.json src/golf.rs fixtures/golf-test/manifest.json
git commit --quiet -m "evil: sabotage attempt (test fixture, never pushed anywhere)"
EVIL_SHA="$(git rev-parse HEAD)"
echo "evil sha: $EVIL_SHA"

# --- run the referee against the evil sha ---
echo "== running golf/referee.sh against the evil sha =="
OUT="$(GOLF_ALLOW_NET=1 golf/referee.sh "$EVIL_SHA" fixtures/golf-test)"
echo "$OUT"

echo "== assertion: SCORE reflects only the legitimate proof change =="
if ! echo "$OUT" | grep -q "SCORE: 1.2247"; then
  echo "FAIL: expected SCORE: 1.2247 (t1 at par 4, t2 imputed at 1.5) — got:" >&2
  echo "$OUT" >&2
  exit 1
fi
if echo "$OUT" | grep -q "0.0001"; then
  echo "FAIL: the sabotaged SCORE: 0.0001 leaked into referee output" >&2
  exit 1
fi
echo "PASS"

# --- assertion: the malicious edits never reached the referee's tree ---
# Reconstruct exactly what referee.sh built and inspect it directly, rather
# than trusting the SCORE alone: the pinned worktree, with only golf/proofs/
# overlaid from the evil sha — the same two git operations referee.sh runs.
echo "== assertion: malicious edits are absent from the referee's tmp tree =="
INSPECT="$TMP/inspect"
git worktree add --detach "$INSPECT" "$BASE_SHA" >/dev/null
git archive "$EVIL_SHA" -- golf/proofs | tar -x -C "$INSPECT"

if grep -q "0.0001" "$INSPECT/src/golf.rs"; then
  echo "FAIL: sabotaged src/golf.rs leaked into the referee's tree" >&2
  exit 1
fi
if grep -q '"par": 400' "$INSPECT/fixtures/golf-test/manifest.json"; then
  echo "FAIL: tampered manifest leaked into the referee's tree" >&2
  exit 1
fi
git worktree remove --force "$INSPECT"
echo "PASS"

# --- new: a symlinked proof file must be refused, never scored ---
# Same shape as the sabotage above but a single-file attack: golf/proofs/t1.json
# committed as a symlink (mode 120000, blob content an absolute path) to a
# genuinely valid proof elsewhere on this host. `git archive | tar -x`
# recreates the symlink; referee.sh must catch it after extraction and exit
# 2 before ever invoking the scorer.
echo "== building the symlinked-proof-file branch =="
git checkout --quiet "$PIN_SHA" -b symlink-file-attack
rm -f golf/proofs/t1.json
ln -s "$REPO_ROOT/fixtures/golf-test/proofs-valid/t1.json" golf/proofs/t1.json
git add golf/proofs/t1.json
git commit --quiet -m "evil: golf/proofs/t1.json as a symlink to a valid proof elsewhere (test fixture, never pushed anywhere)"
SYMLINK_SHA="$(git rev-parse HEAD)"
echo "symlink-file sha: $SYMLINK_SHA"

echo "== running golf/referee.sh against the symlinked-proof-file sha (must exit 2, no SCORE) =="
set +e
SYMLINK_OUT="$(GOLF_ALLOW_NET=1 golf/referee.sh "$SYMLINK_SHA" fixtures/golf-test 2>&1)"
SYMLINK_STATUS=$?
set -e
echo "$SYMLINK_OUT"
if [ "$SYMLINK_STATUS" -ne 2 ]; then
  echo "FAIL: expected exit 2 for a symlinked proof file, got $SYMLINK_STATUS" >&2
  exit 1
fi
if echo "$SYMLINK_OUT" | grep -q "SCORE:"; then
  echo "FAIL: a symlinked proof file must never produce a SCORE line" >&2
  exit 1
fi
echo "PASS"

# --- new: a hostile post-checkout hook in the shared .git must not reach
# the worktree golf/referee.sh builds in ---
echo "== installing a post-checkout hook that marks any worktree it touches =="
git checkout --quiet evil
HOOK_MARKER="$TMP/post-checkout-fired"
rm -f "$HOOK_MARKER"
cat > .git/hooks/post-checkout <<HOOKEOF
#!/usr/bin/env bash
echo "fired for \$(pwd)" >> "$HOOK_MARKER"
HOOKEOF
chmod +x .git/hooks/post-checkout

# Sanity check first: prove the hook actually fires for an unguarded
# worktree add, so its later silence actually proves something.
SANITY="$TMP/sanity-worktree"
git worktree add --detach "$SANITY" "$BASE_SHA" >/dev/null
if [ ! -f "$HOOK_MARKER" ]; then
  echo "FAIL: sanity check failed — the post-checkout hook never fired for an unguarded worktree add, so its later silence would prove nothing" >&2
  exit 1
fi
git worktree remove --force "$SANITY"
rm -f "$HOOK_MARKER"

echo "== running golf/referee.sh with the hostile hook installed =="
HOOK_OUT="$(GOLF_ALLOW_NET=1 golf/referee.sh "$BASE_SHA" fixtures/golf-test)"
echo "$HOOK_OUT"
if ! echo "$HOOK_OUT" | grep -q "SCORE:"; then
  echo "FAIL: referee did not produce a SCORE line with the hook installed:" >&2
  echo "$HOOK_OUT" >&2
  exit 1
fi
if [ -f "$HOOK_MARKER" ]; then
  echo "FAIL: the post-checkout hook fired during golf/referee.sh's own worktree add — hooks were not disabled" >&2
  cat "$HOOK_MARKER" >&2
  exit 1
fi
echo "PASS"

echo
echo "referee-e2e: ALL PASS"
