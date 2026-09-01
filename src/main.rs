use clap::{Parser, Subcommand};
use logic_core::models::{
    Formula,
    theorem::{BaseComplexity, Difficulty, DifficultySpec, DifficultyTier, Theorem},
};
use logic_core::services::{
    TheoremGenerator, ObfuscateGenerator,
    analyze_for_serving, ServeConfig, ServeAnalysis, ServeRejection, OptimalConfig,
};
use rand::{Rng, RngCore, SeedableRng, rngs::StdRng, thread_rng};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use propbench::replay::{ValidateInput, ReplayError, replay_proof};
use propbench::{golf, BenchTheorem};

// ─── CLI argument parsing ───────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "propbench")]
#[command(about = "PropBench — LLM benchmark for propositional logic proof efficiency")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Generate a benchmark theorem set
    Generate {
        /// Number of theorems to generate
        #[arg(short, long, default_value_t = 100)]
        count: usize,

        /// Difficulty distribution as "N:tier,N:tier,..."
        /// e.g. "30:easy,30:medium,20:hard,15:expert,5:nightmare"
        #[arg(short, long)]
        difficulty_distribution: Option<String>,

        /// Preset difficulty tier (easy/medium/hard/expert/nightmare/marathon/absurd/cosmic/mind)
        #[arg(long)]
        tier: Option<String>,

        /// Number of variables (2-20) for custom spec
        #[arg(long)]
        variables: Option<u8>,

        /// Number of passes (1-20) for custom spec
        #[arg(long)]
        passes: Option<u16>,

        /// Transforms per pass (1-24) for custom spec
        #[arg(long)]
        transforms: Option<u16>,

        /// Base complexity (simple/complex) for custom spec
        #[arg(long)]
        base: Option<String>,

        /// Substitution depth (0-4) for custom spec
        #[arg(long)]
        substitution: Option<u16>,

        /// Number of bridge atoms (0-5) for cross-zone interdependencies
        #[arg(long)]
        bridge_atoms: Option<u8>,

        /// Maximum formula nodes (default: 20000) for custom spec
        #[arg(long)]
        max_nodes: Option<u32>,

        /// Maximum formula depth (default: 100) for custom spec
        #[arg(long)]
        max_depth: Option<u32>,

        /// Disable gnarly combos (forced multi-rule transformation chains)
        #[arg(long)]
        no_gnarly_combos: bool,

        /// Enable gnarly combos (forced multi-rule transformation chains)
        #[arg(long, conflicts_with = "no_gnarly_combos")]
        gnarly_combos: bool,

        /// Output file path
        #[arg(short, long, default_value = "theorems.json")]
        output: PathBuf,

        /// Seed the RNG for deterministic, reproducible generation
        #[arg(long)]
        seed: Option<u64>,

        /// Tournament mode: rejection-sample candidates through the serve filter
        /// (analyze_for_serving) and only keep theorems that pass it. Slow — the
        /// bounded-optimal search stage can take seconds per rejected candidate.
        #[arg(long)]
        tournament: bool,

        /// Max generation attempts per accepted theorem in tournament mode
        #[arg(long, default_value_t = 1000)]
        attempts: usize,

        /// Equivalence-rewrite candidate cap per search state, plumbed into
        /// ServeConfig.optimal.equiv_moves_per_state (higher = more optimal
        /// searches certify minimal, at the cost of more time)
        #[arg(long, default_value_t = 64)]
        equiv_cap: usize,
    },

    /// Validate a proof against a theorem
    Validate {
        /// Path to theorem JSON file (single theorem object)
        #[arg(long)]
        theorem: PathBuf,

        /// Path to proof JSON file (array of proof lines)
        #[arg(long)]
        proof: PathBuf,
    },

    /// Run the serve filter (analyze_for_serving) over an existing theorems JSON file
    Analyze {
        /// Path to theorems JSON file (same array shape `generate` writes)
        #[arg(long)]
        theorems: PathBuf,

        /// Only analyze the first N theorems — large historical sets can take a
        /// long time since the optimal search stage is seconds per theorem
        #[arg(long)]
        limit: Option<usize>,

        /// Equivalence-rewrite candidate cap per search state, plumbed into
        /// ServeConfig.optimal.equiv_moves_per_state
        #[arg(long, default_value_t = 64)]
        equiv_cap: usize,
    },

    /// Golf benchmark generation commands
    Golf {
        #[command(subcommand)]
        command: GolfCommands,
    },
}

#[derive(Subcommand)]
enum GolfCommands {
    /// Plant golf candidates through the gate pipeline and write a
    /// theorem-set / answer-key split
    Plant {
        /// Number of candidates to accept
        #[arg(long)]
        count: usize,

        /// Starting seed — seeds increase from here until `count` candidates
        /// are accepted or the 200*count seed budget is exhausted
        #[arg(long)]
        seed: u64,

        /// Difficulty band: 1 (par 12-16), 2 (par 17-22), or 3 (par 23-30)
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=3))]
        band: u8,

        /// Directory to write theorem-only files (the public set — never a proof)
        #[arg(long)]
        out_set: PathBuf,

        /// Directory to write proof + metadata files (the private answer key)
        #[arg(long)]
        out_key: PathBuf,

        /// Require finalists to also survive a per-candidate lawyer freeze
        /// budget (max_lines: par, max_nodes: 5_000_000, equiv_moves_per_state: 256)
        #[arg(long)]
        freeze: bool,

        /// Max subproof nesting depth to plant (0-2)
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u8).range(0..=2))]
        subproofs: u8,

        /// Obfuscation costume passes
        #[arg(long, default_value_t = 0)]
        passes: u8,
    },
}

// ─── Output types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ValidateOutput {
    valid: bool,
    line_count: usize,
    errors: Vec<String>,
}

// ─── Difficulty helpers ─────────────────────────────────────────────────────

/// Extended tier range that supports all 9 tiers.
/// For tiers beyond Marathon (absurd/cosmic/mind), maps to difficulty value 100
/// since spec-based generation handles actual parameters.
fn tier_range_extended(name: &str) -> Result<(u8, u8), String> {
    match name {
        "baby" => Ok((1, 12)),
        "easy" => Ok((1, 25)),
        "medium" => Ok((26, 45)),
        "hard" => Ok((46, 70)),
        "expert" => Ok((71, 85)),
        "nightmare" => Ok((86, 95)),
        "marathon" => Ok((96, 100)),
        "absurd" | "cosmic" | "mind" => Ok((100, 100)),
        other => Err(format!(
            "Unknown difficulty tier: '{}'. Use baby/easy/medium/hard/expert/nightmare/marathon/absurd/cosmic/mind.",
            other
        )),
    }
}

#[derive(Debug)]
enum DistributionEntry {
    /// Legacy mode: generate with random difficulty value in range
    Range { count: usize, min_val: u8, max_val: u8, tier_name: String },
    /// Spec mode: generate with a DifficultySpec (tier is known)
    Spec { count: usize, tier: DifficultyTier, spec: DifficultySpec, tier_name: String },
}

fn parse_difficulty_distribution(spec: &str) -> Result<Vec<DistributionEntry>, String> {
    let mut result = Vec::new();
    for part in spec.split(',') {
        let parts: Vec<&str> = part.trim().split(':').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid distribution part: '{}'. Expected 'N:tier'.", part));
        }
        let count: usize = parts[0].trim().parse()
            .map_err(|_| format!("Invalid count: '{}'", parts[0]))?;
        let tier_name = parts[1].trim().to_lowercase();

        // All known tiers use the spec-based generation path
        if let Some(dt) = DifficultyTier::from_str(&tier_name) {
            result.push(DistributionEntry::Spec {
                count,
                tier: dt,
                spec: DifficultySpec::from_tier(dt),
                tier_name: dt.label().to_string(),
            });
            continue;
        }

        // Fallback for unknown tier names: use legacy range-based path
        let (min, max) = tier_range_extended(&tier_name)?;
        result.push(DistributionEntry::Range {
            count,
            min_val: min,
            max_val: max,
            tier_name,
        });
    }
    Ok(result)
}

// ─── Generate command ───────────────────────────────────────────────────────

/// Determine the generation mode from CLI flags.
enum GenerateMode {
    /// --tier <name>: all theorems use one tier preset
    Tier(DifficultyTier, DifficultySpec, String),
    /// --variables/--passes/... custom spec
    CustomSpec(DifficultySpec),
    /// --difficulty-distribution or default, with optional max_nodes/max_depth overrides
    Distribution(String, Option<u32>, Option<u32>),
}

fn resolve_generate_mode(
    tier: &Option<String>,
    variables: &Option<u8>,
    passes: &Option<u16>,
    transforms: &Option<u16>,
    base: &Option<String>,
    substitution: &Option<u16>,
    bridge_atoms: &Option<u8>,
    max_nodes: &Option<u32>,
    max_depth: &Option<u32>,
    distribution: &Option<String>,
    gnarly_override: Option<bool>,
) -> Result<GenerateMode, String> {
    // Mode 1: --tier
    if let Some(tier_name) = tier {
        let dt = DifficultyTier::from_str(tier_name)
            .ok_or_else(|| format!("Unknown tier: '{}'. Use baby/easy/medium/hard/expert/nightmare/marathon/absurd/cosmic/mind.", tier_name))?;
        let mut spec = DifficultySpec::from_tier(dt);
        if let Some(nodes) = max_nodes {
            spec.max_formula_nodes = Some(*nodes);
        }
        if let Some(depth) = max_depth {
            spec.max_formula_depth = Some(*depth);
        }
        if let Some(ba) = bridge_atoms {
            spec.bridge_atoms = Some(*ba);
        }
        if let Some(gnarly) = gnarly_override {
            spec.gnarly_combos = Some(gnarly);
        }
        return Ok(GenerateMode::Tier(dt, spec, dt.label().to_string()));
    }

    // Mode 2: any custom spec flag (except max_nodes/max_depth which are orthogonal)
    if variables.is_some() || passes.is_some() || transforms.is_some() || base.is_some() || substitution.is_some() {
        let spec = DifficultySpec {
            variables: variables.unwrap_or(3),
            passes: passes.unwrap_or(1),
            transforms_per_pass: transforms.unwrap_or(5),
            base_complexity: match base.as_deref() {
                Some("complex") => BaseComplexity::Complex,
                _ => BaseComplexity::Simple,
            },
            substitution_depth: substitution.unwrap_or(0),
            bridge_atoms: *bridge_atoms,
            max_formula_nodes: *max_nodes,
            max_formula_depth: *max_depth,
            gnarly_combos: gnarly_override,
        };
        return Ok(GenerateMode::CustomSpec(spec));
    }

    // Mode 3: --difficulty-distribution or default
    if gnarly_override.is_some() {
        eprintln!("Warning: --gnarly-combos/--no-gnarly-combos is ignored in distribution mode. Each tier uses its own default.");
    }
    let dist_str = distribution.clone()
        .unwrap_or_else(|| "30:easy,30:medium,20:hard,15:expert,5:nightmare".to_string());
    Ok(GenerateMode::Distribution(dist_str, *max_nodes, *max_depth))
}

/// Rejection-reason category for histogram purposes — the variant name, ignoring
/// any embedded fields (so e.g. `DisguisedIdentity { distance }` doesn't fragment
/// the histogram by distance value).
fn rejection_category(r: &ServeRejection) -> &'static str {
    match r {
        ServeRejection::TautologousDisjunct => "TautologousDisjunct",
        ServeRejection::SubformulaDecoy => "SubformulaDecoy",
        ServeRejection::DisguisedIdentity { .. } => "DisguisedIdentity",
        ServeRejection::NotGreedyProvable => "NotGreedyProvable",
        ServeRejection::OptimalUnknown => "OptimalUnknown",
        ServeRejection::Hallway => "Hallway",
        ServeRejection::TooShort { .. } => "TooShort",
        ServeRejection::InsufficientDivergence { .. } => "InsufficientDivergence",
        ServeRejection::NoUnlock => "NoUnlock",
    }
}

/// How often (in total attempts across the whole run) tournament mode prints a
/// progress line, so a long run stays observable instead of silent for minutes.
const TOURNAMENT_PROGRESS_INTERVAL: usize = 25;

/// Rejection-sampling loop for `--tournament`: keep generating candidates via
/// `generate_one` (same tier/spec path as non-tournament mode) and running them
/// through `analyze_for_serving` until one passes (`rejection: None`), or
/// `max_attempts` attempts are burned on this one theorem. `histogram` and
/// `total_attempts` accumulate across the WHOLE run (every theorem generated so
/// far), not just this call — no silent statistics.
fn tournament_pick(
    mut generate_one: impl FnMut() -> Theorem,
    serve_cfg: &ServeConfig,
    max_attempts: usize,
    tier_label: &str,
    histogram: &mut HashMap<String, usize>,
    total_attempts: &mut usize,
) -> Result<(Theorem, ServeAnalysis), String> {
    for _ in 0..max_attempts {
        let theorem = generate_one();
        let analysis = analyze_for_serving(&theorem, serve_cfg);
        *total_attempts += 1;
        if *total_attempts % TOURNAMENT_PROGRESS_INTERVAL == 0 {
            eprintln!("  tournament: {} attempts so far; histogram: {:?}", total_attempts, histogram);
        }
        match &analysis.rejection {
            None => return Ok((theorem, analysis)),
            Some(r) => {
                *histogram.entry(rejection_category(r).to_string()).or_insert(0) += 1;
            }
        }
    }
    Err(format!(
        "tournament mode: {} attempts exhausted at tier {}; histogram: {:?}",
        max_attempts, tier_label, histogram
    ))
}

fn cmd_generate(
    count: usize,
    distribution: &Option<String>,
    tier: &Option<String>,
    variables: &Option<u8>,
    passes: &Option<u16>,
    transforms: &Option<u16>,
    base: &Option<String>,
    substitution: &Option<u16>,
    bridge_atoms: &Option<u8>,
    max_nodes: &Option<u32>,
    max_depth: &Option<u32>,
    gnarly_override: Option<bool>,
    output: &PathBuf,
    seed: Option<u64>,
    tournament: bool,
    attempts: usize,
    equiv_cap: usize,
) -> Result<(), String> {
    let mode = resolve_generate_mode(tier, variables, passes, transforms, base, substitution, bridge_atoms, max_nodes, max_depth, distribution, gnarly_override)?;

    let mut rng: Box<dyn RngCore> = match seed {
        Some(s) => Box::new(StdRng::seed_from_u64(s)),
        None => Box::new(thread_rng()),
    };
    let mut theorems: Vec<BenchTheorem> = Vec::with_capacity(count);
    let mut theorem_id = 1usize;

    let serve_cfg = ServeConfig {
        optimal: OptimalConfig { equiv_moves_per_state: equiv_cap, ..OptimalConfig::default() },
        ..ServeConfig::default()
    };
    let mut histogram: HashMap<String, usize> = HashMap::new();
    let mut total_attempts: usize = 0;

    match mode {
        GenerateMode::Tier(dt, spec, tier_name) => {
            eprintln!("Generating {} {} theorems via tier spec...", count, tier_name);
            for _ in 0..count {
                let mut bench = if tournament {
                    let (theorem, analysis) = tournament_pick(
                        || ObfuscateGenerator::generate_with_tier_spec(dt, &spec, &mut rng),
                        &serve_cfg, attempts, &tier_name, &mut histogram, &mut total_attempts,
                    )?;
                    let mut b = BenchTheorem::from(&theorem);
                    b.serve_analysis = Some(analysis);
                    b
                } else {
                    BenchTheorem::from(&ObfuscateGenerator::generate_with_tier_spec(dt, &spec, &mut rng))
                };
                bench.id = format!("v1-{:03}", theorem_id);
                bench.difficulty = tier_name.clone();
                bench.difficulty_spec = Some(spec.clone());
                theorems.push(bench);
                theorem_id += 1;
            }
        }

        GenerateMode::CustomSpec(spec) => {
            eprintln!(
                "Generating {} theorems with custom spec (vars={}, passes={}, transforms={}, base={:?}, sub={})...",
                count, spec.variables, spec.passes, spec.transforms_per_pass, spec.base_complexity, spec.substitution_depth
            );
            for _ in 0..count {
                let mut bench = if tournament {
                    let (theorem, analysis) = tournament_pick(
                        || ObfuscateGenerator::generate_with_spec(&spec, &mut rng),
                        &serve_cfg, attempts, "Custom", &mut histogram, &mut total_attempts,
                    )?;
                    let mut b = BenchTheorem::from(&theorem);
                    b.serve_analysis = Some(analysis);
                    b
                } else {
                    BenchTheorem::from(&ObfuscateGenerator::generate_with_spec(&spec, &mut rng))
                };
                bench.id = format!("v1-{:03}", theorem_id);
                bench.difficulty = "Custom".to_string();
                bench.difficulty_spec = Some(spec.clone());
                theorems.push(bench);
                theorem_id += 1;
            }
        }

        GenerateMode::Distribution(dist_str, max_nodes_override, max_depth_override) => {
            let entries = parse_difficulty_distribution(&dist_str)?;
            let total: usize = entries.iter().map(|e| match e {
                DistributionEntry::Range { count, .. } => *count,
                DistributionEntry::Spec { count, .. } => *count,
            }).sum();
            if total != count {
                return Err(format!(
                    "Distribution sums to {} but --count is {}. They must match.",
                    total, count
                ));
            }

            for entry in &entries {
                match entry {
                    DistributionEntry::Range { count: tier_count, min_val, max_val, tier_name } => {
                        eprintln!("Generating {} {} theorems (difficulty {}-{})...", tier_count, tier_name, min_val, max_val);
                        for _ in 0..*tier_count {
                            let difficulty_value = rng.gen_range(*min_val..=*max_val);
                            let generator = TheoremGenerator::with_difficulty_value(difficulty_value);
                            let theorem = generator.generate_with_value(difficulty_value);
                            let mut bench = BenchTheorem::from(&theorem);
                            bench.id = format!("v1-{:03}", theorem_id);
                            theorems.push(bench);
                            theorem_id += 1;
                        }
                    }
                    DistributionEntry::Spec { count: tier_count, tier, spec, tier_name } => {
                        // Apply max_nodes/max_depth overrides if provided.
                        // gnarly_combos is NOT overridden — each tier's spec from
                        // DifficultySpec::from_tier() already has the correct per-tier default.
                        let mut spec = spec.clone();
                        if let Some(nodes) = max_nodes_override {
                            spec.max_formula_nodes = Some(nodes);
                        }
                        if let Some(depth) = max_depth_override {
                            spec.max_formula_depth = Some(depth);
                        }
                        eprintln!("Generating {} {} theorems via spec...", tier_count, tier_name);
                        for _ in 0..*tier_count {
                            let mut bench = if tournament {
                                let (theorem, analysis) = tournament_pick(
                                    || ObfuscateGenerator::generate_with_tier_spec(*tier, &spec, &mut rng),
                                    &serve_cfg, attempts, tier_name, &mut histogram, &mut total_attempts,
                                )?;
                                let mut b = BenchTheorem::from(&theorem);
                                b.serve_analysis = Some(analysis);
                                b
                            } else {
                                BenchTheorem::from(&ObfuscateGenerator::generate_with_tier_spec(*tier, &spec, &mut rng))
                            };
                            bench.id = format!("v1-{:03}", theorem_id);
                            bench.difficulty = tier_name.clone();
                            bench.difficulty_spec = Some(spec.clone());
                            theorems.push(bench);
                            theorem_id += 1;
                        }
                    }
                }
            }
        }
    }

    if tournament {
        let rate = if total_attempts > 0 {
            100.0 * theorems.len() as f64 / total_attempts as f64
        } else {
            0.0
        };
        eprintln!(
            "Tournament complete: {}/{} attempts accepted ({:.3}%). Histogram: {:?}",
            theorems.len(), total_attempts, rate, histogram
        );
    }

    // Create parent directories if needed
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
        }
    }

    let json = serde_json::to_string_pretty(&theorems)
        .map_err(|e| format!("JSON serialization error: {}", e))?;
    fs::write(output, &json)
        .map_err(|e| format!("Failed to write output file: {}", e))?;

    eprintln!("Wrote {} theorems to {}", theorems.len(), output.display());
    Ok(())
}

// ─── Analyze command ────────────────────────────────────────────────────────

/// Reconstruct a `Theorem` from a parsed `BenchTheorem` for re-analysis. Mirrors
/// `cmd_validate`'s formula parsing, but only needs premises/conclusion —
/// `analyze_for_serving` never looks at `difficulty`.
fn parse_bench_theorem(bench: &BenchTheorem) -> Result<Theorem, String> {
    let premises: Vec<Formula> = bench.premises.iter()
        .map(|p| Formula::parse(p).map_err(|e| format!("Theorem {}: invalid premise '{}': {}", bench.id, p, e)))
        .collect::<Result<Vec<_>, _>>()?;
    let conclusion = Formula::parse(&bench.conclusion)
        .map_err(|e| format!("Theorem {}: invalid conclusion '{}': {}", bench.id, bench.conclusion, e))?;
    let difficulty = match bench.difficulty_value {
        1..=25 => Difficulty::Easy,
        26..=45 => Difficulty::Medium,
        46..=70 => Difficulty::Hard,
        _ => Difficulty::Expert,
    };
    Ok(Theorem::with_difficulty_value(premises, conclusion, difficulty, bench.difficulty_value, None, None))
}

#[derive(Debug, Serialize)]
struct AnalyzeEntry {
    id: String,
    serve_analysis: ServeAnalysis,
}

fn cmd_analyze(theorems_path: &PathBuf, limit: Option<usize>, equiv_cap: usize) -> Result<(), String> {
    let json_str = fs::read_to_string(theorems_path)
        .map_err(|e| format!("Failed to read theorems file: {}", e))?;
    let benches: Vec<BenchTheorem> = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse theorems JSON: {}", e))?;

    let total = benches.len();
    let take_n = limit.map(|l| l.min(total)).unwrap_or(total);
    eprintln!("Analyzing {} of {} theorems from {}...", take_n, total, theorems_path.display());

    let serve_cfg = ServeConfig {
        optimal: OptimalConfig { equiv_moves_per_state: equiv_cap, ..OptimalConfig::default() },
        ..ServeConfig::default()
    };

    let mut histogram: HashMap<String, usize> = HashMap::new();
    let mut accepted = 0usize;
    let mut results: Vec<AnalyzeEntry> = Vec::with_capacity(take_n);

    for (i, bench) in benches.iter().take(take_n).enumerate() {
        let theorem = parse_bench_theorem(bench)?;
        let analysis = analyze_for_serving(&theorem, &serve_cfg);
        match &analysis.rejection {
            None => accepted += 1,
            Some(r) => {
                *histogram.entry(rejection_category(r).to_string()).or_insert(0) += 1;
            }
        }
        eprintln!("  [{}/{}] {} -> {:?}", i + 1, take_n, bench.id, analysis.rejection);
        results.push(AnalyzeEntry { id: bench.id.clone(), serve_analysis: analysis });
    }

    let json = serde_json::to_string_pretty(&results)
        .map_err(|e| format!("JSON serialization error: {}", e))?;
    println!("{}", json);

    let rate = if take_n > 0 { 100.0 * accepted as f64 / take_n as f64 } else { 0.0 };
    eprintln!("--- Analyze summary ---");
    eprintln!("Analyzed: {}  Accepted: {} ({:.3}%)", take_n, accepted, rate);
    eprintln!("Rejection histogram: {:?}", histogram);

    Ok(())
}

// ─── Validate command ───────────────────────────────────────────────────────

fn cmd_validate(theorem_path: &PathBuf, proof_path: &PathBuf) -> Result<(), String> {
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
    let replayed = match replay_proof(&theorem, &input_lines) {
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

// ─── Main ───────────────────────────────────────────────────────────────────

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Generate {
            count,
            difficulty_distribution,
            tier,
            variables,
            passes,
            transforms,
            base,
            substitution,
            bridge_atoms,
            max_nodes,
            max_depth,
            no_gnarly_combos,
            gnarly_combos,
            output,
            seed,
            tournament,
            attempts,
            equiv_cap,
        } => {
            let gnarly_override = if gnarly_combos {
                Some(true)
            } else if no_gnarly_combos {
                Some(false)
            } else {
                None
            };
            cmd_generate(
                count,
                &difficulty_distribution,
                &tier,
                &variables,
                &passes,
                &transforms,
                &base,
                &substitution,
                &bridge_atoms,
                &max_nodes,
                &max_depth,
                gnarly_override,
                &output,
                seed,
                tournament,
                attempts,
                equiv_cap,
            )
        }
        Commands::Validate { theorem, proof } => {
            cmd_validate(&theorem, &proof)
        }
        Commands::Analyze { theorems, limit, equiv_cap } => {
            cmd_analyze(&theorems, limit, equiv_cap)
        }
        Commands::Golf { command } => match command {
            GolfCommands::Plant { count, seed, band, out_set, out_key, freeze, subproofs, passes } => {
                golf::cmd_plant(count, seed, band, &out_set, &out_key, freeze, subproofs, passes)
            }
        },
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
