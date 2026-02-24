/**
 * PropBench Scorer — Scoring, Elo ratings, and reporting.
 *
 * Tracks per-theorem, per-model results and produces aggregate statistics
 * including an Elo rating system for head-to-head model comparison.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TheoremResult {
  theoremId: string;
  valid: boolean;
  parseSuccess: boolean;
  lineCount: number | null; // null if proof invalid or parse failed
  difficulty: DifficultyTier;
  difficultyValue: number;
  failureStage?: "api_call" | "parse" | "validation";
}

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

export interface ModelStats {
  model: string;
  totalLines: number;
  validCount: number;
  invalidCount: number;
  totalAttempted: number;
  avgLinesPerValidProof: number | null;
  linesByDifficulty: Record<DifficultyTier, {
    total: number;
    count: number;
    avg: number | null;
    attempted: number;
    valid: number;
    invalid: number;
  }>;
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

export interface BenchmarkReport {
  timestamp: string;
  models: ModelStats[];
  headToHead: HeadToHead[];
  perTheorem: Record<string, Record<string, TheoremResult>>; // theoremId -> model -> result
  rankings: { rank: number; model: string; eloRating: number; totalLines: number; validRate: string }[];
}

// ---------------------------------------------------------------------------
// Scorer class
// ---------------------------------------------------------------------------

const DEFAULT_ELO = 1500;
const ELO_K = 32;

export class Scorer {
  // theoremId -> model -> result
  private results: Map<string, Map<string, TheoremResult>> = new Map();
  private models: Set<string> = new Set();

  /**
   * Record a single theorem result for a model.
   */
  recordResult(theoremId: string, model: string, result: TheoremResult): void {
    this.models.add(model);
    if (!this.results.has(theoremId)) {
      this.results.set(theoremId, new Map());
    }
    this.results.get(theoremId)!.set(model, result);
  }

  /**
   * Generate the full benchmark report with Elo ratings and aggregate stats.
   */
  generateReport(): BenchmarkReport {
    const eloRatings = this.computeElo();
    const headToHead = this.computeHeadToHead();
    const modelStatsList = this.computeModelStats(eloRatings);

    // Build per-theorem map
    const perTheorem: Record<string, Record<string, TheoremResult>> = {};
    for (const [tid, modelMap] of this.results) {
      perTheorem[tid] = {};
      for (const [model, result] of modelMap) {
        perTheorem[tid][model] = result;
      }
    }

    // Rankings sorted by Elo descending
    const rankings = modelStatsList
      .slice()
      .sort((a, b) => b.eloRating - a.eloRating)
      .map((s, i) => ({
        rank: i + 1,
        model: s.model,
        eloRating: s.eloRating,
        totalLines: s.totalLines,
        validRate:
          s.totalAttempted > 0
            ? `${((s.validCount / s.totalAttempted) * 100).toFixed(1)}%`
            : "0.0%",
      }));

    return {
      timestamp: new Date().toISOString(),
      models: modelStatsList,
      headToHead,
      perTheorem,
      rankings,
    };
  }

  /**
   * Print a human-readable summary table to stdout.
   */
  printSummary(report: BenchmarkReport): void {
    console.log("\n=== PropBench Results ===\n");

    // Rankings table
    console.log("Rankings:");
    console.log(
      padRight("#", 4) +
        padRight("Model", 28) +
        padRight("Elo", 8) +
        padRight("Valid", 10) +
        padRight("Rate", 8) +
        padRight("Lines", 8) +
        padRight("Avg Lines", 10)
    );
    console.log("-".repeat(76));

    for (const r of report.rankings) {
      const stats = report.models.find((m) => m.model === r.model)!;
      const avgStr =
        stats.avgLinesPerValidProof !== null
          ? stats.avgLinesPerValidProof.toFixed(1)
          : "N/A";
      console.log(
        padRight(String(r.rank), 4) +
          padRight(r.model, 28) +
          padRight(String(r.eloRating), 8) +
          padRight(`${stats.validCount}/${stats.totalAttempted}`, 10) +
          padRight(r.validRate, 8) +
          padRight(String(r.totalLines), 8) +
          padRight(avgStr, 10)
      );
    }

    // Per-difficulty breakdown
    console.log("\nLines by Difficulty Tier:");
    const tiers: DifficultyTier[] = [
      "baby",
      "easy",
      "medium",
      "hard",
      "expert",
      "nightmare",
      "marathon",
      "absurd",
      "cosmic",
      "mind",
    ];
    console.log(
      padRight("Model", 28) +
        tiers.map((t) => padRight(t, 12)).join("")
    );
    console.log("-".repeat(28 + tiers.length * 12));

    for (const stats of report.models) {
      const cells = tiers.map((t) => {
        const d = stats.linesByDifficulty[t];
        if (d.count === 0) return padRight("-", 12);
        return padRight(`${d.avg?.toFixed(1)} (${d.count})`, 12);
      });
      console.log(padRight(stats.model, 28) + cells.join(""));
    }

    console.log("");
  }

  // -------------------------------------------------------------------------
  // Private: Elo computation
  // -------------------------------------------------------------------------

  private computeElo(): Map<string, number> {
    const ratings = new Map<string, number>();
    for (const model of this.models) {
      ratings.set(model, DEFAULT_ELO);
    }

    const modelList = Array.from(this.models);
    if (modelList.length < 2) return ratings;

    // For each theorem, run pairwise Elo updates
    for (const [, modelMap] of this.results) {
      for (let i = 0; i < modelList.length; i++) {
        for (let j = i + 1; j < modelList.length; j++) {
          const a = modelList[i];
          const b = modelList[j];
          const ra = modelMap.get(a);
          const rb = modelMap.get(b);

          if (!ra || !rb) continue; // one model didn't attempt this theorem

          const scoreA = this.matchScore(ra, rb);

          // Skip Elo update if both models failed (null = no-game)
          if (scoreA === null) continue;

          const scoreB = 1 - scoreA;

          const ratingA = ratings.get(a)!;
          const ratingB = ratings.get(b)!;
          const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
          const expectedB = 1 - expectedA;

          ratings.set(a, Math.round(ratingA + ELO_K * (scoreA - expectedA)));
          ratings.set(b, Math.round(ratingB + ELO_K * (scoreB - expectedB)));
        }
      }
    }

    return ratings;
  }

  /**
   * Determine the match score for model A vs B on a single theorem.
   * Returns 1 for A wins, 0 for B wins, 0.5 for tie, null for no-game (both invalid).
   */
  private matchScore(a: TheoremResult, b: TheoremResult): number | null {
    // If one succeeded and the other didn't, success wins
    if (a.valid && !b.valid) return 1;
    if (!a.valid && b.valid) return 0;

    // If both failed, it's a no-game (skip Elo update)
    if (!a.valid && !b.valid) return null;

    // Both valid — fewer lines wins
    const linesA = a.lineCount!;
    const linesB = b.lineCount!;
    if (linesA < linesB) return 1;
    if (linesB < linesA) return 0;
    return 0.5; // tie
  }

  private computeHeadToHead(): HeadToHead[] {
    const results: HeadToHead[] = [];
    const modelList = Array.from(this.models);

    for (const [tid, modelMap] of this.results) {
      for (let i = 0; i < modelList.length; i++) {
        for (let j = i + 1; j < modelList.length; j++) {
          const a = modelList[i];
          const b = modelList[j];
          const ra = modelMap.get(a);
          const rb = modelMap.get(b);
          if (!ra || !rb) continue;

          const score = this.matchScore(ra, rb);

          // Skip if both models failed (null = no-game)
          if (score === null) continue;

          let winner: string | "tie";
          if (score === 1) winner = a;
          else if (score === 0) winner = b;
          else winner = "tie";

          results.push({
            theoremId: tid,
            modelA: a,
            modelB: b,
            winner,
            modelALines: ra.lineCount,
            modelBLines: rb.lineCount,
          });
        }
      }
    }

    return results;
  }

  private computeModelStats(eloRatings: Map<string, number>): ModelStats[] {
    const statsList: ModelStats[] = [];

    for (const model of this.models) {
      let totalLines = 0;
      let validCount = 0;
      let invalidCount = 0;
      let totalAttempted = 0;

      const byDifficulty: Record<
        DifficultyTier,
        { total: number; count: number; attempted: number; valid: number; invalid: number }
      > = {
        baby: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        easy: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        medium: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        hard: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        expert: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        nightmare: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        marathon: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        absurd: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        cosmic: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
        mind: { total: 0, count: 0, attempted: 0, valid: 0, invalid: 0 },
      };

      for (const [, modelMap] of this.results) {
        const result = modelMap.get(model);
        if (!result) continue;

        totalAttempted++;
        const d = byDifficulty[result.difficulty];
        if (d) d.attempted++;

        if (result.valid && result.lineCount !== null) {
          validCount++;
          totalLines += result.lineCount;
          if (d) {
            d.total += result.lineCount;
            d.count++;
            d.valid++;
          }
        } else {
          invalidCount++;
          if (d) d.invalid++;
        }
      }

      const linesByDifficulty: ModelStats["linesByDifficulty"] = {} as any;
      for (const tier of Object.keys(byDifficulty) as DifficultyTier[]) {
        const d = byDifficulty[tier];
        linesByDifficulty[tier] = {
          total: d.total,
          count: d.count,
          avg: d.count > 0 ? d.total / d.count : null,
          attempted: d.attempted,
          valid: d.valid,
          invalid: d.invalid,
        };
      }

      statsList.push({
        model,
        totalLines,
        validCount,
        invalidCount,
        totalAttempted,
        avgLinesPerValidProof:
          validCount > 0 ? totalLines / validCount : null,
        linesByDifficulty,
        eloRating: eloRatings.get(model) ?? DEFAULT_ELO,
      });
    }

    return statsList;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
