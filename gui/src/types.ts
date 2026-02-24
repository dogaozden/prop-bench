// PropBench GUI — Shared types
// Mirrors the types from ../../config.ts and ../../scorer.ts for GUI usage.

export type Difficulty =
  | "Baby"
  | "Easy"
  | "Medium"
  | "Hard"
  | "Expert"
  | "Nightmare"
  | "Marathon"
  | "Absurd"
  | "Cosmic"
  | "Mind"
  | "Custom";

export type DifficultyTier =
  | "baby"
  | "easy"
  | "medium"
  | "hard"
  | "expert"
  | "nightmare"
  | "marathon"
  | "absurd"
  | "cosmic"
  | "mind";

export type BaseComplexity = "simple" | "complex";

export interface DifficultySpec {
  variables: number;
  passes: number;
  transforms_per_pass: number;
  base_complexity: BaseComplexity;
  substitution_depth: number;
  bridge_atoms?: number;
  max_formula_nodes?: number;
  max_formula_depth?: number;
  gnarly_combos?: boolean;
}

export interface Theorem {
  id: string;
  premises: string[];
  conclusion: string;
  difficulty: Difficulty;
  difficulty_value: number;
  difficulty_spec?: DifficultySpec;
}

export interface ProofLine {
  line_number: number;
  formula: string;
  justification: string;
  depth: number;
}

export interface ProofResult {
  valid: boolean;
  line_count: number;
  errors: string[];
}

export interface BenchmarkResult {
  theorem_id: string;
  model: string;
  proof_lines: ProofLine[];
  result: ProofResult;
  raw_response: string;
  raw_prompt: string;
  parse_errors: string[];
  timestamp: string;
  latency_ms: number;
}

export interface TheoremResult {
  theoremId: string;
  valid: boolean;
  parseSuccess: boolean;
  lineCount: number | null;
  difficulty: DifficultyTier;
  difficultyValue: number;
  failureStage?: "api_call" | "parse" | "validation";
}

export interface ModelStats {
  model: string;
  totalLines: number;
  validCount: number;
  invalidCount: number;
  totalAttempted: number;
  avgLinesPerValidProof: number | null;
  linesByDifficulty: Record<
    DifficultyTier,
    {
      total: number;
      count: number;
      avg: number | null;
      attempted: number;
      valid: number;
      invalid: number;
    }
  >;
  eloRating: number;
}

export interface HeadToHead {
  theoremId: string;
  modelA: string;
  modelB: string;
  winner: string | "tie";
  modelALines: number | null;
  modelBLines: number | null;
}

/** Convert prompt-style formula notation to standard logic display symbols */
export function toDisplayNotation(formula: string): string {
  return formula
    .replace(/#/g, "⊥")
    .replace(/ <> /g, " ≡ ")
    .replace(/ > /g, " ⊃ ")
    .replace(/ \. /g, " · ")
    .replace(/ v /g, " ∨ ");
}

export interface BenchmarkReport {
  timestamp: string;
  models: ModelStats[];
  headToHead: HeadToHead[];
  perTheorem: Record<string, Record<string, TheoremResult>>;
  rankings: {
    rank: number;
    model: string;
    eloRating: number;
    totalLines: number;
    validRate: string;
  }[];
}
