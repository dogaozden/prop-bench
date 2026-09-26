# Interpretation and limitations

The strongest claim supported by a compliant result is narrow: under the
recorded rules, interface, starting state, and budget, the saved proof replayed
as valid with L counted lines. A successful run does not prove that L is
minimal, that the item is intrinsically hard, or that the model can solve an
unseen distribution of formal reasoning problems.

## Dataset and metric

- V2 contains 24 synthetic items, eight in each planted generation band. The
  bands describe generator targets and bounded filtering, not calibrated human
  difficulty or a demonstrated rank ordering of model difficulty.
- The public items include semantic shortcuts: 12/24 are entailed by a proper
  subset of their premises and 5/24 have a premise equivalent to the conclusion.
  All 24 pass the current truth-table check for entailment, satisfiable premises,
  and non-tautologous conclusions. These checks do not construct shortest proofs.
- Reference lengths are generator-produced upper bounds. A result well below
  par may expose a loose reference rather than demonstrate a surprising
  capability. Keep pars frozen for comparisons; a revised reference set creates
  a new score version/identity and must not rewrite historical scores silently.
- Loss L/(L+P) is monotone for a fixed item and makes every finite valid proof
  beat omission. Across items, the reference lengths determine the scale of
  length gains, and long proofs are compressed toward loss 1. Coverage and raw
  lengths are indispensable. A percentage reduction in loss is not the same as
  a percentage reduction in proof length.
- A four-atom truth table can decide semantic entailment cheaply. Constructing a
  short proof in this calculus is a different task; neither property establishes
  general theorem-proving complexity or resistance to future saturation.

## Contamination and conditioning

The set and generator source are published artifacts, and item IDs encode band
and seed. Historical work includes a known six-line result on `g1-2000001`.
Fresh refers to enforced session/workspace inheritance, not verified absence
from pretraining or prior provider exposure. No decontamination audit of model
training data is available. Do not claim held-out, unseen, or contamination-free
performance on v2.

A full generator executable can reconstruct the planted answer key from the
public seed. It therefore cannot be included as the Frontier validator. Even
after this runtime leak is removed, public-seed regeneration remains possible
outside the isolated run. New hidden evaluation sets require a separate design,
withheld seeds/keys, held-out generator families, and a declared release policy.

Tools and methodology developed from these items are benchmark-conditioned.
Their repeated use is valuable cumulative research, but is not an unbiased
fresh evaluation. Label human-authored seeds and cross-model/cross-item artifact
unions explicitly; attribute their costs and source runs.

## Systems and inference

Native subscription clients and hosted models are moving services. The harness
can pin a client executable and record model metadata but cannot freeze remote
weights, server-side inference, batching, hidden retries, or future availability.
An effort label is not an equal-compute guarantee across models. Report observed
usage and missing-usage coverage; do not convert sessions into exact requests,
tokens into FLOPs, or subscription estimates into API charges.

Wall time includes the recorded client/setup/tool/checkpoint policy, service
latency, and host contention. It is a practical allowance, not pure reasoning
time. Parallel jobs on shared hardware or quota affect completion opportunities.
Single-threaded tools, fixed Docker resource limits, and an immutable image
improve control but do not remove these effects.

Validation-only runtime binaries and an owner referee isolate submitted work
from the evaluator. They do not constitute a proof that the verifier is sound
or the sandbox has no exploit. Strict protocol tests, semantic cross-checks,
runtime canaries, and independent replay provide bounded evidence. Preserve
failure cases and version all changes to the accepted proof language.

Invalid output, no proof before the harness deadline, and infrastructure failure
are different observations. Dropping failed infrastructure runs without showing
their denominator can select a favorable sample. Best-of-many proofs describe
a portfolio; averaging selected best proofs does not estimate single-attempt
performance.

The initial campaign has two Unaided trials/item and one fresh plus one dependent
cumulative Frontier trial/item. It supports descriptive comparisons and useful
proof/tool artifacts. It does not establish reliable model rankings, broad
generalization, or a causal benefit of tools without additional matched designs.

## Recorded capture defect in the initial replacement campaign

The campaign frozen at `64b2026` rejected an entire proof directory when it
contained an unrelated draft JSON file. This excluded a valid canonical proof
on `g2-2100030`; the dependent cumulative run encountered the same defect.
The original missing/loss-1 verdicts remain in the data. The
[forensic note](SUBMISSION-FAILURE.md) distinguishes timed local validation,
independent replay of recoverable bytes, and official checkpoint acceptance.
These outcomes confound any interpretation of condition means as pure
proof-solving performance. A subsequent capture repair is a different
evaluator identity; it cannot retroactively improve this campaign.
