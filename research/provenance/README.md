# Historical provenance and retained-reference verification

This archive makes the factual sources cited by [DATASET.md](../DATASET.md)
inspectable in a public clone. It combines selected historical statements with
a new, separately identified replay of the retained reference proofs.

| Artifact | What it establishes |
|---|---|
| [Historical excerpts](historical-excerpts.md) | The exact selected factual text found in five named development records |
| [Source manifest](historical-sources.json) | Full source hashes and sizes, attribution, exact excerpt hashes and offsets, and all omitted line ranges |
| [Retained-reference replay](retained-reference-replay.json) | Current strict validity and achieved par for all 24 retained reference proofs, with exact byte hashes |

## Historical sources and limits

The sources are the Task 15 addendum and Task 16 softness measurements in
`docs/superpowers/plans/2026-08-24-proof-golf-MEASUREMENTS.md`, plus
`docs/superpowers/reviews/2026-08-24-proof-golf/` files `task-15-report.md`,
`task-15-review.md`, `task-16-report.md`, and `task-16-review.md`. These are
relative source identifiers, not files required in a public checkout.

The two reviews identify their reviewer as **Sonnet (t15-review-sonnet),
2026-09-06**. The implementing reports and measurement document have no named
author byline. The model-attributed reviews are development records, not
external human peer reviews; the bylines are reported as written and not
independently authenticated. The reports attribute the two measurement addenda to their
implementing sessions. The `2026-08-24` filename dates do not establish the
dates of later addenda.

Task 15 report lines 298–299 and Task 16 report line 112 say that these documents
were edited outside Git, which the current filesystem check confirms. No
commit identifier or permanent public URL for their full text was established.
The SHA-256 values identify the local bytes inspected on 2026-09-26 UTC; they
do not prove when those bytes were written or authenticate the historical
execution logs. Historical freeze, selection, and timing claims remain
attributed reports. This audit did not repeat their search or generation.

Each fenced excerpt is an exact UTF-8 byte slice of inclusive, one-based source
lines. No wording within an excerpt was changed. The JSON manifest records
zero-based start and exclusive-end byte offsets into `historical-excerpts.md`,
the slice length and hash, and every omitted source line range. Editorial
headings and separators are outside these slices. Omitted material includes
superseded work, internal workflow/brief material, host paths, proof examples,
unrelated implementation details, and redundant passages. The archive contains
no prompts, private reasoning transcripts, credentials, or reference proofs.

The source records contain no separate license declaration. This archive
records provenance without inferring third-party permissions, authenticating
ownership, or adding a new license grant. The repository's existing MIT notice
is unchanged.

## Current reference replay

The retained key was located using the explicit key-directory assignment in
Task 15 report line 124. That absolute host path is omitted from the excerpts.
Each expected `<id>.proof.json` was read directly from that location; no
theorem or proof was regenerated and no search or model inference was used.
Reference proofs were never written into contestant roots or copied into this
archive.

All **24/24** proofs passed the existing `propbench validate --strict-protocol`
CLI against the exact public theorem bytes. All counts equaled manifest par,
totalling **475 lines**. A second serial pass through the unchanged Tracks
`validateCandidate` wrapper also passed **24/24**, including its JSON shape
gate. The report preserves per-item proof-byte hashes and lengths, theorem
hashes, strict and wrapper verdicts, validator hash, source hashes, and UTC
timestamps. Input hashes were checked before and after replay.

This verifies that each par is currently achievable under strict replay. It
does not establish optimality, reproduce the historical search, or prove the
current key bytes identical to an unrecorded historical key hash. The proof
contents remain private; the public report is an audit attestation with exact
artifact identifiers, not a self-contained public proof certificate.

For an integrity check without access to the private sources, run from the
repository root:

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json
root = Path('research/provenance')
m = json.loads((root / 'historical-sources.json').read_bytes())
data = (root / m['excerpt_artifact']['path']).read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(data) == m['excerpt_artifact']['sha256']
for source in m['sources']:
    for e in source['excerpts']:
        chunk = data[e['artifact_start_byte']:e['artifact_end_byte_exclusive']]
        assert len(chunk) == e['bytes'] and sha(chunk) == e['sha256']
print('All 20 excerpt hashes match.')
PY
```

This checks archive consistency. Verifying the full source hashes requires
those source bytes; independently replaying the references requires the
retained proof bytes and the declared validator.
