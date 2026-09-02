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
