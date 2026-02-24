// PropBench GUI — API client
// Typed wrapper around the backend API endpoints.

import type { Theorem, ProofLine, DifficultySpec } from "../types";

const BASE = "/api";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types used by the API client
// ---------------------------------------------------------------------------

export interface GenerateOpts {
  count: number;
  name: string;
  distribution?: string;   // legacy distribution mode
  tier?: string;            // tier preset mode
  spec?: DifficultySpec;    // custom spec mode
  maxNodes?: number;        // max AST node count for obfuscation pipeline
  maxDepth?: number;        // max formula nesting depth for obfuscation pipeline
  gnarlyCombos?: boolean;   // explicit gnarly combos override
}

export interface GenerateResult {
  success: boolean;
  path: string;
  theorems: Theorem[];
}

export interface TheoremSetInfo {
  name: string;
  path: string;
  count: number;
}

export interface ValidateResult {
  valid: boolean;
  line_count: number;
  errors: string[];
}

export interface StartBenchmarkOpts {
  theoremSet: string;
  models: string[];
  temperature: number;
  maxTokens: number;
  maxThinkingTokens?: number;
  workers?: number;
  start?: number;
  count?: number;
  force?: boolean;
  noRetryParse?: boolean;
  retryApiErrors?: boolean;
  runs?: number;
  continueRunId?: number;
  maxCost?: number;
  tierBudgetsEnabled?: boolean;
  tierBudgets?: Record<string, number>;
}

export interface RunInfo {
  runId: string;
  timestamp: string | null;
  models: string[];
  stats: {
    total_run: number;
    total_valid: number;
    total_invalid: number;
    total_errors: number;
    total_parse_errors: number;
    total_api_errors: number;
  };
}

export interface RunDetail {
  summary: Record<string, unknown>;
  results: Record<string, unknown>[];
}

export interface DashboardOverview {
  totalSets: number;
  totalTheorems: number;
  totalResults: number;
  totalModels: number;
  modelSummaries: Array<{
    model_slug: string;
    model_display: string;
    total_attempted: number;
    total_valid: number;
    total_invalid: number;
    total_errors: number;
    valid_rate: number;
    avg_latency_ms: number;
    avg_lines: number | null;
    total_tokens: number;
  }>;
  sets: Array<{
    name: string;
    theorem_count: number;
    result_count: number;
    models: string[];
  }>;
}

export interface HeadToHeadCell {
  modelA: string;
  modelB: string;
  winsA: number;
  winsB: number;
  ties: number;
  total: number;
}

export interface LatencyStats {
  model_slug: string;
  model_display: string;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  p50_ms: number;
  total_tokens: number;
  avg_tokens: number;
}

export interface FailureAnalysis {
  model_slug: string;
  model_display: string;
  total: number;
  valid: number;
  parse_failures: number;
  validation_failures: number;
  api_errors: number;
}

export interface AvgLinesByDifficulty {
  model_slug: string;
  model_display: string;
  difficulty: string;
  avg_lines: number;
  count: number;
}

export interface SetOverview {
  totalTheorems: number;
  totalResults: number;
  totalModels: number;
  modelSummaries: Array<{
    model_slug: string;
    model_display: string;
    total_attempted: number;
    total_valid: number;
    total_invalid: number;
    total_parse_errors: number;
    total_api_errors: number;
    valid_rate: number;
    avg_latency_ms: number;
    avg_lines: number | null;
    total_tokens: number;
    run_count: number;
    valid_run_count: number;
  }>;
}

export interface HardestTheorem {
  theorem_id: string;
  difficulty: string;
  difficulty_value: number;
  attempts: number;
  valid_count: number;
  success_rate: number;
}

export interface IndividualRun {
  runId: number;
  setName: string;
  modelSlug: string;
  modelDisplay: string;
  temperature: number;
  maxTokens: number;
  startedAt: string;
  finishedAt: string | null;
  status?: "Running" | "Finished" | "Finished with API Errors" | "Incomplete";
  stats: {
    total: number;
    valid: number;
    invalid: number;
    errors: number;
    parseErrors: number;
    apiErrors: number;
  };
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export const api = {
  /** Generate a new theorem set */
  generate(opts: GenerateOpts): Promise<GenerateResult> {
    return json<GenerateResult>("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  },

  /** List all available theorem sets */
  getTheoremSets(): Promise<TheoremSetInfo[]> {
    return json<TheoremSetInfo[]>("/theorem-sets");
  },

  /** Get all theorems in a theorem set */
  getTheorems(name: string): Promise<Theorem[]> {
    return json<Theorem[]>(`/theorem-sets/${encodeURIComponent(name)}`);
  },

  /** Delete a theorem set (DB + files) */
  deleteTheoremSet(name: string): Promise<{ success: boolean }> {
    return json<{ success: boolean }>(`/theorem-sets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },

  /** Validate a proof against a theorem */
  validate(theorem: Theorem, proof: ProofLine[]): Promise<ValidateResult> {
    return json<ValidateResult>("/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theorem, proof }),
    });
  },

  /** Start a benchmark run, returns a runId */
  startBenchmark(opts: StartBenchmarkOpts): Promise<{ runId: string }> {
    return json<{ runId: string }>("/benchmark/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  },

  /** Get an SSE EventSource for live benchmark progress */
  getBenchmarkStatus(runId: string): EventSource {
    return new EventSource(`${BASE}/benchmark/status/${encodeURIComponent(runId)}`);
  },

  /** Check for active (in-progress) benchmark runs */
  getActiveBenchmarks(): Promise<{ runIds: string[] }> {
    return json<{ runIds: string[] }>("/benchmark/active");
  },

  /** Stop a running benchmark */
  async stopBenchmark(runId: string): Promise<void> {
    await json<{ success: boolean }>(`/benchmark/stop/${encodeURIComponent(runId)}`, {
      method: "POST",
    });
  },

  /** List all past benchmark runs */
  getRuns(): Promise<RunInfo[]> {
    return json<RunInfo[]>("/runs");
  },

  /** Get full details for a specific run */
  getRun(runId: string): Promise<RunDetail> {
    return json<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
  },

  /** Force-finish a stale "Running" run */
  async finishRun(runId: number): Promise<void> {
    await json<{ success: boolean }>(`/runs/finish/${runId}`, {
      method: "POST",
    });
  },

  /** Delete a benchmark run's results */
  async deleteRun(runId: string): Promise<void> {
    await json<{ success: boolean }>(`/runs/${encodeURIComponent(runId)}`, {
      method: "DELETE",
    });
  },

  /** Get dashboard overview stats */
  getDashboardOverview(): Promise<DashboardOverview> {
    return json<DashboardOverview>("/runs/stats/overview");
  },

  /** Get head-to-head comparison matrix for a theorem set */
  getHeadToHead(setName: string): Promise<HeadToHeadCell[]> {
    return json<HeadToHeadCell[]>(`/runs/stats/head-to-head/${encodeURIComponent(setName)}`);
  },

  /** Get latency statistics, optionally filtered by set */
  getLatencyStats(setName?: string): Promise<LatencyStats[]> {
    const path = setName
      ? `/runs/stats/latency/${encodeURIComponent(setName)}`
      : "/runs/stats/latency";
    return json<LatencyStats[]>(path);
  },

  /** Get avg lines by difficulty, optionally filtered by set */
  getAvgLinesByDifficulty(setName?: string): Promise<AvgLinesByDifficulty[]> {
    const path = setName
      ? `/runs/stats/avg-lines-by-difficulty/${encodeURIComponent(setName)}`
      : "/runs/stats/avg-lines-by-difficulty";
    return json<AvgLinesByDifficulty[]>(path);
  },

  /** Get per-set overview stats */
  getSetOverview(setName: string): Promise<SetOverview> {
    return json<SetOverview>(`/runs/stats/set-overview/${encodeURIComponent(setName)}`);
  },

  /** Get hardest theorems for a set */
  getHardestTheorems(setName: string): Promise<HardestTheorem[]> {
    return json<HardestTheorem[]>(`/runs/stats/hardest-theorems/${encodeURIComponent(setName)}`);
  },

  /** Get failure analysis, optionally filtered by set */
  getFailureAnalysis(setName?: string): Promise<FailureAnalysis[]> {
    const path = setName
      ? `/runs/stats/failures/${encodeURIComponent(setName)}`
      : "/runs/stats/failures";
    return json<FailureAnalysis[]>(path);
  },

  /** Get individual runs, optionally filtered by set */
  getIndividualRuns(setName?: string): Promise<IndividualRun[]> {
    const path = setName
      ? `/runs/individual/${encodeURIComponent(setName)}`
      : "/runs/individual";
    return json<IndividualRun[]>(path);
  },

  /** Get the full result rows for a specific individual run */
  getIndividualRunDetail(runId: number): Promise<Record<string, unknown>[]> {
    return json<Record<string, unknown>[]>(`/runs/individual/detail/${runId}`);
  },

  /** Get tier presets */
  getTierPresets(): Promise<Record<string, DifficultySpec>> {
    return json<Record<string, DifficultySpec>>("/tier-presets");
  },

  /** Save tier presets */
  saveTierPresets(presets: Record<string, DifficultySpec>): Promise<{ success: boolean }> {
    return json<{ success: boolean }>("/tier-presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(presets),
    });
  },
};
