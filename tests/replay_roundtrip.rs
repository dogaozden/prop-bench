use logic_core::models::*;
use logic_core::models::rules::{ProofTechnique, EquivalenceRule, InferenceRule};
use propbench::replay::{ValidateInput, proof_to_replay, replay_proof, justification_to_replay_string, parse_justification};

fn f(s: &str) -> Formula { Formula::parse(s).unwrap() }

fn zero_premise_theorem(conclusion: &str) -> Theorem {
    Theorem {
        id: "test".to_string(),
        premises: vec![],
        conclusion: f(conclusion),
        difficulty: Difficulty::Medium,
        difficulty_value: 50,
        tier: None,
        theme: None,
        name: None,
        is_classic: false,
    }
}

#[test]
fn native_cp_proof_roundtrips_through_replay() {
    let theorem = zero_premise_theorem("P v ~P");
    let mut proof = Proof::new(theorem.clone());
    proof.open_subproof(f("~P"), ProofTechnique::ConditionalProof);
    proof.close_subproof(f("~P > ~P"), ProofTechnique::ConditionalProof);
    proof.add_line(f("~~P v ~P"), Justification::Equivalence { rule: EquivalenceRule::Implication, line: 2 });
    proof.add_line(f("P v ~P"), Justification::Equivalence { rule: EquivalenceRule::DoubleNegation, line: 3 });
    let lines = proof_to_replay(&proof);
    let ok = replay_proof(&theorem, &lines).expect("roundtrip must validate");
    assert_eq!(ok.line_count, 4);

    // Step 4: the emitted lines must equal the committed round-3 fixture. Formula
    // has more than one valid ASCII rendering (e.g. `ascii_string_bracketed()`
    // wraps "~~P" in parens when it sits under a binary connective, but the
    // fixture was hand-authored without those parens since they're unneeded for
    // parsing) so `formula` is compared by re-parsing both sides into `Formula`
    // and checking structural equality; line_number/justification/depth are
    // compared as exact values/strings.
    let fixture_json = std::fs::read_to_string("fixtures/regression/round3_proof.json")
        .expect("fixture readable");
    let fixture: Vec<ValidateInput> = serde_json::from_str(&fixture_json)
        .expect("fixture parses as Vec<ValidateInput>");
    assert_eq!(lines.len(), fixture.len(), "line count mismatch vs fixture");
    for (mine, fx) in lines.iter().zip(fixture.iter()) {
        assert_eq!(mine.line_number, fx.line_number);
        assert_eq!(mine.depth, fx.depth);
        assert_eq!(mine.justification, fx.justification);
        assert_eq!(
            f(&mine.formula), f(&fx.formula),
            "formula mismatch: mine={:?} fixture={:?}", mine.formula, fx.formula
        );
    }
}

/// Fix round 1: `every_justification_string_reparses` below only checks that the
/// emitted string re-parses, not what it literally is — and `parse_line_numbers`
/// tolerates both a comma and a comma-space separator, so a regression from
/// `justification_to_replay_string`'s required comma-only separator to
/// `logic_core::Justification::display_string()`'s comma-space separator
/// (proof.rs:40-46 is otherwise byte-identical for 3 of 5 variants) would pass
/// silently. This test locks the exact emitted string for one representative case
/// of every `Justification` shape, including the two that had zero coverage
/// before (`Assumption (IP)` and the `IP start-end` subproof-conclusion form).
#[test]
fn justification_to_replay_string_matches_exact_format() {
    let cases: Vec<(Justification, &str)> = vec![
        (Justification::Assumption { technique: ProofTechnique::ConditionalProof }, "Assumption (CP)"),
        (Justification::Assumption { technique: ProofTechnique::IndirectProof }, "Assumption (IP)"),
        (Justification::Inference { rule: InferenceRule::ModusPonens, lines: vec![1, 2] }, "MP 1,2"),
        (Justification::Equivalence { rule: EquivalenceRule::Implication, line: 3 }, "Impl 3"),
        (Justification::SubproofConclusion {
            technique: ProofTechnique::ConditionalProof, subproof_start: 1, subproof_end: 4,
        }, "CP 1-4"),
        (Justification::SubproofConclusion {
            technique: ProofTechnique::IndirectProof, subproof_start: 2, subproof_end: 5,
        }, "IP 2-5"),
    ];

    for (j, expected) in cases {
        assert_eq!(justification_to_replay_string(&j), expected, "for {:?}", j);
    }
}

#[test]
fn every_justification_string_reparses() {
    for rule in InferenceRule::all() {
        let lines: Vec<usize> = (1..=rule.premise_count()).collect();
        let j = Justification::Inference { rule, lines };
        let s = justification_to_replay_string(&j);
        let parsed = parse_justification(&s)
            .unwrap_or_else(|e| panic!("failed to reparse '{}' (from {:?}): {}", s, j, e));
        assert_eq!(format!("{:?}", parsed), format!("{:?}", j), "round-trip mismatch for '{}'", s);
    }

    for rule in EquivalenceRule::all() {
        let j = Justification::Equivalence { rule, line: 5 };
        let s = justification_to_replay_string(&j);
        let parsed = parse_justification(&s)
            .unwrap_or_else(|e| panic!("failed to reparse '{}' (from {:?}): {}", s, j, e));
        assert_eq!(format!("{:?}", parsed), format!("{:?}", j), "round-trip mismatch for '{}'", s);
    }
}
