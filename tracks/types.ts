import type { ProofLine } from "../config";
export type { ProofLine } from "../config";

export const RUN_SCHEMA = "propbench-run-v1" as const;
export const SCORER_VERSION = "efficiency-v2" as const;
export type Track = "frontier" | "unaided";
export type Mode = "fresh" | "cumulative" | "unaided";
export interface Budget {
  wall_seconds: number;
  max_generations: number;
  max_output_tokens: number;
  max_thinking_tokens: number;
}
export interface SubscriptionSettings {
  effort: string;
  max_tool_calls: number;
}
export type Provider = "openrouter" | "gemini" | "fixture" | "external" | "claude-subscription" | "codex-subscription";
export const isSubscriptionProvider = (provider: string): provider is "claude-subscription" | "codex-subscription" =>
  provider === "claude-subscription" || provider === "codex-subscription";
export interface Theorem {
  id: string;
  premises: string[];
  conclusion: string;
  difficulty: string;
  difficulty_value: number;
  [key: string]: unknown;
}
export interface SetItem { id: string; par: number; theorem_sha256: string; theorem: Theorem }
export interface BenchmarkSet {
  version: string;
  core_tag: string;
  hash: string;
  items: SetItem[];
}
export interface RunConfig {
  schema_version: typeof RUN_SCHEMA;
  scorer_version: typeof SCORER_VERSION;
  run_id: string;
  track: Track;
  mode: Mode;
  model: string;
  provider: Provider;
  execution_protocol: "unaided-v1" | "frontier-controller-v1" | "external-mcp-v1" | "unaided-subscription-v1" | "frontier-subscription-v1" | "frontier-subscription-v2";
  subscription?: SubscriptionSettings;
  temperature: number;
  budget: Budget;
  starting_snapshot: string | null;
  set_version: string;
  set_hash: string;
  selected_ids: string[];
  core_tag: string;
  validator_sha256: string;
  rulebook_sha256: string;
  evaluator_hash: string;
  created_at: string;
}
export interface RunContext { dir: string; config: RunConfig; set: BenchmarkSet }
export interface PrepareOptions {
  root: string;
  setDir: string;
  ids?: string[];
  track: Track;
  mode: Mode;
  model: string;
  provider: RunConfig["provider"];
  temperature: number;
  budget: Budget;
  startingSnapshot?: string;
  validator: string;
  subscription?: SubscriptionSettings;
}
export type Outcome = "valid" | "invalid" | "parse_error" | "transport_error" | "protocol_error" | "missing" | "interrupted";
export interface Verdict { status: Outcome; line_count: number | null; errors: string[] }
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}
export interface AttemptRecord {
  item_id: string;
  attempt: number;
  started_at: string;
  completed_at?: string;
  request: unknown;
  response?: unknown;
  raw_response?: string;
  proof?: ProofLine[];
  verdict?: Verdict;
  usage?: Usage;
  transport_error?: string;
  model?: string;
  backend?: string;
  dispatch_state?: "not_started" | "dispatched" | "response_confirmed" | "uncertain";
}
export interface ScoredItem extends Verdict { id: string; par: number; loss: number }
export interface RunReport {
  schema_version: "propbench-report-v1";
  config: RunConfig;
  cohort: string;
  graded_at: string;
  score: number;
  valid_count: number;
  total: number;
  valid_rate: number;
  total_lines: number;
  mean_valid_lines: number | null;
  items: ScoredItem[];
  usage: Usage;
  /** Generation attempts, not a claim about remote billing after transport loss. */
  generations: number | null;
  usage_coverage: { attempts_with_usage: number; attempts: number };
  execution_commands: number | null;
  elapsed_seconds: number | null;
  evidence: "fixture" | "provider" | "external-submission" | "subscription";
  client_sessions?: number;
  contestant_rejection?: string;
  evaluation_status: "complete" | "unexecuted" | "external-unmetered" | "interrupted";
  returned_models: string[];
  returned_backends: string[];
  dispatches: { not_started: number; dispatched: number; response_confirmed: number; uncertain: number };
  regraded_by: string;
  runtime: { backend: "docker"; image_id: string; architecture: string } | null;
}
