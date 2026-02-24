import OpenAI from "openai";
import type { ModelAdapter, ModelConfig, ModelResponse } from "./index";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes (thinking models need longer)

// Display names for well-known OpenRouter models
const DISPLAY_NAMES: Record<string, string> = {
  "anthropic/claude-opus-4-6": "Claude Opus 4.6",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "anthropic/claude-haiku-3.5": "Claude Haiku 3.5",
  "openai/gpt-4o": "GPT-4o",
  "openai/gpt-4o-mini": "GPT-4o Mini",
  "openai/o3-mini": "o3-mini",
  "google/gemini-2.5-pro": "Gemini 2.5 Pro",
  "google/gemini-2.5-flash": "Gemini 2.5 Flash",
  "google/gemini-2.0-flash-001": "Gemini 2.0 Flash",
  "google/gemini-3-flash-preview": "Gemini 3 Flash",
  "google/gemini-3-pro-preview": "Gemini 3 Pro",
  "meta-llama/llama-4-maverick": "Llama 4 Maverick",
  "meta-llama/llama-4-scout": "Llama 4 Scout",
  "deepseek/deepseek-r1": "DeepSeek R1",
  "deepseek/deepseek-chat": "DeepSeek V3",
  "mistralai/mistral-large-2": "Mistral Large 2",
  "qwen/qwen-2.5-72b-instruct": "Qwen 2.5 72B",
};

export class OpenRouterAdapter implements ModelAdapter {
  name: string;
  displayName: string;

  constructor(modelId: string) {
    this.name = modelId;
    this.displayName = DISPLAY_NAMES[modelId] ?? modelId;
  }

  async callModel(prompt: string, config: ModelConfig): Promise<ModelResponse> {
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY not set. Provide it via env var or config.apiKey."
      );
    }

    const modelName = config.model || this.name;
    const client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/dogaozden/prop-bench",
        "X-Title": "PropBench",
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const start = performance.now();
        // Build messages: if systemPrompt is provided, use structured messages
        // with cache_control for Anthropic prompt caching (90% input cost savings)
        const messages: any[] = config.systemPrompt
          ? [
              {
                role: "system",
                content: [
                  {
                    type: "text",
                    text: config.systemPrompt,
                    cache_control: { type: "ephemeral" },
                  },
                ],
              },
              { role: "user", content: prompt },
            ]
          : [{ role: "user", content: prompt }];

        const completion = await client.chat.completions.create({
          model: modelName,
          temperature: config.temperature ?? 0.2,
          max_tokens: config.maxTokens ?? 4096,
          messages,
          // @ts-ignore — OpenRouter-specific extension for thinking models
          reasoning: config.maxThinkingTokens ? { max_tokens: config.maxThinkingTokens } : undefined,
          // @ts-ignore — OpenRouter-specific extension for effort level
          verbosity: "max",
        });
        const latency_ms = Math.round(performance.now() - start);

        const rawContent = completion.choices[0]?.message?.content;
        const raw_response = rawContent ?? "";

        // Warn on null content (data loss on cutoff responses)
        if (rawContent === null || rawContent === undefined) {
          const fr = completion.choices[0]?.finish_reason;
          console.warn(
            `[openrouter] WARNING: API returned null content (finish_reason=${fr}, model=${modelName}). Response may be lost.`
          );
        }

        const tokens_used = completion.usage
          ? (completion.usage.prompt_tokens ?? 0) +
            (completion.usage.completion_tokens ?? 0)
          : undefined;

        const thinking_tokens = (completion.usage as any)?.completion_tokens_details?.reasoning_tokens ?? undefined;
        const finish_reason = completion.choices[0]?.finish_reason ?? undefined;

        // Debug: log full usage breakdown to diagnose token accounting anomalies
        if (completion.usage) {
          console.log(`[openrouter] Token usage for ${modelName}: ${JSON.stringify(completion.usage, null, 2)}`);
        }

        return {
          raw_response,
          latency_ms,
          model: modelName,
          tokens_used,
          thinking_tokens,
          finish_reason,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const message = lastError.message.toLowerCase();

        const isRateLimit =
          message.includes("429") ||
          message.includes("rate") ||
          message.includes("quota");

        const isTransient =
          message.includes("fetch failed") ||
          message.includes("econnreset") ||
          message.includes("etimedout") ||
          message.includes("enotfound") ||
          message.includes("socket hang up") ||
          message.includes("network") ||
          message.includes("503") ||
          message.includes("502");

        // Rate limit errors: throw immediately, let the harness handle retries
        if (isRateLimit) {
          throw lastError;
        }

        if (!isTransient) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          const jitter = Math.random() * delay * 0.1;
          console.warn(
            `[openrouter] Transient error: ${lastError.message} — retrying in ${Math.round(delay + jitter)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await sleep(delay + jitter);
        }
      }
    }

    throw lastError ?? new Error("OpenRouter API call failed after retries");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
