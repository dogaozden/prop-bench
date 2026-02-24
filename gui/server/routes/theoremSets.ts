import { Router, Request, Response } from "express";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { BENCHMARKS_DIR } from "../cli";

const require_ = createRequire(import.meta.url);
const dbModule: any = require_("../../../db");

const router = Router();

/** GET /api/theorem-sets — list all theorem set directories */
router.get("/", (_req: Request, res: Response) => {
  try {
    console.log("[theorem-sets] GET / - BENCHMARKS_DIR:", BENCHMARKS_DIR);

    if (!fs.existsSync(BENCHMARKS_DIR)) {
      console.log("[theorem-sets] BENCHMARKS_DIR does not exist, returning empty array");
      res.json([]);
      return;
    }

    const entries = fs.readdirSync(BENCHMARKS_DIR, { withFileTypes: true });
    const sets: { name: string; path: string; count: number }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const theoremsFile = path.join(BENCHMARKS_DIR, entry.name, "theorems.json");
      if (!fs.existsSync(theoremsFile)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(theoremsFile, "utf-8"));
        sets.push({
          name: entry.name,
          path: theoremsFile,
          count: Array.isArray(data) ? data.length : 0,
        });
      } catch (jsonErr) {
        console.error(`[theorem-sets] Failed to parse ${theoremsFile}:`, jsonErr);
      }
    }

    console.log(`[theorem-sets] Returning ${sets.length} sets`);
    res.json(sets);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[theorem-sets] ERROR:", err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/theorem-sets/:name — read theorems from a specific set */
router.get("/:name", (req: Request, res: Response) => {
  try {
    const name = String(req.params.name);
    const theoremsFile = path.join(BENCHMARKS_DIR, name, "theorems.json");

    console.log(`[theorem-sets] GET /${name} - theoremsFile:`, theoremsFile);

    if (!fs.existsSync(theoremsFile)) {
      console.log(`[theorem-sets] File not found: ${theoremsFile}`);
      res.status(404).json({ error: `Theorem set '${name}' not found` });
      return;
    }

    const data = JSON.parse(fs.readFileSync(theoremsFile, "utf-8"));
    console.log(`[theorem-sets] Returning ${Array.isArray(data) ? data.length : 0} theorems for set ${name}`);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[theorem-sets] ERROR for set ${req.params.name}:`, err);
    res.status(500).json({ error: msg });
  }
});

/** DELETE /api/theorem-sets/:name — delete a theorem set (DB + files) */
router.delete("/:name", (req: Request, res: Response) => {
  try {
    const name = String(req.params.name);
    console.log(`[theorem-sets] DELETE /${name}`);

    // Delete from DB (cascades to theorems, results, runs, reports)
    dbModule.deleteTheoremSet(name);

    // Delete the directory on disk
    const setDir = path.join(BENCHMARKS_DIR, name);
    if (fs.existsSync(setDir)) {
      fs.rmSync(setDir, { recursive: true, force: true });
    }

    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[theorem-sets] DELETE ERROR for ${req.params.name}:`, err);
    res.status(500).json({ error: msg });
  }
});

export default router;
