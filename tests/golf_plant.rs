use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use logic_core::models::theorem::{Difficulty, Theorem};
use logic_core::models::Formula;
use propbench::replay::{replay_proof, ValidateInput};
use propbench::BenchTheorem;

/// Rebuild a `Theorem` from a `BenchTheorem` for replay purposes — mirrors
/// `main.rs`'s own `parse_bench_theorem`/`cmd_validate` reconstruction.
/// Difficulty is cosmetic here; `replay_proof` only cares about premises and
/// conclusion.
fn theorem_from_bench(bench: &BenchTheorem) -> Theorem {
    let premises: Vec<Formula> = bench
        .premises
        .iter()
        .map(|p| Formula::parse(p).unwrap_or_else(|e| panic!("invalid premise '{p}': {e}")))
        .collect();
    let conclusion = Formula::parse(&bench.conclusion)
        .unwrap_or_else(|e| panic!("invalid conclusion '{}': {e}", bench.conclusion));
    let difficulty = match bench.difficulty_value {
        1..=25 => Difficulty::Easy,
        26..=45 => Difficulty::Medium,
        46..=70 => Difficulty::Hard,
        _ => Difficulty::Expert,
    };
    Theorem::with_difficulty_value(premises, conclusion, difficulty, bench.difficulty_value, None, None)
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("propbench_golf_plant_test_{name}"));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn run_plant(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(args)
        .output()
        .expect("binary runs")
}

fn json_files(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("reading dir {}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().ends_with(suffix))
        .collect()
}

#[test]
fn plant_two_band1_candidates_notarize_and_split_across_set_and_key() {
    let out_set = fresh_dir("set");
    let out_key = fresh_dir("key");

    let out = run_plant(&[
        "golf", "plant",
        "--count", "2",
        "--seed", "1000",
        "--band", "1",
        "--out-set", out_set.to_str().unwrap(),
        "--out-key", out_key.to_str().unwrap(),
        "--subproofs", "1",
        "--passes", "2",
    ]);
    assert!(
        out.status.success(),
        "expected exit 0, stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    // Set dir: exactly 2 theorem files, none of them a proof file.
    let set_json = json_files(&out_set, ".json");
    assert_eq!(set_json.len(), 2, "expected 2 theorem files in set dir, found {:?}", set_json);
    let set_proofs = json_files(&out_set, ".proof.json");
    assert!(set_proofs.is_empty(), "set dir must contain NO *.proof.json, found {:?}", set_proofs);

    // Key dir: exactly 2 proof files + 2 meta files (2x2).
    let key_proofs = json_files(&out_key, ".proof.json");
    let key_metas = json_files(&out_key, ".meta.json");
    assert_eq!(key_proofs.len(), 2, "expected 2 proof files in key dir, found {:?}", key_proofs);
    assert_eq!(key_metas.len(), 2, "expected 2 meta files in key dir, found {:?}", key_metas);

    // Each accepted candidate: key proof replays against the matching set
    // theorem via the library replay path, with line_count == meta's par.
    for theorem_path in &set_json {
        let id = theorem_path.file_stem().unwrap().to_string_lossy().to_string();

        let bench: BenchTheorem = serde_json::from_str(
            &fs::read_to_string(theorem_path).unwrap_or_else(|e| panic!("reading {}: {e}", theorem_path.display())),
        )
        .unwrap_or_else(|e| panic!("parsing {} as BenchTheorem: {e}", theorem_path.display()));
        assert_eq!(bench.id, id, "theorem file's own id must match its filename stem");

        let proof_path = out_key.join(format!("{id}.proof.json"));
        let proof_lines: Vec<ValidateInput> = serde_json::from_str(
            &fs::read_to_string(&proof_path).unwrap_or_else(|e| panic!("reading {}: {e}", proof_path.display())),
        )
        .unwrap_or_else(|e| panic!("parsing {} as Vec<ValidateInput>: {e}", proof_path.display()));

        let meta_path = out_key.join(format!("{id}.meta.json"));
        let meta: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&meta_path).unwrap_or_else(|e| panic!("reading {}: {e}", meta_path.display())),
        )
        .unwrap_or_else(|e| panic!("parsing {} as JSON: {e}", meta_path.display()));
        let meta_par = meta["par"].as_u64().unwrap_or_else(|| panic!("meta {} missing numeric par: {meta}", meta_path.display()));

        let theorem = theorem_from_bench(&bench);
        let replayed = replay_proof(&theorem, &proof_lines)
            .unwrap_or_else(|e| panic!("key proof for {id} failed to replay against set theorem: {e}"));
        assert_eq!(
            replayed.line_count as u64, meta_par,
            "replayed line_count must equal meta par for {id}"
        );
    }
}

/// `--max-seeds` is a pure scan-termination cap (Task 11 Ruling C): it must
/// stop the seed loop after evaluating the cap, regardless of accept count,
/// and exit 0 even with 0 accepted — never treat a capped scan as an error.
/// Seed 1000000 at band 1 (no `--subproofs`/`--passes` needed to reproduce —
/// same params as the other tests here) is a known reject: empirically
/// confirmed to fail the gate on the very first seed tried.
#[test]
fn max_seeds_stops_cleanly_without_erroring_on_a_known_reject_seed() {
    let out_set = fresh_dir("max_seeds_reject_set");
    let out_key = fresh_dir("max_seeds_reject_key");

    let out = run_plant(&[
        "golf", "plant",
        "--count", "1",
        "--seed", "1000000",
        "--band", "1",
        "--out-set", out_set.to_str().unwrap(),
        "--out-key", out_key.to_str().unwrap(),
        "--subproofs", "1",
        "--passes", "2",
        "--max-seeds", "1",
    ]);
    assert!(
        out.status.success(),
        "expected exit 0 even with 0 accepted (hitting --max-seeds is a clean stop, not an error), stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let set_json = json_files(&out_set, ".json");
    assert!(
        set_json.is_empty(),
        "expected 0 theorem files written when --max-seeds 1 caps the scan at seed 1000000 (a known reject), found {:?}",
        set_json
    );
}

/// A `--max-seeds` cap looser than the natural `200*count` exhaustion budget
/// must not change outcomes: same seed/band/count as
/// `plant_two_band1_candidates_notarize_and_split_across_set_and_key`
/// (proven to accept 2/2 within budget 400), plus a 500 cap that's never the
/// binding constraint — proves `--max-seeds` doesn't alter per-seed
/// evaluation when it isn't actually hit.
#[test]
fn max_seeds_generous_cap_does_not_change_normal_accept_behavior() {
    let out_set = fresh_dir("max_seeds_generous_set");
    let out_key = fresh_dir("max_seeds_generous_key");

    let out = run_plant(&[
        "golf", "plant",
        "--count", "2",
        "--seed", "1000",
        "--band", "1",
        "--out-set", out_set.to_str().unwrap(),
        "--out-key", out_key.to_str().unwrap(),
        "--subproofs", "1",
        "--passes", "2",
        "--max-seeds", "500",
    ]);
    assert!(
        out.status.success(),
        "expected exit 0, stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let set_json = json_files(&out_set, ".json");
    assert_eq!(
        set_json.len(), 2,
        "a generous --max-seeds (never the binding constraint) must not change normal accept behavior, found {:?}",
        set_json
    );
}
