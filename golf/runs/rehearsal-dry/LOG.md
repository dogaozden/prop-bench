# LOG

## 2026-09-04 — r1 (rehearsal set)

- **Attacked:** `r1` — premises `P > Q`, `P`; conclusion `Q`. par = 1.
- **How:** read the premises directly; `Q` follows from `P > Q` and `P` by a
  single Modus Ponens step. Wrote the one-line derived proof
  `[{"line_number":3,"formula":"Q","justification":"MP 1,2","depth":0}]` to
  `golf/proofs/r1.json` by hand — no search, no tooling.
- **Cost:** negligible; one inspection, one file write, one commit.
- **Result:** referee (`golf/referee.sh 8b16ce3 golf/set/rehearsal`) moved
  `r1` from unproven (ratio 1.5000, imputed) to `lines: 1, ratio: 1.0000`.
  `SCORE: 1.5000` → `SCORE: 1.0000`. Matches par exactly — nothing shorter
  is possible (Q needs at least one derived line to appear at all).
- **Stop:** single-item rehearsal set, exhausted in one attempt. Nothing
  left to attack.
