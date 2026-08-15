use std::process::Command;

/// Tournament mode's rejection-sampling loop, pinned to a real (tier, seed,
/// equiv-cap) combination measured to pass reliably and fast.
///
/// MEASURED FINDING (2026-08-15, Task 12): at `ServeConfig::default()`'s equiv-cap
/// (64), tournament mode found ZERO acceptances across baby/easy/medium/hard tiers
/// within 300-1000 attempts each — `OptimalUnknown` (the optimal search couldn't
/// certify a proof minimal) made up 52-80% of every histogram. Raising
/// `--equiv-cap` to 256 (the ledger's validated lever) collapsed `OptimalUnknown`
/// to 0% in this run and produced a real, deterministic accept in exactly 8
/// attempts (~7s in a debug build). See task-12-report.md for the full per-tier,
/// per-cap histograms — this is the Phase C gate's headline data.
#[test]
fn tournament_mode_produces_passing_theorem() {
    let out = Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(["generate", "--tournament", "--tier", "easy", "--count", "1",
               "--seed", "100", "--equiv-cap", "256", "--attempts", "30",
               "--output", "/tmp/propbench_t12_test.json"])
        .output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/tmp/propbench_t12_test.json").unwrap()).unwrap();
    assert!(json[0]["serve_analysis"]["rejection"].is_null());
    assert!(json[0]["serve_analysis"]["divergence"].as_i64().unwrap() >= 3);
}

/// `analyze` end-to-end, using the same disguised-identity shape
/// (`serve_filter.rs`'s own `reason3_disguised_identity_short_circuits_before_greedy`
/// test) so the case is fast and deterministic — cheese rejections never touch the
/// greedy/optimal provers.
#[test]
fn analyze_reports_rejection_for_known_bad_theorem() {
    let input = r#"[{"id":"t12-fixture","premises":[],"conclusion":"P > ~~P","difficulty":"Easy","difficulty_value":15}]"#;
    std::fs::write("/tmp/propbench_t12_analyze_input.json", input).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_propbench"))
        .args(["analyze", "--theorems", "/tmp/propbench_t12_analyze_input.json"])
        .output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));

    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json[0]["id"], "t12-fixture");
    let rejection = &json[0]["serve_analysis"]["rejection"];
    assert!(!rejection.is_null(), "expected a rejection, got: {}", json[0]["serve_analysis"]);
    assert!(rejection.get("DisguisedIdentity").is_some(), "expected DisguisedIdentity, got: {}", rejection);
}
