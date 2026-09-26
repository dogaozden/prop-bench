import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { SubscriptionSessionOptions, SubscriptionSessionResult } from "./subscription-types";
import { assertAuditedCodexRuntime, resolveCodexRuntime } from "./codex-runtime";

const DISABLED_FEATURES = [
  "apps", "auth_elicitation", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "code_mode", "code_mode_only", "code_mode_host", "code_mode_interrupt", "code_mode_prewarm",
  "computer_use", "context_management", "current_time_reminder", "default_mode_request_user_input",
  "deferred_executor", "fast_mode", "goals", "hooks", "codex_hooks", "plugin_hooks",
  "image_generation", "imagegenext", "in_app_browser", "in_app_chat", "in_app_dictation",
  "in_app_local_automation", "in_app_updates", "js_repl", "js_repl_tools_only", "memories", "memory_tool",
  "mentions_v2", "multi_agent", "multi_agent_v2", "plugins", "plugin_sharing", "recommended_plugins",
  "remote_plugin", "request_permissions_tool", "send_async_message", "shell_tool", "shell_snapshot",
  "skill_search", "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "sleep_tool",
  "step_model_switching", "token_budget", "tool_call_mcp_elicitation", "tool_search", "tool_suggest",
  "unavailable_dummy_tools", "view_image", "workspace_dependencies", "external_agent_memory_import",
  "agent_message_board", "artifact", "chronicle", "codex_apps_mcp_2026_07_28",
  "deferred_tool_world_state", "enable_mcp_apps", "executor_capability_discovery",
  "realtime_conversation", "reasoning_effort_override", "send_message_to_user_async",
  "shell_snapshot_v2", "standalone_web_search", "terminal_visualization_instructions", "worktrees",
];
type Json = Record<string, any>;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function subscriptionEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTHORIZATION|BASE_URL|API_URL|CUSTOM_HEADERS|KEY_HELPER/i.test(key)
      || /^(AWS_|AZURE_|GOOGLE_|ANTHROPIC_|OPENAI_|OPENROUTER_|NODE_OPTIONS|NODE_PATH|TS_NODE_|CLAUDE_CODE_|DYLD_|LD_)/.test(key)
      || (key.startsWith("CODEX_") && key !== "CODEX_HOME")) delete env[key];
  }
  // Keep the user's real HOME/CODEX_HOME and let the native client read its own
  // existing login. We never read, copy, or inject authentication credentials.
  return env;
}

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = (value as string).split(secret).join("[REDACTED]");
    return (value as string).replace(/\bsk-[\w-]{16,}\b/g, "[REDACTED]").replace(/Bearer\s+[\w.~/+=-]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map(entry => redact(entry,secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(email|.*(?:secret|password|credential|cookie|authorization).*|(?:access|refresh|id|auth|oauth|session)?token|(?:api|private|access)key)$/i.test(key.replace(/[_-]/g,"")) ? "[REDACTED]" : redact(entry,secrets)]));
  return value;
}

/** Validate the native session boundary before executing any callback. */
export class CodexTurnGuard {
  private turnId?: string;
  private calls = new Map<string,string>();
  private completed = false;
  constructor(private threadId: string, private frontier: boolean) {}
  start(turn: Json) {
    if (this.completed || !turn || typeof turn.id !== "string" || !turn.id || (this.turnId && this.turnId !== turn.id)) throw new Error("Codex protocol violation: unexpected turn");
    this.turnId = turn.id;
  }
  private session(params: Json, needsTurn = true) {
    if (params?.threadId !== this.threadId || (needsTurn && (!this.turnId || params.turnId !== this.turnId))) throw new Error("Codex protocol violation: wrong session or turn");
  }
  private dynamic(call: Json): Json {
    if (!this.frontier || call.namespace != null) throw new Error("Codex protocol violation: unexpected dynamic tool surface");
    const input = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
    if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).length !== 1) throw new Error("Codex protocol violation: invalid tool arguments");
    if (call.tool === "exec" && Array.isArray(input.command) && input.command.length > 0 && input.command.length <= 256 && input.command.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0") && arg.length <= 100000)) return input;
    if (call.tool === "delegate" && typeof input.task === "string" && input.task.trim() && input.task.length <= 100000) return input;
    throw new Error(`Codex protocol violation: invalid dynamic tool ${call.tool}`);
  }
  private item(item: Json) {
    if (item?.type === "dynamicToolCall") this.dynamic(item);
    else if (!["userMessage","reasoning","agentMessage"].includes(item?.type)) throw new Error(`Codex protocol violation: unexpected item ${item?.type}`);
  }
  request(event: Json): Json {
    if (this.completed) throw new Error("Codex protocol violation: tool request after terminal event");
    if (event.method !== "item/tool/call") throw new Error(`Codex protocol violation: unexpected request ${event.method}`);
    const call = event.params;
    this.session(call);
    const input = this.dynamic(call);
    if (typeof call.callId !== "string" || !call.callId || this.calls.has(call.callId)) throw new Error("Codex protocol violation: missing or duplicate tool call ID");
    this.calls.set(call.callId,JSON.stringify([call.tool,input]));
    return input;
  }
  event(event: Json) {
    const p = event.params;
    if (this.completed && (event.method === "turn/started" || event.method?.startsWith("item/"))) throw new Error("Codex protocol violation: item or turn after terminal event");
    if (p?.threadId !== undefined && p.threadId !== this.threadId) throw new Error("Codex protocol violation: wrong session");
    if (event.method === "turn/started") { this.session(p,false); this.start(p.turn); }
    else if (event.method?.startsWith("item/")) {
      this.session(p);
      if (event.method === "item/started" || event.method === "item/completed") {
        this.item(p.item);
        if (p.item.type === "dynamicToolCall") {
          if (typeof p.item.id !== "string" || !p.item.id) throw new Error("Codex protocol violation: missing streamed tool call ID");
          if (event.method === "item/completed" && this.calls.get(p.item.id) !== JSON.stringify([p.item.tool,this.dynamic(p.item)])) throw new Error("Codex protocol violation: unobserved or mismatched streamed tool call");
        }
      }
      else if (!["item/agentMessage/delta","item/reasoning/summaryTextDelta","item/reasoning/summaryPartAdded","item/reasoning/textDelta"].includes(event.method)) throw new Error(`Codex protocol violation: unexpected event ${event.method}`);
    } else if (event.method === "turn/completed") {
      if (this.completed) throw new Error("Codex protocol violation: duplicate terminal event");
      this.session({...p,turnId:p?.turn?.id});
      // 0.158 sends only the last message in its terminal summary. Every live
      // item is checked above; validate terminal items too without mistaking a
      // summary for a full transcript (ephemeral threads have no saved history).
      if (!Array.isArray(p.turn.items) || (p.turn.itemsView !== undefined && !["full","summary","notLoaded"].includes(p.turn.itemsView))) throw new Error("Codex protocol violation: invalid terminal items view");
      p.turn.items.forEach((item: Json) => this.item(item));
      for (const item of p.turn.items.filter((item: Json)=>item.type === "dynamicToolCall")) {
        if (this.calls.get(item.id) !== JSON.stringify([item.tool,this.dynamic(item)])) throw new Error("Codex protocol violation: unobserved or mismatched terminal tool call");
      }
      this.completed = true;
    } else if (event.method === "model/rerouted") throw new Error("Codex model rerouted; fallback forbidden");
  }
}

// Every native spawn is its own process group. Never signal the owner's group.
function signalGroup(child: {pid?:number}, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid,signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function reapGroup(child: {pid?:number}) {
  if (!child.pid) return;
  signalGroup(child,"SIGTERM");
  for (let i=0;i<20;i++) {
    try { process.kill(-child.pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  signalGroup(child,"SIGKILL");
}
function toml(value: unknown): string {
  if (typeof value === "object" && value && !Array.isArray(value)) return `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function constrainedCatalog(catalog: Json, model: string, effort: string): Json {
  const found = catalog.models?.find((entry: Json) => entry.slug === model);
  if (!found) throw new Error(`Codex bundled catalog does not contain requested model ${model}; no fallback allowed`);
  if (!found.supported_reasoning_levels?.some((entry: Json) => entry.effort === effort)) throw new Error(`Codex model ${model} does not support effort ${effort}`);
  return { models: [{ ...found, tool_mode: "direct", shell_type: "disabled", apply_patch_tool_type: null,
    experimental_supported_tools: [], node_repl_disabled: true, supports_search_tool: false,
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false }] };
}

export function restrictedConfig(catalogPath: string, mcpNames: string[]): Json {
  if (mcpNames.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error("Cannot safely override an unusual native MCP server name");
  return {
    model_provider: "openai", model_catalog_json: catalogPath, forced_login_method: "chatgpt",
    openai_base_url: "", chatgpt_base_url: "https://chatgpt.com/backend-api/",
    service_tier: "default", web_search: "disabled", project_doc_max_bytes: 0,
    developer_instructions: "", instructions: "", include_environment_context: false,
    model_instructions_file: path.join(path.dirname(catalogPath),"benchmark-instructions.md"), "skills.include_instructions": false, "skills.bundled.enabled": false,
    include_apps_instructions: false, include_collaboration_mode_instructions: false,
    include_permissions_instructions: false,
    "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
    "agents.enabled": false, "memories.generate_memories": false, "memories.use_memories": false,
    "features.skip_host_skill_discovery": true,
    ...Object.fromEntries(DISABLED_FEATURES.map(name => [`features.${name}`, false])),
    ...Object.fromEntries(mcpNames.map(name => [`mcp_servers.${name}.enabled`, false])),
  };
}

export function assertIsolatedThread(thread: Json, model: string, effort: string): void {
  if (thread?.model !== model || thread.modelProvider !== "openai" || thread.reasoningEffort !== effort
    || !Array.isArray(thread.instructionSources) || thread.instructionSources.length
    || !Array.isArray(thread.runtimeWorkspaceRoots) || thread.runtimeWorkspaceRoots.length
    || thread.approvalPolicy !== "never" || thread.sandbox?.type !== "readOnly"
    || (thread.serviceTier != null && thread.serviceTier !== "default")) {
    throw new Error("Codex thread isolation mismatch: requested model, effort, normal speed, instructions, roots, or permissions did not resolve exactly");
  }
}

export function assertConstrainedCatalog(resolved: Json, model: string): Json {
  const found = resolved.models?.find((entry: Json) => entry.slug === model);
  if (resolved.models?.length !== 1 || !found || found.tool_mode !== "direct" || found.shell_type !== "disabled"
    || found.apply_patch_tool_type != null || !Array.isArray(found.experimental_supported_tools) || found.experimental_supported_tools.length
    || found.node_repl_disabled !== true || found.supports_search_tool !== false
    || found.include_skills_usage_instructions !== false || found.include_plugin_usage_instructions !== false || found.include_apps_usage_instructions !== false) {
    throw new Error("Codex constrained model catalog did not resolve; refusing inference");
  }
  return found;
}

export function assertRestrictedConfig(effective: Json, expected: Json, report?: Json): void {
  for (const [key,value] of Object.entries(expected)) {
    // config/read preserves the caller's raw dotted feature name as a key within features.
    let actual = key.startsWith("features.") ? effective.features?.[key.slice(9)] : key.split(".").reduce((current,part)=>current?.[part],effective);
    // Native 0.158 ToolsV2 only serializes web_search. Verify the two omitted
    // recognized controls against their winning session-layer origins instead.
    if (["tools.update_plan.enabled","tools.experimental_request_user_input.enabled"].includes(key)) {
      const layer = report?.layers?.find((entry: Json)=>entry.name?.type === "sessionFlags" && !entry.disabledReason);
      if (report?.origins?.[key]?.name?.type !== "sessionFlags") throw new Error(`Codex isolation control has no winning session origin: ${key}`);
      actual = key.split(".").reduce((current,part)=>current?.[part],layer?.config);
    }
    if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error(`Codex isolation setting did not resolve exactly: ${key}`);
  }
  for (const [name,server] of Object.entries(effective.mcp_servers ?? {})) {
    if ((server as Json).enabled !== false) throw new Error(`Codex MCP server remained enabled: ${name}`);
  }
}

async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached:true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => { failure ??= error; signalGroup(child,"SIGTERM"); killTimer ??= setTimeout(() => signalGroup(child,"SIGKILL"), 1000); };
    const timer = setTimeout(() => stop(new Error("Codex initialization wall-clock timeout")), timeoutMs);
    child.stdout.on("data", chunk => { out += chunk; if (out.length > 8_000_000) stop(new Error("Codex initialization output limit")); });
    child.stderr.on("data", chunk => { err = (err + chunk).slice(-16000); });
    child.on("error", error => { failure ??= error; });
    child.on("close", code => { clearTimeout(timer); clearTimeout(killTimer); void reapGroup(child).then(()=>{ if (failure) reject(failure); else if (code !== 0) reject(new Error(`Codex initialization failed: ${redact(err)}`)); else resolve(out); },reject); });
  });
}

class NativeRpc {
  child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private closed = false;
  private failure?: Error;
  private killTimer?: NodeJS.Timeout;
  private timer: NodeJS.Timeout;
  readonly exited: Promise<void>;
  onEvent: (event: Json) => void = () => {};
  onRequest: (event: Json) => Promise<unknown> = async event => { throw new Error(`Unexpected native request ${event.method}`); };
  onFailure: (error: Error) => void = () => {};
  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, private record: (event: unknown) => void) {
    this.child = spawn(executable, args, { cwd, env, detached:true, stdio: ["pipe", "pipe", "pipe"] });
    this.timer = setTimeout(() => this.abort(new Error("Codex session wall-clock timeout")), timeoutMs);
    this.exited = new Promise(resolve => this.child.on("close", () => {
      this.closed = true; clearTimeout(this.timer); clearTimeout(this.killTimer);
      const error = this.failure ?? new Error("Codex app-server closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear(); this.onFailure(error); void reapGroup(this.child).catch(error=>this.onFailure(error)).finally(resolve);
    }));
    this.child.on("error", error => this.abort(error));
    this.child.stdin.on("error", error => { if (!this.closed) this.abort(error); });
    this.child.stderr.on("data", chunk => { try { this.record({ type: "native_stderr", text: String(chunk).slice(0,32000) }); } catch (error) { this.abort(new Error(errorText(error))); } });
    this.child.stdout.on("data", chunk => {
      try {
        this.buffer += chunk;
        if (this.buffer.length > 8_000_000) throw new Error("Codex event line exceeds limit");
        let end;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0,end); this.buffer = this.buffer.slice(end+1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
      } catch (error) { this.abort(new Error(errorText(error))); }
    });
  }
  private receive(event: Json) {
    if (this.failure) return;
    // Account and configuration responses can contain unrelated personal data.
    // Their relevant redacted controls are recorded by the caller instead.
    if (event.method) this.record(event);
    if (event.id !== undefined && !event.method) {
      const pending = this.pending.get(event.id); this.pending.delete(event.id);
      if (event.error) pending?.reject(new Error(event.error.message ?? JSON.stringify(event.error))); else pending?.resolve(event.result);
    } else if (event.id !== undefined && event.method) {
      void this.onRequest(event).then(result => this.send({ id: event.id, result }), error => {
        this.send({ id: event.id, error: { code: -32000, message: errorText(error) } });
        this.abort(new Error(errorText(error)));
      }).catch(error => this.abort(new Error(errorText(error))));
    } else this.onEvent(event);
  }
  send(value: unknown) { if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  request(method: string, params: unknown): Promise<any> {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error("Codex app-server closed"));
    const id = ++this.sequence;
    return new Promise((resolve,reject) => { this.pending.set(id,{resolve,reject}); this.send({id,method,params}); });
  }
  abort(error: Error) { this.failure ??= error; this.onFailure(this.failure); this.stop(); }
  stop() {
    if (this.closed) return;
    signalGroup(this.child,"SIGTERM");
    this.killTimer ??= setTimeout(() => signalGroup(this.child,"SIGKILL"), 1000);
  }
}

export async function runCodexSession(options: SubscriptionSessionOptions): Promise<SubscriptionSessionResult> {
  if (process.platform !== "darwin") throw new Error("Codex instruction isolation requires audited macOS sandbox-exec; this platform is not audited");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid Codex timeout");
  if (fs.readdirSync(options.cwd).length) throw new Error("Codex session requires an empty working directory");
  const deadline = performance.now() + options.timeoutMs;
  const remaining = () => { const ms = Math.floor(deadline - performance.now()); if (ms <= 0) throw new Error("Codex session wall-clock timeout"); return ms; };
  const env = subscriptionEnvironment(process.env);
  const secrets = Object.entries(process.env).filter(([key,value])=>value && env[key] === undefined && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)).map(([,value])=>value!);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "propbench-codex-config-"));
  const fd = fs.openSync(options.eventsPath, "wx", 0o600);
  let bytes = 0;
  const record = (event: unknown) => {
    const line = JSON.stringify(redact(event,secrets)) + "\n"; bytes += Buffer.byteLength(line);
    if (bytes > 64 * 1024 * 1024) throw new Error("Codex event archive exceeded limit");
    fs.writeSync(fd, line);
  };
  let rpc: NativeRpc | undefined;
  const onAbort = () => rpc?.abort(new Error("Codex session wall-clock timeout"));
  try {
    const runtime = resolveCodexRuntime();
    const executable = runtime.path;
    const executableHash = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    const version = (await command(executable,["--version"],options.cwd,env,remaining())).trim();
    assertAuditedCodexRuntime(version,executableHash);
    const auth = await command(executable,["login","status"],options.cwd,env,remaining());
    // Some native releases print login status on stderr. The app-server account
    // check below is authoritative and happens before any model turn.
    void auth;
    const catalog = constrainedCatalog(JSON.parse(await command(executable,["debug","models","--bundled"],options.cwd,env,remaining())),options.model,options.effort);
    const catalogPath = path.join(work,"models.json"); fs.writeFileSync(catalogPath,JSON.stringify(catalog),{mode:0o600});
    fs.writeFileSync(path.join(work,"benchmark-instructions.md"),options.systemPrompt,{mode:0o600});
    const baseArgs = Object.entries(restrictedConfig(catalogPath,[])).flatMap(([key,value]) => ["-c",`${key}=${toml(value)}`]);
    const mcp = JSON.parse(await command(executable,[...baseArgs,"mcp","list","--json"],options.cwd,env,remaining()));
    if (!Array.isArray(mcp) || mcp.some(entry => typeof entry.name !== "string")) throw new Error("Cannot enumerate native MCP servers");
    const config = restrictedConfig(catalogPath,mcp.map(entry => entry.name));
    const args = Object.entries(config).flatMap(([key,value]) => ["-c",`${key}=${toml(value)}`]);
    // Verify the installed binary accepts and resolves the static model metadata.
    const resolved = JSON.parse(await command(executable,[...args,"debug","models"],options.cwd,env,remaining()));
    const model = assertConstrainedCatalog(resolved,options.model);
    record({type:"native_control_audit",client_version:version,executable_sha256:executableHash,
      executable_path:executable,runtime_resolution:runtime.source,
      model:options.model,effort:options.effort,catalog:{...model,model_messages:undefined,base_instructions:undefined},
      config:{...config,model_catalog_json:"[per-session temporary catalog]"},environments:[],
      available_tools:options.tools ? ["exec","delegate"] : [],
      tool_catalog_source:"pinned native client; resolved static model metadata and effective configuration; no environment; explicit dynamic tools"});
    // Codex's global AGENTS.md loader is independent of project_doc_max_bytes.
    // Deny only those optional instruction files for this process, preserving
    // the real login directory and every native authentication mechanism.
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(),".codex");
    const deniedInstructions = ["AGENTS.md","AGENTS.override.md"].flatMap(name => {
      const file = path.join(codexHome,name);
      return fs.existsSync(file) ? [file,fs.realpathSync(file)] : [file];
    });
    const profile = `(version 1) (allow default) (deny file-read* ${[...new Set(deniedInstructions)].map(file => `(literal ${JSON.stringify(file)})`).join(" ")})`;
    record({type:"instruction_isolation",mechanism:"macOS process sandbox read denial",denied_files:[...new Set(deniedInstructions)]});
    rpc = new NativeRpc("/usr/bin/sandbox-exec",["-p",profile,executable,...args,"app-server"],options.cwd,env,remaining(),record);
    options.signal?.addEventListener("abort",onAbort,{once:true});
    options.signal?.throwIfAborted();
    await rpc.request("initialize",{clientInfo:{name:"propbench_subscription",version:"1.0.0"},capabilities:{experimentalApi:true}});
    rpc.send({method:"initialized",params:{}});
    const account = await rpc.request("account/read",{refreshToken:false});
    if (account.account?.type !== "chatgpt" || account.requiresOpenaiAuth !== true) throw new Error("Codex requires an existing ChatGPT subscription login; API-key authentication is forbidden");
    record({type:"native_auth",auth_type:"chatgpt",plan_type:account.account.planType});
    const configReport = await rpc.request("config/read",{cwd:options.cwd,includeLayers:true});
    assertRestrictedConfig(configReport.config,config,configReport);
    const requirements = (await rpc.request("configRequirements/read",{})).requirements;
    if (requirements?.additional_developer_instructions?.trim()) throw new Error("Codex managed instructions would contaminate the benchmark");
    const dynamicTools = options.tools ? [
      {name:"exec",description:"Run argv in the isolated PropBench Docker workspace. Use /bin/sh -c for shell syntax. No host filesystem or network access.",inputSchema:{type:"object",properties:{command:{type:"array",items:{type:"string"}}},required:["command"],additionalProperties:false}},
      {name:"delegate",description:"Delegate a task to a fresh subscription session sharing the workspace and the run allowance.",inputSchema:{type:"object",properties:{task:{type:"string"}},required:["task"],additionalProperties:false}},
    ] : [];
    const thread = await rpc.request("thread/start",{model:options.model,modelProvider:"openai",allowProviderModelFallback:false,
      baseInstructions:options.systemPrompt,developerInstructions:"",cwd:options.cwd,ephemeral:true,environments:[],
      runtimeWorkspaceRoots:[],selectedCapabilityRoots:[],sandbox:"read-only",approvalPolicy:"never",
      config:{model_reasoning_effort:options.effort},dynamicTools});
    record({type:"native_thread",id:thread.thread.id,model:thread.model,provider:thread.modelProvider,reasoning_effort:thread.reasoningEffort,instruction_sources:thread.instructionSources,
      service_tier:thread.serviceTier,runtime_workspace_roots:thread.runtimeWorkspaceRoots,approval_policy:thread.approvalPolicy,sandbox:thread.sandbox});
    assertIsolatedThread(thread,options.model,options.effort);
    const result: SubscriptionSessionResult = {text:"",model:thread.model,client_version:version,auth_type:"chatgpt",usage:{},tool_calls:[],
      available_tools:dynamicTools.map(tool=>tool.name),session_id:thread.thread.id,
      tool_catalog_source:"resolved native configuration and static catalog; environments=[]; explicit dynamic tools"};
    let resolveTurn!: () => void, rejectTurn!: (error: Error) => void;
    const finished = new Promise<void>((resolve,reject) => {resolveTurn=resolve;rejectTurn=reject;});
    // Attach an error sink while waiting for turn/start to avoid an unhandled
    // rejection if the native child fails before that RPC completes.
    void finished.catch(()=>{});
    rpc.onFailure = rejectTurn;
    const guard = new CodexTurnGuard(thread.thread.id,!!options.tools);
    rpc.onRequest = async event => {
      if (event.method !== "item/tool/call" || !options.tools) throw new Error(`Codex protocol violation: unexpected tool/request ${event.method}`);
      const call = event.params;
      const input = guard.request(event);
      result.tool_calls.push(call.tool);
      let output;
      if (call.tool === "exec" && Array.isArray(input?.command) && Object.keys(input).length === 1) output = await options.tools.exec(input.command);
      else if (call.tool === "delegate" && typeof input?.task === "string" && Object.keys(input).length === 1) output = await options.tools.delegate(input.task);
      else throw new Error(`Codex protocol violation: invalid dynamic tool ${call.tool}`);
      const text = JSON.stringify(output);
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("Codex tool output exceeds limit");
      return {contentItems:[{type:"inputText",text}],success:true};
    };
    rpc.onEvent = event => {
      const p = event.params;
      guard.event(event);
      if (event.method === "item/completed") {
        const item = p.item;
        if (item.type === "agentMessage" && (item.phase === "final_answer" || !item.phase)) result.text = item.text;
        else if (!["userMessage","reasoning","agentMessage","dynamicToolCall"].includes(item.type)) rpc!.abort(new Error(`Codex protocol violation: unexpected item ${item.type}`));
      }
      if (event.method === "item/started" && !["userMessage","reasoning","agentMessage","dynamicToolCall"].includes(p.item.type)) rpc!.abort(new Error(`Codex protocol violation: unexpected item ${p.item.type}`));
      if (event.method === "thread/tokenUsage/updated") {
        const total = p.tokenUsage.total;
        result.usage = {input_tokens:total.inputTokens,output_tokens:total.outputTokens};
      }
      if (event.method === "model/rerouted") rpc!.abort(new Error("Codex model rerouted; fallback forbidden"));
      if (event.method === "turn/completed") {
        if (p.turn.status !== "completed") rejectTurn(new Error(`Codex turn ${p.turn.status}: ${p.turn.error?.message ?? "native client interrupted"}`));
        else resolveTurn();
      }
      if (event.method === "error" && p?.willRetry !== true) rejectTurn(new Error(`Codex native error: ${p.message ?? p.error?.message ?? JSON.stringify(p)}`));
    };
    const started = await rpc.request("turn/start",{threadId:thread.thread.id,model:options.model,effort:options.effort,environments:[],serviceTierForTurn:"default",
      input:[{type:"text",text:options.prompt,text_elements:[]}],approvalPolicy:"never"});
    guard.start(started.turn);
    await finished;
    if (!result.text.trim()) throw new Error("Codex subscription returned no final response");
    record({type:"native_result",result});
    return result;
  } finally {
    options.signal?.removeEventListener("abort",onAbort);
    if (rpc) { rpc.stop(); await rpc.exited; }
    fs.closeSync(fd); fs.rmSync(work,{recursive:true,force:true});
  }
}
