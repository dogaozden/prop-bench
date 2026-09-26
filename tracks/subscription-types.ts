import type { Usage } from "./types";

export type SubscriptionProvider = "claude-subscription" | "codex-subscription";
export interface SubscriptionToolRejection {
  tool: "exec" | "delegate";
  /** Preserve the exact native input for the owner receipt; never execute it. */
  arguments: unknown;
  native_call_id: string;
}
export interface SubscriptionTools {
  exec(command: string[]): Promise<unknown>;
  delegate(task: string): Promise<unknown>;
  /** Must charge the shared allowance and durably record rejected input. */
  reject?(rejection: SubscriptionToolRejection): Promise<unknown>;
}
/** The CLI owns its internal inference loop. Token counts are observations, not caps. */
export interface SubscriptionSessionOptions {
  model: string;
  effort: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  eventsPath: string;
  tools?: SubscriptionTools;
  signal?: AbortSignal;
}
export interface SubscriptionSessionResult {
  text: string;
  model: string;
  client_version: string;
  auth_type: string;
  usage: Usage;
  tool_calls: string[];
  /** Enforced tool surface; the evidence source is recorded separately. */
  available_tools: string[];
  tool_catalog_source?: string;
  session_id?: string;
  error?: string;
}
