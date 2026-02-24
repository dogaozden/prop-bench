import { Router, Request, Response } from "express";
import { loadTierPresets, saveTierPresets } from "../cli";

const router = Router();

// GET /api/tier-presets — return current presets
router.get("/", (req: Request, res: Response) => {
  const presets = loadTierPresets();
  res.json(presets);
});

// PUT /api/tier-presets — save updated presets
router.put("/", (req: Request, res: Response) => {
  try {
    const presets = req.body;
    // Basic validation: must be an object with tier names as keys
    if (!presets || typeof presets !== "object") {
      res.status(400).json({ error: "Invalid presets object" });
      return;
    }
    saveTierPresets(presets);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
