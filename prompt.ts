// PropBench -- Prompt template builder
//
// Builds a complete prompt for an LLM to produce a Fitch-style natural
// deduction proof. Includes all 19 rules, CP/IP techniques, symbol
// reference, and strict output format specification.

import { Theorem } from "./config";

// --- Rule reference (included verbatim in every prompt) ---------------------

const INFERENCE_RULES = `\
VALID ARGUMENT FORMS (Inference Rules)
These rules derive a NEW formula from cited lines.

 #  Name                     Abbrev  Pattern
 1  Modus Ponens             MP      p > q, p           => q
 2  Modus Tollens            MT      p > q, ~q          => ~p
 3  Disjunctive Syllogism    DS      p v q, ~p          => q
 4  Simplification           Simp    p . q              => p  (or q)
 5  Conjunction              Conj    p, q               => p . q
 6  Hypothetical Syllogism   HS      p > q, q > r       => p > r
 7  Addition                 Add     p                  => p v q
 8  Constructive Dilemma     CD      p v q, p > r, q > s  => r v s
 9  Negation Elimination     NegE    p, ~p              => #`;

const EQUIVALENCE_RULES = `\
VALID EQUIVALENCE FORMS (Replacement Rules)
These rules REPLACE a formula (or subformula) with a logically
equivalent form. They work bidirectionally and on subformulas.

 #   Name              Abbrev   Equivalence
 10  Double Negation   DN       p  ::  ~~p
 11  DeMorgan's        DeM      ~(p . q)  ::  ~p v ~q
                                ~(p v q)  ::  ~p . ~q
 12  Commutation       Comm     p v q  ::  q v p
                                p . q  ::  q . p
 13  Association       Assoc    p v (q v r)  ::  (p v q) v r
                                p . (q . r)  ::  (p . q) . r
 14  Distribution      Dist     p . (q v r)  ::  (p . q) v (p . r)
                                p v (q . r)  ::  (p v q) . (p v r)
 15  Contraposition    Contra   p > q  ::  ~q > ~p
 16  Implication       Impl     p > q  ::  ~p v q
 17  Exportation       Exp      (p . q) > r  ::  p > (q > r)
 18  Tautology         Taut     p  ::  p . p
                                p  ::  p v p
 19  Equivalence       Equiv    p <> q  ::  (p > q) . (q > p)`;

const TECHNIQUES = `\
PROOF TECHNIQUES (Subproofs)

Conditional Proof (CP):
  1. Assume p              (opens a subproof -- write "Assumption (CP)")
  2. Derive q              (within the subproof, using any rules)
  3. Close: p > q          (write "CP start-end" where start-end are
                            the line numbers of the subproof)

Indirect Proof (IP):
  1. Assume p (or ~p)      (opens a subproof -- write "Assumption (IP)")
  2. Derive a contradiction (#, or any A . ~A)
  3. Close: ~p (or p)      (write "IP start-end" -- negation of assumption)

Subproofs can be nested. Lines inside a closed subproof cannot be
cited from outside it.`;

const SYMBOLS = `\
SYMBOL REFERENCE
  >   conditional (if...then)
  v   disjunction (or)
  .   conjunction (and)
  ~   negation (not)
  <>  biconditional (if and only if)
  #   contradiction (bottom / falsum)

PARENTHESES
  Use ( ) for grouping subformulas.
  For nested grouping, use the hierarchy:  {  {  {  [  (  )  ]  }  }  }
  Outermost: { }   Middle: [ ]   Innermost: ( )
  Example: {[P > (Q . R)] v S} > T
  All bracket types are treated as equivalent grouping -- use them to
  make deeply nested formulas readable.`;

const OUTPUT_FORMAT = `\
OUTPUT FORMAT
Write each proof line as:
  N. FORMULA JUSTIFICATION

Where:
  N              -- line number
  FORMULA        -- a SINGLE propositional formula (the result you derived)
  JUSTIFICATION  -- the rule and line references used

JUSTIFICATION is one of:
  Assumption (CP)            -- opens a CP subproof
  Assumption (IP)            -- opens an IP subproof
  RULE LINE_NUMBERS          -- e.g. MP 1,2  or  Simp 3  or  DeM 5
  CP START-END               -- closes a CP subproof (e.g. CP 3-7)
  IP START-END               -- closes an IP subproof (e.g. IP 4-9)

CRITICAL: The FORMULA field must contain ONLY the single formula you derived,
NOT the formulas you used to derive it.

Indent lines inside subproofs with 2 extra spaces per nesting level.
Minimize the total number of proof lines.

COMPLETE EXAMPLE (tautology — uses nested CP):
  Prove: P > (Q > (P . Q))

  1.   P Assumption (CP)
  2.     Q Assumption (CP)
  3.     P . Q Conj 1,2
  4.   Q > (P . Q) CP 2-3
  5. P > (Q > (P . Q)) CP 1-4

Your output must look EXACTLY like the example above: numbered lines only,
no backticks, no commentary, no natural language reasoning.`;

// --- Prompt builder ---------------------------------------------------------

/**
 * Static system prompt — identical for every theorem.
 * Separated out so adapters can cache it (e.g., Anthropic prompt caching).
 */
export const SYSTEM_PROMPT = `\
You are a formal logic proof assistant. Given a theorem, produce a
correct Fitch-style natural deduction proof using ONLY the rules and
techniques listed below. Your primary goal is to get the correct proof with the fewest logical operations.

${SYMBOLS}

${INFERENCE_RULES}

${EQUIVALENCE_RULES}

${TECHNIQUES}

${OUTPUT_FORMAT}`;

/**
 * Build the theorem-specific user prompt (short, changes every call).
 */
export function buildUserPrompt(theorem: Theorem): string {
  return `\
-------------------------------------
THEOREM TO PROVE
Prove the following tautology:
  ${theorem.conclusion}

You will need to use Conditional Proof (CP) and/or Indirect Proof (IP)
to derive the formula.
-------------------------------------

Write your proof below. Output ONLY the numbered proof lines.
Do not include any explanation, commentary, or extra text.`;
}

/**
 * Build a complete benchmark prompt for a given theorem (tautology).
 * All theorems are tautologies with no premises — proofs use CP and/or IP.
 */
export function buildPrompt(theorem: Theorem): string {
  return `${SYSTEM_PROMPT}\n\n${buildUserPrompt(theorem)}`;
}
