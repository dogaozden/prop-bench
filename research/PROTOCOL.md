# Experimental protocol

Status: pre-campaign plan, agreed on 2026-09-25. Initial configuration:
`gpt-6-astra`, `xhigh` reasoning, normal speed. The final campaign manifest must
record the frozen source commit, model/effort configurations, native-client
identity, runtime image, exact selected IDs, order, budgets, and plan hash
before dispatch. Results cannot be inferred from this document.

## Question and endpoints

PropBench measures construction of valid, short proofs under a particular
natural-deduction calculus and interface. Unaided measures final-response proof
construction without tool feedback. Frontier measures proof improvement with
isolated computation, validation, and bounded delegation. Fresh and cumulative
Frontier measure different starting conditions.

For item i with frozen reference length P_i and verified length L_i, report
loss L_i/(L_i+P_i); invalid, missing, malformed, or budget-exhausted submissions
score 1. The primary endpoint is the arithmetic mean over **all 24 planned
items**, with equal weight per item. Lower is better. Also publish valid count,
per-item status/length/loss, band breakdown, elapsed time, and observed usage
with its coverage. Mean length among valid proofs is descriptive and must never
replace all-item loss or coverage.

P_i is a known achievable length, not a lower bound or shortest proof. All
assumptions, derived lines, and scope-closing lines count; premises are free.
Strict replay determines validity, scope, and line count. The calculus includes
replacement of all identical occurrences of a selected subformula in one line;
this matters when comparing lengths with other proof systems.

## Fixed experiment schedule

Repeat the following for every model/effort configuration named in the frozen
manifest. Do not change effort, budget, item set, or prompt in response to a
configuration's scored outcomes.

| Arm | Units per configuration | Enforced allowance per unit | Starting state |
|---|---:|---|---|
| Unaided, repeat 1 | 24 singleton items | 900 s; zero tools; one fresh session | Rulebook, proof format, one theorem |
| Unaided, repeat 2 | Same 24 singleton items | Same 900 s and empty tool surface | Independent fresh sessions |
| Frontier, fresh | 24 singleton items | 900 s; 128 tool calls; at most 8 sessions, depth 4 | Blank methods/tools/proofs |
| Frontier, cumulative | Same 24 singleton items | Same 900 s and 128 calls | That item's own fresh owner archive |

The ceiling is 24 run-wall-clock hours per configuration (12 Unaided, 6 fresh,
6 cumulative), plus setup/finalization overhead. This is not a token budget or
a claim about provider compute or billing. Up to six simultaneous native jobs
are planned initially, subject to resource acceptance; record actual concurrency
and Docker CPU/memory/profile configuration. Keep the concurrency policy fixed
within comparison blocks. If contention requires a change, label a new block.

Use singleton runs because the current subscription runner shares its wall
deadline across the entire selection. A 24-item run at 900 seconds would allow
900 seconds total, not per item. Fresh sessions alone do not repair this timing
confound. The manifest defines an execution order independently of the CLI's
manifest-order filtering; singleton dispatch makes that order enforceable.

Finish the first full census before outcome-driven expansion. Interleave model
configurations within item/repeat blocks using a deterministic stored order so
one model does not systematically run at a different service/load period. With
one configuration, use a stored item permutation for each repeat. A rejected or
unsupported configuration remains a documented preflight failure; no fallback.

## Run acceptance and failure rules

1. Dispatch only through the audited Codex native client with ChatGPT
   subscription authentication. Preserve requested and returned model/effort,
   client version and executable hash. Do not use API keys or another provider.
2. Unaided exposes no tools, inherited instructions, filesystem access, prior
   proofs, or verifier feedback. Grade only its final response. Invalid proofs
   are terminal scored outcomes; no repair/retry of the same attempt.
3. Frontier receives only the selected theorem, rulebook, validation-only
   executable, blank or explicitly inherited state, and isolated exec/delegate
   capabilities. It receives no generator, owner checkout, answer key, host
   filesystem, or network access. This must be established by runtime canaries.
4. Checkpoints retain exact candidate bytes and independent strict verdicts;
   only a strictly shorter valid candidate may improve the owner incumbent.
   Stop writes before finalization and seal the best accepted proof. Failed
   candidate checks never delete an incumbent. Proofs, tools, and journals must
   be captured before the deadline; cumulative archives use the latest safe,
   timely tool/journal snapshot, never files left during cleanup grace. Capture
   and checking consume the shared allowance, but checking bytes already
   captured in time may finish after cutoff. The owner returns no checkpoint
   verdict feedback; the agent may call its own validator through exec.
5. Harness budget exhaustion is a scored endpoint. Authentication, quota,
   transport, verifier, or isolation failures are retained as interrupted
   infrastructure/protocol outcomes and are not silently converted to successes.
   An explicit replacement, if needed, receives a new ID and links the original.
6. A census is complete only when every scheduled unit has an eligible terminal
   outcome. Publish interrupted units and attempted denominator alongside any
   completed-only summary; do not use a changing denominator as a leaderboard.
   Until complete, label aggregate results provisional. Optionally give a
   conservative all-planned loss bound with interruptions assigned 1, clearly
   distinguished from scored model failures.

## Analysis and continued useful work

For Unaided, report each repeat's 24-item score plus their arithmetic mean.
Keep all 48 outcomes; do not select the better of two proofs for the primary
single-attempt endpoint. An explicitly labeled best-of-two portfolio may be
reported secondarily. Two repeats show observed variation, not precise tail
reliability.

Fresh Frontier has one trial/item initially. Report it as that trial. Cumulative
Frontier reports starting and ending coverage/loss, new proofs, shortened
proofs, and per-item deltas. Its baseline includes the fresh run's accepted
proofs and exact tool/method archive. Different starting snapshot digests are
different cohort conditions. Baseline copies count as inherited, not newly
discovered proofs.

Unaided versus fresh Frontier has the same 900 s wall allowance but differs in
tool access, prompt/interface, and available multi-session computation. It is a
comparison of these complete conditions, not an equal-token or equal-FLOP
ablation. Cumulative improvement additionally has inherited work and 900 s more
computation; it does not isolate a causal tool effect.

After the census, freeze an amendment before further runs. Prefer: a second
fresh Frontier census for repeatability; controlled interface ablations; or a common
archived tool/method snapshot tested across configurations. New cross-item tools
or a union of best proofs form an explicitly **seeded/cumulative research
portfolio**, with every source run and preparation effort recorded. Never relabel
that portfolio as a fresh score. It is useful engineering progress, even when
it is not an independent benchmark replicate.

For paired model comparisons, show item-level paired differences on the same
conditions and report effect size. The 24 items are a curated census, not an
IID sample of all logic tasks. If uncertainty intervals are added, state their
resampling unit and estimand; resample theorem clusters together across repeats
and configurations. Do not treat correlated sessions as independent items or
call a single observed difference statistically established superiority.
