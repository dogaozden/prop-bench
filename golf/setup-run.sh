#!/usr/bin/env bash
# Creates a worktree + branch for one contest run, off master.
#   --assisted : tree as-is (inherited proofs, tools, methods, ledger).
#   --clean    : strips inherited knowledge so the run starts honest at
#                SCORE 1.5000; the stripped state is committed on the
#                branch so `git diff` against master shows exactly what
#                was removed.
set -euo pipefail
usage() { echo "usage: golf/setup-run.sh --clean|--assisted <branch>" >&2; exit 1; }
[ $# -eq 2 ] || usage
MODE="$1"
BRANCH="$2"
case "$MODE" in
  --clean|--assisted) ;;
  *) usage ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
git -C "$ROOT" worktree add "../propbench-$BRANCH" -b "$BRANCH" master
WORKTREE="$(cd "$ROOT/../propbench-$BRANCH" && pwd)"

if [ "$MODE" = "--clean" ]; then
  find "$WORKTREE/golf/proofs" -type f ! -name ".gitkeep" -delete
  rm -rf "$WORKTREE/golf/tools" "$WORKTREE/golf/runs" "$WORKTREE/golf/METHODS.md" "$WORKTREE/golf/LEDGER.md"
  touch "$WORKTREE/golf/CLEAN-RUN"
  git -C "$WORKTREE" add -A golf
  git -C "$WORKTREE" commit --quiet -m "chore: strip inherited knowledge for clean run"
fi

echo "Worktree ready: $WORKTREE"
echo
echo "Launch checklist:"
echo "  cd $WORKTREE"
echo "  Read golf/GOAL.md first — it is the whole briefing."
echo "  Measure yourself any time:  propbench golf score --set golf/set/v1 --proofs golf/proofs"
echo "  The score that counts:     golf/referee.sh \$(git rev-parse HEAD)"
