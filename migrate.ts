#!/usr/bin/env npx ts-node

/**
 * PropBench Migration — One-time script to populate SQLite from existing JSON files.
 *
 * Scans benchmarks/ for theorem sets and results/ for benchmark results,
 * then inserts everything into propbench.db.
 *
 * Usage: npx ts-node migrate.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  initSchema,
  upsertTheoremSet,
  upsertTheorem,
  insertResult,
  getDb,
  closeDb,
} from "./db";

const PROJECT_ROOT = __dirname;
const BENCHMARKS_DIR = path.join(PROJECT_ROOT, "benchmarks");
const RESULTS_DIR = path.join(PROJECT_ROOT, "results");

interface BenchTheorem {
  id: string;
  premises: string[];
  conclusion: string;
  difficulty: string;
  difficulty_value: number;
}

interface RawResult {
  theorem_id: string;
  model: string;
  model_name: string;
  raw_response: string;
  parsed_proof: unknown[] | null;
  parse_error: string | null;
  validation_result: "valid" | "invalid" | "error";
  validation_errors: string[];
  line_count: number | null;
  latency_ms: number;
  tokens_used: number | undefined;
  timestamp: string;
}

function migrate(): void {
  console.log("=== PropBench SQLite Migration ===\n");

  // Initialize schema
  initSchema();
  console.log("Schema initialized.\n");

  const db = getDb();

  let totalSets = 0;
  let totalTheorems = 0;
  let totalResults = 0;
  let skippedFiles = 0;

  // Phase 1: Migrate theorem sets from benchmarks/
  console.log("--- Phase 1: Theorem Sets ---");
  if (fs.existsSync(BENCHMARKS_DIR)) {
    const setDirs = fs.readdirSync(BENCHMARKS_DIR, { withFileTypes: true });
    for (const dir of setDirs) {
      if (!dir.isDirectory()) continue;

      const theoremsPath = path.join(BENCHMARKS_DIR, dir.name, "theorems.json");
      if (!fs.existsSync(theoremsPath)) {
        console.log(`  [skip] ${dir.name}/ — no theorems.json`);
        continue;
      }

      const relativePath = `benchmarks/${dir.name}/theorems.json`;

      try {
        const theorems: BenchTheorem[] = JSON.parse(
          fs.readFileSync(theoremsPath, "utf-8")
        );

        const setId = upsertTheoremSet(dir.name, relativePath);
        console.log(`  [set] ${dir.name} (id=${setId}, ${theorems.length} theorems)`);
        totalSets++;

        // Batch insert theorems in a transaction
        const insertTheoremsTx = db.transaction(() => {
          for (const t of theorems) {
            upsertTheorem(setId, {
              id: t.id,
              premises: t.premises,
              conclusion: t.conclusion,
              difficulty: t.difficulty,
              difficulty_value: t.difficulty_value,
            });
            totalTheorems++;
          }
        });
        insertTheoremsTx();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [error] ${dir.name}: ${msg}`);
      }
    }
  } else {
    console.log("  No benchmarks/ directory found.");
  }

  console.log();

  // Phase 2: Migrate results
  console.log("--- Phase 2: Results ---");
  if (fs.existsSync(RESULTS_DIR)) {
    const setDirs = fs.readdirSync(RESULTS_DIR, { withFileTypes: true });
    for (const setDir of setDirs) {
      if (!setDir.isDirectory()) continue;

      const setPath = path.join(RESULTS_DIR, setDir.name);
      const setName = setDir.name;

      // Check for model subdirectories with raw/ folders
      const subDirs = fs.readdirSync(setPath, { withFileTypes: true });
      let foundModels = false;

      for (const modelDir of subDirs) {
        if (!modelDir.isDirectory()) continue;

        const rawDir = path.join(setPath, modelDir.name, "raw");
        if (!fs.existsSync(rawDir)) continue;
        foundModels = true;

        // Ensure the theorem set exists in DB (may not be in benchmarks/)
        const ensuredSetId = upsertTheoremSet(setName);

        const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith(".json"));
        console.log(`  [results] ${setName}/${modelDir.name}: ${rawFiles.length} files`);

        // Batch insert results in a transaction
        const insertResultsTx = db.transaction(() => {
          for (const file of rawFiles) {
            try {
              const data: RawResult = JSON.parse(
                fs.readFileSync(path.join(rawDir, file), "utf-8")
              );

              // Ensure theorem exists in theorems table (may be missing if benchmarks/ was deleted)
              // We need the theorem in the DB for the foreign key
              const theoremExists = db.prepare(`
                SELECT 1 FROM theorems WHERE set_id = ? AND theorem_id = ?
              `).get(ensuredSetId, data.theorem_id);

              if (!theoremExists) {
                // Insert a minimal theorem record
                upsertTheorem(ensuredSetId, {
                  id: data.theorem_id,
                  premises: [],
                  conclusion: "",
                  difficulty: "Medium",
                  difficulty_value: 0,
                });
              }

              insertResult(setName, {
                theorem_id: data.theorem_id,
                model: data.model,
                model_name: data.model_name,
                raw_response: data.raw_response,
                parsed_proof: data.parsed_proof as any,
                parse_error: data.parse_error,
                validation_result: data.validation_result,
                validation_errors: data.validation_errors,
                line_count: data.line_count,
                latency_ms: data.latency_ms,
                tokens_used: data.tokens_used,
                timestamp: data.timestamp,
              });
              totalResults++;
            } catch (err) {
              skippedFiles++;
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`    [skip] ${file}: ${msg}`);
            }
          }
        });
        insertResultsTx();
      }

      // Also check for old flat layout: results/{set}/raw/
      if (!foundModels) {
        const flatRawDir = path.join(setPath, "raw");
        if (fs.existsSync(flatRawDir)) {
          const ensuredSetId = upsertTheoremSet(setName);
          const rawFiles = fs.readdirSync(flatRawDir).filter((f) => f.endsWith(".json"));
          console.log(`  [results] ${setName} (flat layout): ${rawFiles.length} files`);

          const insertFlatTx = db.transaction(() => {
            for (const file of rawFiles) {
              try {
                const data: RawResult = JSON.parse(
                  fs.readFileSync(path.join(flatRawDir, file), "utf-8")
                );

                const theoremExists = db.prepare(`
                  SELECT 1 FROM theorems WHERE set_id = ? AND theorem_id = ?
                `).get(ensuredSetId, data.theorem_id);

                if (!theoremExists) {
                  upsertTheorem(ensuredSetId, {
                    id: data.theorem_id,
                    premises: [],
                    conclusion: "",
                    difficulty: "Medium",
                    difficulty_value: 0,
                  });
                }

                insertResult(setName, {
                  theorem_id: data.theorem_id,
                  model: data.model,
                  model_name: data.model_name,
                  raw_response: data.raw_response,
                  parsed_proof: data.parsed_proof as any,
                  parse_error: data.parse_error,
                  validation_result: data.validation_result,
                  validation_errors: data.validation_errors,
                  line_count: data.line_count,
                  latency_ms: data.tokens_used !== undefined ? data.latency_ms : 0,
                  tokens_used: data.tokens_used,
                  timestamp: data.timestamp,
                });
                totalResults++;
              } catch (err) {
                skippedFiles++;
              }
            }
          });
          insertFlatTx();
        }
      }
    }
  } else {
    console.log("  No results/ directory found.");
  }

  // Print summary
  console.log("\n=== Migration Summary ===");
  console.log(`Theorem sets: ${totalSets}`);
  console.log(`Theorems:     ${totalTheorems}`);
  console.log(`Results:      ${totalResults}`);
  if (skippedFiles > 0) {
    console.log(`Skipped:      ${skippedFiles} (corrupt/unreadable files)`);
  }

  // Verify counts
  const dbSetCount = (db.prepare("SELECT COUNT(*) AS c FROM theorem_sets").get() as { c: number }).c;
  const dbTheoremCount = (db.prepare("SELECT COUNT(*) AS c FROM theorems").get() as { c: number }).c;
  const dbResultCount = (db.prepare("SELECT COUNT(*) AS c FROM results").get() as { c: number }).c;

  console.log(`\nDB verification:`);
  console.log(`  theorem_sets: ${dbSetCount}`);
  console.log(`  theorems:     ${dbTheoremCount}`);
  console.log(`  results:      ${dbResultCount}`);

  closeDb();
  console.log("\nMigration complete.");
}

migrate();
