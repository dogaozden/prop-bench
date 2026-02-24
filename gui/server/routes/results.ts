import { Router, Request, Response } from "express";
import { createRequire } from "node:module";

// Import db module from the prop-bench root. We use createRequire to avoid
// rootDir issues (db.ts lives outside gui/server's tsconfig rootDir).
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbModule: any = require_("../../../db");

const router = Router();

/** GET /api/runs — list all benchmark runs */
router.get("/", (_req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const runs = dbModule.getRunsList();
    res.json(runs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Stats endpoints — MUST come before the /:runId(*) catch-all
// ---------------------------------------------------------------------------

/** GET /api/runs/stats/overview — Dashboard overview */
router.get("/stats/overview", (_req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const overview = dbModule.getDashboardOverview();
    res.json(overview);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/stats/head-to-head/:setName — Head-to-head matrix */
router.get("/stats/head-to-head/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const cells = dbModule.getHeadToHeadMatrix(req.params.setName);
    res.json(cells);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/stats/latency/:setName? — Latency stats */
router.get("/stats/latency/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const stats = dbModule.getLatencyStats(req.params.setName);
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/stats/latency", (_req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const stats = dbModule.getLatencyStats();
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/stats/avg-lines-by-difficulty/:setName — Avg lines by difficulty */
router.get("/stats/avg-lines-by-difficulty/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const data = dbModule.getAvgLinesByDifficulty(req.params.setName);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/stats/avg-lines-by-difficulty", (_req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const data = dbModule.getAvgLinesByDifficulty();
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/stats/set-overview/:setName — Per-set overview */
router.get("/stats/set-overview/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const data = dbModule.getSetOverview(req.params.setName);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/stats/hardest-theorems/:setName — Hardest theorems */
router.get("/stats/hardest-theorems/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const data = dbModule.getHardestTheorems(req.params.setName, 15);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/stats/failures/:setName? — Failure analysis */
router.get("/stats/failures/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const analysis = dbModule.getFailureAnalysis(req.params.setName);
    res.json(analysis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/stats/failures", (_req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const analysis = dbModule.getFailureAnalysis();
    res.json(analysis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/individual/:setName? — get individual run records */
router.get("/individual/:setName", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const runs = dbModule.getIndividualRuns(req.params.setName);
    res.json(runs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/individual", (_req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const runs = dbModule.getIndividualRuns();
    res.json(runs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/individual/detail/:runId — get results for a specific individual run */
router.get("/individual/detail/:runId", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const results = dbModule.getIndividualRunDetail(req.params.runId);
    res.json(results);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/runs/:runId — get full results for a run */
router.get("/:runId(*)", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const { runId } = req.params;
    const detail = dbModule.getRunDetail(runId);
    res.json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** POST /api/runs/finish/:runId — force-finish a stale "Running" run */
router.post("/finish/:runId", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const runId = parseInt(req.params.runId, 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }
    dbModule.finishRun(runId);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** DELETE /api/runs/:runId — delete a run's results */
router.delete("/:runId(*)", (req: Request, res: Response) => {
  try {
    if (!dbModule.dbExists()) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const { runId } = req.params;
    dbModule.deleteRun(runId);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
