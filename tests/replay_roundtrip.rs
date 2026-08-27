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
