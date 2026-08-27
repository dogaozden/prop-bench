use logic_core::models::{
    Formula, Proof, Justification,
    theorem::Theorem,
    rules::{InferenceRule, EquivalenceRule, ProofTechnique},
};
use logic_core::services::ProofVerifier;
use serde::{Deserialize, Serialize};

// ─── Input/output types ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateInput {
    pub line_number: usize,
    pub formula: String,
    pub justification: String,
    pub depth: usize,
}

#[derive(Debug)]
pub struct ReplayOk {
    pub line_count: usize,
}

#[derive(Debug)]
pub enum ReplayError {
    Parse(String),
    InvalidLine { line_number: usize, message: String },
    PremiseInInput { line_number: usize },
    BadNumbering { line_number: usize, expected: usize },
    Incomplete,
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplayError::Parse(msg) => write!(f, "{}", msg),
            ReplayError::InvalidLine { line_number, message } => {
                write!(f, "Line {}: {}", line_number, message)
            }
            ReplayError::PremiseInInput { line_number } => write!(
                f,
                "Line {}: 'premise' justification not allowed in proof input (premises are auto-seeded from the theorem)",
                line_number
            ),
            ReplayError::BadNumbering { line_number, expected } => write!(
                f,
                "Line {}: input declared line {} but the next engine-assigned line number is {}",
                line_number, line_number, expected
            ),
            ReplayError::Incomplete => write!(
                f,
                "Proof incomplete: conclusion not established at depth 0, or a subproof scope remains open"
            ),
        }
    }
}

// ─── Replay ──────────────────────────────────────────────────────────────────

/// Replay a proof's input lines against `theorem` and report validity + the
/// derived (non-premise) line count. `Proof::new` auto-seeds premise lines
/// from the theorem, so `lines` must contain derived lines only — a
/// `"premise"` justification in the input is rejected (it would otherwise
/// silently duplicate a premise line), as is an input `line_number` that
/// doesn't match the engine-assigned next line number.
///
/// Fails fast: the first invalid/malformed line stops replay and is returned
/// as the error.
pub fn replay_proof(theorem: &Theorem, lines: &[ValidateInput]) -> Result<ReplayOk, ReplayError> {
    let mut proof = Proof::new(theorem.clone());

    for input_line in lines {
        let formula = Formula::parse(&input_line.formula).map_err(|e| {
            ReplayError::Parse(format!(
                "Line {}: Invalid formula '{}': {}",
                input_line.line_number, input_line.formula, e
            ))
        })?;

        let justification = parse_justification(&input_line.justification).map_err(|e| {
            ReplayError::Parse(format!(
                "Line {}: Invalid justification '{}': {}",
                input_line.line_number, input_line.justification, e
            ))
        })?;

        if matches!(justification, Justification::Premise) {
            return Err(ReplayError::PremiseInInput { line_number: input_line.line_number });
        }

        let expected = proof.next_line_number();
        if input_line.line_number != expected {
            return Err(ReplayError::BadNumbering {
                line_number: input_line.line_number,
                expected,
            });
        }

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
                        return Err(ReplayError::InvalidLine {
                            line_number: input_line.line_number,
                            message: result.message.unwrap_or_else(|| "Invalid".to_string()),
                        });
                    }
                } else {
                    return Err(ReplayError::InvalidLine {
                        line_number: input_line.line_number,
                        message: "No open subproof to close".to_string(),
                    });
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
                    return Err(ReplayError::InvalidLine {
                        line_number: input_line.line_number,
                        message: result.message.unwrap_or_else(|| "Invalid".to_string()),
                    });
                }
            }
        }
    }

    if !proof.check_complete() {
        return Err(ReplayError::Incomplete);
    }

    let line_count = proof.lines.len() - theorem.premises.len();
    Ok(ReplayOk { line_count })
}

// ─── Justification parsing ──────────────────────────────────────────────────

pub fn parse_justification(s: &str) -> Result<Justification, String> {
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

// ─── Serialization (Proof → replay JSON) ────────────────────────────────────

/// Serialize a `Justification` to the string format `parse_justification` accepts.
/// This is the exact inverse of `parse_justification` — NOT the same thing as
/// `logic_core::Justification::display_string()`, which looks similar but isn't:
/// it returns `"Premise"` instead of panicking, and it joins `Inference` line
/// lists with `", "` instead of `","`. Don't collapse this into a call to
/// `display_string()`; `parse_line_numbers` in this file happens to tolerate
/// either separator, but the required format — locked down by
/// `justification_to_replay_string_matches_exact_format` in
/// `tests/replay_roundtrip.rs` — is `","`.
///
/// # Panics
/// Panics on `Justification::Premise` — premises are auto-seeded by `Proof::new`
/// and never appear as replay JSON input lines, so there is no string form to
/// produce. Callers must filter premise lines out first (see `proof_to_replay`,
/// which does exactly that).
pub fn justification_to_replay_string(j: &Justification) -> String {
    match j {
        Justification::Premise => panic!(
            "justification_to_replay_string: Justification::Premise has no replay-JSON form; \
             the caller must filter premise lines before serializing"
        ),
        Justification::Assumption { technique } => {
            format!("Assumption ({})", technique.abbreviation())
        }
        Justification::Inference { rule, lines } => {
            let lines_str = lines
                .iter()
                .map(|l| l.to_string())
                .collect::<Vec<_>>()
                .join(",");
            format!("{} {}", rule.abbreviation(), lines_str)
        }
        Justification::Equivalence { rule, line } => {
            format!("{} {}", rule.abbreviation(), line)
        }
        Justification::SubproofConclusion { technique, subproof_start, subproof_end } => {
            format!("{} {}-{}", technique.abbreviation(), subproof_start, subproof_end)
        }
    }
}

/// Serialize a native `Proof` to the `ValidateInput` lines `replay_proof` expects:
/// premise lines are skipped (they're auto-seeded from the theorem on replay), and
/// `line_number`/`depth` are carried over verbatim from each `ProofLine`.
pub fn proof_to_replay(proof: &Proof) -> Vec<ValidateInput> {
    proof
        .lines
        .iter()
        .filter(|line| !matches!(line.justification, Justification::Premise))
        .map(|line| ValidateInput {
            line_number: line.line_number,
            formula: line.formula.ascii_string_bracketed(),
            justification: justification_to_replay_string(&line.justification),
            depth: line.depth,
        })
        .collect()
}
