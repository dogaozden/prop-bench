# Frontier and Unaided implementation dossier

Status: **September 25 Codex-only publication preparation: current native controls, validation-only runtime and Frontier v2 verified; expanded campaign pending**.
See [verification](TRACKS-VERIFICATION.md) for exact results and retained
artifacts, and [the guide](TRACKS.md) for commands.

The initial implementation incorrectly made API-key access the primary live
path. The owner clarified that the experiment is to use Claude and Codex
subscriptions. Native subscription clients are now the primary implementation;
their separate protocols record effort, enforced wall/tool limits, actual
client/model identity, and observed usage. Exact internal inference counts and
API-style token caps are not asserted. The historical acceptance below covers
the original verifier, sandbox, records, fixtures, and UI, not live subscription
acceptance. See the appended September 8 subscription verification for actual
proof results, final control checks, and the remaining Claude login blocker.

## Mission and decisions

The user's two questions are preserved:
- Frontier: how much can a fully equipped agent shorten proofs?
- Unaided: how well can a model construct short valid proofs without external
  computation or verifier feedback?

Claude design history was reviewed in the local logic-project transcript
`d5cd26cd-5e60-4654-9d52-38d62d800e5a.jsonl`. Relevant historical concerns
included full sandboxing, repeated hill-climbing, retaining methodology, and
avoiding claims that a known proof length is optimal.

Both tracks use the same rules, pinned Rust referee, proof format, and line
count. Premises are free; assumptions and subproof closing lines count. New
strict replay checks claimed depths and CP/IP ranges while default legacy
replay behavior remains unchanged.

The versioned efficiency-v2 loss is L/(L+par) for valid proofs and 1 for
missing/invalid answers. Shorter is better; any finite valid proof beats
omission. Historical golf ratios, Elo data, frozen sets, and answer keys retain
their original interpretation. Par is an achievable length, never a minimum.

Frontier has fresh and explicit hashed cumulative starts. Native subscription
drivers share wall and tool budgets across exec and delegate contexts.
Linux Docker containers isolate computation from owner
history, keys, neighboring files, and grading state. The runtime image is
pinned per run. External MCP handoffs remain supported, explicitly unmetered,
and excluded from controlled rankings.

Unaided exposes no tools and starts one fresh session per reached theorem.
Invalid proofs receive no feedback or repair opportunity. Native transport
behavior remains client-owned; no extra owner session is silently dispatched.
Prompts, dispatch uncertainty, returned native metadata, usage
availability, and final results are recorded.

Owner records pin configuration, theorem bytes, rulebook, and native referee.
Comparison regrades proofs instead of trusting cached scores. Controlled
Frontier finalization is one-shot and sealed. External imports are serialized,
independently checked, and monotonic. Archives retain accepted proofs, tools,
methodology, and debriefs.

## Acceptance

- Main inspected integration and independently ran the final **49-test**
  TypeScript suite with **zero failures or skips**, including physical Docker.
- **22 Rust tests** passed for strict replay and legacy validator/replay/golf.
- Root typecheck, GUI typecheck, and GUI production build passed.
- The final deterministic CLI rehearsal passed Unaided, fresh Frontier,
  cumulative Frontier, external handoff/import, sealing, and cohort comparison.
- Main exercised Unaided and Frontier through the actual GUI and inspected
  their result tables, runtime identity, usage, and separate rankings.
- Independent Sol review drove fixes to inference metering, image pinning,
  ranking status, executable response detection, and finalization integrity.
- Historical golf/Cargo/legacy regression files were unchanged; adjacent
  logic-core checkout stayed clean. No paid provider calls, commits, or pushes.

## Useful failures and operational state

The native macOS sandbox could not reliably terminate detached sessions and
was abandoned. A broad host-signal diagnostic was rejected; no such mechanism
remains. Docker is the only contestant execution backend.

Docker's legacy builder required COPY followed by RUN chmod. The bind mount
uses Docker's default read-write mode without an invalid bare rw option.
A test compiler-startup timeout was removed by separating child transpilation
from the independent TypeScript check. An evaluator change during rehearsal
correctly rejected the old run; a new run on frozen source passed.

This Mac has a dedicated Colima propbench profile (2 CPUs, 2 GiB), separate
from the existing default profile. The local image is built and physical
acceptance passed. The GUI's installed native SQLite binding uses Node 25.2.1;
use a consistent Node version when installing dependencies and running it.

The September 7 acceptance above establishes the shared verifier, isolation,
records, and fixture behavior. Subscription compatibility and actual proof
results are tracked separately in the September 8 verification entry.
