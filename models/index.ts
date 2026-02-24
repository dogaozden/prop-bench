import { GeminiAdapter } from "./gemini";
import { OpenRouterAdapter } from "./openrouter";

export interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxThinkingTokens?: number;
  apiKey?: string;
  /** Static system prompt for caching (OpenRouter/Anthropic). If set, `prompt` in callModel is just the user message. */
  systemPrompt?: string;
}

export interface ModelResponse {
  raw_response: string;
  latency_ms: number;
  model: string;
  tokens_used?: number;
  thinking_tokens?: number;
  finish_reason?: string;
}

export interface ModelAdapter {
  name: string;
  displayName: string;
  callModel(prompt: string, config: ModelConfig): Promise<ModelResponse>;
}

// Direct Gemini API adapters — these use GEMINI_API_KEY directly
const GEMINI_ALIASES: Record<string, () => ModelAdapter> = {
  "gemini-2.5-pro": () => new GeminiAdapter("gemini-2.5-pro", "Gemini 2.5 Pro", "gemini-2.5-pro"),
  "gemini-2.5-flash": () => new GeminiAdapter("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini-2.5-flash"),
  "gemini-2.0-flash": () => new GeminiAdapter("gemini-2.0-flash", "Gemini 2.0 Flash", "gemini-2.0-flash"),
  "gemini-2.5-flash-lite-preview-09-2025": () => new GeminiAdapter(),
  "gemini-3-flash-preview": () => new GeminiAdapter("gemini-3-flash-preview", "Gemini 3 Flash", "gemini-3-flash-preview"),
  "gemini-3-pro-preview": () => new GeminiAdapter("gemini-3-pro-preview", "Gemini 3 Pro", "gemini-3-pro-preview"),
  "gemini-3.1-pro-preview": () => new GeminiAdapter("gemini-3.1-pro-preview", "Gemini 3.1 Pro", "gemini-3.1-pro-preview"),
};

/**
 * Create a model adapter by name.
 *
 * Known Gemini model names (e.g., "gemini-2.5-flash") use the direct Gemini API.
 * Everything else (e.g., "anthropic/claude-sonnet-4.5") is routed through OpenRouter.
 */
export function getModel(name: string): ModelAdapter {
  const factory = GEMINI_ALIASES[name.toLowerCase()];
  if (factory) {
    return factory();
  }
  // Fall through to OpenRouter for any unknown model name
  return new OpenRouterAdapter(name);
}

export { GeminiAdapter, OpenRouterAdapter };
