# Publish PropBench on a website

The `publication/` directory is the complete public artifact. It is a static
HTML/CSS/JavaScript site with an allowlisted JSON export and independently
replayed proofs. It requires no backend, accounts, API keys, model clients,
database, fonts, or external script services.

## Prepare the evidence

Use the recorded campaign that you intend to publish:

```sh
npm run publication:export -- track-runs/my-campaign publication/data/results.json
npm run test:publication
```

The export binds each run to its prespecified campaign job, reruns the pinned
referee, and emits only public fields. It also writes the exact frozen theorem
files and rulebook under `publication/data/`. Proof hashes use canonical JSON;
theorem hashes refer to the original theorem-file bytes. The public campaign
retains its planned jobs, including queued or interrupted work. A partial export
must stay visibly partial; it cannot be described as the completed census.

Raw `track-runs/`, `.env`, native-client events, prompts containing local paths,
account metadata, private reasoning traces, SQLite files and contestant work
directories are not website assets. They are intentionally ignored by Git.

## Preview the exact directory

```sh
python3 -m http.server 8769 --directory publication
```

Inspect `http://localhost:8769/` at desktop and mobile widths. Check all track
filters, theorem selection, proof lines, outcome labels, budget/provenance
receipts and data downloads. Test a long formula and an incomplete result.
The page fetches relative JSON, so a `file:` URL is not a supported preview.

## Copy to your website

Copy the **contents** of `publication/` into the intended static site directory,
for example `public/propbench/`. Keep its structure intact:

```text
propbench/
  index.html
  app.js
  data.js
  style.css
  favicon.svg
  data/
    results.json
    rules.md
    theorems/
      manifest.json
      <theorem-id>.json
```

All references are relative, so hosting at `/propbench/` or
`/research/propbench/` works. Serve `.json` as JSON and `.js` as JavaScript.
The test files, `package.json` and `README.md` are optional on the host.
No redirect/rewrite to an application backend is required. A static host may
use a restrictive policy such as `default-src 'self'; script-src 'self';
style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'`.

The Express/Vite control panel is an owner tool. Keep it on loopback; it is not
a public deployment target. Publishing the website does not start inference,
expose a subscription, or authorize visitors to run commands.

## Release record

Commit the code and reviewed `publication/data/` together with the exact
experiment notes. Preserve the campaign identity and per-run evaluator hashes;
later improvements receive a new run/campaign identity. Link the repository,
[protocol](research/PROTOCOL.md), [dataset](research/DATASET.md),
[limitations](research/LIMITATIONS.md) and [citation](CITATION.cff) from any
announcement. Claims should distinguish observed proof lengths, achievable
reference pars, and unknown optima.

This task prepares the directory for the owner's website. It does not modify
the website repository or publish to an external hosting service.
