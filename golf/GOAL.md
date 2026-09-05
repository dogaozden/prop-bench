# GOAL — Proof Golf

You are an agent in a worktree of the propbench repo. This file is your
whole briefing: the game, the commands, and the rules. Read it before
touching anything.

If this document ever contradicts the code or the referee's own output, the
code is right and this document is stale — log the discrepancy in
`golf/LOG.md` and trust what the referee prints.

## 1. The game

`golf/set/v1/` holds a frozen set of propositional-logic theorems. Each item
`i` has a public par `b_i` — the line count of a proof that already exists
(a planted answer key you never see). Your job: write a proof for each item,
as short as the validator will accept, and drop it at `golf/proofs/<id>.json`
in propbench's replay-JSON format.

For each item, `ratio_i = your_lines_i / par_i`. An item with no proof file
scores `ratio_i = 1.5` — that's the imputation penalty, not a guess at how
hard the item is. An item with a proof file that fails validation voids the
whole run: no SCORE at all, just errors. The tree must stay green.

`SCORE` is the geometric mean of every `ratio_i`, printed to 4 decimal
places. Lower is better. Three landmarks:

- **1.5000** — a clean tree, nothing proven. Where a `--clean` run starts,
  and where any run lands if every proof is deleted.
- **1.0000** — every item proven at exactly its par. You've matched the
  construction that built the set.
- **Below 1.0** — SOTA territory. You found something shorter than the
  construction did. Nothing caps a ratio above 1.0 either — a valid proof
  worse than par still counts honestly, and still beats the 1.5 imputation.

## 2. The commands

`cargo run --release -- golf score --set golf/set/v1 --proofs golf/proofs`
— score your own tree, for your own convenience while you work (no
installed binary assumed). Prints a per-item table
and `SCORE: X.XXXX` on success (exit 0). Exits 1 with errors and no SCORE
line if any submitted proof is invalid. Exits 2 if the set itself looks
tampered — that should never happen from anything you do; if it does, see
rule 5. Add `--json` for `{score, items: [...]}`.

`golf/referee.sh <your-sha>` — the score that counts. It builds the scorer
from a pinned harness commit in a fresh worktree, pulls only your
`golf/proofs/` out of the sha you name, and scores there. Nothing else about
your tree — not edits to the harness, not your tooling, not even a
recompiled prover — reaches this measurement. Run it whenever you want the
real number; run it before you claim one.

## 3. THE RULES

Inviolable. The referee enforces most of this structurally; journal review
catches the rest.

1. **Only `golf/proofs/*.json` is scored.** Everything else you touch is a
   tool, not an answer. Write solvers, recompile provers with bigger
   budgets, spawn subagents, script whatever you want — tools are means,
   proofs are the only ends.
2. **Never edit the harness, set, manifest, or scripts to affect your
   score.** The referee ignores your copies of all of it — it builds from a
   pinned commit and reads nothing from your sha but `golf/proofs/`.
   Attempting it is sabotage, not optimization.
3. **Journal every attempt in `golf/LOG.md`** (append-only, on your
   branch) — what you attacked, how, what it cost, what happened. Failures
   too, especially failures. Read the journal before you start anything; a
   rejection can expire when the tree around it changes.
4. **Stop rule:** after three consecutive attempts with zero SCORE
   movement, stop. Write the exit summary at the top of `golf/LOG.md`: what
   you tried, what you kept (quote the referee's output verbatim, with
   cumulative effect), what you rejected and why, where you'd look next.
   Then idle. Do not invent speculative work to look busy.
5. **Misbehaving-harness clause:** if the validator, scorer, or referee
   does something plainly wrong that your proofs didn't cause, stop and
   report it. Do not patch it to get your run through — a benchmark you
   repaired to make your own change look good is worth nothing.
6. **Claims are the referee's output, quoted verbatim.** Never merge your
   own branch.
7. **Debrief in `golf/DEBRIEF.md`** before stopping — required, and it's a
   methodology report, not a logic essay: approaches you tried in order
   with the cost and yield of each, tooling you built and where it lives,
   the shape of your workflow (in-context proving, scripts, subagents),
   what moved the score and what didn't, where you'd look next. Logic
   insights get a subsection if you want one, not the headline.

## Clean-run appendix

*(Applies only if `golf/CLEAN-RUN` exists in your worktree.)*

This is a clean run: no inherited proofs, tools, methods notes, or ledger.
They existed once and you can find them in this repo's git history — and you
must not go looking. Consulting history for anything `setup-run.sh --clean`
stripped (former contents of `golf/proofs/`, `golf/tools/`,
`golf/METHODS.md`, `golf/LEDGER.md`, `golf/runs/`) defeats the point of a
clean run. The journal is how compliance gets checked, so a git-log dive
that surfaces old proofs will be visible there too.
