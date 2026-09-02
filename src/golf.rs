//! `golf plant` subcommand: seed-loop planted-candidate generation through
//! the golf gate pipeline, notarized via propbench's own replay path, with
//! output split into a public theorem set and a private answer key.

use logic_core::services::{
    golf_gate, plant, GateConfig, GateReject, OptimalConfig, PlantError, PlantSpec, PlantedCandidate,
};
use serde::Serialize;
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
) -> Result<(), String> {
    let spec = spec_for_band(band, subproofs, passes);
    let gate_label: &'static str = if freeze { "freeze" } else { "probe" };

    fs::create_dir_all(out_set)
        .map_err(|e| format!("Failed to create --out-set dir {}: {}", out_set.display(), e))?;
    fs::create_dir_all(out_key)
        .map_err(|e| format!("Failed to create --out-key dir {}: {}", out_key.display(), e))?;

    let seed_budget = SEED_BUDGET_PER_CANDIDATE.saturating_mul(count as u64);
    let mut histogram = RejectionHistogram::default();
    let mut accepted_ids: Vec<String> = Vec::with_capacity(count);
    let mut seeds_tried: u64 = 0;
    let mut this_seed = seed;

    while accepted_ids.len() < count && seeds_tried < seed_budget {
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
                    max_nodes: 5_000_000,
                    equiv_moves_per_state: 256,
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
