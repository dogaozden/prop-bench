#!/usr/bin/env python3
"""Package reviewed static assets; never include owner runs or a model client."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
STATIC = ("index.html", "app.js", "data.js", "style.css", "favicon.svg")
PRIVATE = re.compile(rb"/Users/|/private/var/|PRIVATE_[A-Z_]+|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}")


def verified_evidence(blobs: dict, prefix: str) -> dict:
    """Bind receipts to the exact bytes going into the ZIP, without executing data."""
    allowed = {"results.json", "summary.json", "verification.json", "jobs.csv", "README.md"}
    documents = {}
    for name in ("results.json", "verification.json", "summary.json"):
        key = f"{prefix}/{name}"
        if key not in blobs:
            raise ValueError(f"Missing {name} in {prefix}; regenerate public analysis and verification before packaging")
        documents[name] = json.loads(blobs[key])
        if not isinstance(documents[name], dict):
            raise ValueError(f"Invalid {name} in {prefix}")
    data, receipt, summary = (documents[name] for name in ("results.json", "verification.json", "summary.json"))
    campaign = data.get("campaign")
    if data.get("schema_version") != "propbench-publication-v1" or not isinstance(campaign, dict):
        raise ValueError(f"A real campaign export is required in {prefix}")
    digest = hashlib.sha256(blobs[f"{prefix}/results.json"]).hexdigest()
    if (receipt.get("schema_version") != "propbench-publication-verification-v1"
            or receipt.get("verified") is not True
            or receipt.get("results_sha256") != digest
            or receipt.get("campaign_id") != campaign.get("id")
            or receipt.get("campaign_status") != campaign.get("status")):
        raise ValueError(f"Missing, stale, or unsuccessful verification receipt in {prefix}; rerun publication:verify with --report")
    if (summary.get("schema_version") != "propbench-publication-analysis-v1"
            or summary.get("source_export_sha256") != digest
            or summary.get("campaign_id") != campaign.get("id")):
        raise ValueError(f"Missing or stale analysis summary in {prefix}; rerun publication:analyze")

    def asset(relative: str, expected: str) -> None:
        if (not isinstance(relative, str) or "\\" in relative
                or any(ord(char) < 32 or ord(char) == 127 for char in relative)
                or any(part in ("", ".", "..") for part in relative.split("/"))):
            raise ValueError(f"Unsafe evidence asset path in {prefix}")
        if not isinstance(expected, str) or re.fullmatch(r"[a-f0-9]{64}", expected) is None:
            raise ValueError(f"Missing or invalid evidence asset hash in {prefix}")
        key = f"{prefix}/{relative}"
        if key not in blobs:
            raise ValueError(f"Missing evidence asset in {prefix}: {relative}")
        if hashlib.sha256(blobs[key]).hexdigest() != expected:
            raise ValueError(f"Evidence asset byte hash mismatch in {prefix}: {relative}")
        allowed.add(relative)

    def safe_id(value: str) -> str:
        if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value) is None:
            raise ValueError(f"Invalid evidence identity in {prefix}")
        return value

    # A receipt binds the results metadata; bind that metadata to the exact
    # captured asset bytes too. No rereads or external commands are needed.
    asset("theorems/manifest.json", data.get("set", {}).get("manifest_sha256"))
    asset("rules.md", data.get("evaluator", {}).get("rulebook_sha256"))
    theorem_ids = set()
    for item in data["items"]:
        item_id = safe_id(item["id"])
        theorem_ids.add(item_id)
        asset(f"theorems/{item_id}.json", item.get("theorem_sha256"))
    for run in data["runs"]:
        run_id = safe_id(run["id"])
        for item in run["items"]:
            if item["status"] != "valid":
                if item.get("proof_file") is not None:
                    raise ValueError(f"Nonvalid outcome claims a proof asset in {prefix}")
                continue
            item_id = safe_id(item["id"])
            if item_id not in theorem_ids or item.get("proof_file") != f"proofs/{run_id}/{item_id}.json":
                raise ValueError(f"Unexpected final proof asset path in {prefix}")
            asset(item["proof_file"], item.get("proof_bytes_sha256"))
        for event in run.get("improvements", []):
            item_id, import_id = safe_id(event["item_id"]), event.get("import_id")
            if (item_id not in theorem_ids or not isinstance(import_id, str)
                    or re.fullmatch(r"[0-9]{6}", import_id) is None
                    or event.get("proof_file") != f"proofs/{run_id}/checkpoints/{item_id}-{import_id}.json"):
                raise ValueError(f"Unexpected checkpoint proof asset path in {prefix}")
            asset(event["proof_file"], event.get("proof_bytes_sha256"))
    if f"{prefix}/jobs.csv" not in blobs:
        raise ValueError(f"Missing jobs.csv in {prefix}; regenerate public analysis before packaging")
    captured = {key[len(prefix) + 1:] for key in blobs if key.startswith(prefix + "/")}
    if captured - allowed:
        raise ValueError(f"Unexpected data asset in {prefix}; only declared evidence and fixed public metadata may be packaged")
    return data


def package(source: Path, output: Path, allow_partial: bool = False) -> dict:
    source = source.resolve()
    files = {name: source / name for name in STATIC}
    data_roots = [source / "data"]
    pilots = source / "pilots"
    if pilots.exists():
        if pilots.is_symlink():
            raise ValueError("Symlinks are not public assets")
        for pilot in sorted(pilots.iterdir()):
            if not re.fullmatch(r"[0-9]{8}", pilot.name) or pilot.is_symlink() or not pilot.is_dir():
                raise ValueError("Unexpected archived pilot directory")
            for name in STATIC:
                files[f"pilots/{pilot.name}/{name}"] = pilot / name
            data_roots.append(pilot / "data")
    for data_root in data_roots:
        if data_root.is_symlink() or not data_root.is_dir():
            raise ValueError("Public data must be a regular directory")
        for file in sorted(data_root.rglob("*")):
            if file.is_symlink():
                raise ValueError("Symlinks are not public assets")
            if file.is_file():
                if file.suffix not in (".json", ".md", ".csv"):
                    raise ValueError(f"Unrecognized public data type: {file.name}")
                files[file.relative_to(source).as_posix()] = file
    blobs = {}
    for name, file in files.items():
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"Missing regular public asset: {name}")
        raw = file.read_bytes()
        if PRIVATE.search(raw):
            raise ValueError(f"Possible private material in {name}; review before packaging")
        blobs[name] = raw
    for data_root in data_roots:
        verified_evidence(blobs, data_root.relative_to(source).as_posix())
    campaign = json.loads(blobs["data/results.json"])["campaign"]
    if campaign["status"] != "complete" and not allow_partial:
        raise ValueError("Campaign is incomplete; --allow-partial explicitly packages its recorded partial status")
    blobs["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    blobs["README.txt"] = (
        "PropBench static publication\n\n"
        f"Campaign: {campaign['id']}\nStatus: {campaign['status']}\n"
        "Copy this directory's contents to your static website, preserving all paths.\n"
        "Preview: python3 -m http.server 8769 --bind 127.0.0.1\n"
        "The site needs HTTP serving; file: URLs are not supported.\n"
        "No backend, API key, model client, account, or build step is required.\n"
        "Proof replay instructions: https://github.com/dogaozden/prop-bench/blob/master/research/REPRODUCIBILITY.md\n"
        "Bundle hashes prove internal byte consistency, not independent authorship or experimental authenticity.\n"
    ).encode()
    manifest = {
        "schema_version": "propbench-static-release-v1",
        "campaign_id": campaign["id"], "campaign_status": campaign["status"],
        "source_commit": campaign["source_commit"],
        "files": [{"path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
                  for name, raw in sorted(blobs.items())],
    }
    blobs["release.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, raw in sorted(blobs.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 << 16)
            archive.writestr(info, raw)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(f"{digest}  {output.name}\n")
    return {"archive": str(output), "sha256": digest, "files": len(blobs), "campaign_status": campaign["status"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "publication")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/propbench-publication.zip")
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()
    print(json.dumps(package(args.source, args.output.resolve(), args.allow_partial)))
