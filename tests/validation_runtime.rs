//! The contestant executable must retain the referee contract without exposing
//! the owner's construction tools. Keep the owner executable as the oracle.
#![cfg(feature = "owner-tools")]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

const OWNER: &str = env!("CARGO_BIN_EXE_propbench");
const VALIDATOR: &str = env!("CARGO_BIN_EXE_propbench-validate");
static NEXT_CASE: AtomicU64 = AtomicU64::new(0);

struct CaseFiles(PathBuf);

impl CaseFiles {
    fn new(theorem: Value, proof: Value) -> Self {
        let root = std::env::temp_dir().join(format!(
            "propbench-validation-runtime-{}-{}",
            std::process::id(),
            NEXT_CASE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("theorem.json"), serde_json::to_vec(&theorem).unwrap()).unwrap();
        fs::write(root.join("proof.json"), serde_json::to_vec(&proof).unwrap()).unwrap();
        Self(root)
    }

    fn compare(&self) -> Output {
        compare(&self.0.join("theorem.json"), &self.0.join("proof.json"))
    }
}

impl Drop for CaseFiles {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn theorem(premises: &[&str], conclusion: &str) -> Value {
    json!({"id":"runtime-test", "premises":premises, "conclusion":conclusion,
        "difficulty":"Easy", "difficulty_value":1})
}

fn compare(theorem: &Path, proof: &Path) -> Output {
    let run = |binary| Command::new(binary)
        .args(["validate", "--strict-protocol", "--theorem"])
        .arg(theorem).arg("--proof").arg(proof).output().unwrap();
    let owner = run(OWNER);
    let validator = run(VALIDATOR);
    assert_eq!(validator.status.code(), owner.status.code(), "exit contract differs");
    assert_eq!(validator.stdout, owner.stdout, "JSON stdout differs");
    assert_eq!(validator.stderr, owner.stderr, "error stderr differs");
    validator
}

#[test]
fn strict_regression_fixtures_match_owner_byte_for_byte() {
    for (theorem, proof) in [
        ("round10_theorem.json", "round10_proof_5line.json"),
        ("round10_theorem.json", "round10_proof_6line.json"),
        ("round3_theorem.json", "round3_proof.json"),
        ("premises_theorem.json", "premises_proof.json"),
        ("premises_theorem.json", "premises_proof_bad.json"),
        ("round3_theorem.json", "invalid_line_proof.json"),
    ] {
        compare(&Path::new("fixtures/regression").join(theorem),
            &Path::new("fixtures/regression").join(proof));
    }
}

#[test]
fn strict_scope_verdicts_and_line_counts_match_owner() {
    let cp = json!([
        {"line_number":1,"formula":"P","justification":"Assumption (CP)","depth":1},
        {"line_number":2,"formula":"Q","justification":"Assumption (CP)","depth":2},
        {"line_number":3,"formula":"Q > Q","justification":"CP 2-2","depth":1},
        {"line_number":4,"formula":"P > (Q > Q)","justification":"CP 1-3","depth":0}
    ]);
    let ip = json!([
        {"line_number":2,"formula":"~P","justification":"Assumption (IP)","depth":1},
        {"line_number":3,"formula":"#","justification":"NegE 1,2","depth":1},
        {"line_number":4,"formula":"P","justification":"IP 2-3","depth":0}
    ]);
    for (theorem, proof, count) in [
        (theorem(&[], "P > (Q > Q)"), cp, 4),
        (theorem(&["P"], "P"), ip, 3),
    ] {
        let output = CaseFiles::new(theorem.clone(), proof.clone()).compare();
        assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({"valid":true,"line_count":count,"errors":[]}));
        for forged in ["depth", "range"] {
            let mut bad = proof.clone();
            let last = bad.as_array_mut().unwrap().last_mut().unwrap();
            if forged == "depth" { last["depth"] = json!(999); }
            else { last["justification"] = json!(if count == 4 { "CP 999-999" } else { "IP 999-999" }); }
            let output = CaseFiles::new(theorem.clone(), bad).compare();
            assert!(output.status.success());
            assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap()["valid"], false);
        }
    }
}

#[test]
fn malformed_missing_and_incomplete_inputs_preserve_exit_contract() {
    let proof = json!([{"line_number":3,"formula":"Q","justification":"MP 1,2","depth":0}]);
    let files = CaseFiles::new(theorem(&["P > Q", "P"], "Q"), proof.clone());
    files.compare();
    for (field, value) in [("line_number", json!(9)), ("justification", json!("Premise")),
        ("formula", json!("(")), ("justification", json!("unknown"))] {
        let mut malformed = proof.clone();
        malformed[0][field] = value;
        fs::write(files.0.join("proof.json"), serde_json::to_vec(&malformed).unwrap()).unwrap();
        files.compare();
    }
    for content in ["[]", "{", "{}", "null"] {
        fs::write(files.0.join("proof.json"), content).unwrap();
        files.compare();
    }
    fs::remove_file(files.0.join("proof.json")).unwrap();
    files.compare();
    fs::write(files.0.join("theorem.json"), "{").unwrap();
    files.compare();
    fs::remove_file(files.0.join("theorem.json")).unwrap();
    files.compare();
}

#[test]
fn contestant_executable_exposes_only_validation() {
    let help = Command::new(VALIDATOR).arg("--help").output().unwrap();
    assert!(help.status.success());
    let help = String::from_utf8(help.stdout).unwrap();
    assert!(help.contains("validate"));
    for word in ["golf", "plant", "generate", "analyze", "answer-key", "out-key"] {
        assert!(!help.contains(word), "owner command leaked through help: {word}");
    }
    for args in [vec!["generate"], vec!["analyze"], vec!["golf", "--help"],
        vec!["golf", "plant", "--count", "1", "--seed", "2000001", "--band", "1",
            "--out-set", "/tmp/forbidden-set", "--out-key", "/tmp/forbidden-key"]] {
        let output = Command::new(VALIDATOR).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr).unwrap().contains("unrecognized subcommand"));
    }
}
