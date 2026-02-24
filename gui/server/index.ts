import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from prop-bench root (parent of gui/)
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname2, "..", "..", ".env"), override: true });

import express from "express";
import cors from "cors";
import { createRequire } from "node:module";

// Ensure DB schema exists on server startup
const require_ = createRequire(import.meta.url);
const dbModule: any = require_("../../db");
try { dbModule.initSchema(); } catch (e: any) { console.warn("[propbench] DB init failed:", e.message); }

import generateRoutes from "./routes/generate";
import validateRoutes from "./routes/validate";
import theoremSetRoutes from "./routes/theoremSets";
import benchmarkRoutes from "./routes/benchmark";
import resultsRoutes from "./routes/results";
import tierPresetsRoutes from "./routes/tierPresets";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Routes
app.use("/api/generate", generateRoutes);
app.use("/api/validate", validateRoutes);
app.use("/api/theorem-sets", theoremSetRoutes);
app.use("/api/benchmark", benchmarkRoutes);
app.use("/api/runs", resultsRoutes);
app.use("/api/tier-presets", tierPresetsRoutes);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`PropBench API server listening on http://localhost:${PORT}`);
});
