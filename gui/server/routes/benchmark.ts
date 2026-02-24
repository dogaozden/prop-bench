import { Router, Request, Response } from "express";
import { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { spawnHarness, BENCHMARKS_DIR } from "../cli";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

const require_ = createRequire(import.meta.url);
const dbModule: any = require_("../../../db");

const router = Router();

/** Parsed progress state tracked per run */
interface RunProgress {
  completed: number;
  total: number;
  sequentialRuns: number;
  perRunTotal: number;
  currentTheoremId: string;
  currentModel: string;
  validCount: number;
  invalidCount: number;
  parseErrorCount: number;
  apiErrorCount: number;
  skippedCount: number;
  costUsd: number;
}

/** Active benchmark runs keyed by runId */
const activeRuns = new Map<string, {
  process: ChildProcess;
  output: string[];
  progress: RunProgress;
  done: boolean;
  error: string | null;
}>();

/**
 * Parse a harness output line and update progress state.
 * Harness output patterns:
 *   "Processing theorems 0 to 4 (5 total)"
 *   "[1/5] v1-001 x gemini — running..."
 *   "[1/5] v1-001 x gemini — SKIPPED (already done)"
 *   "  -> VALID (3 lines, 1234ms)"
 *   "  -> INVALID: ..."
 *   "  -> API ERROR: ..."
 *   "  -> PARSE ERROR: ..."
 *   "  -> PROMPT ERROR: ..."
 */
function parseHarnessLine(line: string, progress: RunProgress): void {
  // Match "Sequential runs: N"
  const seqMatch = line.match(/^Sequential runs:\s+(\d+)/);
  if (seqMatch) {
    progress.sequentialRuns = parseInt(seqMatch[1], 10);
    // If we already know per-run total, update grand total
    if (progress.perRunTotal > 0) {
      progress.total = progress.perRunTotal * progress.sequentialRuns;
    }
    return;
  }

  // Match "Processing theorems X to Y (N total)"
  const totalMatch = line.match(/Processing theorems \d+ to \d+ \((\d+) total\)/);
  if (totalMatch) {
    progress.perRunTotal = parseInt(totalMatch[1], 10);
    progress.total = progress.perRunTotal * progress.sequentialRuns;
    return;
  }

  // Match "[n/total] theorem_id x model_name — running..." (with optional "(run X/Y) " prefix)
  const runningMatch = line.match(/(?:\(run \d+\/\d+\)\s+)?\[(\d+)\/(\d+)\]\s+([\w-]+)\s+x\s+(\S+)\s+—\s+running/);
  if (runningMatch) {
    progress.currentTheoremId = runningMatch[3];
    progress.currentModel = runningMatch[4];
    // Set per-run total from the bracket if not already set
    if (progress.perRunTotal === 0) {
      progress.perRunTotal = parseInt(runningMatch[2], 10);
      progress.total = progress.perRunTotal * progress.sequentialRuns;
    }
    return;
  }

  // Match "[n/total] theorem_id x model_name — SKIPPED" (with optional "(run X/Y) " prefix)
  const skippedMatch = line.match(/(?:\(run \d+\/\d+\)\s+)?\[(\d+)\/(\d+)\]\s+([\w-]+)\s+x\s+(\S+)\s+—\s+SKIPPED/);
  if (skippedMatch) {
    progress.skippedCount++;
    progress.completed++;
    progress.currentTheoremId = skippedMatch[3];
    progress.currentModel = skippedMatch[4];
    return;
  }

  // Match "  -> VALID"
  if (line.match(/^\s*->\s+VALID/)) {
    progress.validCount++;
    progress.completed++;
    return;
  }

  // Match "  -> INVALID"
  if (line.match(/^\s*->\s+INVALID/)) {
    progress.invalidCount++;
    progress.completed++;
    return;
  }

  // Match "  -> API ERROR" / "  -> PARSE ERROR" / "  -> PROMPT ERROR"
  // Skip retry lines — only count final errors (those without "(will retry)")
  if (line.match(/^\s*->\s+(API|PARSE|PROMPT)\s+ERROR/) && !line.includes("(will retry)")) {
    if (line.match(/^\s*->\s+API\s+ERROR/)) {
      progress.apiErrorCount++;
    } else {
      progress.parseErrorCount++;
    }
    progress.completed++;
    return;
  }

  // Match "  cost: $X.XXXX" (running cost from harness)
  const costMatch = line.match(/^\s+cost:\s+\$(\d+\.\d+)/);
  if (costMatch) {
    progress.costUsd = parseFloat(costMatch[1]);
    return;
  }
}

/** POST /api/benchmark/start — spawn a harness run */
router.post("/start", (req: Request, res: Response) => {
  try {
    const { theoremSet, models, temperature, maxTokens, maxThinkingTokens, workers, start, count, force, noRetryParse, retryApiErrors, runs, continueRunId, maxCost, tierBudgetsEnabled, tierBudgets } = req.body;

    // Continue-run mode: look up settings from the DB run record
    if (continueRunId != null) {
      const runSettings = dbModule.getRunSettings(continueRunId);
      if (!runSettings) {
        res.status(404).json({ error: `Run #${continueRunId} not found` });
        return;
      }

      const runId = randomUUID().slice(0, 8);
      console.log(`[benchmark] Continuing run #${continueRunId} (session ${runId}), set='${runSettings.setName}', model='${runSettings.modelSlug}'`);

      const child = spawnHarness({
        theoremSet: runSettings.setName,
        models: [runSettings.modelSlug],
        temperature: runSettings.temperature,
        maxTokens: runSettings.maxTokens,
        maxThinkingTokens,
        workers,
        noRetryParse: noRetryParse ?? true,
        retryApiErrors,
        continueRunId,
        maxCost,
        tierBudgetsEnabled,
        tierBudgets,
      });

      const run = {
        process: child,
        output: [] as string[],
        progress: {
          completed: 0,
          total: 0,
          sequentialRuns: 1,
          perRunTotal: 0,
          currentTheoremId: "",
          currentModel: "",
          validCount: 0,
          invalidCount: 0,
          parseErrorCount: 0,
          apiErrorCount: 0,
          skippedCount: 0,
          costUsd: 0,
        },
        done: false,
        error: null as string | null,
      };

      activeRuns.set(runId, run);

      child.stdout?.on("data", (data: Buffer) => {
        const raw = data.toString();
        const lines = raw.split("\n").filter(Boolean);
        for (const line of lines) {
          run.output.push(line);
          parseHarnessLine(line, run.progress);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          run.output.push(line);
        }
      });

      child.on("close", (code) => {
        run.done = true;
        if (code !== 0 && code !== null) {
          const tail = run.output.slice(-5).join("\n");
          run.error = `Process exited with code ${code}.\n${tail}`;
        }
        console.log(`[benchmark] Continue-run ${runId} finished with code ${code}`);
      });

      child.on("error", (err) => {
        run.done = true;
        run.error = err.message;
      });

      res.json({ runId });
      return;
    }

    if (!theoremSet || !models || !Array.isArray(models) || models.length === 0) {
      res.status(400).json({ error: "Missing required fields: theoremSet, models (array)" });
      return;
    }

    const runId = randomUUID().slice(0, 8);

    console.log(`[benchmark] Starting run ${runId} for theorem set '${theoremSet}' with models:`, models);

    const child = spawnHarness({
      theoremSet,
      models,
      temperature: temperature ?? 0.2,
      maxTokens: maxTokens ?? 4096,
      maxThinkingTokens,
      workers,
      start,
      count,
      force,
      noRetryParse,
      runs,
      maxCost,
      tierBudgetsEnabled,
      tierBudgets,
    });

    const run = {
      process: child,
      output: [] as string[],
      progress: {
        completed: 0,
        total: 0,
        sequentialRuns: 1,
        perRunTotal: 0,
        currentTheoremId: "",
        currentModel: "",
        validCount: 0,
        invalidCount: 0,
        parseErrorCount: 0,
        apiErrorCount: 0,
        skippedCount: 0,
        costUsd: 0,
      },
      done: false,
      error: null as string | null,
    };

    activeRuns.set(runId, run);

    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        run.output.push(line);
        parseHarnessLine(line, run.progress);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        run.output.push(line);
      }
    });

    child.on("close", (code) => {
      run.done = true;
      if (code !== 0 && code !== null) {
        // Collect last few output lines for context
        const tail = run.output.slice(-5).join("\n");
        run.error = `Process exited with code ${code}.\n${tail}`;
      }
      console.log(`[benchmark] Run ${runId} finished with code ${code}`);
    });

    child.on("error", (err) => {
      console.error(`[benchmark:${runId}:error] spawn error: ${err.message}`);
      run.done = true;
      run.error = err.message;
    });

    console.log(`[benchmark] Run ${runId} spawned successfully`);
    res.json({ runId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[benchmark] ERROR starting run:", err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/benchmark/status/:runId — SSE stream of harness output */
router.get("/status/:runId", (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const run = activeRuns.get(runId);

  if (!run) {
    res.status(404).json({ error: `Run '${runId}' not found` });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Skip already-sent log lines — client can reconnect mid-run
  let logCursor = run.output.length;

  let closed = false;

  const interval = setInterval(() => {
    if (closed) return;

    // Send any new log lines
    while (logCursor < run.output.length) {
      const line = run.output[logCursor];
      res.write(`data: ${JSON.stringify({ type: "log", message: line })}\n\n`);
      logCursor++;
    }

    // Always send current progress state
    const p = run.progress;
    res.write(`data: ${JSON.stringify({
      type: "progress",
      completed: p.completed,
      total: p.total,
      currentTheoremId: p.currentTheoremId,
      currentModel: p.currentModel,
      validCount: p.validCount,
      invalidCount: p.invalidCount,
      parseErrorCount: p.parseErrorCount,
      apiErrorCount: p.apiErrorCount,
      skippedCount: p.skippedCount,
    })}\n\n`);

    // If done, send final event and close
    if (run.done) {
      clearInterval(interval);
      if (run.error) {
        res.write(`data: ${JSON.stringify({ type: "error", error: run.error })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({
          type: "complete",
          completed: p.completed,
          total: p.total,
          validCount: p.validCount,
          invalidCount: p.invalidCount,
          parseErrorCount: p.parseErrorCount,
          apiErrorCount: p.apiErrorCount,
          skippedCount: p.skippedCount,
          message: "Benchmark run complete",
        })}\n\n`);
      }
      res.end();
      // Clean up after a delay
      setTimeout(() => activeRuns.delete(runId), 60_000);
    }
  }, 500);

  // Handle client disconnect — only stop the SSE interval, NOT the child process
  req.on("close", () => {
    closed = true;
    clearInterval(interval);
  });
});

/** POST /api/benchmark/stop/:runId — kill a running benchmark */
router.post("/stop/:runId", (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const run = activeRuns.get(runId);

  if (!run) {
    res.status(404).json({ error: `Run '${runId}' not found` });
    return;
  }

  if (!run.done) {
    run.process.kill("SIGTERM");
    run.done = true;
    run.error = "Stopped by user";
  }

  res.json({ success: true });
});

/** GET /api/benchmark/active — list currently active (not done) run IDs */
router.get("/active", (_req: Request, res: Response) => {
  const active: string[] = [];
  for (const [id, run] of activeRuns) {
    if (!run.done) active.push(id);
  }
  res.json({ runIds: active });
});

export default router;
