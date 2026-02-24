// PropBench — Shared types and benchmark configuration

// ─── Theorem types ──────────────────────────────────────────────────────────

export interface Theorem {
  id: string;
  premises: string[];
  conclusion: string;
  difficulty: Difficulty;
  difficulty_value: number; // 1-100
  difficulty_spec?: DifficultySpec;
}

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

// ─── DifficultySpec types ─────────────────────────────────────────────────

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
}

// ─── Proof types ────────────────────────────────────────────────────────────

export interface ProofLine {
  line_number: number;
  formula: string;
  justification: string; // e.g. "Assumption (CP)", "MP 1,2", "CP 3-7"
  depth: number; // subproof nesting depth (0 = top level)
}

export interface ProofResult {
  valid: boolean;
  line_count: number;
  errors: string[];
}

// ─── Benchmark result types ─────────────────────────────────────────────────

export interface BenchmarkResult {
  theorem_id: string;
  model: string;
  proof_lines: ProofLine[];
  result: ProofResult;
  raw_response: string;
  raw_prompt: string;
  parse_errors: string[];
  timestamp: string; // ISO 8601
  latency_ms: number;
}

export interface BenchmarkSummary {
  model: string;
  total_theorems: number;
  valid_proofs: number;
  invalid_proofs: number;
  parse_failures: number;
  total_lines: number; // sum of line_count for valid proofs
  average_lines: number;
  results: BenchmarkResult[];
}

// ─── Model configuration ───────────────────────────────────────────────────

export interface ModelConfig {
  name: string;
  provider: "gemini" | "openrouter";
  model_id: string;
  api_key_env: string; // environment variable name for the API key
  temperature: number;
  max_tokens: number;
}

// ─── Difficulty distribution ────────────────────────────────────────────────

export interface DifficultyDistribution {
  easy: number;    // count of Easy theorems (difficulty 1-25)
  medium: number;  // count of Medium theorems (difficulty 26-45)
  hard: number;    // count of Hard theorems (difficulty 46-70)
  expert: number;  // count of Expert theorems (difficulty 71-85)
  nightmare: number; // count of Nightmare theorems (difficulty 86-100)
}

// ─── Parse result types ─────────────────────────────────────────────────────

export interface ParsedLine {
  line_number: number;
  formula: string;
  justification: string;
  depth: number;
  raw: string; // original unparsed line
}

export interface ParseResult {
  lines: ParsedLine[];
  errors: ParseError[];
  unparsed_sections: string[];
}

export interface ParseError {
  line_number: number | null; // null if we can't determine which line
  raw: string;
  message: string;
}

// ─── Default benchmark parameters ──────────────────────────────────────────

export const DEFAULT_DISTRIBUTION: DifficultyDistribution = {
  easy: 30,
  medium: 30,
  hard: 20,
  expert: 15,
  nightmare: 5,
};

export const DEFAULT_TOTAL_THEOREMS = 100;

// ─── Difficulty value ranges ────────────────────────────────────────────────

export function difficultyFromValue(value: number): Difficulty {
  if (value <= 25) return "Easy";
  if (value <= 45) return "Medium";
  if (value <= 70) return "Hard";
  if (value <= 85) return "Expert";
  if (value <= 95) return "Nightmare";
  return "Marathon";
}

export function difficultyRange(
  difficulty: Difficulty
): { min: number; max: number } {
  switch (difficulty) {
    case "Easy":
      return { min: 1, max: 25 };
    case "Medium":
      return { min: 26, max: 45 };
    case "Hard":
      return { min: 46, max: 70 };
    case "Expert":
      return { min: 71, max: 85 };
    case "Nightmare":
      return { min: 86, max: 95 };
    case "Marathon":
      return { min: 96, max: 100 };
    case "Absurd":
    case "Cosmic":
    case "Mind":
    case "Custom":
      return { min: 100, max: 100 };
  }
}
