import type { RequestHandler } from "express";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export function assertLocalHost(host: string): void {
  if (!LOOPBACK.has(host.toLowerCase())) throw new Error("The owner console must bind to a loopback host. Publish the static publication/ site instead.");
}

export function localAccess(apiPort: number, webPort = 3000): RequestHandler {
  const ports = new Set([String(apiPort), String(webPort)]);
  const localUrl = (value: string, hostOnly = false): boolean => {
    try {
      const url = new URL(hostOnly ? `http://${value}` : value);
      return ["http:", "https:"].includes(url.protocol) && LOOPBACK.has(url.hostname.toLowerCase()) && ports.has(url.port) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
  };
  return (req, res, next) => {
    // Host validation also blocks DNS rebinding. A public origin cannot read
    // private records or submit a run, even if it can reach localhost.
    if (!localUrl(req.headers.host ?? "", true)) { res.status(403).json({error:"Local owner console only"}); return; }
    const origin = req.headers.origin;
    if ((origin && !localUrl(origin)) || req.headers["sec-fetch-site"] === "cross-site") { res.status(403).json({error:"Cross-origin owner-console access denied"}); return; }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  };
}
