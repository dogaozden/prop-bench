use std::process::{Command, Output};

fn validate(theorem: &str, proof: &str) -> serde_json::Value {
    let out = Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(["validate", "--theorem", &format!("fixtures/regression/{theorem}"),
               "--proof", &format!("fixtures/regression/{proof}")])
        .output().expect("binary runs");
    serde_json::from_slice(&out.stdout).expect("valid JSON on stdout")
}

fn run_validate(theorem: &str, proof: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(["validate", "--theorem", theorem, "--proof", proof])
        .output().expect("binary runs")
}

fn out_str(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn err_str(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

#[test]
fn round10_house_rule_5line_validates() {
    let v = validate("round10_theorem.json", "round10_proof_5line.json");
    assert_eq!(v["valid"], true, "errors: {}", v["errors"]);
    assert_eq!(v["line_count"], 5);
}

#[test]
fn round10_strict_6line_validates() {
    let v = validate("round10_theorem.json", "round10_proof_6line.json");
    assert_eq!(v["valid"], true, "errors: {}", v["errors"]);
    assert_eq!(v["line_count"], 6);
}

#[test]
fn round3_cp_1_1_validates() {
    let v = validate("round3_theorem.json", "round3_proof.json");
    assert_eq!(v["valid"], true, "errors: {}", v["errors"]);
    assert_eq!(v["line_count"], 4);
}

#[test]
fn theorem_with_premises_validates_and_counts_derived_only() {
    let out = run_validate("fixtures/regression/premises_theorem.json", "fixtures/regression/premises_proof.json");
    assert!(out.status.success(), "stdout: {} stderr: {}", out_str(&out), err_str(&out));
    assert!(out_str(&out).contains("\"line_count\": 1") || out_str(&out).contains("line_count: 1"),
        "expected line_count 1, got: {}", out_str(&out));
}

#[test]
fn premise_lines_in_proof_input_are_rejected() {
    let out = run_validate("fixtures/regression/premises_theorem.json", "fixtures/regression/premises_proof_bad.json");
    assert!(!out.status.success());
}

#[test]
fn invalid_mp_citation_reports_valid_false_with_exit_0() {
    // Legacy CLI contract: a wrong-but-well-formed proof (here, an MP citation
    // referencing lines that don't support the derivation) is a semantic
    // verdict, not a protocol violation — it must exit 0 with a `valid: false`
    // JSON body, not a hard CLI failure. The GUI's validate() has no
    // try/catch around the CLI call, so a non-zero exit here would 500 on
    // every ordinary "the proof is wrong" case.
    let out = run_validate("fixtures/regression/round3_theorem.json", "fixtures/regression/invalid_line_proof.json");
    assert!(out.status.success(), "stdout: {} stderr: {}", out_str(&out), err_str(&out));
    let v: serde_json::Value = serde_json::from_str(&out_str(&out))
        .unwrap_or_else(|e| panic!("stdout should parse as JSON: {} (stdout: {:?})", e, out_str(&out)));
    assert_eq!(v["valid"], false, "expected valid:false for a wrong MP citation, full output: {}", v);
}
