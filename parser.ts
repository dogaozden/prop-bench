// PropBench — LLM output parser
//
// Parses a complete proof text block (as returned by an LLM) into
// structured ParsedLine[] that can be fed to the Rust CLI validator.
//
// Handles:
//   - Line number stripping (1., Step 1:, 1), (1), etc.)
//   - Subproof indentation detection (spaces, tabs, explicit markers)
//   - Rule name variation mapping (40+ aliases → canonical names)
//   - Symbol variation normalization
//   - Conversion to the JSON format expected by `propbench validate`

import {
  Theorem,
  ParsedLine,
  ParseResult,
  ParseError,
} from "./config";

// ─── Canonical rule names ───────────────────────────────────────────────────

// The canonical names must match what the Rust CLI validator expects.

const INFERENCE_ALIASES: Record<string, string> = {
  // Modus Ponens
  mp: "MP",
  "modus ponens": "MP",
  "modusponens": "MP",
  modus: "MP",
  ponens: "MP",
  // Modus Tollens
  mt: "MT",
  "modus tollens": "MT",
  "modustollens": "MT",
  tollens: "MT",
  // Disjunctive Syllogism
  ds: "DS",
  "disjunctive syllogism": "DS",
  "disjunctivesyllogism": "DS",
  disj: "DS",
  disjsyl: "DS",
  // Simplification
  simp: "Simp",
  sim: "Simp",
  simplification: "Simp",
  simple: "Simp",
  // Conjunction
  conj: "Conj",
  conjunction: "Conj",
  and: "Conj",
  // Hypothetical Syllogism
  hs: "HS",
  "hypothetical syllogism": "HS",
  "hypotheticalsyllogism": "HS",
  hyp: "HS",
  hypo: "HS",
  syl: "HS",
  // Addition
  add: "Add",
  addition: "Add",
  or: "Add",
  // Constructive Dilemma
  cd: "CD",
  "constructive dilemma": "CD",
  "constructivedilemma": "CD",
  dil: "CD",
  dilemma: "CD",
  // Negation Elimination
  nege: "NegE",
  "negation elimination": "NegE",
  "negationelimination": "NegE",
  "neg elim": "NegE",
  "⊥i": "NegE",
  "⊥-intro": "NegE",
  "bottom intro": "NegE",
  contradiction: "NegE",
};

const EQUIVALENCE_ALIASES: Record<string, string> = {
  // Double Negation
  dn: "DN",
  "double negation": "DN",
  "doublenegation": "DN",
  "double neg": "DN",
  // DeMorgan's
  dem: "DeM",
  demorgan: "DeM",
  "de morgan": "DeM",
  "demorgans": "DeM",
  "de morgan's": "DeM",
  morgan: "DeM",
  dm: "DeM",
  // Commutation
  comm: "Comm",
  commutation: "Comm",
  com: "Comm",
  commute: "Comm",
  // Association
  assoc: "Assoc",
  association: "Assoc",
  associate: "Assoc",
  // Distribution
  dist: "Dist",
  distribution: "Dist",
  distrib: "Dist",
  distribute: "Dist",
  // Contraposition
  contra: "Contra",
  contraposition: "Contra",
  contrap: "Contra",
  contrapositive: "Contra",
  trans: "Contra",
  transposition: "Contra",
  // Implication
  impl: "Impl",
  implication: "Impl",
  imp: "Impl",
  "material implication": "Impl",
  // Exportation
  exp: "Exp",
  exportation: "Exp",
  export: "Exp",
  // Tautology
  taut: "Taut",
  tautology: "Taut",
  // Equivalence
  equiv: "Equiv",
  equivalence: "Equiv",
  eq: "Equiv",
  bicon: "Equiv",
  biconditional: "Equiv",
  "material equivalence": "Equiv",
};

const TECHNIQUE_ALIASES: Record<string, string> = {
  cp: "CP",
  "conditional proof": "CP",
  "conditionalproof": "CP",
  conditional: "CP",
  cond: "CP",
  ip: "IP",
  "indirect proof": "IP",
  "indirectproof": "IP",
  indirect: "IP",
  raa: "IP",
  "reductio ad absurdum": "IP",
  "reductio": "IP",
  "~i": "IP",
  ni: "IP",
  negintro: "IP",
  "negation introduction": "IP",
};

/**
 * Look up a rule/technique name and return its canonical form,
 * or null if not recognized.
 */
function canonicalizeRule(
  name: string
): { canonical: string; kind: "inference" | "equivalence" | "technique" } | null {
  // Strip trailing dots and normalize
  const lower = name.toLowerCase().trim().replace(/\.+$/, "");

  // Try the normalized version first
  if (TECHNIQUE_ALIASES[lower]) {
    return { canonical: TECHNIQUE_ALIASES[lower], kind: "technique" };
  }
  if (INFERENCE_ALIASES[lower]) {
    return { canonical: INFERENCE_ALIASES[lower], kind: "inference" };
  }
  if (EQUIVALENCE_ALIASES[lower]) {
    return { canonical: EQUIVALENCE_ALIASES[lower], kind: "equivalence" };
  }

  // If nothing matched, try with ALL dots removed (e.g., "M.P." -> "mp")
  const noDots = lower.replace(/\./g, "");
  if (noDots !== lower) {
    if (TECHNIQUE_ALIASES[noDots]) {
      return { canonical: TECHNIQUE_ALIASES[noDots], kind: "technique" };
    }
    if (INFERENCE_ALIASES[noDots]) {
      return { canonical: INFERENCE_ALIASES[noDots], kind: "inference" };
    }
    if (EQUIVALENCE_ALIASES[noDots]) {
      return { canonical: EQUIVALENCE_ALIASES[noDots], kind: "equivalence" };
    }
  }

  return null;
}

// ─── Symbol normalization ───────────────────────────────────────────────────

/**
 * Normalize symbol variations in a formula string to the canonical forms
 * accepted by the Rust parser.
 *
 * The Rust parser accepts many aliases, so we only normalize truly
 * unusual variants that models might produce.
 */
function normalizeFormula(formula: string): string {
  return formula
    // Normalize arrow-style implications
    .replace(/→/g, ">")
    .replace(/⊃/g, ">")
    .replace(/=>/g, ">")
    .replace(/->/g, ">")
    // Normalize contradiction (MUST come before | -> v)
    .replace(/⊥/g, "#")
    .replace(/_\|_/g, "#")
    // Normalize disjunction
    .replace(/∨/g, "v")
    .replace(/\|\|/g, "v")
    .replace(/\|/g, "v")        // single | (AFTER || and _|_)
    // Normalize conjunction
    .replace(/·/g, ".")
    .replace(/∧/g, ".")
    .replace(/&&/g, ".")
    .replace(/&/g, ".")         // single & (AFTER &&)
    .replace(/\u2227/g, ".") // ∧
    // Normalize negation
    .replace(/¬/g, "~")
    .replace(/−/g, "~") // em-dash used as negation
    // Normalize biconditional
    .replace(/≡/g, "<>")
    .replace(/↔/g, "<>")
    .replace(/<=>/g, "<>")
    .replace(/<->/g, "<>")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Line number stripping ─────────────────────────────────────────────────

// Patterns to match line numbers at the start of a line:
//   "1."  "1)"  "(1)"  "Step 1:"  "Step 1."  "Line 1:"  "#1."  "#1"
const LINE_NUMBER_PATTERNS = [
  /^\((\d+)\)\s*/,       // (1)
  /^#(\d+)[.):]\s*/,     // #1. or #1) or #1:
  /^Step\s+(\d+)[.:]\s*/i, // Step 1: or Step 1.
  /^Line\s+(\d+)[.:]\s*/i, // Line 1: or Line 1.
  /^(\d+)\)\s*/,         // 1)
  /^(\d+)\.\s*/,         // 1.
  /^(\d+):\s*/,          // 1:
];

/**
 * Strip a line number prefix from a proof line.
 * Returns the extracted line number and the remaining text.
 */
function stripLineNumber(
  line: string
): { lineNumber: number | null; rest: string } {
  for (const pattern of LINE_NUMBER_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      return {
        lineNumber: parseInt(match[1], 10),
        rest: line.slice(match[0].length),
      };
    }
  }
  return { lineNumber: null, rest: line };
}

// ─── Indentation / depth detection ──────────────────────────────────────────

/**
 * Measure the indentation of a line (number of leading spaces/tabs).
 * Each tab counts as 2 spaces.
 */
function measureIndent(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent += 1;
    else if (ch === "\t") indent += 2;
    else break;
  }
  return indent;
}

/**
 * Detect explicit subproof markers like "|" or "│" at the start of a line.
 * Returns the depth (number of markers) and the remaining text.
 */
function stripSubproofMarkers(
  line: string
): { depth: number; rest: string } {
  let depth = 0;
  let rest = line;
  // Strip leading vertical bar markers
  while (/^\s*[|│]\s*/.test(rest)) {
    rest = rest.replace(/^\s*[|│]\s*/, "");
    depth++;
  }
  return { depth, rest };
}

// ─── Justification parsing ──────────────────────────────────────────────────

// Patterns for justification at the end of a line:
//   "Premise"
//   "Assume FORMULA (CP)" or "Assumption FORMULA (IP)" (keyword-first)
//   "FORMULA Assumption (CP)" or "FORMULA Assume (IP)" or "FORMULA Assume CP"
//   "MP 1,2" or "MP 1, 2" or "MP 1 2"
//   "CP 3-7" or "IP 4-9" or "CP 3–7" (en-dash)

interface ParsedJustification {
  justification: string; // canonical form: "Premise", "Assumption (CP)", "MP 1,2", "CP 3-7"
  formula: string;       // everything before the justification
}

/**
 * Parse a line (after line number stripping) into formula + justification.
 */
function parseJustification(text: string): ParsedJustification | null {
  let trimmed = text.trim();

  // ── Early stripping of trailing commentary ──
  // Strip trailing "-- ..." comments (require space after -- to avoid false positives)
  trimmed = trimmed.replace(/\s+--\s.*$/, '').trim();

  // Strip trailing parenthetical commentary (but preserve justification parens)
  // Must handle nested parens like "(Simplifies ~[P . (T > T)] to ~P)"
  while (true) {
    // Find the last ')' at or near end of string
    const lastClose = trimmed.lastIndexOf(')');
    if (lastClose < 0) break;
    // Only strip if it's at or near end (allow trailing whitespace)
    if (trimmed.slice(lastClose + 1).trim() !== '') break;

    // Walk backward to find matching '('
    let depth = 0;
    let openIdx = -1;
    for (let i = lastClose; i >= 0; i--) {
      if (trimmed[i] === ')') depth++;
      else if (trimmed[i] === '(') { depth--; if (depth === 0) { openIdx = i; break; } }
    }
    if (openIdx < 0) break;

    // Ensure there's non-whitespace content before the paren group
    const before = trimmed.slice(0, openIdx).trimEnd();
    if (!before) break;

    const parenContent = trimmed.slice(openIdx + 1, lastClose).trim();

    // Check if paren content looks like a justification: "RULE" or "RULE LINES"
    const ruleCheck = parenContent.match(/^([A-Za-z][A-Za-z\s.]*?)(?:\s+([\d,\s\-–]+))?$/);
    if (ruleCheck) {
      const possibleRule = ruleCheck[1].trim();
      if (canonicalizeRule(possibleRule)) {
        break; // This is a justification paren — stop stripping
      }
      // Also check for CP/IP which are technique rules
      if (/^(CP|IP)$/i.test(possibleRule)) {
        break;
      }
    }

    // Not a justification — strip it
    trimmed = before;
  }

  // Case 1: Just "Premise" (with optional trailing noise in parens)
  const premiseMatch = trimmed.match(/^(.+?)\s+Premise(?:\s*\([^)]*\))*$/i);
  if (premiseMatch) {
    return {
      justification: "Premise",
      formula: premiseMatch[1].trim(),
    };
  }

  // Case 2a: "Assume FORMULA (CP)" or "Assumption FORMULA (IP)" — keyword-first format
  const assumeFirstMatch = trimmed.match(
    /^(?:Assume|Assumption|Ass\.?)\s+(.+?)\s*\(?\s*(CP|IP)\s*\)?$/i
  );
  if (assumeFirstMatch) {
    const tech = canonicalizeRule(assumeFirstMatch[2]);
    if (tech) {
      return {
        justification: `Assumption (${tech.canonical})`,
        formula: assumeFirstMatch[1].trim(),
      };
    }
  }

  // Case 2b: "FORMULA Assumption (CP)" or "FORMULA Assume (IP)" — formula-first format
  const assumptionMatch = trimmed.match(
    /^(.+?)\s+(?:Assumption|Assume|Ass\.?)\s*\(?\s*(CP|IP)\s*\)?$/i
  );
  if (assumptionMatch) {
    const tech = canonicalizeRule(assumptionMatch[2]);
    if (tech) {
      return {
        justification: `Assumption (${tech.canonical})`,
        formula: assumptionMatch[1].trim(),
      };
    }
  }

  // Case 3a: Bare subproof close with no formula: "CP 3-7" or "IP 4-9"
  const bareSubproofCloseMatch = trimmed.match(
    /^(CP|IP)\s+(\d+)\s*[-–,]\s*(\d+)$/i
  );
  if (bareSubproofCloseMatch) {
    const tech = canonicalizeRule(bareSubproofCloseMatch[1]);
    if (tech) {
      return {
        justification: `${tech.canonical} ${bareSubproofCloseMatch[2]}-${bareSubproofCloseMatch[3]}`,
        formula: "", // Empty — will be inferred in post-processing
      };
    }
  }

  // Case 3b: Subproof close: "CP 3-7" or "IP 4-9" at the end (with formula)
  const subproofCloseMatch = trimmed.match(
    /^(.+?)\s+(CP|IP)\s+(\d+)\s*[-–,]\s*(\d+)$/i
  );
  if (subproofCloseMatch) {
    const tech = canonicalizeRule(subproofCloseMatch[2]);
    if (tech) {
      const start = subproofCloseMatch[3];
      const end = subproofCloseMatch[4];
      return {
        justification: `${tech.canonical} ${start}-${end}`,
        formula: subproofCloseMatch[1].trim(),
      };
    }
  }

  // Case 4: Rule application at the end: "FORMULA RULE LINE_NUMBERS"
  // Try multi-word rule names (up to 3 words) before single-word, so that
  // "Negation Elimination 6, 7" matches as a whole rule name.

  // Helper: try to extract "RULE LINES" from the end with N-word rule names
  const result = tryExtractRuleAndLines(trimmed);
  if (result) return result;

  return null;
}

/**
 * Try to extract a rule name + line numbers from the end of a proof line.
 * Handles multi-word rule names (up to 3 words) and both orderings:
 *   "FORMULA RULE N,N" and "FORMULA N,N RULE"
 */
function tryExtractRuleAndLines(text: string): ParsedJustification | null {
  // Strip trailing -- comments first
  let cleaned = text.replace(/\s*--.*$/, "").trim();

  // Check if the text ends with a parenthesized justification like "(DeM 1)" or "(NegE 5, 6)" or "(CP 1-7)"
  // Match: FORMULA (RULE LINES) where LINES can be "1", "1,2", "1-7", etc.
  const parenJustMatch = cleaned.match(/^(.+?)\s*\(\s*([A-Za-z][A-Za-z\s]*?)(?:\s+([\d,\s\-–]+))?\s*\)$/);
  if (parenJustMatch) {
    const formulaPart = parenJustMatch[1].trim();
    const rulePart = parenJustMatch[2].trim();
    const linesPart = parenJustMatch[3];

    const canon = canonicalizeRule(rulePart);
    if (canon) {
      // For technique rules (CP/IP), preserve range format (1-7)
      if (canon.kind === "technique" && linesPart) {
        const normalized = linesPart.replace(/\s+/g, "").replace(/–/g, "-"); // normalize en-dash to hyphen
        return {
          justification: `${canon.canonical} ${normalized}`,
          formula: formulaPart,
        };
      }
      // For inference/equivalence rules, parse line numbers into comma-separated list
      else if ((canon.kind === "inference" || canon.kind === "equivalence") && linesPart) {
        const lines = linesPart
          .split(/[\s,]+/)
          .map((s) => s.replace(/[-–]/g, "")) // remove dashes
          .map((s) => parseInt(s, 10))
          .filter((n) => !isNaN(n));
        return {
          justification: `${canon.canonical} ${lines.join(",")}`,
          formula: formulaPart,
        };
      }
      // Rule with no line numbers (e.g., equivalence rules)
      else if (!linesPart) {
        return {
          justification: canon.canonical,
          formula: formulaPart,
        };
      }
    }
  }

  // Strip trailing parenthetical groups that are NOT justifications (e.g., noise)
  while (/\s*\([^)]*\)\s*$/.test(cleaned)) {
    cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  // Pattern A: "... RULE LINES" at end (rule then line numbers)
  // Try 3-word, 2-word, then 1-word rule names
  for (const wordCount of [3, 2, 1]) {
    const rulePattern = wordCount === 1
      ? /\s+(\S+)\s+(\d[\d,\s]*\d|\d)$/
      : wordCount === 2
      ? /\s+(\S+\s+\S+)\s+(\d[\d,\s]*\d|\d)$/
      : /\s+(\S+\s+\S+\s+\S+)\s+(\d[\d,\s]*\d|\d)$/;

    const match = cleaned.match(rulePattern);
    if (match) {
      const rulePart = match[1].trim();
      const linesPart = match[2];
      const canon = canonicalizeRule(rulePart);
      if (canon && (canon.kind === "inference" || canon.kind === "equivalence")) {
        const formulaPart = cleaned.slice(0, cleaned.length - match[0].length).trim();
        const lines = linesPart
          .split(/[\s,]+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => !isNaN(n));
        return {
          justification: `${canon.canonical} ${lines.join(",")}`,
          formula: formulaPart,
        };
      }
    }
  }

  // Pattern B: "... LINES RULE" at end (line numbers then rule)
  for (const wordCount of [3, 2, 1]) {
    const linesPattern = wordCount === 1
      ? /\s+(\d[\d,\s]*\d|\d)\s+(\S+)$/
      : wordCount === 2
      ? /\s+(\d[\d,\s]*\d|\d)\s+(\S+\s+\S+)$/
      : /\s+(\d[\d,\s]*\d|\d)\s+(\S+\s+\S+\s+\S+)$/;

    const match = cleaned.match(linesPattern);
    if (match) {
      const linesPart = match[1];
      const rulePart = match[2].trim();
      const canon = canonicalizeRule(rulePart);
      if (canon && (canon.kind === "inference" || canon.kind === "equivalence")) {
        const formulaPart = cleaned.slice(0, cleaned.length - match[0].length).trim();
        const lines = linesPart
          .split(/[\s,]+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => !isNaN(n));
        return {
          justification: `${canon.canonical} ${lines.join(",")}`,
          formula: formulaPart,
        };
      }
    }
  }

  // Pattern C: Just "RULE N" at end (single line ref, try multi-word names too)
  for (const wordCount of [3, 2, 1]) {
    const singlePattern = wordCount === 1
      ? /\s+(\S+)\s+(\d+)$/
      : wordCount === 2
      ? /\s+(\S+\s+\S+)\s+(\d+)$/
      : /\s+(\S+\s+\S+\s+\S+)\s+(\d+)$/;

    const match = cleaned.match(singlePattern);
    if (match) {
      const rulePart = match[1].trim();
      const lineNum = match[2];
      const canon = canonicalizeRule(rulePart);
      if (canon && (canon.kind === "inference" || canon.kind === "equivalence")) {
        const formulaPart = cleaned.slice(0, cleaned.length - match[0].length).trim();
        return {
          justification: `${canon.canonical} ${lineNum}`,
          formula: formulaPart,
        };
      }
    }
  }

  // Pattern D: Just "RULE" at end (no line numbers, for equivalence rules)
  for (const wordCount of [3, 2, 1]) {
    const ruleOnlyPattern = wordCount === 1
      ? /\s+(\S+)$/
      : wordCount === 2
      ? /\s+(\S+\s+\S+)$/
      : /\s+(\S+\s+\S+\s+\S+)$/;

    const match = cleaned.match(ruleOnlyPattern);
    if (match) {
      const rulePart = match[1].trim();
      const canon = canonicalizeRule(rulePart);
      if (canon && canon.kind === "equivalence") {
        const formulaPart = cleaned.slice(0, cleaned.length - match[0].length).trim();
        return {
          justification: canon.canonical,
          formula: formulaPart,
        };
      }
    }
  }

  return null;
}

// ─── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a raw LLM proof output into structured proof lines.
 *
 * @param rawOutput  The full text response from the LLM
 * @param theorem    The theorem being proved (used for context)
 * @returns          ParseResult with parsed lines, errors, and unparsed sections
 */
export function parseProof(rawOutput: string, theorem: Theorem): ParseResult {
  const lines: ParsedLine[] = [];
  const errors: ParseError[] = [];
  const unparsedSections: string[] = [];

  // Split into lines and filter out blanks / commentary
  const rawLines = rawOutput.split("\n");

  // Detect base indentation level from the first numbered line
  let baseIndent = 0;
  let indentUnit = 2; // default: 2 spaces per depth level
  let firstNumberedFound = false;

  // Pre-scan to detect indentation unit
  const indents: number[] = [];
  for (const raw of rawLines) {
    const stripped = raw.trimEnd();
    if (!stripped) continue;
    const { rest: afterMarkers } = stripSubproofMarkers(stripped);
    const { lineNumber } = stripLineNumber(afterMarkers.trimStart());
    if (lineNumber !== null) {
      const indent = measureIndent(stripped);
      indents.push(indent);
      if (!firstNumberedFound) {
        baseIndent = indent;
        firstNumberedFound = true;
      }
    }
  }

  // Determine indentation unit from the minimum non-zero difference
  if (indents.length > 1) {
    const uniqueIndents = [...new Set(indents)].sort((a, b) => a - b);
    if (uniqueIndents.length > 1) {
      const minDiff = uniqueIndents[1] - uniqueIndents[0];
      if (minDiff > 0) {
        indentUnit = minDiff;
      }
    }
  }

  let autoLineNumber = 1;
  let inProofBlock = false;

  for (const rawLine of rawLines) {
    const stripped = rawLine.trimEnd().replace(/`/g, "");

    // Skip empty lines
    if (!stripped.trim()) continue;

    // Skip common LLM commentary markers
    if (isCommentary(stripped.trim())) {
      if (inProofBlock) {
        // If we were in the proof, this might be trailing commentary
        continue;
      }
      unparsedSections.push(stripped);
      continue;
    }

    // Detect subproof markers (|, │)
    const { depth: markerDepth, rest: afterMarkers } =
      stripSubproofMarkers(stripped);

    // Measure indentation-based depth
    const indent = measureIndent(stripped);
    const indentDepth = Math.max(
      0,
      Math.round((indent - baseIndent) / indentUnit)
    );

    // Use marker depth if present, otherwise indentation depth
    const depth = markerDepth > 0 ? markerDepth : indentDepth;

    // Strip line number
    const { lineNumber, rest: afterLineNum } = stripLineNumber(
      afterMarkers.trimStart()
    );

    // If we can't find a line number AND the line doesn't look like proof
    // content, skip it
    if (lineNumber === null && !looksLikeProofLine(afterLineNum)) {
      unparsedSections.push(stripped);
      continue;
    }

    inProofBlock = true;

    // Parse the formula + justification
    const parsed = parseJustification(afterLineNum.trim());

    if (parsed) {
      const effectiveLineNum = lineNumber ?? autoLineNumber;
      lines.push({
        line_number: effectiveLineNum,
        formula: normalizeFormula(parsed.formula),
        justification: parsed.justification,
        depth,
        raw: rawLine,
      });
      autoLineNumber = effectiveLineNum + 1;
    } else {
      // Could not parse justification — record as error
      errors.push({
        line_number: lineNumber ?? autoLineNumber,
        raw: rawLine,
        message: `Could not parse justification from: "${afterLineNum.trim()}"`,
      });
      autoLineNumber = (lineNumber ?? autoLineNumber) + 1;
    }
  }

  // ── Post-processing: infer formulas for bare CP/IP lines ──
  // Process in order so earlier inferred formulas are available for later ones
  // (handles nested bare CP/IP).
  for (const line of lines) {
    if (line.formula !== "") continue;

    const cpMatch = line.justification.match(/^CP\s+(\d+)-(\d+)$/);
    const ipMatch = line.justification.match(/^IP\s+(\d+)-(\d+)$/);

    if (cpMatch) {
      const startNum = parseInt(cpMatch[1], 10);
      const endNum = parseInt(cpMatch[2], 10);
      const assumptionLine = lines.find((l) => l.line_number === startNum);
      const lastLine = lines.find((l) => l.line_number === endNum);
      if (assumptionLine && lastLine) {
        line.formula = normalizeFormula(
          `(${assumptionLine.formula}) > (${lastLine.formula})`
        );
      }
    } else if (ipMatch) {
      const startNum = parseInt(ipMatch[1], 10);
      const assumptionLine = lines.find((l) => l.line_number === startNum);
      if (assumptionLine) {
        line.formula = normalizeFormula(`~(${assumptionLine.formula})`);
      }
    }
  }

  // ── DW-1: Reconstruct subproof depth from CP/IP annotations ──
  // Whitespace-based depth detection is unreliable because LLM output has
  // inconsistent indentation.  CP/IP justification annotations are always
  // present in tautology proofs and encode the subproof structure exactly:
  //   - "Assumption (CP)" / "Assumption (IP)" opens a new subproof  (depth++)
  //   - "CP N-M" / "IP N-M" closes the most recent subproof        (depth--)
  //   - Everything else stays at the current depth
  // This pass overrides the earlier whitespace-based depth values.
  {
    let currentDepth = 0;
    for (const line of lines) {
      if (
        line.justification === "Assumption (CP)" ||
        line.justification === "Assumption (IP)"
      ) {
        currentDepth++;
        line.depth = currentDepth;
      } else if (/^(?:CP|IP)\s+\d+-\d+$/.test(line.justification)) {
        line.depth = Math.max(0, currentDepth - 1);
        currentDepth = Math.max(0, currentDepth - 1);
      } else {
        line.depth = currentDepth;
      }
    }
  }

  return { lines, errors, unparsed_sections: unparsedSections };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a line looks like LLM commentary rather than proof content.
 */
function isCommentary(line: string): boolean {
  const lower = line.toLowerCase();
  // Common LLM preamble/postscript patterns
  if (lower.startsWith("proof:")) return true;
  if (lower.startsWith("here is")) return true;
  if (lower.startsWith("here's")) return true;
  if (lower.startsWith("the proof")) return true;
  if (lower.startsWith("let me")) return true;
  if (lower.startsWith("i will")) return true;
  if (lower.startsWith("i'll")) return true;
  if (lower.startsWith("we need")) return true;
  if (lower.startsWith("we can")) return true;
  if (lower.startsWith("note:")) return true;
  if (lower.startsWith("note that")) return true;
  if (lower.startsWith("explanation")) return true;
  if (lower.startsWith("therefore")) return true;
  if (lower.startsWith("thus")) return true;
  if (lower.startsWith("qed")) return true;
  if (lower.startsWith("∎")) return true;
  if (lower.startsWith("//")) return true;
  if (lower.startsWith("/*")) return true;
  if (lower.startsWith("```")) return true;
  if (lower.startsWith("--")) return true;
  if (lower.startsWith("wait")) return true;
  if (lower.startsWith("let's")) return true;
  if (lower.startsWith("it looks like")) return true;
  if (lower.startsWith("this is")) return true;
  if (lower.startsWith("let me")) return true;
  if (line.startsWith("─") || line.startsWith("—"))
    return true;
  if (lower.startsWith("now ")) return true;
  if (lower.startsWith("next")) return true;
  if (lower.startsWith("first")) return true;
  if (lower.startsWith("then")) return true;
  if (lower.startsWith("so ")) return true;
  if (lower.startsWith("since")) return true;
  if (lower.startsWith("because")) return true;
  if (lower.startsWith("using")) return true;
  if (lower.startsWith("applying")) return true;
  if (lower.startsWith("from ")) return true;
  if (lower.startsWith("to ")) return true;
  if (lower.startsWith("by ")) return true;
  if (lower.startsWith("finally")) return true;
  if (lower.startsWith("we should")) return true;
  if (lower.startsWith("we must")) return true;
  if (lower.startsWith("to prove")) return true;
  return false;
}

/**
 * Check if a line looks like it could be proof content
 * (contains logical symbols, rule names, or line references).
 */
function looksLikeProofLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Contains logical symbols
  if (/[>v.~⊃∨·¬≡⊥∧→↔#]/.test(trimmed)) return true;
  // Contains a rule name (abbreviation or full name)
  if (/\b(MP|MT|DS|Simp|Conj|HS|Add|CD|NegE|DN|DeM|Comm|Assoc|Dist|Contra|Impl|Exp|Taut|Equiv|CP|IP|Premise|Assumption|Modus Ponens|Modus Tollens|Disjunctive Syllogism|Simplification|Conjunction|Hypothetical Syllogism|Addition|Constructive Dilemma|Negation Elimination|Double Negation|DeMorgan|Commutation|Association|Distribution|Contraposition|Implication|Exportation|Tautology|Equivalence|Conditional Proof|Indirect Proof)\b/i.test(trimmed)) return true;
  // Contains uppercase single letters (atom names)
  if (/\b[A-Z]\b/.test(trimmed)) return true;
  return false;
}

// ─── CLI validation format ──────────────────────────────────────────────────

/**
 * Convert parsed proof lines into the JSON format expected by the
 * `propbench validate` CLI command.
 */
export function toValidationJSON(
  theorem: Theorem,
  parsed: ParseResult
): string {
  const proofLines = parsed.lines.map((line) => ({
    line_number: line.line_number,
    formula: line.formula,
    justification: line.justification,
    depth: line.depth,
  }));

  const payload = {
    theorem: {
      id: theorem.id,
      premises: theorem.premises,
      conclusion: theorem.conclusion,
      difficulty: theorem.difficulty,
      difficulty_value: theorem.difficulty_value,
    },
    proof: proofLines,
  };

  return JSON.stringify(payload, null, 2);
}
