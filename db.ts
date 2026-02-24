/**
 * PropBench SQLite Database Module
 *
 * Single propbench.db file using better-sqlite3 with WAL mode.
 * CJS module — imported by harness (CJS) directly and by GUI server (ESM) via createRequire.
 */

import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { Scorer } from "./scorer";
import type { TheoremResult, DifficultyTier, BenchmarkReport } from "./scorer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors harness.ts BenchmarkResult */
export interface BenchmarkResult {
  theorem_id: string;
  model: string;
  model_name: string;
  raw_response: string;
  parsed_proof: { line_number: number; formula: string; justification: string; depth: number }[] | null;
  parse_error: string | null;
  validation_result: "valid" | "invalid" | "error";
  validation_errors: string[];
  line_count: number | null;
  latency_ms: number;
  tokens_used: number | undefined;
  thinking_tokens?: number;
  finish_reason?: string;
  timestamp: string;
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

export interface TheoremRow {
  theorem_id: string;
  premises: string;
  conclusion: string;
  difficulty: string;
  difficulty_value: number;
}

// ---------------------------------------------------------------------------
// Database path & singleton
// ---------------------------------------------------------------------------

export const DB_PATH = path.join(__dirname, "propbench.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function dbExists(): boolean {
  return fs.existsSync(DB_PATH);
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS theorem_sets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      theorems_file TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS theorems (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id           INTEGER NOT NULL REFERENCES theorem_sets(id) ON DELETE CASCADE,
      theorem_id       TEXT NOT NULL,
      premises         TEXT NOT NULL DEFAULT '[]',
      conclusion       TEXT NOT NULL,
      difficulty       TEXT NOT NULL,
      difficulty_value INTEGER NOT NULL,
      UNIQUE(set_id, theorem_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id     INTEGER NOT NULL REFERENCES theorem_sets(id) ON DELETE CASCADE,
      model_slug TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.2,
      max_tokens  INTEGER NOT NULL DEFAULT 4096,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS results (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id            INTEGER NOT NULL REFERENCES theorem_sets(id) ON DELETE CASCADE,
      theorem_id        TEXT NOT NULL,
      model_slug        TEXT NOT NULL,
      model_display     TEXT NOT NULL,
      run_id            INTEGER REFERENCES runs(id) ON DELETE CASCADE,
      raw_response      TEXT NOT NULL DEFAULT '',
      parsed_proof      TEXT,
      parse_error       TEXT,
      validation_result TEXT NOT NULL CHECK(validation_result IN ('valid','invalid','error')),
      validation_errors TEXT NOT NULL DEFAULT '[]',
      line_count        INTEGER,
      latency_ms        INTEGER NOT NULL DEFAULT 0,
      tokens_used       INTEGER,
      finish_reason     TEXT,
      timestamp         TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (set_id, theorem_id) REFERENCES theorems(set_id, theorem_id)
    );

    CREATE INDEX IF NOT EXISTS idx_results_set_model   ON results(set_id, model_slug);
    CREATE INDEX IF NOT EXISTS idx_results_set_theorem  ON results(set_id, theorem_id);
  `);

  // Migration: add finish_reason column if missing
  try {
    db.exec(`ALTER TABLE results ADD COLUMN finish_reason TEXT`);
  } catch { /* column already exists */ }

  // Migration: add run_id column if missing
  try {
    db.exec(`ALTER TABLE results ADD COLUMN run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE`);
  } catch { /* column already exists */ }

  // Create run_id index (must be after migration that adds the column)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id)`);

  // Migration: add temperature column if missing
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN temperature REAL NOT NULL DEFAULT 0.2`);
  } catch { /* column already exists */ }

  // Migration: add max_tokens column if missing
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 4096`);
  } catch { /* column already exists */ }

  // Migration: add thinking_tokens column if missing
  try {
    db.exec(`ALTER TABLE results ADD COLUMN thinking_tokens INTEGER`);
  } catch { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id     INTEGER NOT NULL REFERENCES theorem_sets(id) ON DELETE CASCADE,
      scope      TEXT NOT NULL,
      report     TEXT NOT NULL,
      summary    TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(set_id, scope)
    );
  `);
}

// ---------------------------------------------------------------------------
// Theorem sets & theorems
// ---------------------------------------------------------------------------

export function upsertTheoremSet(name: string, theoremsFile?: string): number {
  const db = getDb();

  const insertStmt = db.prepare(`
    INSERT INTO theorem_sets (name, theorems_file)
    VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET theorems_file = COALESCE(excluded.theorems_file, theorems_file)
  `);
  insertStmt.run(name, theoremsFile ?? null);

  const row = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(name) as { id: number };
  return row.id;
}

export function upsertTheorem(
  setId: number,
  theorem: {
    id: string;
    premises: string[];
    conclusion: string;
    difficulty: string;
    difficulty_value: number;
  }
): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO theorems (set_id, theorem_id, premises, conclusion, difficulty, difficulty_value)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(set_id, theorem_id) DO UPDATE SET
      premises = excluded.premises,
      conclusion = excluded.conclusion,
      difficulty = excluded.difficulty,
      difficulty_value = excluded.difficulty_value
  `);

  stmt.run(
    setId,
    theorem.id,
    JSON.stringify(theorem.premises),
    theorem.conclusion,
    theorem.difficulty,
    theorem.difficulty_value
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function insertResult(setName: string, result: BenchmarkResult, runId?: number): void {
  const db = getDb();

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) {
    throw new Error(`Theorem set '${setName}' not found in DB`);
  }

  // Delete previous error results for this theorem/model in the SAME run so retries replace them
  if (runId != null) {
    db.prepare(`
      DELETE FROM results
      WHERE set_id = ? AND theorem_id = ? AND model_slug = ? AND validation_result = 'error' AND run_id = ?
    `).run(setRow.id, result.theorem_id, result.model, runId);
  } else {
    db.prepare(`
      DELETE FROM results
      WHERE set_id = ? AND theorem_id = ? AND model_slug = ? AND validation_result = 'error' AND run_id IS NULL
    `).run(setRow.id, result.theorem_id, result.model);
  }

  const stmt = db.prepare(`
    INSERT INTO results (
      set_id, theorem_id, model_slug, model_display, run_id,
      raw_response, parsed_proof, parse_error,
      validation_result, validation_errors,
      line_count, latency_ms, tokens_used, thinking_tokens, finish_reason, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    setRow.id,
    result.theorem_id,
    result.model,
    result.model_name,
    runId ?? null,
    result.raw_response,
    result.parsed_proof ? JSON.stringify(result.parsed_proof) : null,
    result.parse_error,
    result.validation_result,
    JSON.stringify(result.validation_errors),
    result.line_count,
    result.latency_ms,
    result.tokens_used ?? null,
    result.thinking_tokens ?? null,
    result.finish_reason ?? null,
    result.timestamp
  );
}

export function hasResult(setName: string, theoremId: string, modelSlug: string): boolean {
  const db = getDb();

  const row = db.prepare(`
    SELECT 1 FROM results r
    JOIN theorem_sets ts ON ts.id = r.set_id
    WHERE ts.name = ? AND r.theorem_id = ? AND r.model_slug = ?
    LIMIT 1
  `).get(setName, theoremId, modelSlug);

  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Runs management
// ---------------------------------------------------------------------------

export function createRun(setName: string, modelSlug: string, temperature: number, maxTokens: number): number {
  const db = getDb();

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) {
    throw new Error(`Theorem set '${setName}' not found in DB`);
  }

  const stmt = db.prepare(`
    INSERT INTO runs (set_id, model_slug, temperature, max_tokens)
    VALUES (?, ?, ?, ?)
  `);

  const info = stmt.run(setRow.id, modelSlug, temperature, maxTokens);
  return info.lastInsertRowid as number;
}

/** Find the most recent run for a set+model, or create a new one. */
export function findOrCreateRun(setName: string, modelSlug: string, temperature: number, maxTokens: number): number {
  const db = getDb();

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) {
    throw new Error(`Theorem set '${setName}' not found in DB`);
  }

  const existing = db.prepare(`
    SELECT id FROM runs
    WHERE set_id = ? AND model_slug = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(setRow.id, modelSlug) as { id: number } | undefined;

  if (existing) {
    // Reset finished_at so it shows as "Running" again
    db.prepare("UPDATE runs SET finished_at = NULL WHERE id = ?").run(existing.id);
    return existing.id;
  }

  return createRun(setName, modelSlug, temperature, maxTokens);
}

export function getRunSettings(runId: number): { setName: string; modelSlug: string; temperature: number; maxTokens: number; setId: number } | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT ts.name AS set_name, runs.model_slug, runs.temperature, runs.max_tokens, runs.set_id
    FROM runs
    JOIN theorem_sets ts ON ts.id = runs.set_id
    WHERE runs.id = ?
  `).get(runId) as { set_name: string; model_slug: string; temperature: number; max_tokens: number; set_id: number } | undefined;

  if (!row) return null;

  return {
    setName: row.set_name,
    modelSlug: row.model_slug,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    setId: row.set_id,
  };
}

export function getRunCompletedTheorems(runId: number): Set<string> {
  const db = getDb();

  const rows = db.prepare(`
    SELECT DISTINCT theorem_id FROM results WHERE run_id = ?
  `).all(runId) as Array<{ theorem_id: string }>;

  return new Set(rows.map((r) => r.theorem_id));
}

export function getIndividualRunDetail(runId: number): Array<{
  _id: number;
  theorem_id: string;
  model: string;
  model_name: string;
  raw_response: string;
  parsed_proof: { line_number: number; formula: string; justification: string; depth: number }[] | null;
  parse_error: string | null;
  validation_result: string;
  validation_errors: string[];
  line_count: number | null;
  latency_ms: number;
  tokens_used: number | undefined;
  thinking_tokens: number | undefined;
  finish_reason: string | undefined;
  timestamp: string;
}> {
  const db = getDb();

  const rawResults = db.prepare(`
    SELECT id, theorem_id, model_slug, model_display, raw_response, parsed_proof,
           parse_error, validation_result, validation_errors, line_count,
           latency_ms, tokens_used, thinking_tokens, finish_reason, timestamp
    FROM results
    WHERE run_id = ?
    ORDER BY theorem_id
  `).all(runId) as Array<{
    id: number;
    theorem_id: string;
    model_slug: string;
    model_display: string;
    raw_response: string;
    parsed_proof: string | null;
    parse_error: string | null;
    validation_result: string;
    validation_errors: string;
    line_count: number | null;
    latency_ms: number;
    tokens_used: number | null;
    thinking_tokens: number | null;
    finish_reason: string | null;
    timestamp: string;
  }>;

  return rawResults.map((r) => ({
    _id: r.id,
    theorem_id: r.theorem_id,
    model: r.model_slug,
    model_name: r.model_display,
    raw_response: r.raw_response,
    parsed_proof: r.parsed_proof ? JSON.parse(r.parsed_proof) : null,
    parse_error: r.parse_error,
    validation_result: r.validation_result,
    validation_errors: JSON.parse(r.validation_errors),
    line_count: r.line_count,
    latency_ms: r.latency_ms,
    tokens_used: r.tokens_used ?? undefined,
    thinking_tokens: r.thinking_tokens ?? undefined,
    finish_reason: r.finish_reason ?? undefined,
    timestamp: r.timestamp,
  }));
}

export function deleteApiErrorResults(runId: number): number {
  const db = getDb();
  const info = db.prepare(`
    DELETE FROM results
    WHERE run_id = ? AND validation_result = 'error' AND parse_error IS NULL
  `).run(runId);
  return info.changes;
}

export function resetRunFinished(runId: number): void {
  const db = getDb();
  db.prepare("UPDATE runs SET finished_at = NULL WHERE id = ?").run(runId);
}

export function finishRun(runId: number): void {
  const db = getDb();

  db.prepare(`
    UPDATE runs
    SET finished_at = datetime('now')
    WHERE id = ?
  `).run(runId);
}

export function getIndividualRuns(setName?: string): Array<{
  runId: number;
  setName: string;
  modelSlug: string;
  modelDisplay: string;
  temperature: number;
  maxTokens: number;
  startedAt: string;
  finishedAt: string | null;
  status: "Running" | "Finished" | "Finished with API Errors" | "Incomplete";
  stats: { total: number; valid: number; invalid: number; errors: number; parseErrors: number; apiErrors: number; };
}> {
  const db = getDb();

  let setFilter = "";
  const params: unknown[] = [];

  if (setName) {
    const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
    if (!setRow) return [];
    setFilter = "WHERE runs.set_id = ?";
    params.push(setRow.id);
  }

  const rows = db.prepare(`
    SELECT
      runs.id AS run_id,
      ts.name AS set_name,
      runs.model_slug,
      runs.temperature,
      runs.max_tokens,
      runs.started_at,
      runs.finished_at,
      COALESCE(r.model_display, '') AS model_display,
      COALESCE(COUNT(r.id), 0) AS total,
      COALESCE(SUM(CASE WHEN r.validation_result = 'valid' THEN 1 ELSE 0 END), 0) AS valid,
      COALESCE(SUM(CASE WHEN r.validation_result = 'invalid' THEN 1 ELSE 0 END), 0) AS invalid,
      COALESCE(SUM(CASE WHEN r.validation_result = 'error' THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS parse_errors,
      COALESCE(SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NULL THEN 1 ELSE 0 END), 0) AS api_errors,
      (SELECT COUNT(*) FROM theorems WHERE theorems.set_id = runs.set_id) AS theorem_count
    FROM runs
    JOIN theorem_sets ts ON ts.id = runs.set_id
    LEFT JOIN results r ON r.run_id = runs.id
    ${setFilter}
    GROUP BY runs.id, ts.name, runs.model_slug, runs.temperature, runs.max_tokens, runs.started_at, runs.finished_at
    ORDER BY runs.started_at DESC
  `).all(...params) as Array<{
    run_id: number;
    set_name: string;
    model_slug: string;
    temperature: number;
    max_tokens: number;
    model_display: string;
    started_at: string;
    finished_at: string | null;
    total: number;
    valid: number;
    invalid: number;
    errors: number;
    parse_errors: number;
    api_errors: number;
    theorem_count: number;
  }>;

  return rows.map((row) => {
    let status: "Running" | "Finished" | "Finished with API Errors" | "Incomplete";
    if (row.finished_at === null) {
      status = "Running";
    } else if (row.total >= row.theorem_count && row.api_errors > 0) {
      status = "Finished with API Errors";
    } else if (row.total >= row.theorem_count) {
      status = "Finished";
    } else {
      status = "Incomplete";
    }

    return {
      runId: row.run_id,
      setName: row.set_name,
      modelSlug: row.model_slug,
      modelDisplay: row.model_display || row.model_slug,
      temperature: row.temperature,
      maxTokens: row.max_tokens,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status,
      stats: {
        total: row.total,
        valid: row.valid,
        invalid: row.invalid,
        errors: row.errors,
        parseErrors: row.parse_errors,
        apiErrors: row.api_errors,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Queries (server)
// ---------------------------------------------------------------------------

export function getRunsList(): RunInfo[] {
  const db = getDb();

  // Get per-model runs
  // Use MAX(model_display) to pick a non-empty display name (empty string sorts before real names)
  // Split errors into parse errors (parse_error IS NOT NULL) and API errors (parse_error IS NULL)
  const modelRuns = db.prepare(`
    SELECT
      ts.name AS set_name,
      r.model_slug,
      MAX(r.model_display) AS model_display,
      MAX(r.timestamp) AS latest_timestamp,
      COUNT(*) AS total_run,
      SUM(CASE WHEN r.validation_result = 'valid' THEN 1 ELSE 0 END) AS total_valid,
      SUM(CASE WHEN r.validation_result = 'invalid' THEN 1 ELSE 0 END) AS total_invalid,
      SUM(CASE WHEN r.validation_result = 'error' THEN 1 ELSE 0 END) AS total_errors,
      SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NOT NULL THEN 1 ELSE 0 END) AS total_parse_errors,
      SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NULL THEN 1 ELSE 0 END) AS total_api_errors
    FROM results r
    JOIN theorem_sets ts ON ts.id = r.set_id
    GROUP BY ts.name, r.model_slug
    ORDER BY ts.name, r.model_slug
  `).all() as Array<{
    set_name: string;
    model_slug: string;
    model_display: string;
    latest_timestamp: string;
    total_run: number;
    total_valid: number;
    total_invalid: number;
    total_errors: number;
    total_parse_errors: number;
    total_api_errors: number;
  }>;

  // Get combined set-level runs
  const setRuns = db.prepare(`
    SELECT
      ts.name AS set_name,
      MAX(r.timestamp) AS latest_timestamp,
      COUNT(*) AS total_run,
      SUM(CASE WHEN r.validation_result = 'valid' THEN 1 ELSE 0 END) AS total_valid,
      SUM(CASE WHEN r.validation_result = 'invalid' THEN 1 ELSE 0 END) AS total_invalid,
      SUM(CASE WHEN r.validation_result = 'error' THEN 1 ELSE 0 END) AS total_errors,
      SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NOT NULL THEN 1 ELSE 0 END) AS total_parse_errors,
      SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NULL THEN 1 ELSE 0 END) AS total_api_errors
    FROM results r
    JOIN theorem_sets ts ON ts.id = r.set_id
    GROUP BY ts.name
    HAVING COUNT(DISTINCT r.model_slug) > 0
    ORDER BY ts.name
  `).all() as Array<{
    set_name: string;
    latest_timestamp: string;
    total_run: number;
    total_valid: number;
    total_invalid: number;
    total_errors: number;
    total_parse_errors: number;
    total_api_errors: number;
  }>;

  // Get models per set for combined runs
  const modelsPerSet = db.prepare(`
    SELECT ts.name AS set_name, r.model_display
    FROM results r
    JOIN theorem_sets ts ON ts.id = r.set_id
    GROUP BY ts.name, r.model_display
    ORDER BY ts.name, r.model_display
  `).all() as Array<{ set_name: string; model_display: string }>;

  const modelsMap = new Map<string, string[]>();
  for (const row of modelsPerSet) {
    if (!modelsMap.has(row.set_name)) modelsMap.set(row.set_name, []);
    modelsMap.get(row.set_name)!.push(row.model_display);
  }

  const runs: RunInfo[] = [];

  // Add per-model runs
  for (const row of modelRuns) {
    runs.push({
      runId: `${row.set_name}/${row.model_slug}`,
      timestamp: row.latest_timestamp,
      models: [row.model_display],
      stats: {
        total_run: row.total_run,
        total_valid: row.total_valid,
        total_invalid: row.total_invalid,
        total_errors: row.total_errors,
        total_parse_errors: row.total_parse_errors,
        total_api_errors: row.total_api_errors,
      },
    });
  }

  // Add combined set-level runs
  for (const row of setRuns) {
    runs.push({
      runId: row.set_name,
      timestamp: row.latest_timestamp,
      models: modelsMap.get(row.set_name) ?? [],
      stats: {
        total_run: row.total_run,
        total_valid: row.total_valid,
        total_invalid: row.total_invalid,
        total_errors: row.total_errors,
        total_parse_errors: row.total_parse_errors,
        total_api_errors: row.total_api_errors,
      },
    });
  }

  return runs;
}

export function getRunDetail(runId: string): { summary: unknown; results: unknown[] } {
  const db = getDb();

  // Determine if this is a set-level or model-level run
  const parts = runId.split("/");
  const setName = parts[0];
  const modelSlug = parts.length > 1 ? parts.slice(1).join("/") : null;

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) {
    throw new Error(`Run '${runId}' not found`);
  }

  // Fetch results
  let rawResults: Array<{
    id: number;
    theorem_id: string;
    model_slug: string;
    model_display: string;
    raw_response: string;
    parsed_proof: string | null;
    parse_error: string | null;
    validation_result: string;
    validation_errors: string;
    line_count: number | null;
    latency_ms: number;
    tokens_used: number | null;
    finish_reason: string | null;
    timestamp: string;
  }>;

  if (modelSlug) {
    rawResults = db.prepare(`
      SELECT id, theorem_id, model_slug, model_display, raw_response, parsed_proof,
             parse_error, validation_result, validation_errors, line_count,
             latency_ms, tokens_used, finish_reason, timestamp
      FROM results
      WHERE set_id = ? AND model_slug = ?
      ORDER BY theorem_id
    `).all(setRow.id, modelSlug) as typeof rawResults;
  } else {
    rawResults = db.prepare(`
      WITH complete_runs AS (
        SELECT r2.id AS run_id
        FROM runs r2
        WHERE r2.finished_at IS NOT NULL
          AND (SELECT COUNT(*) FROM results WHERE results.run_id = r2.id)
              >= (SELECT COUNT(*) FROM theorems WHERE theorems.set_id = r2.set_id)
          AND (SELECT COUNT(*) FROM results
               WHERE results.run_id = r2.id
                 AND results.validation_result = 'error'
                 AND results.parse_error IS NULL) = 0
      )
      SELECT id, theorem_id, model_slug, model_display, raw_response, parsed_proof,
             parse_error, validation_result, validation_errors, line_count,
             latency_ms, tokens_used, finish_reason, timestamp
      FROM results
      WHERE set_id = ?
        AND (run_id IS NULL OR run_id IN (SELECT run_id FROM complete_runs))
      ORDER BY theorem_id, model_slug
    `).all(setRow.id) as typeof rawResults;
  }

  // Convert to BenchmarkResult shape
  const results = rawResults.map((r) => ({
    _id: r.id,
    theorem_id: r.theorem_id,
    model: r.model_slug,
    model_name: r.model_display,
    raw_response: r.raw_response,
    parsed_proof: r.parsed_proof ? JSON.parse(r.parsed_proof) : null,
    parse_error: r.parse_error,
    validation_result: r.validation_result,
    validation_errors: JSON.parse(r.validation_errors),
    line_count: r.line_count,
    latency_ms: r.latency_ms,
    tokens_used: r.tokens_used ?? undefined,
    finish_reason: r.finish_reason ?? undefined,
    timestamp: r.timestamp,
  }));

  // Always recompute report via Scorer to ensure it uses current scorer code
  // (caching would serve stale data when scorer.ts changes)
  const scope = modelSlug ?? "combined";
  const summary = computeReport(setRow.id, scope, results);
  return { summary, results };
}

function computeReport(setId: number, scope: string, results: unknown[]): unknown {
  const db = getDb();

  // Load theorems for difficulty info
  const theoremRows = db.prepare(`
    SELECT theorem_id, difficulty, difficulty_value FROM theorems WHERE set_id = ?
  `).all(setId) as Array<{ theorem_id: string; difficulty: string; difficulty_value: number }>;

  const theoremMap = new Map<string, { difficulty: string; difficultyValue: number }>();
  for (const t of theoremRows) {
    theoremMap.set(t.theorem_id, { difficulty: t.difficulty, difficultyValue: t.difficulty_value });
  }

  // Helper: convert a raw result to TheoremResult
  function toTheoremResult(raw: Record<string, unknown>): { modelDisplay: string; theoremResult: TheoremResult } {
    const theoremId = raw.theorem_id as string;
    const modelDisplay = raw.model_name as string;
    const validationResult = raw.validation_result as string;
    const parseError = raw.parse_error as string | null;
    const validationErrors = (raw.validation_errors as string[]) ?? [];
    const lineCount = raw.line_count as number | null;

    const theoremInfo = theoremMap.get(theoremId);
    const difficulty = (theoremInfo?.difficulty?.toLowerCase() ?? "medium") as DifficultyTier;
    const difficultyValue = theoremInfo?.difficultyValue ?? 0;

    const valid = validationResult === "valid";

    let failureStage: "api_call" | "parse" | "validation" | undefined;
    if (!valid) {
      if (parseError !== null) failureStage = "parse";
      else if (validationErrors.some((e) => typeof e === "string" && e.includes("API"))) failureStage = "api_call";
      else failureStage = "validation";
    }

    return {
      modelDisplay,
      theoremResult: {
        theoremId,
        valid,
        parseSuccess: parseError === null,
        lineCount,
        difficulty,
        difficultyValue,
        ...(failureStage !== undefined ? { failureStage } : {}),
      },
    };
  }

  // Deduplicate: keep latest (highest _id) per theorem_id::model_name for Elo/head-to-head
  const dedupMap = new Map<string, Record<string, unknown>>();
  for (const raw of results as Array<Record<string, unknown>>) {
    const key = `${raw.theorem_id}::${raw.model_name}`;
    const existing = dedupMap.get(key);
    if (!existing || (raw._id as number) > (existing._id as number)) {
      dedupMap.set(key, raw);
    }
  }

  // Feed only deduped results to scorer for Elo/head-to-head
  const scorer = new Scorer();
  for (const raw of dedupMap.values()) {
    const { modelDisplay, theoremResult } = toTheoremResult(raw);
    scorer.recordResult(theoremResult.theoremId, modelDisplay, theoremResult);
  }

  const report = scorer.generateReport() as BenchmarkReport;

  // Recompute model stats from ALL results (combined across runs)
  const allDiffTiers: DifficultyTier[] = [
    "baby", "easy", "medium", "hard", "expert", "nightmare", "marathon", "absurd", "cosmic", "mind",
  ];
  const modelAllStats = new Map<string, {
    totalAttempted: number;
    validCount: number;
    invalidCount: number;
    totalLines: number;
    byDiff: Record<string, { attempted: number; valid: number; invalid: number; total: number; count: number }>;
  }>();

  for (const raw of results as Array<Record<string, unknown>>) {
    const { modelDisplay, theoremResult } = toTheoremResult(raw);
    let stats = modelAllStats.get(modelDisplay);
    if (!stats) {
      stats = {
        totalAttempted: 0, validCount: 0, invalidCount: 0, totalLines: 0,
        byDiff: {},
      };
      for (const tier of allDiffTiers) {
        stats.byDiff[tier] = { attempted: 0, valid: 0, invalid: 0, total: 0, count: 0 };
      }
      modelAllStats.set(modelDisplay, stats);
    }

    stats.totalAttempted++;
    const tier = theoremResult.difficulty;
    const d = stats.byDiff[tier];
    d.attempted++;

    if (theoremResult.valid) {
      stats.validCount++;
      d.valid++;
      if (theoremResult.lineCount !== null) {
        stats.totalLines += theoremResult.lineCount;
        d.total += theoremResult.lineCount;
        d.count++;
      }
    } else {
      stats.invalidCount++;
      d.invalid++;
    }
  }

  // Overwrite model stats and rankings in the report with combined counts
  for (const ms of report.models) {
    const combined = modelAllStats.get(ms.model);
    if (!combined) continue;

    ms.totalAttempted = combined.totalAttempted;
    ms.validCount = combined.validCount;
    ms.invalidCount = combined.invalidCount;
    ms.totalLines = combined.totalLines;
    ms.avgLinesPerValidProof = combined.validCount > 0 ? combined.totalLines / combined.validCount : null;

    for (const tier of allDiffTiers) {
      const src = combined.byDiff[tier];
      ms.linesByDifficulty[tier as DifficultyTier] = {
        attempted: src.attempted,
        valid: src.valid,
        invalid: src.invalid,
        total: src.total,
        count: src.count,
        avg: src.count > 0 ? src.total / src.count : null,
      };
    }
  }

  // Update rankings validRate with combined counts
  for (const r of report.rankings) {
    const combined = modelAllStats.get(r.model);
    if (!combined) continue;
    r.validRate = combined.totalAttempted > 0
      ? `${((combined.validCount / combined.totalAttempted) * 100).toFixed(1)}%`
      : "0.0%";
  }

  return report;
}

export function deleteRun(runId: string): void {
  const db = getDb();

  const parts = runId.split("/");
  const setName = parts[0];
  const modelSlug = parts.length > 1 ? parts.slice(1).join("/") : null;

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) return;

  if (modelSlug) {
    db.prepare("DELETE FROM results WHERE set_id = ? AND model_slug = ?").run(setRow.id, modelSlug);
  } else {
    db.prepare("DELETE FROM results WHERE set_id = ?").run(setRow.id);
  }
}

export function deleteTheoremSet(setName: string): void {
  const db = getDb();
  db.prepare("DELETE FROM theorem_sets WHERE name = ?").run(setName);
}

// ---------------------------------------------------------------------------
// Report cache
// ---------------------------------------------------------------------------

export function getCachedReport(setId: number, scope: string): { report: unknown; summary: unknown } | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT report, summary FROM reports_cache
    WHERE set_id = ? AND scope = ?
  `).get(setId, scope) as { report: string; summary: string } | undefined;

  if (!row) return null;

  return {
    report: JSON.parse(row.report),
    summary: JSON.parse(row.summary),
  };
}

export function cacheReport(setId: number, scope: string, report: unknown, summary: unknown): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO reports_cache (set_id, scope, report, summary, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(set_id, scope) DO UPDATE SET
      report = excluded.report,
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `).run(setId, scope, JSON.stringify(report), JSON.stringify(summary));
}

export function invalidateReportCache(setId: number): void {
  const db = getDb();
  db.prepare("DELETE FROM reports_cache WHERE set_id = ?").run(setId);
}

// Convenience: invalidate by set name
export function invalidateReportCacheByName(setName: string): void {
  const db = getDb();
  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (setRow) {
    invalidateReportCache(setRow.id);
  }
}

// ---------------------------------------------------------------------------
// Dashboard stats queries
// ---------------------------------------------------------------------------

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
    run_count: number;
  }>;
  sets: Array<{
    name: string;
    theorem_count: number;
    result_count: number;
    models: string[];
  }>;
}

export function getDashboardOverview(): DashboardOverview {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM theorem_sets) AS totalSets,
      (SELECT COUNT(*) FROM theorems) AS totalTheorems,
      (SELECT COUNT(*) FROM results) AS totalResults,
      (SELECT COUNT(DISTINCT model_slug) FROM results) AS totalModels
  `).get() as { totalSets: number; totalTheorems: number; totalResults: number; totalModels: number };

  const modelSummaries = db.prepare(`
    WITH complete_runs AS (
      SELECT r2.id AS run_id
      FROM runs r2
      WHERE r2.finished_at IS NOT NULL
        AND (SELECT COUNT(*) FROM results WHERE results.run_id = r2.id)
            >= (SELECT COUNT(*) FROM theorems WHERE theorems.set_id = r2.set_id)
        AND (SELECT COUNT(*) FROM results
             WHERE results.run_id = r2.id
               AND results.validation_result = 'error'
               AND results.parse_error IS NULL) = 0
    ),
    latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY set_id, theorem_id, model_slug ORDER BY id DESC) AS rn
      FROM results
      WHERE run_id IS NULL OR run_id IN (SELECT run_id FROM complete_runs)
    )
    SELECT
      model_slug,
      MAX(model_display) AS model_display,
      COUNT(*) AS total_attempted,
      SUM(CASE WHEN validation_result = 'valid' THEN 1 ELSE 0 END) AS total_valid,
      SUM(CASE WHEN validation_result = 'invalid' THEN 1 ELSE 0 END) AS total_invalid,
      SUM(CASE WHEN validation_result = 'error' THEN 1 ELSE 0 END) AS total_errors,
      ROUND(100.0 * SUM(CASE WHEN validation_result = 'valid' THEN 1 ELSE 0 END) / COUNT(*), 2) AS valid_rate,
      ROUND(AVG(latency_ms), 0) AS avg_latency_ms,
      ROUND(AVG(CASE WHEN validation_result = 'valid' THEN line_count ELSE NULL END), 1) AS avg_lines,
      COALESCE(SUM(tokens_used), 0) AS total_tokens,
      (SELECT COUNT(*) FROM runs WHERE runs.model_slug = latest.model_slug) as run_count
    FROM latest WHERE rn = 1
    GROUP BY model_slug
    ORDER BY valid_rate DESC
  `).all() as DashboardOverview["modelSummaries"];

  const setRows = db.prepare(`
    SELECT
      ts.name,
      (SELECT COUNT(*) FROM theorems t WHERE t.set_id = ts.id) AS theorem_count,
      (SELECT COUNT(*) FROM results r WHERE r.set_id = ts.id) AS result_count
    FROM theorem_sets ts
    ORDER BY ts.name
  `).all() as Array<{ name: string; theorem_count: number; result_count: number }>;

  const setModels = db.prepare(`
    SELECT ts.name, r.model_display
    FROM results r
    JOIN theorem_sets ts ON ts.id = r.set_id
    GROUP BY ts.name, r.model_display
    ORDER BY ts.name, r.model_display
  `).all() as Array<{ name: string; model_display: string }>;

  const modelsMap = new Map<string, string[]>();
  for (const row of setModels) {
    if (!modelsMap.has(row.name)) modelsMap.set(row.name, []);
    modelsMap.get(row.name)!.push(row.model_display);
  }

  const sets = setRows.map((s) => ({
    name: s.name,
    theorem_count: s.theorem_count,
    result_count: s.result_count,
    models: modelsMap.get(s.name) ?? [],
  }));

  return { ...totals, modelSummaries, sets };
}

export interface HeadToHeadCell {
  modelA: string;
  modelB: string;
  winsA: number;
  winsB: number;
  ties: number;
  total: number;
}

export function getHeadToHeadMatrix(setName: string): HeadToHeadCell[] {
  const db = getDb();

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) return [];

  // Get all results for this set, grouped by theorem and model
  const rows = db.prepare(`
    SELECT theorem_id, model_display, validation_result, line_count
    FROM results
    WHERE set_id = ?
    ORDER BY theorem_id, model_display
  `).all(setRow.id) as Array<{
    theorem_id: string;
    model_display: string;
    validation_result: string;
    line_count: number | null;
  }>;

  // Group by theorem
  const byTheorem = new Map<string, Map<string, { valid: boolean; lines: number | null }>>();
  for (const r of rows) {
    if (!byTheorem.has(r.theorem_id)) byTheorem.set(r.theorem_id, new Map());
    byTheorem.get(r.theorem_id)!.set(r.model_display, {
      valid: r.validation_result === "valid",
      lines: r.line_count,
    });
  }

  // Collect all models
  const allModels = [...new Set(rows.map((r) => r.model_display))].sort();

  // Compare each pair
  const cells: HeadToHeadCell[] = [];
  for (let i = 0; i < allModels.length; i++) {
    for (let j = i + 1; j < allModels.length; j++) {
      const modelA = allModels[i];
      const modelB = allModels[j];
      let winsA = 0, winsB = 0, ties = 0, total = 0;

      for (const [, modelResults] of byTheorem) {
        const a = modelResults.get(modelA);
        const b = modelResults.get(modelB);
        if (!a || !b) continue; // both must have attempted this theorem

        if (a.valid && !b.valid) {
          total++;
          winsA++;
        }
        else if (!a.valid && b.valid) {
          total++;
          winsB++;
        }
        else if (a.valid && b.valid) {
          // Both valid: fewer lines wins
          total++;
          if (a.lines !== null && b.lines !== null) {
            if (a.lines < b.lines) winsA++;
            else if (b.lines < a.lines) winsB++;
            else ties++;
          } else {
            ties++;
          }
        }
        // Both invalid: skip (no-game, don't increment total, wins, or ties)
      }

      cells.push({ modelA, modelB, winsA, winsB, ties, total });
    }
  }

  return cells;
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

export function getLatencyStats(setName?: string): LatencyStats[] {
  const db = getDb();

  let setFilter = "";
  const params: unknown[] = [];

  if (setName) {
    const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
    if (!setRow) return [];
    setFilter = "WHERE r.set_id = ?";
    params.push(setRow.id);
  }

  const aggRows = db.prepare(`
    SELECT
      r.model_slug,
      r.model_display,
      ROUND(AVG(r.latency_ms), 0) AS avg_ms,
      MIN(r.latency_ms) AS min_ms,
      MAX(r.latency_ms) AS max_ms,
      COALESCE(SUM(r.tokens_used), 0) AS total_tokens,
      ROUND(COALESCE(AVG(r.tokens_used), 0), 0) AS avg_tokens,
      COUNT(*) AS cnt
    FROM results r
    ${setFilter}
    GROUP BY r.model_slug
    ORDER BY avg_ms ASC
  `).all(...params) as Array<{
    model_slug: string;
    model_display: string;
    avg_ms: number;
    min_ms: number;
    max_ms: number;
    total_tokens: number;
    avg_tokens: number;
    cnt: number;
  }>;

  // Compute p50 (median) for each model
  const stats: LatencyStats[] = [];
  for (const row of aggRows) {
    const medianParams: unknown[] = [];
    let medianFilter = "";
    if (setName) {
      const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number };
      medianFilter = "AND r.set_id = ?";
      medianParams.push(row.model_slug, setRow.id);
    } else {
      medianParams.push(row.model_slug);
    }

    const medianRow = db.prepare(`
      SELECT r.latency_ms
      FROM results r
      WHERE r.model_slug = ? ${medianFilter}
      ORDER BY r.latency_ms
      LIMIT 1 OFFSET ?
    `).get(...medianParams, Math.floor(row.cnt / 2)) as { latency_ms: number } | undefined;

    stats.push({
      model_slug: row.model_slug,
      model_display: row.model_display,
      avg_ms: row.avg_ms,
      min_ms: row.min_ms,
      max_ms: row.max_ms,
      p50_ms: medianRow?.latency_ms ?? row.avg_ms,
      total_tokens: row.total_tokens,
      avg_tokens: row.avg_tokens,
    });
  }

  return stats;
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

export function getAvgLinesByDifficulty(setName?: string): AvgLinesByDifficulty[] {
  const db = getDb();

  let setFilter = "";
  const params: unknown[] = [];

  if (setName) {
    const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
    if (!setRow) return [];
    setFilter = "AND r.set_id = ?";
    params.push(setRow.id);
  }

  return db.prepare(`
    SELECT
      r.model_slug,
      r.model_display,
      t.difficulty,
      ROUND(AVG(r.line_count), 1) AS avg_lines,
      COUNT(*) AS count
    FROM results r
    JOIN theorems t ON t.set_id = r.set_id AND t.theorem_id = r.theorem_id
    WHERE r.validation_result = 'valid'
      AND r.line_count IS NOT NULL
      ${setFilter}
    GROUP BY r.model_slug, t.difficulty
    ORDER BY r.model_display, t.difficulty_value
  `).all(...params) as AvgLinesByDifficulty[];
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
  }>;
}

export function getSetOverview(setName: string): SetOverview {
  const db = getDb();

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) {
    return { totalTheorems: 0, totalResults: 0, totalModels: 0, modelSummaries: [] };
  }

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM theorems WHERE set_id = ?) as totalTheorems,
      (SELECT COUNT(*) FROM results WHERE set_id = ?) as totalResults,
      (SELECT COUNT(DISTINCT model_slug) FROM results WHERE set_id = ?) as totalModels
  `).get(setRow.id, setRow.id, setRow.id) as { totalTheorems: number; totalResults: number; totalModels: number };

  const modelSummaries = db.prepare(`
    WITH complete_runs AS (
      SELECT r2.id AS run_id
      FROM runs r2
      WHERE r2.finished_at IS NOT NULL
        AND (SELECT COUNT(*) FROM results WHERE results.run_id = r2.id)
            >= (SELECT COUNT(*) FROM theorems WHERE theorems.set_id = r2.set_id)
        AND (SELECT COUNT(*) FROM results
             WHERE results.run_id = r2.id
               AND results.validation_result = 'error'
               AND results.parse_error IS NULL) = 0
    ),
    latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY theorem_id, model_slug ORDER BY id DESC) AS rn
      FROM results
      WHERE set_id = ?
        AND (run_id IS NULL OR run_id IN (SELECT run_id FROM complete_runs))
    )
    SELECT
      model_slug, MAX(model_display) as model_display,
      COUNT(*) as total_attempted,
      SUM(CASE WHEN validation_result = 'valid' THEN 1 ELSE 0 END) as total_valid,
      SUM(CASE WHEN validation_result = 'invalid' THEN 1 ELSE 0 END) as total_invalid,
      SUM(CASE WHEN validation_result = 'error' AND parse_error IS NOT NULL THEN 1 ELSE 0 END) as total_parse_errors,
      SUM(CASE WHEN validation_result = 'error' AND parse_error IS NULL THEN 1 ELSE 0 END) as total_api_errors,
      ROUND(100.0 * SUM(CASE WHEN validation_result = 'valid' THEN 1 ELSE 0 END) / COUNT(*), 1) as valid_rate,
      ROUND(AVG(latency_ms), 0) as avg_latency_ms,
      ROUND(AVG(CASE WHEN validation_result = 'valid' THEN line_count END), 1) as avg_lines,
      SUM(COALESCE(tokens_used, 0)) as total_tokens,
      (SELECT COUNT(*) FROM runs WHERE runs.set_id = ? AND runs.model_slug = latest.model_slug) as run_count,
      (SELECT COUNT(*) FROM runs WHERE runs.set_id = ? AND runs.model_slug = latest.model_slug AND runs.id IN (SELECT run_id FROM complete_runs)) as valid_run_count
    FROM latest WHERE rn = 1
    GROUP BY model_slug
  `).all(setRow.id, setRow.id, setRow.id) as SetOverview["modelSummaries"];

  return { ...totals, modelSummaries };
}

export interface HardestTheorem {
  theorem_id: string;
  difficulty: string;
  difficulty_value: number;
  attempts: number;
  valid_count: number;
  success_rate: number;
}

export function getHardestTheorems(setName: string, limit: number = 30): HardestTheorem[] {
  const db = getDb();

  const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
  if (!setRow) return [];

  return db.prepare(`
    SELECT
      t.theorem_id, t.difficulty, t.difficulty_value,
      COUNT(r.id) as attempts,
      SUM(CASE WHEN r.validation_result = 'valid' THEN 1 ELSE 0 END) as valid_count,
      ROUND(100.0 * SUM(CASE WHEN r.validation_result = 'valid' THEN 1 ELSE 0 END) / COUNT(r.id), 1) as success_rate
    FROM theorems t
    JOIN results r ON t.set_id = r.set_id AND t.theorem_id = r.theorem_id
    WHERE t.set_id = ?
    GROUP BY t.theorem_id, t.difficulty, t.difficulty_value
    HAVING COUNT(r.id) > 0
    ORDER BY success_rate ASC, t.difficulty_value DESC
    LIMIT ?
  `).all(setRow.id, limit) as HardestTheorem[];
}

export function getFailureAnalysis(setName?: string): FailureAnalysis[] {
  const db = getDb();

  let setFilter = "";
  const params: unknown[] = [];

  if (setName) {
    const setRow = db.prepare("SELECT id FROM theorem_sets WHERE name = ?").get(setName) as { id: number } | undefined;
    if (!setRow) return [];
    setFilter = "WHERE r.set_id = ?";
    params.push(setRow.id);
  }

  return db.prepare(`
    SELECT
      r.model_slug,
      r.model_display,
      COUNT(*) AS total,
      SUM(CASE WHEN r.validation_result = 'valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NOT NULL THEN 1 ELSE 0 END) AS parse_failures,
      SUM(CASE WHEN r.validation_result = 'invalid' THEN 1 ELSE 0 END) AS validation_failures,
      SUM(CASE WHEN r.validation_result = 'error' AND r.parse_error IS NULL THEN 1 ELSE 0 END) AS api_errors
    FROM results r
    ${setFilter}
    GROUP BY r.model_slug
    ORDER BY r.model_display
  `).all(...params) as FailureAnalysis[];
}
