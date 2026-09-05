use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

fn run_score(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(args)
        .output()
        .expect("binary runs")
}

fn out_str(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn err_str(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("propbench_golf_score_test_{name}"));
    let _ = fs::remove_dir_all(&dir);
    dir
}

/// (a) Two-item fixture set (t1 par 4 replays at exactly 4 lines, ratio 1.0;
/// t2 has no submitted proof, imputed at manifest.imputed_ratio 1.5) must
/// score as the geometric mean of [1.0, 1.5] == sqrt(1.5) == 1.2247.
#[test]
fn score_matches_expected_geometric_mean() {
    let out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test",
        "--proofs", "fixtures/golf-test/proofs-valid",
    ]);
    assert!(
        out.status.success(),
        "expected exit 0, stdout: {}\nstderr: {}",
        out_str(&out), err_str(&out)
    );
    let stdout = out_str(&out);
    assert!(stdout.contains("SCORE: 1.2247"), "expected SCORE: 1.2247 in stdout, got: {stdout}");
    // Per-item detail: t1 at par (ratio 1.0000), t2 imputed (ratio 1.5000).
    assert!(stdout.contains("t1"), "stdout should mention t1: {stdout}");
    assert!(stdout.contains("t2"), "stdout should mention t2: {stdout}");
    assert!(stdout.contains("1.0000"), "expected t1's ratio 1.0000 in stdout: {stdout}");
    assert!(stdout.contains("1.5000"), "expected t2's imputed ratio 1.5000 in stdout: {stdout}");
}

/// (b) A present-but-invalid proof must fail the whole run closed: exit 1,
/// every error printed, and — the absolute rule — no "SCORE:" line anywhere
/// in stdout, even though t2 alone would otherwise impute fine.
#[test]
fn invalid_proof_exits_1_with_no_score_and_no_score_line() {
    let out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test",
        "--proofs", "fixtures/golf-test/proofs-invalid",
    ]);
    assert_eq!(out.status.code(), Some(1), "stdout: {}\nstderr: {}", out_str(&out), err_str(&out));
    let stdout = out_str(&out);
    assert!(!stdout.contains("SCORE:"), "stdout must contain no SCORE: line on the invalid path, got: {stdout}");
    // The error must be surfaced somewhere (stdout or stderr), not swallowed.
    let combined = format!("{stdout}{}", err_str(&out));
    assert!(combined.contains("t1"), "expected the invalid item's error to mention t1: {combined}");
}

/// A declared proof path that's a symlink to a genuinely valid proof file
/// elsewhere on disk must never be scored (or imputed as "absent" — that
/// would silently score it via the imputed_ratio while pretending nothing
/// was submitted): exit 1, no SCORE line, the offending id named. Mirrors
/// the demonstrated referee escape (a committed symlink to the answer key)
/// one layer down, at the scorer itself.
#[test]
fn symlinked_proof_path_exits_1_with_no_score() {
    let dir = fresh_dir("symlink_proof");
    fs::create_dir_all(&dir).expect("create proofs dir");
    let target = fs::canonicalize("fixtures/golf-test/proofs-valid/t1.json")
        .expect("canonicalize real proof file");
    std::os::unix::fs::symlink(&target, dir.join("t1.json")).expect("create symlink");

    let out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test",
        "--proofs", dir.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(1), "stdout: {}\nstderr: {}", out_str(&out), err_str(&out));
    let combined = format!("{}{}", out_str(&out), err_str(&out));
    assert!(!combined.contains("SCORE:"), "a symlinked proof path must never produce a SCORE line: {combined}");
    assert!(combined.contains("t1"), "error should name the offending item: {combined}");
}

/// A directory at the declared proof path (instead of a file) must also
/// fail closed: exit 1, no SCORE line, id named.
#[test]
fn directory_at_proof_path_exits_1_with_no_score() {
    let dir = fresh_dir("dir_proof");
    fs::create_dir_all(dir.join("t1.json")).expect("create directory at proof path");

    let out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test",
        "--proofs", dir.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(1), "stdout: {}\nstderr: {}", out_str(&out), err_str(&out));
    let combined = format!("{}{}", out_str(&out), err_str(&out));
    assert!(!combined.contains("SCORE:"), "a directory at the proof path must never produce a SCORE line: {combined}");
    assert!(combined.contains("t1"), "error should name the offending item: {combined}");
}

/// (c) A theorem file whose bytes no longer match the manifest's recorded
/// theorem_sha256 (tampered after packaging) must hard-fail with exit 2,
/// distinct from an ordinary invalid-proof exit 1 — checked before any
/// scoring is attempted.
#[test]
fn tampered_theorem_file_exits_2() {
    let dir = fresh_dir("tampered");
    fs::create_dir_all(&dir).expect("create tampered set dir");
    fs::copy("fixtures/golf-test/manifest.json", dir.join("manifest.json")).expect("copy manifest");
    fs::copy("fixtures/golf-test/t1.json", dir.join("t1.json")).expect("copy t1");
    fs::copy("fixtures/golf-test/t2.json", dir.join("t2.json")).expect("copy t2");

    // Tamper t1's bytes post-copy without touching the manifest's recorded
    // hash — the file on disk no longer matches what was notarized.
    fs::write(
        dir.join("t1.json"),
        br#"{"id": "t1", "premises": [], "conclusion": "P . Q", "difficulty": "Easy", "difficulty_value": 10}"#,
    )
    .expect("tamper t1");

    let out = run_score(&[
        "golf", "score",
        "--set", dir.to_str().unwrap(),
        "--proofs", "fixtures/golf-test/proofs-valid",
    ]);
    assert_eq!(out.status.code(), Some(2), "stdout: {}\nstderr: {}", out_str(&out), err_str(&out));
    assert!(!out_str(&out).contains("SCORE:"), "tampered set must never print a SCORE line");
}

/// (d) `--json` must parse as valid JSON and carry the same score/ratios as
/// the human-readable path: {score, items:[{id, par, lines, ratio}]}.
#[test]
fn json_output_parses_and_matches_expected_score() {
    let out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test",
        "--proofs", "fixtures/golf-test/proofs-valid",
        "--json",
    ]);
    assert!(
        out.status.success(),
        "expected exit 0, stdout: {}\nstderr: {}",
        out_str(&out), err_str(&out)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("stdout should parse as JSON: {e} (stdout: {})", out_str(&out)));

    assert_eq!(v["score"], 1.2247, "full output: {v}");

    let items = v["items"].as_array().expect("items is an array");
    assert_eq!(items.len(), 2, "full output: {v}");

    assert_eq!(items[0]["id"], "t1");
    assert_eq!(items[0]["par"], 4);
    assert_eq!(items[0]["lines"], 4);
    assert_eq!(items[0]["ratio"], 1.0);

    assert_eq!(items[1]["id"], "t2");
    assert_eq!(items[1]["par"], 8);
    assert_eq!(items[1]["lines"], serde_json::Value::Null);
    assert_eq!(items[1]["ratio"], 1.5);
}

/// Regression: par=32 with a 1-line replay gives ratio exactly 1/32 =
/// 0.03125 — an exact tie at the 4th decimal place. Rust's `{:.4}` formats
/// ties-to-even (-> "0.0312"), while `round4()` (used for --json) rounds
/// ties away from zero (-> "0.0313"). The table must route through the same
/// `round4()` as --json so the two output modes never disagree on a real
/// input. Fixture: `fixtures/golf-test/rounding` (reuses the already-proven
/// `premises_theorem.json`/`premises_proof.json` shape — 2 premises, 1
/// derived MP line — under par 32).
#[test]
fn table_and_json_agree_on_an_exact_rounding_tie() {
    let human = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test/rounding",
        "--proofs", "fixtures/golf-test/rounding/proofs",
    ]);
    assert!(human.status.success(), "stdout: {}\nstderr: {}", out_str(&human), err_str(&human));
    let human_stdout = out_str(&human);
    assert!(human_stdout.contains("0.0313"), "table must round the 0.03125 tie to 0.0313, got: {human_stdout}");
    assert!(!human_stdout.contains("0.0312"), "table must not use ties-to-even rounding, got: {human_stdout}");
    assert!(human_stdout.contains("SCORE: 0.0313"), "got: {human_stdout}");

    let json_out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test/rounding",
        "--proofs", "fixtures/golf-test/rounding/proofs",
        "--json",
    ]);
    assert!(json_out.status.success(), "stdout: {}\nstderr: {}", out_str(&json_out), err_str(&json_out));
    let v: serde_json::Value = serde_json::from_slice(&json_out.stdout).expect("valid JSON");
    assert_eq!(v["score"], 0.0313, "full output: {v}");
    assert_eq!(v["items"][0]["ratio"], 0.0313, "full output: {v}");
}

/// A theorem file the manifest declares but that doesn't exist in `--set`
/// is tampering, exactly like a hash mismatch — the integrity contract is
/// manifest <-> files, not just manifest <-> file-contents. Exit 2, and the
/// missing item's id/filename must be named in the output.
#[test]
fn missing_declared_theorem_file_is_tampering_exits_2() {
    let dir = fresh_dir("missing_theorem");
    fs::create_dir_all(&dir).expect("create dir");
    fs::copy("fixtures/golf-test/manifest.json", dir.join("manifest.json")).expect("copy manifest");
    fs::copy("fixtures/golf-test/t1.json", dir.join("t1.json")).expect("copy t1");
    // t2.json is deliberately NOT copied — the manifest declares it, but the
    // file is missing from the set dir.

    let out = run_score(&[
        "golf", "score",
        "--set", dir.to_str().unwrap(),
        "--proofs", "fixtures/golf-test/proofs-valid",
    ]);
    assert_eq!(out.status.code(), Some(2), "stdout: {}\nstderr: {}", out_str(&out), err_str(&out));
    let combined = format!("{}{}", out_str(&out), err_str(&out));
    assert!(!combined.contains("SCORE:"), "a set with a missing theorem file must never print a SCORE line");
    assert!(combined.contains("t2"), "error should name the missing item: {combined}");
}

/// A manifest with zero items is a broken set, not a vacuous 0-item success
/// — geometric mean over zero ratios is 0.0/0.0 = NaN, which must never
/// reach stdout as `SCORE: NaN` under exit 0.
#[test]
fn empty_manifest_errors_instead_of_nan_score() {
    let out = run_score(&[
        "golf", "score",
        "--set", "fixtures/golf-test/empty",
        "--proofs", "fixtures/golf-test/proofs-valid",
    ]);
    assert!(!out.status.success(), "an empty manifest must not exit 0, stdout: {}\nstderr: {}", out_str(&out), err_str(&out));
    let combined = format!("{}{}", out_str(&out), err_str(&out));
    assert!(!combined.to_uppercase().contains("NAN"), "must never print a NaN score: {combined}");
    assert!(
        combined.to_lowercase().contains("empty") || combined.to_lowercase().contains("no items"),
        "error message should explain the empty set: {combined}"
    );
}
