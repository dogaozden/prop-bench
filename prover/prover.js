#!/usr/bin/env node
// PropBench Natural Deduction Theorem Prover
// Proves propositional tautologies using Fitch-style natural deduction

const fs = require('fs');
const { execSync } = require('child_process');

// ========== TOKENIZER ==========
function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { tokens.push({ type: 'LPAREN', value: ch }); i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { tokens.push({ type: 'RPAREN', value: ch }); i++; continue; }
    if (ch === '~') { tokens.push({ type: 'NOT', value: '~' }); i++; continue; }
    if (ch === '.') { tokens.push({ type: 'AND', value: '.' }); i++; continue; }
    if (ch === 'v' && (i + 1 >= str.length || !str[i+1].match(/[A-Za-z]/))) {
      tokens.push({ type: 'OR', value: 'v' }); i++; continue;
    }
    if (ch === '>') { tokens.push({ type: 'COND', value: '>' }); i++; continue; }
    if (ch >= 'A' && ch <= 'Z') { tokens.push({ type: 'ATOM', value: ch }); i++; continue; }
    // Handle lowercase 'v' as atom if followed by letter (shouldn't happen but just in case)
    if (ch >= 'a' && ch <= 'z') { tokens.push({ type: 'ATOM', value: ch.toUpperCase() }); i++; continue; }
    throw new Error(`Unexpected character '${ch}' at position ${i} in: ...${str.substring(Math.max(0,i-10), i+10)}...`);
  }
  return tokens;
}

// ========== PARSER ==========
// Grammar (precedence low to high):
//   expr     → cond
//   cond     → disj ('>' disj)*          (right-associative)
//   disj     → conj ('v' conj)*          (left-associative)
//   conj     → unary ('.' unary)*        (left-associative)
//   unary    → '~' unary | primary
//   primary  → ATOM | '(' expr ')'

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.pos < this.tokens.length ? this.tokens[this.pos] : null; }
  consume(type) {
    const t = this.tokens[this.pos];
    if (!t || t.type !== type) throw new Error(`Expected ${type}, got ${t ? t.type : 'EOF'} at pos ${this.pos}`);
    this.pos++;
    return t;
  }

  parse() {
    const result = this.expr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token ${this.tokens[this.pos].type} at pos ${this.pos}`);
    }
    return result;
  }

  expr() { return this.cond(); }

  cond() {
    let left = this.disj();
    while (this.peek() && this.peek().type === 'COND') {
      this.consume('COND');
      const right = this.disj();
      left = { type: 'cond', left, right };
    }
    return left;
  }

  disj() {
    let left = this.conj();
    while (this.peek() && this.peek().type === 'OR') {
      this.consume('OR');
      const right = this.conj();
      left = { type: 'or', left, right };
    }
    return left;
  }

  conj() {
    let left = this.unary();
    while (this.peek() && this.peek().type === 'AND') {
      this.consume('AND');
      const right = this.unary();
      left = { type: 'and', left, right };
    }
    return left;
  }

  unary() {
    if (this.peek() && this.peek().type === 'NOT') {
      this.consume('NOT');
      const operand = this.unary();
      return { type: 'not', operand };
    }
    return this.primary();
  }

  primary() {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of input');
    if (t.type === 'ATOM') {
      this.consume('ATOM');
      return { type: 'atom', name: t.value };
    }
    if (t.type === 'LPAREN') {
      this.consume('LPAREN');
      const inner = this.expr();
      this.consume('RPAREN');
      return inner;
    }
    throw new Error(`Unexpected token ${t.type} '${t.value}' at pos ${this.pos}`);
  }
}

function parseFormula(str) {
  const tokens = tokenize(str);
  const parser = new Parser(tokens);
  return parser.parse();
}

// ========== AST UTILITIES ==========
function formulaToString(ast) {
  if (!ast) return '???';
  switch (ast.type) {
    case 'atom': return ast.name;
    case 'not': {
      if (ast.operand.type === 'atom') return `~${ast.operand.name}`;
      if (ast.operand.type === 'not') return `~${formulaToString(ast.operand)}`;
      return `~(${formulaToString(ast.operand)})`;
    }
    case 'and': case 'or': case 'cond': {
      const op = ast.type === 'and' ? ' . ' : ast.type === 'or' ? ' v ' : ' > ';
      const l = needsParens(ast.left) ? `(${formulaToString(ast.left)})` : formulaToString(ast.left);
      const r = needsParens(ast.right) ? `(${formulaToString(ast.right)})` : formulaToString(ast.right);
      return `${l}${op}${r}`;
    }
    default: return '???';
  }
}

// Always parenthesize compound (binary) sub-expressions to ensure the Rust parser
// reconstructs the exact same AST structure
function needsParens(child) {
  return child.type === 'and' || child.type === 'or' || child.type === 'cond';
}

function astEqual(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'atom') return a.name === b.name;
  if (a.type === 'not') return astEqual(a.operand, b.operand);
  return astEqual(a.left, b.left) && astEqual(a.right, b.right);
}

function astSize(ast) {
  if (ast.type === 'atom') return 1;
  if (ast.type === 'not') return 1 + astSize(ast.operand);
  return 1 + astSize(ast.left) + astSize(ast.right);
}

function getAtoms(ast) {
  const atoms = new Set();
  function walk(node) {
    if (node.type === 'atom') atoms.add(node.name);
    else if (node.type === 'not') walk(node.operand);
    else { walk(node.left); walk(node.right); }
  }
  walk(ast);
  return [...atoms].sort();
}

// ========== EVALUATOR ==========
function evaluate(ast, assignment) {
  switch (ast.type) {
    case 'atom': return assignment[ast.name];
    case 'not': return !evaluate(ast.operand, assignment);
    case 'and': return evaluate(ast.left, assignment) && evaluate(ast.right, assignment);
    case 'or': return evaluate(ast.left, assignment) || evaluate(ast.right, assignment);
    case 'cond': return !evaluate(ast.left, assignment) || evaluate(ast.right, assignment);
    default: throw new Error(`Unknown type ${ast.type}`);
  }
}

function isTautology(ast) {
  const atoms = getAtoms(ast);
  const n = atoms.length;
  for (let i = 0; i < (1 << n); i++) {
    const assignment = {};
    for (let j = 0; j < n; j++) {
      assignment[atoms[j]] = !!(i & (1 << j));
    }
    if (!evaluate(ast, assignment)) return false;
  }
  return true;
}

// ========== PROOF GENERATOR ==========
// Uses truth-table method with case splitting on variables.
// Under a complete assignment, derives each subformula (if true) or its negation (if false).

class ProofBuilder {
  constructor() {
    this.lines = [];
    this.currentDepth = 0;
    this.lineNumber = 0;
    // Scope-based memoization: stack of Maps, one per active scope
    // Each map: formulaString_T/F → line number
    this.scopeStack = [new Map()]; // Start with global scope
  }

  cacheKey(ast, positive) {
    return `${formulaToString(ast)}_${positive ? 'T' : 'F'}`;
  }

  getDerived(ast, positive) {
    const key = this.cacheKey(ast, positive);
    // Search from innermost scope to outermost
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].has(key)) return this.scopeStack[i].get(key);
    }
    return null;
  }

  setDerived(ast, positive, lineNum) {
    const key = this.cacheKey(ast, positive);
    // Always cache in the current (innermost) scope
    this.scopeStack[this.scopeStack.length - 1].set(key, lineNum);
  }

  addLine(ast, justification) {
    this.lineNumber++;
    const entry = {
      line_number: this.lineNumber,
      formula: formulaToString(ast),
      justification: justification,
      depth: this.currentDepth,
      ast: ast
    };
    this.lines.push(entry);
    return this.lineNumber;
  }

  openSubproof(ast, technique) {
    this.currentDepth++;
    this.scopeStack.push(new Map()); // New scope for this subproof
    return this.addLine(ast, `Assumption (${technique})`);
  }

  closeSubproof(ast, technique, startLine) {
    this.scopeStack.pop(); // Discard this subproof's scope
    this.currentDepth--;
    return this.addLine(ast, `${technique} ${startLine}-${this.lineNumber}`);
  }

  // Derive the formula (if positive=true) or its negation (if positive=false)
  // under the current set of assumptions.
  // Returns the line number where the result was derived.
  derive(ast, positive, assignment) {
    // Check if already derived
    const cached = this.getDerived(ast, positive);
    if (cached !== null) return cached;

    let lineNum;

    switch (ast.type) {
      case 'atom':
        // Should already be in assumptions
        throw new Error(`Atom ${ast.name} (${positive ? 'T' : 'F'}) not found in assumptions!`);

      case 'not':
        lineNum = this.deriveNot(ast, positive, assignment);
        break;

      case 'and':
        lineNum = this.deriveAnd(ast, positive, assignment);
        break;

      case 'or':
        lineNum = this.deriveOr(ast, positive, assignment);
        break;

      case 'cond':
        lineNum = this.deriveCond(ast, positive, assignment);
        break;

      default:
        throw new Error(`Unknown AST type: ${ast.type}`);
    }

    this.setDerived(ast, positive, lineNum);
    return lineNum;
  }

  deriveNot(ast, positive, assignment) {
    // ast = ~operand
    if (positive) {
      // We want to derive ~operand (it's true, so operand is false)
      // By IH, derive ~operand... which means derive(operand, false)
      // derive(operand, false) gives us ~operand. That's what we want!
      // Actually, derive(operand, false) gives us the negation of operand, which is ~operand.
      // But our derive function for operand with positive=false would return a line with ~operand.
      // We need to think about this more carefully.

      // If operand evaluates to false under assignment:
      // derive(operand, false) returns a line with formula ~operand
      // But wait - that's only true for atoms. For compound formulas, the "negation" we derive
      // might be ~(compound). Let me rethink.

      // Actually, derive(ast, positive) should:
      //   if positive: derive ast itself (as a line in the proof)
      //   if not positive: derive ~ast (as a line in the proof)

      // So for ast = ~operand, positive=true:
      //   We want to derive ~operand.
      //   Since operand is false (because ~operand is true):
      //   derive(operand, false) gives us a line with ~operand.
      //   That's exactly what we want! ~operand IS ast.

      const negLine = this.derive(ast.operand, false, assignment);
      // The line at negLine has formula ~operand = ast
      // We need to check: does derive(operand, false) actually produce ~operand?
      // For an atom X with X=false: we have ~X as assumption. derive(X, false) returns that line.
      //   That line's formula is ~X. ✓
      // For compound operand: derive(operand, false) produces ~operand. ✓

      // But we need the line's formula to be exactly ast (= ~operand).
      // If derive(operand, false) produces a line whose formula is ~(operand), that IS ~operand = ast.
      // However, the line might use a different representation...

      // Actually, the issue is: derive(operand, false) might produce ~operand in a different form.
      // For example, if operand = A . B and it's false, derive might produce ~A v ~B (DeM)
      // rather than ~(A . B).

      // Hmm, I need to be more careful. Let me restructure:
      // derive(ast, positive=true) → produces a proof line whose formula IS ast
      // derive(ast, positive=false) → produces a proof line whose formula IS ~ast

      // For ast = ~operand, positive=true:
      //   I need a line with formula ~operand
      //   Since ~operand is true, operand is false
      //   If I derive(operand, false), I get a line with ~operand ← that's what I want!
      return this.derive(ast.operand, false, assignment);
    } else {
      // We want to derive ~(~operand) = ~~operand
      // Since ~operand is false, operand is true
      // derive(operand, true) gives us operand
      // Then DN: operand → ~~operand
      const posLine = this.derive(ast.operand, true, assignment);
      // Apply DN: operand → ~~operand
      const result = { type: 'not', operand: { type: 'not', operand: ast.operand } };
      return this.addLine(result, `DN ${posLine}`);
    }
  }

  deriveAnd(ast, positive, assignment) {
    // ast = left . right
    if (positive) {
      // Both left and right are true
      const leftLine = this.derive(ast.left, true, assignment);
      const rightLine = this.derive(ast.right, true, assignment);
      return this.addLine(ast, `Conj ${leftLine},${rightLine}`);
    } else {
      // At least one is false. Derive ~(left . right)
      const leftVal = evaluate(ast.left, assignment);
      const rightVal = evaluate(ast.right, assignment);

      if (!leftVal) {
        // left is false, derive ~left
        const negLeftLine = this.derive(ast.left, false, assignment);
        // Add: ~left → ~left v ~right
        const addResult = { type: 'or', left: { type: 'not', operand: ast.left }, right: { type: 'not', operand: ast.right } };
        const addLine = this.addLine(addResult, `Add ${negLeftLine}`);
        // DeM: ~left v ~right → ~(left . right)
        const demResult = { type: 'not', operand: ast };
        return this.addLine(demResult, `DeM ${addLine}`);
      } else {
        // right is false, derive ~right
        const negRightLine = this.derive(ast.right, false, assignment);
        // Add: ~right → ~right v ~left
        const addResult1 = { type: 'or', left: { type: 'not', operand: ast.right }, right: { type: 'not', operand: ast.left } };
        const addLine = this.addLine(addResult1, `Add ${negRightLine}`);
        // Comm: ~right v ~left → ~left v ~right
        const commResult = { type: 'or', left: { type: 'not', operand: ast.left }, right: { type: 'not', operand: ast.right } };
        const commLine = this.addLine(commResult, `Comm ${addLine}`);
        // DeM: ~left v ~right → ~(left . right)
        const demResult = { type: 'not', operand: ast };
        return this.addLine(demResult, `DeM ${commLine}`);
      }
    }
  }

  deriveOr(ast, positive, assignment) {
    // ast = left v right
    if (positive) {
      const leftVal = evaluate(ast.left, assignment);
      if (leftVal) {
        // left is true, derive left, then Add
        const leftLine = this.derive(ast.left, true, assignment);
        return this.addLine(ast, `Add ${leftLine}`);
      } else {
        // right is true, derive right, then Add + Comm
        const rightLine = this.derive(ast.right, true, assignment);
        const addResult = { type: 'or', left: ast.right, right: ast.left };
        const addLine = this.addLine(addResult, `Add ${rightLine}`);
        return this.addLine(ast, `Comm ${addLine}`);
      }
    } else {
      // Both are false. Derive ~left and ~right, Conj, DeM
      const negLeftLine = this.derive(ast.left, false, assignment);
      const negRightLine = this.derive(ast.right, false, assignment);
      const conjResult = { type: 'and', left: { type: 'not', operand: ast.left }, right: { type: 'not', operand: ast.right } };
      const conjLine = this.addLine(conjResult, `Conj ${negLeftLine},${negRightLine}`);
      const demResult = { type: 'not', operand: ast };
      return this.addLine(demResult, `DeM ${conjLine}`);
    }
  }

  deriveCond(ast, positive, assignment) {
    // ast = left > right
    if (positive) {
      const leftVal = evaluate(ast.left, assignment);

      if (!leftVal) {
        // left is false: ~left → ~left v right → left > right
        const negLeftLine = this.derive(ast.left, false, assignment);
        const addResult = { type: 'or', left: { type: 'not', operand: ast.left }, right: ast.right };
        const addLine = this.addLine(addResult, `Add ${negLeftLine}`);
        return this.addLine(ast, `Impl ${addLine}`);
      } else {
        // right is true: right → right v ~left → ~left v right → left > right
        const rightLine = this.derive(ast.right, true, assignment);
        const addResult = { type: 'or', left: ast.right, right: { type: 'not', operand: ast.left } };
        const addLine = this.addLine(addResult, `Add ${rightLine}`);
        const commResult = { type: 'or', left: { type: 'not', operand: ast.left }, right: ast.right };
        const commLine = this.addLine(commResult, `Comm ${addLine}`);
        return this.addLine(ast, `Impl ${commLine}`);
      }
    } else {
      // left=true, right=false. Need ~(left > right)
      // Use IP: assume (left > right), derive contradiction, conclude ~(left > right)
      const leftLine = this.derive(ast.left, true, assignment);
      const negRightLine = this.derive(ast.right, false, assignment);

      // Assume left > right (for IP)
      const assumeLine = this.openSubproof(ast, 'IP');

      // MP: left, left > right → right
      const rightLine = this.addLine(ast.right, `MP ${leftLine},${assumeLine}`);

      // Contradiction: right . ~right
      const contradiction = { type: 'and', left: ast.right, right: { type: 'not', operand: ast.right } };
      const contLine = this.addLine(contradiction, `Conj ${rightLine},${negRightLine}`);

      // Close IP: ~(left > right)
      const negCond = { type: 'not', operand: ast };
      return this.closeSubproof(negCond, 'IP', assumeLine);
    }
  }

  // Prove the formula using case analysis on the given variables
  proveByTruthTable(formula, atoms) {
    if (atoms.length === 0) {
      throw new Error("No atoms to case-split on");
    }

    // First, establish X v ~X for each variable
    const excludedMiddleLines = {};
    for (const atom of atoms) {
      excludedMiddleLines[atom] = this.proveExcludedMiddle(atom);
    }

    // Now do nested case analysis
    return this.caseSplit(formula, atoms, 0, {}, excludedMiddleLines);
  }

  proveExcludedMiddle(atomName) {
    // Prove X v ~X by IP
    const atomAst = { type: 'atom', name: atomName };
    const xOrNotX = { type: 'or', left: atomAst, right: { type: 'not', operand: atomAst } };
    const negXOrNotX = { type: 'not', operand: xOrNotX };

    // Assume ~(X v ~X)
    const assumeLine = this.openSubproof(negXOrNotX, 'IP');

    // DeM: ~(X v ~X) → ~X . ~~X
    const demResult = { type: 'and', left: { type: 'not', operand: atomAst }, right: { type: 'not', operand: { type: 'not', operand: atomAst } } };
    const demLine = this.addLine(demResult, `DeM ${assumeLine}`);

    // Simp: ~X
    const negX = { type: 'not', operand: atomAst };
    const simpLine1 = this.addLine(negX, `Simp ${demLine}`);

    // Simp: ~~X
    const negNegX = { type: 'not', operand: { type: 'not', operand: atomAst } };
    const simpLine2 = this.addLine(negNegX, `Simp ${demLine}`);

    // Conj for the contradiction: ~X . ~~X
    const contradiction = { type: 'and', left: negX, right: negNegX };
    const conjLine = this.addLine(contradiction, `Conj ${simpLine1},${simpLine2}`);

    // Close IP: X v ~X
    return this.closeSubproof(xOrNotX, 'IP', assumeLine);
  }

  caseSplit(formula, atoms, atomIndex, assignment, excludedMiddleLines) {
    if (atomIndex === atoms.length) {
      // All variables assigned - derive the formula directly
      return this.derive(formula, true, assignment);
    }

    const atom = atoms[atomIndex];
    const atomAst = { type: 'atom', name: atom };
    const emLine = excludedMiddleLines[atom];

    // Case 1: Assume atom = true
    const assumeTrueLine = this.openSubproof(atomAst, 'CP');
    this.setDerived(atomAst, true, assumeTrueLine);

    const trueResult = this.caseSplit(formula, atoms, atomIndex + 1, { ...assignment, [atom]: true }, excludedMiddleLines);

    // Close CP: atom > formula
    const cpTrue = { type: 'cond', left: atomAst, right: formula };
    const cpTrueLine = this.closeSubproof(cpTrue, 'CP', assumeTrueLine);

    // Case 2: Assume atom = false (~atom)
    const negAtom = { type: 'not', operand: atomAst };
    const assumeFalseLine = this.openSubproof(negAtom, 'CP');
    this.setDerived(atomAst, false, assumeFalseLine);

    const falseResult = this.caseSplit(formula, atoms, atomIndex + 1, { ...assignment, [atom]: false }, excludedMiddleLines);

    // Close CP: ~atom > formula
    const cpFalse = { type: 'cond', left: negAtom, right: formula };
    const cpFalseLine = this.closeSubproof(cpFalse, 'CP', assumeFalseLine);

    // CD: (atom v ~atom), (atom > formula), (~atom > formula) → formula v formula
    const formulaOrFormula = { type: 'or', left: formula, right: formula };
    const cdLine = this.addLine(formulaOrFormula, `CD ${emLine},${cpTrueLine},${cpFalseLine}`);

    // Taut: formula v formula → formula
    return this.addLine(formula, `Taut ${cdLine}`);
  }

  toJSON() {
    return this.lines.map(l => ({
      line_number: l.line_number,
      formula: l.formula,
      justification: l.justification,
      depth: l.depth
    }));
  }
}

// ========== MAIN ==========
async function main() {
  // Read the theorem
  const theoremPath = process.argv[2] || '/Users/dogaozden/Dev/test/prop-bench/benchmarks/Claudy-test/theorems.json';
  const theorems = JSON.parse(fs.readFileSync(theoremPath, 'utf8'));
  const theorem = theorems[0];

  console.log(`Theorem ID: ${theorem.id}`);
  console.log(`Difficulty: ${theorem.difficulty} (${theorem.difficulty_value})`);
  console.log(`Conclusion length: ${theorem.conclusion.length} characters`);

  // Parse
  console.log('\nParsing formula...');
  const ast = parseFormula(theorem.conclusion);
  console.log(`AST size: ${astSize(ast)} nodes`);
  console.log(`Top-level type: ${ast.type}`);

  const atoms = getAtoms(ast);
  console.log(`Variables: ${atoms.join(', ')} (${atoms.length} total)`);

  // Verify it's a tautology
  console.log('\nVerifying tautology (2^' + atoms.length + ' = ' + (1 << atoms.length) + ' assignments)...');
  const startVerify = Date.now();
  const isTaut = isTautology(ast);
  console.log(`Tautology: ${isTaut} (${Date.now() - startVerify}ms)`);

  if (!isTaut) {
    console.error('ERROR: Formula is NOT a tautology!');
    process.exit(1);
  }

  // Generate proof
  console.log('\nGenerating proof...');
  const startProof = Date.now();
  const builder = new ProofBuilder();
  builder.proveByTruthTable(ast, atoms);
  console.log(`Proof generated: ${builder.lineNumber} lines (${Date.now() - startProof}ms)`);

  // Write proof JSON
  const proofJson = builder.toJSON();
  const proofPath = '/Users/dogaozden/Dev/test/prop-bench/Claude-test/proof.json';
  fs.writeFileSync(proofPath, JSON.stringify(proofJson, null, 2));
  console.log(`Proof written to ${proofPath}`);

  // Write theorem as single-theorem JSON for validator
  const theoremForValidator = {
    id: theorem.id,
    premises: theorem.premises || [],
    conclusion: theorem.conclusion,
    difficulty: theorem.difficulty,
    difficulty_value: theorem.difficulty_value
  };
  const singleTheoremPath = '/Users/dogaozden/Dev/test/prop-bench/Claude-test/theorem.json';
  fs.writeFileSync(singleTheoremPath, JSON.stringify(theoremForValidator, null, 2));

  // Validate
  console.log('\nValidating proof...');
  try {
    const result = execSync(
      `/Users/dogaozden/Dev/test/prop-bench/target/release/propbench validate --theorem ${singleTheoremPath} --proof ${proofPath}`,
      { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
    );
    console.log('Validation result:');
    console.log(result);
  } catch (e) {
    console.error('Validation failed:');
    console.error(e.stdout || e.message);
    console.error(e.stderr || '');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
