use std::process::Command;

fn validate(theorem: &str, proof: &str) -> serde_json::Value {
    let out = Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(["validate", "--theorem", &format!("fixtures/regression/{theorem}"),
               "--proof", &format!("fixtures/regression/{proof}")])
        .output().expect("binary runs");
    serde_json::from_slice(&out.stdout).expect("valid JSON on stdout")
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
