# Selected historical provenance excerpts

Exact factual excerpts only; read [README](README.md) for attribution, omissions,
license limits, and current verification. Source hashes and original line ranges
are in [historical-sources.json](historical-sources.json).

Text inside each fenced block preserves the original bytes, including line endings.
Everything outside the blocks is archive editorial labeling.

## measurements

Source: `docs/superpowers/plans/2026-08-24-proof-golf-MEASUREMENTS.md`.

Full source SHA-256: `e341ea6c9208b9a1ada13f23017b32af77a249a89ab3aa4b39abc2ad7d7fc6e0`.

### measurements excerpt 1: original lines 405–417

```text
### Result

8/8/8 freeze-accepted across bands 1/2/3 (24 total), core `v0.3.4`, propbench commits `8fdb2a2ff46087c58311e7be89016e7495dae646` (referee fix: score an empty submission when `golf/proofs` is absent from the contestant sha), `ea5775353a2eb0c3575809bf1bf6bfa1755996f2` (set v2 + manifest + v1 README + doc pointers) and `ed0a867732235ef8b5be09d6c819c8d2a02c77e0` (`golf/PIN`). Zero `LawyerFreezeCracked` across all 24 accepts, zero par>30 skips, no leash (the 45-minute `gtimeout` escalation) ever invoked.

### Per-band seed ranges scanned

| Band | Range scanned | Accepts needed | Probe passers found | Selection method |
|---|---|---|---|---|
| 1 | 2,000,000–2,000,199 (200 seeds, 1 chunk) | 8 | 40 | first 8 freeze-survivors in seed order |
| 2 | 2,100,000–2,100,199 (200 seeds, 2 chunks) | 8 | 9 | first 8 freeze-survivors in seed order |
| 3 | 2,200,000–2,205,899 (5,900 seeds, 4 chunks) | 8 | 10 | probe-only scan located passers across 4 chunks; each freeze-verified individually in seed order; scan retired once 10 passers existed (well past the 1-per-600 stop line) |

Every band's probe scan found more passers than the 8 needed (band 2: 9, band 3: 10). The extra passers (all at higher seeds than the 8th shipped) were never freeze-tested — 0/24 freeze attempts failed, so the safety margin went unused.
```

### measurements excerpt 2: original lines 450–456

```text
Target windows unchanged from v1 (12–16 / 17–22 / 23–30):

| Band | Shipped pars (seed order) | In-band count | Rate |
|---|---|---|---|
| 1 | 13,19,13,11,16,13,15,18 | 13,13,16,13,15 (5) | **62.5%** (5/8) — 19 and 18 above ceiling, 11 below floor |
| 2 | 23,17,20,17,18,21,18,20 | 17,20,17,18,21,18,20 (7) | **87.5%** (7/8) — 23 above ceiling |
| 3 | 25,25,26,29,23,23,25,27 | all 8 | **100%** (8/8) |
```

### measurements excerpt 3: original lines 518–522

```text
### Semantic sweep (independent from-scratch audit, Step 3.1)

`audit.py semantic` (a from-scratch truth-table evaluator, deliberately not reusing logic-core's own gate code) against all 24 v2 theorems: every item `satisfiable=True tautology=False` → **OK**. **0 violations / 24.**

Run against the v1 baseline for comparison (`golf/set/v1`, 24 items): **3 violations** — `g1-1000043` and `g2-1100090` (`satisfiable=False`: contradictory premises), `g3-1200381` (`satisfiable=True tautology=True`: tautologous conclusion). Matches exactly the three ids named in `golf/set/v1/README.md` and the spec's 2026-09-05 §4 amendment.
```

### measurements excerpt 4: original lines 530–532

```text
### Replay verification

Every one of the 24 v2 answer-key proofs was scored in isolation (fresh `mktemp -d` per proof, copied in alone, never touching `propbench/golf/proofs/`) against `golf/set/v2`: all 24 replayed at a line count exactly equal to manifest par (ratio 1.0000, exit 0 for all 24). Empty-proofs spot-check (`golf score --set golf/set/v2` against a fresh empty dir): `SCORE: 1.5000`, exit 0. Manifest verified by rebuilding via `golf manifest` into a scratch dir and `cmp`-ing against the committed `golf/set/v2/manifest.json`: byte-identical; every item's `theorem_sha256` independently re-hashed from the actual set-file bytes and matched (0 mismatches / 24).
```

### measurements excerpt 5: original lines 546–548

```text
Two checks per item:
- **(i) strict-subset entailment** — does some proper subset of the premises (size 0 through n−1, i.e. including the empty subset) already entail the conclusion under standard truth-table entailment?
- **(ii) premise ≡ conclusion** — is some single premise semantically equivalent (identical truth table) to the conclusion?
```

### measurements excerpt 6: original lines 552–561

```text
**Set v2 — 0 degenerate items** (Critical 1 is closed for v2):

| Band | (i) strict-subset-entailed | (ii) premise ≡ conclusion |
|---|---|---|
| 1 (g1-*) | 3/8 | 2/8 |
| 2 (g2-*) | 4/8 | 3/8 |
| 3 (g3-*) | 5/8 | 0/8 |
| **Total** | **12/24** | **5/24** |

(ii) ids: `g1-2000001`, `g1-2000035`, `g2-2100023`, `g2-2100030`, `g2-2100067`.
```


## task-15-report

Source: `docs/superpowers/reviews/2026-08-24-proof-golf/task-15-report.md`.

Full source SHA-256: `2195b4c9903811118f0f170b3de2ed2d4f1ade5fd4df39df63caa4982e6a6be7`.

### task-15-report excerpt 1: original lines 63–67

```text
| Band | Range scanned | Passers found | Shipped seeds (par) | In-band rate |
|---|---|---|---|---|
| 1 | 2,000,000–2,000,199 | 40 | 2000001(13), 2000011(19), 2000013(13), 2000021(11), 2000025(16), 2000031(13), 2000034(15), 2000035(18) | 62.5% (5/8) |
| 2 | 2,100,000–2,100,199 | 9 | 2100023(23), 2100030(17), 2100067(20), 2100087(17), 2100100(18), 2100122(21), 2100153(18), 2100178(20) | 87.5% (7/8) |
| 3 | 2,200,000–2,205,899 | 10 | 2200607(25), 2200683(25), 2200923(26), 2201428(29), 2201955(23), 2202121(23), 2204890(25), 2205032(27) | 100% (8/8) |
```

### task-15-report excerpt 2: original lines 117–119

```text
**Replay loop** — every one of the 24 `golf-answer-key/v2/*.proof.json`
files, scored in isolation (fresh `mktemp -d` per proof, never touching
`propbench/golf/proofs/`):
```

### task-15-report excerpt 3: original lines 133–136

```text
All 24 rows printed `ratio 1.0000` (lines == manifest par) and exit 0 —
e.g. `g1-2000001     13     13   1.0000`, `g3-2205032     27     27   1.0000`,
every id in between the same shape. Full loop output is in the
MEASUREMENTS addendum's "Replay verification" subsection.
```

### task-15-report excerpt 4: original lines 298–299

```text
edited in place, no commit applies to them.

```


## task-15-review

Source: `docs/superpowers/reviews/2026-08-24-proof-golf/task-15-review.md`.

Full source SHA-256: `d056658cf21e6cb2e160d552ecd3fd27a2af9279486c6ae2707d7ba49838d4af`.

### task-15-review excerpt 1: original lines 3–4

```text
Reviewer: Sonnet (t15-review-sonnet), 2026-09-06. Range `72174c8..ed0a867`, propbench,
branch `master` (HEAD `ed0a867`, confirmed == `origin/master` via `git fetch`). Read-only
```

### task-15-review excerpt 2: original lines 31–36

```text
- Independent replay loop (own script): scored all 24 `golf-answer-key/v2/*.proof.json`
  files in isolation (fresh `mktemp -d` per proof) and once more all together.
- Independent manifest rebuild: copied the 24 committed set files into a fresh scratch
  dir, ran `golf manifest` myself, `cmp`'d byte-identical against the committed
  `manifest.json`; independently re-hashed all 24 set files' actual bytes against the
  manifest's `theorem_sha256` values (0 mismatches/24).
```

### task-15-review excerpt 3: original lines 41–44

```text
- Cross-checked the "shipped = first 8 in seed order" claim against the actual
  `probe-b2/set/` and `probe-b3/set/` directory listings on disk (ground truth, not
  report prose): band 2's 9 passers and band 3's 10 passers, sorted, both show the
  shipped 8 as an exact prefix with the 9th/10th correctly excluded.
```

### task-15-review excerpt 4: original lines 49–51

```text
- `wc -l gen2/ledger.csv` → 25 (header + 24 rows), one row per band-ordered shipped seed,
  every row `shipped=yes`, zero reject rows — matches "24/24 shipped, zero freeze
  rejects."
```

### task-15-review excerpt 5: original lines 97–104

```text
**(c) Replay loop — ✅.** All 24 v2 key proofs, scored in isolation: every one
`par == lines`, `ratio 1.0000`, exit 0. All 24 scored together: `SCORE: 1.0000`. Empty
proofs dir: `SCORE: 1.5000`, exit 0.

**(d) Manifest — ✅.** Independent rebuild (fresh scratch dir) byte-identical (`cmp`) to
the committed `manifest.json`. All 24 `theorem_sha256` independently re-hashed against
actual file bytes: 0 mismatches. 24 ids, `core_tag: v0.3.4`, `set_version: v2`,
`imputed_ratio: 1.5` all confirmed directly from the file.
```


## task-16-report

Source: `docs/superpowers/reviews/2026-08-24-proof-golf/task-16-report.md`.

Full source SHA-256: `772ef92452e87673ce557aae5d394994f2f056b8593ccafd4258ab4607e38181`.

### task-16-report excerpt 1: original lines 3–6

```text
BASE (propbench HEAD at task start): `ed0a867732235ef8b5be09d6c819c8d2a02c77e0`
Commits made (both on propbench `master`, pushed):
- Part A: `7c75177` — `fix: build the pinned referee tree from git archive, not a worktree checkout`
- Part C: `29fba82` — `docs: report v2 par softness; refresh stale v1 wording`
```

### task-16-report excerpt 2: original lines 108–108

```text
**v2** (0 degenerate items): **12/24** strict-subset-entailed (band 1: 3/8, band 2: 4/8, band 3: 5/8), **5/24** premise≡conclusion (band 1: 2/8, band 2: 3/8, band 3: 0/8) — ids `g1-2000001`, `g1-2000035`, `g2-2100023`, `g2-2100030`, `g2-2100067`. **Matches final-review.md's Residual risk 2 figures exactly, same five ids.**
```

### task-16-report excerpt 3: original lines 112–112

```text
Both docs edited in place (not a git repo, no commit):
```


## task-16-review

Source: `docs/superpowers/reviews/2026-08-24-proof-golf/task-16-review.md`.

Full source SHA-256: `3506828003214313c5189123f750552c4f193d474679944536a22585f34c0e5a`.

### task-16-review excerpt 1: original lines 3–4

```text
Reviewer: Sonnet (t15-review-sonnet), 2026-09-06. Range `ed0a867..29fba82`, propbench,
branch `master` (HEAD `29fba82`, confirmed == `origin/master`). Read-only on all repos:
```

### task-16-review excerpt 2: original lines 106–111

```text
**(6) Part B figures — ✅, exact match.** My independent script (own parser, reused and
extended from the Task 15 review's already-validated grammar) reproduces **every single
number** in the report and in the docs: v2 — 12/24 (i) (band 3/8, 4/8, 5/8), 5/24 (ii)
(band 2/8, 3/8, 0/8), same 5 ids (`g1-2000001`, `g1-2000035`, `g2-2100023`, `g2-2100030`,
`g2-2100067`); v1 — raw 7/24 (i) (band 0/8, 5/8, 2/8), 5/21 excluding all 3 degenerate ids
(band 0/7, 4/7, 1/7), 2/24 (ii) (`g2-1100185`, `g2-1100211`). Confirmed these exact figures
```
