# PropBench public publication

This directory is a standalone, read-only website. It needs no build step, third-party assets, runtime API, or owner run directory. Copy the directory to any static host; all site paths are relative, so `/research/propbench/` and other subpaths work.

## Preview and checks

From `publication/`:

```sh
npm test
python3 -m http.server 8769
```

Open `http://localhost:8769/` in a browser. An empty `data/results.json` deliberately displays “No evaluations are published yet.” The site uses `fetch`, so opening `index.html` through a `file:` URL is not a supported preview.

## Data contract

The owner-side export writes `data/results.json`. Only publish a reviewed, independently verified export. The viewer accepts schema `propbench-publication-v1`:

```json
{
  "schema_version": "propbench-publication-v1",
  "generated_at": "ISO-8601 UTC timestamp",
  "set": { "version": "v2", "hash": "set hash", "core_tag": "core version" },
  "evaluator": {
    "scorer_version": "efficiency-v2",
    "rulebook_sha256": "hash",
    "validator_sha256": "hash"
  },
  "campaign": {
    "id": "campaign-1",
    "model": "example-model",
    "effort": "high",
    "status": "complete",
    "planned_jobs": 1,
    "source_commit": null,
    "jobs": [
      { "key": "theorem-1--unaided-1", "item_id": "theorem-1", "condition": "unaided-1", "status": "complete", "wall_seconds": 900, "max_tool_calls": 0, "run_id": "public-run-1" }
    ]
  },
  "items": [
    {
      "id": "theorem-1",
      "par": 8,
      "theorem_sha256": "hash",
      "theorem": { "premises": ["P", "P > Q"], "conclusion": "Q", "difficulty": "Medium" }
    }
  ],
  "runs": [
    {
      "id": "public-run-1",
      "campaign_id": "campaign-1",
      "campaign_condition": "unaided-1",
      "track": "unaided",
      "mode": "unaided",
      "model": "example-model",
      "returned_models": ["returned model ID"],
      "observed_models": ["observed model ID"],
      "provider": "codex-subscription",
      "execution_protocol": "unaided-subscription-v1",
      "evidence": "subscription",
      "evaluation_status": "complete",
      "outcome": "completed",
      "graded_at": "ISO-8601 UTC timestamp",
      "cohort": "exact evaluator cohort",
      "starting_snapshot": null,
      "selected_ids": ["theorem-1"],
      "budget": { "wall_seconds": 900 },
      "subscription": { "effort": "high", "max_tool_calls": 0 },
      "score": 0.1111111111,
      "evaluator_hash": "hash",
      "validator_sha256": "hash",
      "rulebook_sha256": "hash",
      "items": [
        {
          "id": "theorem-1",
          "status": "valid",
          "line_count": 1,
          "par": 8,
          "loss": 0.1111111111,
          "proof_sha256": "hash",
          "proof_bytes_sha256": "hash of exact public proof file bytes",
          "proof_file": "proofs/public-run-1/theorem-1.json",
          "independently_replayed": true,
          "proof": [
            { "line_number": 3, "formula": "Q", "justification": "MP 1,2", "depth": 0 }
          ]
        }
      ]
    }
  ]
}
```

The example illustrates field names; its numbers and proof are **not benchmark results**. A proof may be omitted (`null`) when no public line-by-line export is available. If present, its array length must equal the referee's `line_count`. The viewer checks each item par and loss against the frozen set and scoring rule, validates structure, and renders dynamic text as text nodes. It does not independently verify proofs; that is the exporter's job. When the exporter includes a public `proof_file`, the site links to those exact submitted bytes and shows their separate byte hash.

Frontier runs may additionally include `improvements`: an array of accepted owner checkpoints. Each entry has `item_id`, six-digit `import_id` and `checkpoint_id`, `execution_command`, `captured_elapsed_seconds`, `line_count`, `previous_line_count` (null for a first accepted proof), `proof`, `proof_sha256`, `proof_bytes_sha256`, `proof_file`, and `independently_replayed`. Checkpoint proof files live at `data/proofs/<run-id>/checkpoints/<item-id>-<import-id>.json`. The viewer checks that each event belongs to the selected theorem, reduces a verified line count, follows the prior accepted checkpoint, falls within the run allowance, and links to its own public proof. It displays these discrete observations as “Verified progress” only when every shown checkpoint carries an independent replay flag. Capture offsets do not imply anything about the path between observations or prove optimality.

The campaign job plan creates all four condition cards before dispatch. Each card shows completed, interrupted, active, and pending jobs. Runs with the same `campaign_id` and `campaign_condition` are grouped while retaining each run's exact ID and cohort in the theorem view. Only completed subscription runs attached to completed campaign jobs enter the valid count and mean loss. Interrupted records remain inspectable but excluded. Fixtures cannot mix into subscription groups or earn an official mean; inconsistent model, budget, protocol, effort, provider, or evidence within a condition is rejected. Historical runs without campaign fields remain separate. Campaign conditions are never presented as one cross-track leaderboard.

The results page links to the public JSON export, job ledger CSV, summary JSON, frozen rulebook, exact theorem files, submitted proof files, source repository, and method document. Its theorem browser remains usable before the first result arrives. The frozen files are available after the owner-side export populates `data/`. A campaign source commit, when present, links to that immutable repository tree.

The interrupted 2026-09-25 engineering pilot is retained as a separate static snapshot at `pilots/20260925/`. The current study links to it, and the archived page links back to the current study. The pilot is not pooled with a subsequent repaired campaign.

The publication must contain only allowlisted data. Never include credentials, local paths, owner commands, raw native-client transcripts, personal contact details, or unreviewed proof artifacts. This site deliberately has no endpoint for starting runs or submitting proofs.
