use clap::{Parser, Subcommand};
use logic_proof_trainer_lib::models::{
    Formula, Proof, Justification,
    theorem::{BaseComplexity, Difficulty, DifficultySpec, DifficultyTier, Theorem},
    rules::{InferenceRule, EquivalenceRule, ProofTechnique},
};
use logic_proof_trainer_lib::services::{TheoremGenerator, ProofVerifier, ObfuscateGenerator};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
}

// ─── Output types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct BenchTheorem {
    id: String,
    premises: Vec<String>,
    conclusion: String,
    difficulty: String,
    difficulty_value: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    difficulty_spec: Option<DifficultySpec>,
}

impl From<&Theorem> for BenchTheorem {
    fn from(t: &Theorem) -> Self {
        BenchTheorem {
            id: t.id.clone(),
            premises: t.premises.iter().map(|f| f.ascii_string_bracketed()).collect(),
            conclusion: t.conclusion.ascii_string_bracketed(),
            difficulty: difficulty_label(t.difficulty_value),
            difficulty_value: t.difficulty_value,
            difficulty_spec: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ValidateInput {
    line_number: usize,
    formula: String,
    justification: String,
    depth: usize,
}

#[derive(Debug, Serialize)]
struct ValidateOutput {
    valid: bool,
    line_count: usize,
    errors: Vec<String>,
}

// ─── Difficulty helpers ─────────────────────────────────────────────────────

fn difficulty_label(value: u8) -> String {
    match value {
        1..=25 => "Easy".to_string(),
        26..=45 => "Medium".to_string(),
        46..=70 => "Hard".to_string(),
        71..=85 => "Expert".to_string(),
        86..=95 => "Nightmare".to_string(),
        _ => "Marathon".to_string(),
    }
}

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
) -> Result<(), String> {
    let mode = resolve_generate_mode(tier, variables, passes, transforms, base, substitution, bridge_atoms, max_nodes, max_depth, distribution, gnarly_override)?;

    let mut rng = rand::thread_rng();
    let mut theorems: Vec<BenchTheorem> = Vec::with_capacity(count);
    let mut theorem_id = 1usize;

    match mode {
        GenerateMode::Tier(dt, spec, tier_name) => {
            eprintln!("Generating {} {} theorems via tier spec...", count, tier_name);
            for _ in 0..count {
                let theorem = ObfuscateGenerator::generate_with_tier_spec(dt, &spec, &mut rng);
                let mut bench = BenchTheorem::from(&theorem);
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
                let theorem = ObfuscateGenerator::generate_with_spec(&spec, &mut rng);
                let mut bench = BenchTheorem::from(&theorem);
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
                            let theorem = ObfuscateGenerator::generate_with_tier_spec(*tier, &spec, &mut rng);
                            let mut bench = BenchTheorem::from(&theorem);
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

    // Build the proof by replaying each line
    let mut proof = Proof::new(theorem);
    let mut errors: Vec<String> = Vec::new();

    for input_line in &input_lines {
        let formula = match Formula::parse(&input_line.formula) {
            Ok(f) => f,
            Err(e) => {
                errors.push(format!("Line {}: Invalid formula '{}': {}", input_line.line_number, input_line.formula, e));
                continue;
            }
        };

        let justification = match parse_justification(&input_line.justification) {
            Ok(j) => j,
            Err(e) => {
                errors.push(format!("Line {}: Invalid justification '{}': {}", input_line.line_number, input_line.justification, e));
                continue;
            }
        };

        // Handle different justification types
        match &justification {
            Justification::Assumption { technique } => {
                proof.open_subproof(formula, *technique);
            }
            Justification::SubproofConclusion { technique, .. } => {
                let closed = proof.close_subproof(formula.clone(), *technique).is_some();
                if closed {
                    let last_idx = proof.lines.len() - 1;
                    let line = &proof.lines[last_idx];
                    let result = ProofVerifier::verify_line(line, &proof);
                    proof.lines[last_idx].is_valid = result.is_valid;
                    proof.lines[last_idx].validation_message = result.message.clone();
                    if !result.is_valid {
                        errors.push(format!("Line {}: {}", input_line.line_number,
                            result.message.unwrap_or_else(|| "Invalid".to_string())));
                    }
                } else {
                    errors.push(format!("Line {}: No open subproof to close", input_line.line_number));
                }
            }
            _ => {
                proof.add_line(formula, justification);
                let last_idx = proof.lines.len() - 1;
                let line = &proof.lines[last_idx];
                let result = ProofVerifier::verify_line(line, &proof);
                proof.lines[last_idx].is_valid = result.is_valid;
                proof.lines[last_idx].validation_message = result.message.clone();
                if !result.is_valid {
                    errors.push(format!("Line {}: {}", input_line.line_number,
                        result.message.unwrap_or_else(|| "Invalid".to_string())));
                }
            }
        }
    }

    // Check completeness
    proof.check_complete();

    // If proof is incomplete, add diagnostic error messages explaining why
    if !proof.is_complete {
        // Condition 1: open scopes remain
        if proof.scope_manager.has_open_scopes() {
            let open_count = proof.scope_manager.current_depth();
            errors.push(format!(
                "Proof incomplete: {} subproof scope(s) still open (unclosed)",
                open_count
            ));
        }

        // Condition 2: conclusion not derived at depth 0
        let conclusion = &proof.theorem.conclusion;
        let has_conclusion_at_depth_0 = proof.lines.iter().any(|l| {
            l.depth == 0 && l.formula == *conclusion && l.is_valid
        });
        if !has_conclusion_at_depth_0 {
            errors.push(
                "Proof incomplete: conclusion not established at depth 0".to_string()
            );
        }

        // Condition 3: invalid lines present
        let invalid_lines: Vec<usize> = proof.lines.iter()
            .filter(|l| !l.is_valid)
            .map(|l| l.line_number)
            .collect();
        if !invalid_lines.is_empty() {
            let line_list: Vec<String> = invalid_lines.iter().map(|n| n.to_string()).collect();
            errors.push(format!(
                "Proof incomplete: invalid lines: [{}]",
                line_list.join(", ")
            ));
        }
    }

    let non_premise_lines = proof.lines.len().saturating_sub(proof.theorem.premises.len());
    let output = ValidateOutput {
        valid: proof.is_complete && errors.is_empty(),
        line_count: non_premise_lines,
        errors,
    };

    let json = serde_json::to_string_pretty(&output)
        .map_err(|e| format!("JSON serialization error: {}", e))?;
    println!("{}", json);
    Ok(())
}

// ─── Justification parsing ──────────────────────────────────────────────────

fn parse_justification(s: &str) -> Result<Justification, String> {
    let s = s.trim();

    // Premise
    if s.eq_ignore_ascii_case("premise") || s.eq_ignore_ascii_case("pr") {
        return Ok(Justification::Premise);
    }

    // Assumption (CP) or Assumption (IP)
    if s.to_lowercase().starts_with("assumption") || s.to_lowercase().starts_with("assume") {
        let technique = if s.to_uppercase().contains("IP") {
            ProofTechnique::IndirectProof
        } else {
            ProofTechnique::ConditionalProof
        };
        return Ok(Justification::Assumption { technique });
    }

    // Subproof conclusion: "CP 3-7" or "IP 3-7"
    if let Some(rest) = strip_prefix_ci(s, "CP") {
        if let Some((start, end)) = parse_line_range(rest.trim()) {
            return Ok(Justification::SubproofConclusion {
                technique: ProofTechnique::ConditionalProof,
                subproof_start: start,
                subproof_end: end,
            });
        }
    }
    if let Some(rest) = strip_prefix_ci(s, "IP") {
        if let Some((start, end)) = parse_line_range(rest.trim()) {
            return Ok(Justification::SubproofConclusion {
                technique: ProofTechnique::IndirectProof,
                subproof_start: start,
                subproof_end: end,
            });
        }
    }

    // Inference rules: "MP 1,2" or "Simp 3"
    let inference_rules: &[(&str, InferenceRule)] = &[
        ("MP", InferenceRule::ModusPonens),
        ("MT", InferenceRule::ModusTollens),
        ("DS", InferenceRule::DisjunctiveSyllogism),
        ("HS", InferenceRule::HypotheticalSyllogism),
        ("Simp", InferenceRule::Simplification),
        ("Conj", InferenceRule::Conjunction),
        ("Add", InferenceRule::Addition),
        ("CD", InferenceRule::ConstructiveDilemma),
        ("NegE", InferenceRule::Contradiction),
    ];

    for (abbrev, rule) in inference_rules {
        if let Some(rest) = strip_prefix_ci(s, abbrev) {
            let rest = rest.trim();
            if rest.is_empty() {
                return Err(format!("Missing line numbers for {}", abbrev));
            }
            let lines = parse_line_numbers(rest)?;
            return Ok(Justification::Inference { rule: *rule, lines });
        }
    }

    // Equivalence rules: "DN 3" or "DeM 5"
    let equiv_rules: &[(&str, EquivalenceRule)] = &[
        ("DN", EquivalenceRule::DoubleNegation),
        ("DeM", EquivalenceRule::DeMorgan),
        ("Comm", EquivalenceRule::Commutation),
        ("Assoc", EquivalenceRule::Association),
        ("Dist", EquivalenceRule::Distribution),
        ("Contra", EquivalenceRule::Contraposition),
        ("Impl", EquivalenceRule::Implication),
        ("Exp", EquivalenceRule::Exportation),
        ("Taut", EquivalenceRule::Tautology),
        ("Equiv", EquivalenceRule::Equivalence),
    ];

    for (abbrev, rule) in equiv_rules {
        if let Some(rest) = strip_prefix_ci(s, abbrev) {
            let rest = rest.trim();
            if rest.is_empty() {
                return Err(format!("Missing line number for {}", abbrev));
            }
            let line: usize = rest.parse()
                .map_err(|_| format!("Invalid line number for {}: '{}'", abbrev, rest))?;
            return Ok(Justification::Equivalence { rule: *rule, line });
        }
    }

    Err(format!("Unrecognized justification: '{}'", s))
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let s_lower = s.to_lowercase();
    let prefix_lower = prefix.to_lowercase();
    if s_lower.starts_with(&prefix_lower) {
        let rest = &s[prefix.len()..];
        // Must be followed by whitespace, digit, or end of string
        if rest.is_empty() || rest.starts_with(char::is_whitespace) || rest.starts_with(char::is_numeric) {
            Some(rest)
        } else {
            None
        }
    } else {
        None
    }
}

fn parse_line_numbers(s: &str) -> Result<Vec<usize>, String> {
    let s = s.trim();
    s.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .map(|p| p.trim().parse::<usize>().map_err(|_| format!("Invalid line number: '{}'", p)))
        .collect()
}

fn parse_line_range(s: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() == 2 {
        let start = parts[0].trim().parse::<usize>().ok()?;
        let end = parts[1].trim().parse::<usize>().ok()?;
        Some((start, end))
    } else {
        None
    }
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
            )
        }
        Commands::Validate { theorem, proof } => {
            cmd_validate(&theorem, &proof)
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
