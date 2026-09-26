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


def package(source: Path, output: Path, allow_partial: bool = False) -> dict:
    source = source.resolve()
    result_path = source / "data/results.json"
    data = json.loads(result_path.read_text())
    if data.get("schema_version") != "propbench-publication-v1" or not data.get("campaign"):
        raise ValueError("A real campaign export is required")
    campaign = data["campaign"]
    if campaign["status"] != "complete" and not allow_partial:
        raise ValueError("Campaign is incomplete; --allow-partial explicitly packages its recorded partial status")
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
