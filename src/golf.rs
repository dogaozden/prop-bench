//! `golf plant` subcommand: seed-loop planted-candidate generation through
//! the golf gate pipeline, notarized via propbench's own replay path, with
//! output split into a public theorem set and a private answer key.

use logic_core::models::{theorem::{Difficulty, Theorem}, Formula};
use logic_core::services::{
    golf_gate, plant, GateConfig, GateReject, OptimalConfig, PlantError, PlantSpec, PlantedCandidate,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::replay::{proof_to_replay, replay_proof, ValidateInput};
use crate::BenchTheorem;

/// How many seeds to try, per accepted candidate requested, before giving up
/// on the whole batch (Task 7 brief: "200*count seeds tried").
const SEED_BUDGET_PER_CANDIDATE: u64 = 200;

/// Per-band `PlantSpec` shape. `atoms`/`max_premises`/`max_formula_len` are
/// shared across all three bands (Task 7 brief); only the par range differs.
/// `band` is pre-validated by clap's `1..=3` range parser, so the match is
/// exhaustive without a fallback arm.
///
/// `(par_min, par_max)` here are **pre-costume** targets, not the band's
/// advertised final-par contract (Ruling C, Task 8b). `plant()` checks
/// `par_min`/`par_max` against the cone's par *before* the costume pass
/// (`obfuscation_passes > 0`) adds prologue/epilogue lines on top, so the
/// *final* `PlantedCandidate::par` written to `<id>.meta.json` lands above
/// this window by however much costume adds — and that overhead isn't a
/// clean band-independent constant (measured ~4.6 par lines on average via
/// a direct `passes:0` vs `passes:2` comparison at band 1's old window, but
/// bands 2-3 needed a smaller downward shift than that single number would
/// predict to actually land in-band, most likely because `plant()`'s
/// internal growth target scales with `par_max` itself, so each band is a
/// somewhat different growth regime). These constants are therefore an
/// *empirically verified* fit, not a formula: derive-then-measure, repeated
/// per band until a fresh `--subproofs 1 --passes 2` sample of ≥8 accepts
/// landed ≥80% inside the advertised final-par contract (12-16 / 17-22 /
/// 23-30), with band 3 additionally checked to never exceed 30. See
/// `docs/superpowers/plans/2026-08-24-proof-golf-MEASUREMENTS.md`'s Task 8b
/// addendum for the full measurement trail (all three bands landed at
/// 87.5% in-band on the verification sample).
fn spec_for_band(band: u8, subproofs: u8, obfuscation_passes: u8) -> PlantSpec {
    let (par_min, par_max) = match band {
        1 => (7, 11),
        2 => (14, 19),
        3 => (19, 26),
        other => unreachable!("clap's value_parser restricts --band to 1..=3, got {other}"),
    };
    PlantSpec {
        atoms: 4,
        par_min,
        par_max,
        max_premises: 5,
        max_formula_len: 90,
        subproofs,
        obfuscation_passes,
    }
}

/// Serializable mirror of `PlantSpec` (which only derives `Debug`/`Clone` in
/// logic-core) for embedding in `<id>.meta.json`.
#[derive(Debug, Serialize)]
struct SpecMeta {
    atoms: u8,
    par_min: usize,
    par_max: usize,
    max_premises: usize,
    max_formula_len: usize,
    subproofs: u8,
    obfuscation_passes: u8,
}

impl From<&PlantSpec> for SpecMeta {
    fn from(s: &PlantSpec) -> Self {
        SpecMeta {
            atoms: s.atoms,
            par_min: s.par_min,
            par_max: s.par_max,
            max_premises: s.max_premises,
            max_formula_len: s.max_formula_len,
            subproofs: s.subproofs,
            obfuscation_passes: s.obfuscation_passes,
        }
    }
}

#[derive(Debug, Serialize)]
struct PlantMeta {
    seed: u64,
    band: u8,
    spec: SpecMeta,
    par: usize,
    gate: &'static str,
}

/// Rejection tally across the whole seed loop: one bucket per `GateReject`
/// variant plus one per `PlantError` variant, printed unconditionally at the
/// end of the run (accepted or not) so a low yield is always visible rather
/// than silently swallowed.
#[derive(Debug, Default)]
struct RejectionHistogram {
    stuck: usize,
    out_of_band: usize,
    too_big: usize,
    cheese: usize,
    greedy_provable: usize,
    lawyer_probe_cracked: usize,
    lawyer_freeze_cracked: usize,
}

impl RejectionHistogram {
    fn record_plant_error(&mut self, e: PlantError) {
        match e {
            PlantError::Stuck => self.stuck += 1,
            PlantError::OutOfBand => self.out_of_band += 1,
        }
    }

    fn record_gate_reject(&mut self, r: &GateReject) {
        match r {
            GateReject::TooBig => self.too_big += 1,
            GateReject::Cheese(_) => self.cheese += 1,
            GateReject::GreedyProvable { .. } => self.greedy_provable += 1,
            GateReject::LawyerProbeCracked { .. } => self.lawyer_probe_cracked += 1,
            GateReject::LawyerFreezeCracked { .. } => self.lawyer_freeze_cracked += 1,
        }
    }

    fn print(&self, accepted: usize) {
        eprintln!("--- golf plant rejection histogram ---");
        eprintln!("Stuck: {}", self.stuck);
        eprintln!("OutOfBand: {}", self.out_of_band);
        eprintln!("TooBig: {}", self.too_big);
        eprintln!("Cheese: {}", self.cheese);
        eprintln!("GreedyProvable: {}", self.greedy_provable);
        eprintln!("LawyerProbeCracked: {}", self.lawyer_probe_cracked);
        eprintln!("LawyerFreezeCracked: {}", self.lawyer_freeze_cracked);
        eprintln!("Accepted: {}", accepted);
    }
}

/// Write one accepted candidate's three files: the theorem-only set file
/// (`BenchTheorem`, no `serve_analysis`), the notarized replay proof, and
/// the generation metadata.
fn write_candidate(
    out_set: &Path,
    out_key: &Path,
    id: &str,
    candidate: &PlantedCandidate,
    spec: &PlantSpec,
    band: u8,
    seed: u64,
    replay_lines: &[ValidateInput],
    gate_label: &'static str,
) -> Result<(), String> {
    let mut bench = BenchTheorem::from(&candidate.theorem);
    bench.id = id.to_string();
    let theorem_json = serde_json::to_string_pretty(&bench)
        .map_err(|e| format!("JSON serialization error for {id} theorem: {e}"))?;
    fs::write(out_set.join(format!("{id}.json")), theorem_json)
        .map_err(|e| format!("Failed to write {id} theorem file: {e}"))?;

    let proof_json = serde_json::to_string_pretty(replay_lines)
        .map_err(|e| format!("JSON serialization error for {id} proof: {e}"))?;
    fs::write(out_key.join(format!("{id}.proof.json")), proof_json)
        .map_err(|e| format!("Failed to write {id} proof file: {e}"))?;

    let meta = PlantMeta {
        seed,
        band,
        spec: SpecMeta::from(spec),
        par: candidate.par,
        gate: gate_label,
    };
    let meta_json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("JSON serialization error for {id} meta: {e}"))?;
    fs::write(out_key.join(format!("{id}.meta.json")), meta_json)
        .map_err(|e| format!("Failed to write {id} meta file: {e}"))?;

    Ok(())
}

/// Run `golf plant`: seed-loop `plant` + `golf_gate` from `seed` upward
/// until `count` candidates are accepted or `200 * count` seeds have been
/// tried. Every accepted candidate is notarized (`proof_to_replay` ->
/// `replay_proof` must reproduce `line_count == par`; a mismatch or replay
/// error is a generator bug, not a legitimate rejection, so it panics rather
/// than silently dropping the candidate) and split across two directories:
/// the public theorem-only set (`out_set`) and the private answer key
/// (`out_key`, proof + generation metadata). Never writes a proof file into
/// `out_set`.
pub fn cmd_plant(
    count: usize,
    seed: u64,
    band: u8,
    out_set: &Path,
    out_key: &Path,
    freeze: bool,
    subproofs: u8,
    passes: u8,
    max_seeds: Option<u64>,
) -> Result<(), String> {
    let spec = spec_for_band(band, subproofs, passes);
    let gate_label: &'static str = if freeze { "freeze" } else { "probe" };

    fs::create_dir_all(out_set)
        .map_err(|e| format!("Failed to create --out-set dir {}: {}", out_set.display(), e))?;
    fs::create_dir_all(out_key)
        .map_err(|e| format!("Failed to create --out-key dir {}: {}", out_key.display(), e))?;

    // `--max-seeds` is a pure scan-termination cap: it only shortens how many
    // seeds this invocation walks before stopping, never how any individual
    // seed is evaluated (`plant`/`golf_gate` below are called identically
    // either way). It composes with the existing generator-exhaustion budget
    // (200*count) by taking whichever cap is tighter; when `--max-seeds`
    // isn't given, or is looser than that budget, behavior is unchanged.
    let seed_budget = SEED_BUDGET_PER_CANDIDATE.saturating_mul(count as u64);
    let effective_budget = match max_seeds {
        Some(m) => seed_budget.min(m),
        None => seed_budget,
    };
    let mut histogram = RejectionHistogram::default();
    let mut accepted_ids: Vec<String> = Vec::with_capacity(count);
    let mut seeds_tried: u64 = 0;
    let mut this_seed = seed;

    while accepted_ids.len() < count && seeds_tried < effective_budget {
        seeds_tried += 1;
        let current_seed = this_seed;
        this_seed += 1;

        let candidate = match plant(&spec, current_seed) {
            Ok(c) => c,
            Err(e) => {
                histogram.record_plant_error(e);
                continue;
            }
        };

        let gate_cfg = GateConfig {
            freeze: if freeze {
                Some(OptimalConfig {
                    max_lines: candidate.par,
                    max_nodes: 1_000_000,
                    equiv_moves_per_state: 128,
                })
            } else {
                None
            },
            ..GateConfig::default()
        };

        if let Err(reject) = golf_gate(&candidate, &gate_cfg) {
            histogram.record_gate_reject(&reject);
            continue;
        }

        // Notarize: propbench's replay path is the single authority on
        // validity/line-count. A failure here means `plant` handed us a
        // proof its own gate accepted but propbench can't replay — a
        // generator bug, never a silent skip.
        let replay_lines = proof_to_replay(&candidate.proof);
        let replayed = replay_proof(&candidate.theorem, &replay_lines).unwrap_or_else(|e| {
            panic!(
                "golf plant: notarization failed for accepted candidate seed {current_seed} (generator bug): {e}"
            )
        });
        if replayed.line_count != candidate.par {
            panic!(
                "golf plant: notarized line_count {} != par {} for accepted candidate seed {current_seed} (generator bug)",
                replayed.line_count, candidate.par
            );
        }

        let id = format!("g{band}-{current_seed}");
        write_candidate(out_set, out_key, &id, &candidate, &spec, band, current_seed, &replay_lines, gate_label)?;
        accepted_ids.push(id);
    }

    histogram.print(accepted_ids.len());

    if accepted_ids.len() < count {
        // Running out of the *generator-exhaustion* budget is a real
        // problem (the band's par range may be too tight). Hitting an
        // explicit `--max-seeds` cap is the caller asking for exactly this
        // — a clean, expected stop, not an error — so the caller's own exit
        // code can distinguish "capped scan, 0-or-more accepted" from an
        // actual failure.
        if max_seeds.is_some_and(|m| seeds_tried >= m) {
            eprintln!(
                "golf plant: stopped at --max-seeds cap ({seeds_tried} seeds evaluated), accepted {}/{count}",
                accepted_ids.len()
            );
            return Ok(());
        }
        return Err(format!(
            "golf plant: only {}/{count} candidates accepted after trying {seeds_tried} seeds (budget {seed_budget}); \
             band {band} par range may be too tight for the current gate — see histogram above",
            accepted_ids.len()
        ));
    }

    eprintln!(
        "golf plant: wrote {} candidates to {} (set) / {} (key)",
        accepted_ids.len(),
        out_set.display(),
        out_key.display()
    );
    Ok(())
}

// ─── `golf score` subcommand ────────────────────────────────────────────────
//
// Scores a submitted proof set against a golf manifest at `<set>/manifest.json`.
// Each item's theorem file lives at `<set>/<id>.json`; its bytes must still hash
// to the manifest's recorded `theorem_sha256`, or the set has been tampered with
// since packaging — a hard failure distinct from an ordinary invalid proof
// (exit 2, checked before any scoring happens). A submission lives at
// `<proofs>/<id>.json` per item: a missing file is a legitimate "no attempt"
// (imputed at `manifest.imputed_ratio`), while a present-but-invalid proof means
// the whole run fails closed — every collected error is printed and the process
// exits 1 with no SCORE, since a single bad proof means the benchmark's one
// number can't be trusted.

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // set_version/core_tag are set metadata, not read by scoring
struct Manifest {
    set_version: String,
    core_tag: String,
    imputed_ratio: f64,
    items: Vec<ManifestItem>,
}

#[derive(Debug, Deserialize)]
struct ManifestItem {
    id: String,
    par: usize,
    theorem_sha256: String,
}

/// One item's scoring outcome. `ratio` stays full-precision — SCORE is the
/// geometric mean over these exact values; only display/JSON output rounds
/// (via `round4`).
struct ScoredItem {
    id: String,
    par: usize,
    lines: Option<usize>,
    ratio: f64,
}

#[derive(Debug, Serialize)]
struct ScoreItemJson {
    id: String,
    par: usize,
    lines: Option<usize>,
    ratio: f64,
}

#[derive(Debug, Serialize)]
struct ScoreJson {
    score: f64,
    items: Vec<ScoreItemJson>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

/// Rebuild a `Theorem` from a `BenchTheorem` for replay purposes — mirrors
/// `main.rs`'s own `parse_bench_theorem`/`cmd_validate` reconstruction.
/// Difficulty is cosmetic here; `replay_proof` only cares about premises and
/// conclusion.
fn theorem_from_bench(bench: &BenchTheorem) -> Result<Theorem, String> {
    let premises: Vec<Formula> = bench
        .premises
        .iter()
        .map(|p| Formula::parse(p).map_err(|e| format!("invalid premise '{p}': {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    let conclusion = Formula::parse(&bench.conclusion)
        .map_err(|e| format!("invalid conclusion '{}': {e}", bench.conclusion))?;
    let difficulty = match bench.difficulty_value {
        1..=25 => Difficulty::Easy,
        26..=45 => Difficulty::Medium,
        46..=70 => Difficulty::Hard,
        _ => Difficulty::Expert,
    };
    Ok(Theorem::with_difficulty_value(premises, conclusion, difficulty, bench.difficulty_value, None, None))
}

/// Run `golf score`: read the manifest at `<set>/manifest.json` (an empty
/// `items` list is refused as a broken set), verify every item's theorem
/// file exists and its bytes still hash to the manifest's recorded
/// `theorem_sha256` — a missing file is tampering exactly like a mismatch —
/// (every problem is collected; if any exist, all are printed and the
/// process exits 2 — "set tampered" — before any scoring happens). Then for
/// each item, look for `<proofs>/<id>.json`: absent
/// imputes `manifest.imputed_ratio`; present is replayed via propbench's own
/// `replay_proof` (the single validity/line-count authority) and scored as
/// `line_count / par`. Any present-but-invalid proof is collected as an
/// error; if any errors were collected, every one is printed and the process
/// exits 1 — no SCORE line, no per-item table. Otherwise the per-item table
/// and `SCORE: <geomean>` (or `--json`'s `{score, items}`) are printed and
/// the function returns `Ok(())` (exit 0).
pub fn cmd_score(set_dir: &Path, proofs_dir: &Path, json: bool) -> Result<(), String> {
    let manifest_path = set_dir.join("manifest.json");
    let manifest_json = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest {}: {e}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Failed to parse manifest {}: {e}", manifest_path.display()))?;

    if manifest.items.is_empty() {
        return Err(format!(
            "manifest {} has no items — refusing to score an empty set",
            manifest_path.display()
        ));
    }

    // Integrity gate: every theorem file declared by the manifest must exist
    // and its bytes must still hash to the manifest's recorded sha256 — the
    // integrity contract is manifest <-> files, so a file the manifest
    // declares but that's missing (or unreadable) is tampering too, exactly
    // like a hash mismatch. Checked (and parsed) up front, before any
    // scoring, so a tampered set never produces a partial/misleading score.
    let mut tamper_errors: Vec<String> = Vec::new();
    let mut theorems: Vec<(String, usize, BenchTheorem)> = Vec::with_capacity(manifest.items.len());

    for item in &manifest.items {
        let theorem_path = set_dir.join(format!("{}.json", item.id));
        let bytes = match fs::read(&theorem_path) {
            Ok(b) => b,
            Err(e) => {
                tamper_errors.push(format!(
                    "{}: missing theorem file {} ({e})",
                    item.id, theorem_path.display()
                ));
                continue;
            }
        };

        let actual_sha256 = sha256_hex(&bytes);
        if actual_sha256 != item.theorem_sha256 {
            tamper_errors.push(format!(
                "{}: theorem_sha256 mismatch (manifest: {}, actual: {})",
                item.id, item.theorem_sha256, actual_sha256
            ));
            continue;
        }

        let bench: BenchTheorem = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Failed to parse theorem file {}: {e}", theorem_path.display()))?;
        theorems.push((item.id.clone(), item.par, bench));
    }

    if !tamper_errors.is_empty() {
        eprintln!("set tampered:");
        for e in &tamper_errors {
            eprintln!("  {e}");
        }
        std::process::exit(2);
    }

    // Score each item: absent proof imputes; present proof replays.
    let mut errors: Vec<String> = Vec::new();
    let mut results: Vec<ScoredItem> = Vec::with_capacity(theorems.len());

    for (id, par, bench) in &theorems {
        let proof_path = proofs_dir.join(format!("{id}.json"));
        if !proof_path.exists() {
            results.push(ScoredItem { id: id.clone(), par: *par, lines: None, ratio: manifest.imputed_ratio });
            continue;
        }

        let attempt = (|| -> Result<usize, String> {
            let theorem = theorem_from_bench(bench)?;
            let proof_json = fs::read_to_string(&proof_path)
                .map_err(|e| format!("failed to read proof file: {e}"))?;
            let lines: Vec<ValidateInput> = serde_json::from_str(&proof_json)
                .map_err(|e| format!("failed to parse proof JSON: {e}"))?;
            replay_proof(&theorem, &lines)
                .map(|ok| ok.line_count)
                .map_err(|e| e.to_string())
        })();

        match attempt {
            Ok(line_count) => {
                let ratio = line_count as f64 / *par as f64;
                results.push(ScoredItem { id: id.clone(), par: *par, lines: Some(line_count), ratio });
            }
            Err(msg) => errors.push(format!("{id}: {msg}")),
        }
    }

    if !errors.is_empty() {
        for e in &errors {
            eprintln!("{e}");
        }
        std::process::exit(1);
    }

    // SCORE = geometric mean of ratios, via mean-of-ln (numerically steadier
    // than a running product for larger sets).
    let mean_ln = results.iter().map(|r| r.ratio.ln()).sum::<f64>() / results.len() as f64;
    let score = mean_ln.exp();

    if json {
        let out = ScoreJson {
            score: round4(score),
            items: results
                .iter()
                .map(|r| ScoreItemJson { id: r.id.clone(), par: r.par, lines: r.lines, ratio: round4(r.ratio) })
                .collect(),
        };
        let out_json = serde_json::to_string_pretty(&out)
            .map_err(|e| format!("JSON serialization error: {e}"))?;
        println!("{out_json}");
    } else {
        // Route every displayed number through round4() first, then format
        // the already-rounded value — the same two-step the JSON path uses.
        // Rust's `{:.4}` formats the raw float with ties-to-even, while
        // round4() rounds ties away from zero; formatting a raw ratio
        // directly could then disagree with --json's rounded value on an
        // exact .xxxx5 tie (e.g. 1/32 = 0.03125 -> table "0.0312" vs JSON
        // "0.0313"). Pre-rounding here keeps both output modes identical.
        println!("{:<12} {:>4} {:>6} {:>8}", "id", "par", "lines", "ratio");
        for r in &results {
            let lines_str = r.lines.map(|l| l.to_string()).unwrap_or_else(|| "—".to_string());
            println!("{:<12} {:>4} {:>6} {:>8.4}", r.id, r.par, lines_str, round4(r.ratio));
        }
        println!("SCORE: {:.4}", round4(score));
    }

    Ok(())
}
