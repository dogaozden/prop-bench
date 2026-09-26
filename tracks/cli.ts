import * as path from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { PROJECT_ROOT, prepareRun, loadRun, listSets, gradeRun, listReports, compareReports, readJson, readRegularFile } from "./core";
import type { PrepareOptions } from "./types";
import { runUnaided } from "./unaided";
import { prepareFrontier, submitFrontier } from "./frontier";
import { serveBridge, executeForRun } from "./bridge";
import { runFrontier } from "./frontier-runner";
import { runSubscription } from "./subscription-runner";
import { isSubscriptionProvider } from "./types";

const HELP = [
"PropBench Frontier and Unaided — versioned evaluations",
"",
"npm run tracks -- sets",
"npm run tracks -- prepare --track unaided --set rehearsal --provider fixture --model fixture",
"npm run tracks -- run-unaided --run PATH --fixture-responses FILE",
"npm run tracks -- prepare --track unaided --set v2 --provider codex-subscription --model gpt-6-astra --effort xhigh --seconds 900",
"npm run tracks -- run-unaided --run PATH",
"npm run tracks -- run-frontier --run PATH [--fixture-responses FILE]",
"npm run tracks -- prepare --track frontier --mode fresh --set v2 --provider codex-subscription --model gpt-6-astra --effort xhigh --tool-calls 96",
"npm run tracks -- prepare --track frontier --mode fresh --set v2 --provider external --model AGENT_ID",
"npm run tracks -- prepare --track frontier --mode cumulative --snapshot BUNDLE --set v2 --model MODEL",
"npm run tracks -- sandbox --run PATH -- /bin/sh -c 'ls; echo hello'",
"npm run tracks -- bridge --run PATH",
"npm run tracks -- handoff --run PATH",
"npm run tracks -- submit --run PATH --proofs BUNDLE/proofs",
"npm run tracks -- grade --run PATH",
"npm run tracks -- compare --root PATH",
"",
"Options: --ids ID,ID; --validator FILE; --run-root DIR; --bundle DIR;",
"--seconds N; --generations N; --tokens N; --thinking N; --temperature N.",
"Subscription controls: --effort LEVEL; --tool-calls N; --seconds N.",
"Subscriptions use native logged-in clients; API token controls do not meter their internal inference.",
"Sets default to v2. Default private records: propbench/track-runs.",
"Frontier bundles: ../propbench-contestants/<id>, outside the owner repo.",
"Only the sandbox bridge exposes contestant tools. An ordinary host checkout",
"is not isolated. API credentials stay in owner-side provider runners.",
"Legacy golf/Elo scores remain unchanged; efficiency-v2 is a separate score."
].join("\n") + "\n";

function args(argv: string[]): { command: string; opts: Record<string,string>; rest: string[] } {
  const [command = "help", ...input] = argv;
  const opts: Record<string, string> = {};
  let rest: string[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "--") { rest = input.slice(i + 1); break; }
    const key = input[i];
    if (!key.startsWith("--") || !input[i + 1] || input[i + 1].startsWith("--") || opts[key.slice(2)] !== undefined) throw new Error("Expected a unique --option VALUE: " + key);
    opts[key.slice(2)] = input[++i];
  }
  const supported = ["track", "mode", "set", "provider", "model", "tokens", "thinking", "seconds", "generations", "temperature", "ids", "validator", "run-root", "bundle", "snapshot", "run", "fixture-responses", "proofs", "root", "effort", "tool-calls"];
  for (const key of Object.keys(opts)) if (!supported.includes(key)) throw new Error("Unknown option --" + key);
  return { command, opts, rest };
}
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const required = (opts: Record<string, string>, key: string): string => {
  if (!opts[key]) throw new Error("--" + key + " is required");
  return opts[key];
};
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, opts, rest } = args(argv);
  const validator = path.resolve(opts.validator ?? path.join(PROJECT_ROOT, "target/release/propbench"));
  const runRoot = path.resolve(opts["run-root"] ?? opts.root ?? path.join(PROJECT_ROOT, "track-runs"));
  if (command === "help" || command === "--help") { process.stdout.write(HELP); return; }
  if (command === "sets") { output(listSets()); return; }
  if (command === "prepare") {
    if (opts.provider && !["codex-subscription", "fixture", "external"].includes(opts.provider)) throw new Error("New Tracks evaluations use Codex subscriptions only; fixture and external are explicit local test/handoff modes");
    const track = required(opts, "track");
    if (!["frontier", "unaided"].includes(track)) throw new Error("--track must be frontier or unaided");
    const setName = opts.set ?? "v2";
    const setDir = path.isAbsolute(setName) || setName.includes(path.sep) ? path.resolve(setName) : path.join(PROJECT_ROOT, "golf/set", setName);
    const prepare: PrepareOptions = {
      root: runRoot, setDir, ids: opts.ids?.split(","), track: track as PrepareOptions["track"],
      mode: (track === "unaided" ? "unaided" : opts.mode ?? "fresh") as PrepareOptions["mode"],
      provider: (opts.provider ?? "codex-subscription") as PrepareOptions["provider"],
      model: required(opts, "model"), temperature: Number(opts.temperature ?? "0.2"), validator,
      budget: { wall_seconds: Number(opts.seconds ?? "3600"), max_generations: Number(opts.generations ?? "24"),
        max_output_tokens: Number(opts.tokens ?? "8192"), max_thinking_tokens: Number(opts.thinking ?? "8192") },
    };
    if (isSubscriptionProvider(prepare.provider)) prepare.subscription = {
      effort: opts.effort ?? (prepare.provider === "claude-subscription" ? "max" : "xhigh"),
      max_tool_calls: Number(opts["tool-calls"] ?? (track === "unaided" ? "0" : "96")),
    };
    const ctx = track === "unaided" ? prepareRun(prepare) : prepareFrontier(prepare,
      path.resolve(opts.bundle ?? path.join(PROJECT_ROOT, "../propbench-contestants", randomUUID())), opts.snapshot ? path.resolve(opts.snapshot) : undefined);
    output({ run: ctx.dir, config: ctx.config, ...(track === "frontier" ? { frontier: readJson(path.join(ctx.dir, "frontier.json")) } : {}) });
    return;
  }
  if (command === "run-unaided") {
    const ctx = loadRun(path.resolve(required(opts, "run")));
    if (isSubscriptionProvider(ctx.config.provider)) {
      if (opts["fixture-responses"]) throw new Error("Subscription clients cannot use fixture responses");
      output(await runSubscription(ctx, { validator: opts.validator ? validator : path.join(ctx.dir, "referee/validator") })); return;
    }
    if (ctx.config.provider !== "fixture") dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
    const fixtureResponses = opts["fixture-responses"] ? readJson<Record<string, unknown>>(path.resolve(opts["fixture-responses"])) : undefined;
    if (fixtureResponses && ctx.config.provider !== "fixture") throw new Error("Fixture responses require an explicitly fixture-labeled run");
    output(await runUnaided(ctx, { validator: opts.validator ? validator : path.join(ctx.dir, "referee/validator"), fixtureResponses }));
    return;
  }
  if (command === "run-frontier") {
    const ctx = loadRun(path.resolve(required(opts, "run")));
    if (isSubscriptionProvider(ctx.config.provider)) {
      if (opts["fixture-responses"]) throw new Error("Subscription clients cannot use fixture responses");
      output(await runSubscription(ctx, { validator: opts.validator ? validator : path.join(ctx.dir, "referee/validator") })); return;
    }
    if (ctx.config.provider !== "fixture") dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
    const fixtureResponses = opts["fixture-responses"] ? readJson<unknown[]>(path.resolve(opts["fixture-responses"])) : undefined;
    if (fixtureResponses && ctx.config.provider !== "fixture") throw new Error("Fixture responses require an explicitly fixture-labeled run");
    output(await runFrontier(ctx, { validator: opts.validator ? validator : path.join(ctx.dir, "referee/validator"), fixtureResponses }));
    return;
  }
  if (command === "grade") { output(await gradeRun(path.resolve(required(opts, "run")), opts.validator ? validator : undefined)); return; }
  if (command === "submit") {
    const runDir = path.resolve(required(opts, "run"));
    output(await submitFrontier(runDir, path.resolve(required(opts, "proofs")), opts.validator ? validator : path.join(runDir, "referee/validator")));
    return;
  }
  if (command === "compare") { output(compareReports(await listReports(runRoot))); return; }
  if (command === "sandbox") {
    if (!rest.length) throw new Error("sandbox requires -- COMMAND [ARGS]");
    const result = await executeForRun(path.resolve(required(opts, "run")), rest);
    output(result); process.exitCode = result.exitCode; return;
  }
  if (command === "bridge") { await serveBridge(path.resolve(required(opts, "run"))); return; }
  if (command === "handoff") {
    const ctx = loadRun(path.resolve(required(opts, "run")));
    if (ctx.config.track !== "frontier") throw new Error("Handoff is for Frontier");
    if (ctx.config.execution_protocol !== "external-mcp-v1") throw new Error("Controlled Frontier uses run-frontier. Prepare --provider external for an unmetered MCP handoff");
    const info = readJson<{bundle_dir: string}>(path.join(ctx.dir, "frontier.json"));
    output({ run: ctx.dir, bundle: info.bundle_dir, goal: readRegularFile(path.join(info.bundle_dir, "GOAL.md")).toString(),
      mcp_server: { command: process.execPath, args: ["--require", path.join(PROJECT_ROOT, "node_modules/ts-node/register"), path.join(PROJECT_ROOT, "tracks/cli.ts"), "bridge", "--run", ctx.dir],
        ...(process.env.PROPBENCH_DOCKER_HOST ? { env: { PROPBENCH_DOCKER_HOST: process.env.PROPBENCH_DOCKER_HOST } } : {}) },
      requirement: "Start a fresh agent context with ONLY this MCP server as its filesystem/execution access; give subagents the same boundary. Do not expose other host tools or old conversations. Model API communication remains controller-side." });
    return;
  }
  throw new Error("Unknown command " + command + "; use help");
}
if (require.main === module) main().catch(err => { process.stderr.write(String(err instanceof Error ? err.message : err) + "\n"); process.exitCode = 1; });
