//! File and JSON adapter shared by the owner CLI and the contestant validator.
//! Proof validity and line counts remain exclusively defined by `replay`.

use crate::replay::{replay_proof, replay_proof_strict, ReplayError, ValidateInput};
use crate::BenchTheorem;
use logic_core::models::{theorem::{Difficulty, Theorem}, Formula};
use serde::Serialize;
use std::{fs, path::PathBuf};

#[derive(Debug, Serialize)]
struct ValidateOutput {
    valid: bool,
    line_count: usize,
    errors: Vec<String>,
}

pub fn cmd_validate(theorem_path: &PathBuf, proof_path: &PathBuf, strict_protocol: bool) -> Result<(), String> {
    // Read theorem
    let theorem_json = fs::read_to_string(theorem_path)
        .map_err(|e| format!("Failed to read theorem file: {}", e))?;
    let bench_theorem: BenchTheorem = serde_json::from_str(&theorem_json)
        .map_err(|e| format!("Failed to parse theorem JSON: {}", e))?;

    // Parse theorem formulas
    let premises: Vec<Formula> = bench_theorem.premises.iter()
        .map(|p| Formula::parse(p).map_err(|e| format!("Invalid premise '{}': {}", p, e)))
        .collect::<Result<Vec<_>, _>>()?;

    let conclusion = Formula::parse(&bench_theorem.conclusion)
        .map_err(|e| format!("Invalid conclusion '{}': {}", bench_theorem.conclusion, e))?;

    let difficulty = match bench_theorem.difficulty_value {
        1..=25 => Difficulty::Easy,
        26..=45 => Difficulty::Medium,
        46..=70 => Difficulty::Hard,
        _ => Difficulty::Expert,
    };

    let theorem = Theorem::with_difficulty_value(
        premises,
        conclusion,
        difficulty,
        bench_theorem.difficulty_value,
        None,
        None,
    );

    // Read proof lines
    let proof_json = fs::read_to_string(proof_path)
        .map_err(|e| format!("Failed to read proof file: {}", e))?;
    let input_lines: Vec<ValidateInput> = serde_json::from_str(&proof_json)
        .map_err(|e| format!("Failed to parse proof JSON: {}", e))?;

    // Replay the proof — replay_proof is the single validity + line-count authority.
    let replayed = match if strict_protocol {
        replay_proof_strict(&theorem, &input_lines)
    } else {
        replay_proof(&theorem, &input_lines)
    } {
        Ok(r) => r,
        Err(e) => {
            let is_protocol_violation = matches!(
                e,
                ReplayError::PremiseInInput { .. } | ReplayError::BadNumbering { .. }
            );
            if is_protocol_violation {
                // Malformed proof input, not a semantic verdict — hard CLI failure.
                return Err(e.to_string());
            }
            // Parse / InvalidLine / Incomplete: a wrong-but-well-formed proof.
            // Legacy CLI contract — exit 0, JSON body with valid:false — since
            // the GUI's validate() has no try/catch around the CLI call and
            // would 500 on the common "the proof is just wrong" case otherwise.
            let output = ValidateOutput {
                valid: false,
                line_count: 0,
                errors: vec![e.to_string()],
            };
            let json = serde_json::to_string_pretty(&output)
                .map_err(|e| format!("JSON serialization error: {}", e))?;
            println!("{}", json);
            return Ok(());
        }
    };

    let output = ValidateOutput {
        valid: true,
        line_count: replayed.line_count,
        errors: Vec::new(),
    };

    let json = serde_json::to_string_pretty(&output)
        .map_err(|e| format!("JSON serialization error: {}", e))?;
    println!("{}", json);
    Ok(())
}
