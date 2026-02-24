import { Router, Request, Response } from "express";
import { validate } from "../cli";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { theorem, proof } = req.body;

    if (!theorem || !proof) {
      res.status(400).json({ error: "Missing required fields: theorem, proof" });
      return;
    }

    if (!Array.isArray(proof)) {
      res.status(400).json({ error: "proof must be an array of proof lines" });
      return;
    }

    const result = await validate(theorem, proof);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
