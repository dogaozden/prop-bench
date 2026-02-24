import { Router, Request, Response } from "express";
import { generate } from "../cli";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { count, distribution, tier, spec, name, maxNodes, maxDepth } = req.body;

    console.log(`[generate] POST / - Generating ${count} theorems for set '${name}' (mode: ${tier ? "tier" : spec ? "spec" : "distribution"})`);

    if (!count || !name) {
      res.status(400).json({ error: "Missing required fields: count, name" });
      return;
    }

    if (typeof count !== "number" || count < 1) {
      res.status(400).json({ error: "count must be a positive number" });
      return;
    }

    if (typeof name !== "string" || !name.match(/^[a-zA-Z0-9_-]+$/)) {
      res.status(400).json({ error: "name must be alphanumeric (with dashes/underscores)" });
      return;
    }

    // At least one generation mode must be specified (or none for default)
    if (distribution && typeof distribution !== "string") {
      res.status(400).json({ error: "distribution must be a string like '30:easy,30:medium,...'" });
      return;
    }

    if (tier && typeof tier !== "string") {
      res.status(400).json({ error: "tier must be a string like 'easy', 'expert', etc." });
      return;
    }

    if (maxNodes !== undefined && (typeof maxNodes !== "number" || maxNodes < 1)) {
      res.status(400).json({ error: "maxNodes must be a positive number" });
      return;
    }

    if (maxDepth !== undefined && (typeof maxDepth !== "number" || maxDepth < 1)) {
      res.status(400).json({ error: "maxDepth must be a positive number" });
      return;
    }

    const result = await generate({ count, name, distribution, tier, spec, maxNodes, maxDepth });
    console.log(`[generate] Successfully generated ${result.theorems.length} theorems at ${result.path}`);
    res.json({ success: true, path: result.path, theorems: result.theorems });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate] ERROR:", err);
    res.status(500).json({ error: msg });
  }
});

export default router;
