import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import tracksRouter from "./tracks";

test("new Tracks requests reject non-Codex providers before preparing a run", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/tracks", tracksRouter);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const setsResponse = await fetch(`${origin}/api/tracks/sets`);
    assert.equal(setsResponse.status, 200);
    const sets = await setsResponse.json() as { name: string }[];
    assert.ok(sets.length > 0);

    for (const endpoint of ["unaided", "frontier", "frontier/prepare", "frontier/run"]) {
      for (const provider of ["claude-subscription", "gemini", "openrouter", "external"]) {
        const response = await fetch(`${origin}/api/tracks/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ set: sets[0].name, provider, model: "gpt-6-astra" }),
        });
        assert.equal(response.status, 400, `${endpoint} accepted ${provider}`);
        const payload = await response.json() as { error: string };
        assert.match(payload.error, /native Codex subscription or an explicit local fixture/);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
