use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

static NEXT_CASE: AtomicU64 = AtomicU64::new(0);

struct CaseFiles {
    root: PathBuf,
    theorem: PathBuf,
    proof: PathBuf,
}

impl CaseFiles {
    fn new(theorem: Value, proof: Value) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after Unix epoch")
            .as_nanos();
        let sequence = NEXT_CASE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "propbench-strict-protocol-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create isolated test directory");
        let theorem_path = root.join("theorem.json");
        let proof_path = root.join("proof.json");
        fs::write(
            &theorem_path,
            serde_json::to_vec_pretty(&theorem).expect("serialize theorem"),
        )
        .expect("write theorem");
        fs::write(
            &proof_path,
            serde_json::to_vec_pretty(&proof).expect("serialize proof"),
        )
        .expect("write proof");
        Self {
            root,
            theorem: theorem_path,
            proof: proof_path,
        }
    }
}

impl Drop for CaseFiles {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn theorem(premises: &[&str], conclusion: &str) -> Value {
    json!({
        "id": "strict-protocol-test",
        "premises": premises,
        "conclusion": conclusion,
        "difficulty": "Easy",
        "difficulty_value": 1
    })
}

fn run_validate(files: &CaseFiles, strict: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_propbench"));
    command
        .arg("validate")
        .arg("--theorem")
        .arg(&files.theorem)
        .arg("--proof")
        .arg(&files.proof);
    if strict {
        command.arg("--strict-protocol");
    }
    command.output().expect("validator runs")
}

fn verdict(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "validator failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("validator emits JSON")
}

fn error_text(verdict: &Value) -> String {
    verdict["errors"]
        .as_array()
        .expect("errors is an array")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_legacy_accepts_strict_rejects(files: &CaseFiles, error_fragment: &str) {
    let legacy = verdict(&run_validate(files, false));
    assert_eq!(
        legacy["valid"], true,
        "legacy compatibility changed: {legacy}"
    );

    let strict = verdict(&run_validate(files, true));
    assert_eq!(
        strict["valid"], false,
        "strict validator accepted forged scope: {strict}"
    );
    assert!(
        error_text(&strict).contains(error_fragment),
        "strict error did not mention {error_fragment:?}: {strict}"
    );
}

#[test]
fn strict_rejects_forged_depth_while_default_remains_compatible() {
    let files = CaseFiles::new(
        theorem(&["P > Q", "P"], "Q"),
        json!([
            {"line_number": 3, "formula": "Q", "justification": "MP 1,2", "depth": 999}
        ]),
    );
    assert_legacy_accepts_strict_rejects(&files, "engine-derived depth is 0");
}

#[test]
fn strict_rejects_forged_cp_range_while_default_remains_compatible() {
    let files = CaseFiles::new(
        theorem(&[], "P > P"),
        json!([
            {"line_number": 1, "formula": "P", "justification": "Assumption (CP)", "depth": 1},
            {"line_number": 2, "formula": "P > P", "justification": "CP 999-999", "depth": 0}
        ]),
    );
    assert_legacy_accepts_strict_rejects(&files, "engine-derived range is 1-1");
}

#[test]
fn strict_rejects_forged_ip_range_while_default_remains_compatible() {
    let files = CaseFiles::new(
        theorem(&["P"], "P"),
        json!([
            {"line_number": 2, "formula": "~P", "justification": "Assumption (IP)", "depth": 1},
            {"line_number": 3, "formula": "#", "justification": "NegE 1,2", "depth": 1},
            {"line_number": 4, "formula": "P", "justification": "IP 999-999", "depth": 0}
        ]),
    );
    assert_legacy_accepts_strict_rejects(&files, "engine-derived range is 2-3");
}

#[test]
fn strict_accepts_engine_derived_nested_scope_and_counts_all_subproof_lines() {
    let files = CaseFiles::new(
        theorem(&[], "P > (Q > Q)"),
        json!([
            {"line_number": 1, "formula": "P", "justification": "Assumption (CP)", "depth": 1},
            {"line_number": 2, "formula": "Q", "justification": "Assumption (CP)", "depth": 2},
            {"line_number": 3, "formula": "Q > Q", "justification": "CP 2-2", "depth": 1},
            {"line_number": 4, "formula": "P > (Q > Q)", "justification": "CP 1-3", "depth": 0}
        ]),
    );
    let result = verdict(&run_validate(&files, true));
    assert_eq!(
        result["valid"], true,
        "strict nested proof failed: {result}"
    );
    assert_eq!(result["line_count"], 4);
    assert_eq!(result["errors"], json!([]));
}
