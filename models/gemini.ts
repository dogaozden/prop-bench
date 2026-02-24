import { GoogleGenAI } from "@google/genai";
import type { ModelAdapter, ModelConfig, ModelResponse } from "./index";

const DEFAULT_MODEL = "gemini-2.5-flash-lite-preview-09-2025";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes (thinking models need longer on hard theorems)

export class GeminiAdapter implements ModelAdapter {
  name: string;
  displayName: string;
  private defaultModel: string;

  constructor(name = "gemini-2.5-flash-lite-preview-09-2025", displayName = "Gemini 2.5 Flash Lite", defaultModel = DEFAULT_MODEL) {
    this.name = name;
    this.displayName = displayName;
    this.defaultModel = defaultModel;
  }

  async callModel(prompt: string, config: ModelConfig): Promise<ModelResponse> {
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY not set. Provide it via env var or config.apiKey."
      );
    }

    const modelName = config.model || this.defaultModel;
    const client = new GoogleGenAI({ apiKey });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const start = performance.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;
        // If systemPrompt is provided, prepend it to the user prompt
        const fullPrompt = config.systemPrompt
          ? `${config.systemPrompt}\n\n${prompt}`
          : prompt;

        try {
          response = await client.models.generateContent({
            model: modelName,
            contents: fullPrompt,
            config: {
              temperature: config.temperature ?? 0.2,
              // Gemini counts thinking tokens toward maxOutputTokens, so add
              // the thinking budget on top of the desired output token limit.
              maxOutputTokens: (config.maxTokens ?? 4096) + (config.maxThinkingTokens ?? 10000),
              thinkingConfig: { thinkingBudget: config.maxThinkingTokens ?? 10000 },
              abortSignal: controller.signal,
            },
          });
        } finally {
          clearTimeout(timeout);
        }
        const latency_ms = Math.round(performance.now() - start);

        const finishReason = response.candidates?.[0]?.finishReason;

        // Extract text from response
        let text = response.text ?? "";
        if (!text && response.candidates) {
          for (const candidate of response.candidates) {
            for (const part of candidate.content?.parts ?? []) {
              if (part.text) {
                text += part.text;
              }
            }
          }
        }

        const usage = response.usageMetadata;

        return {
          raw_response: text,
          latency_ms,
          model: modelName,
          tokens_used: usage?.totalTokenCount ?? undefined,
          thinking_tokens: usage?.thoughtsTokenCount ?? undefined,
          finish_reason: finishReason ?? undefined,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const message = lastError.message.toLowerCase();

        const isRateLimit =
          message.includes("429") ||
          message.includes("rate") ||
          message.includes("quota") ||
          message.includes("resource_exhausted");

        const isTransient =
          message.includes("fetch failed") ||
          message.includes("econnreset") ||
          message.includes("etimedout") ||
          message.includes("enotfound") ||
          message.includes("socket hang up") ||
          message.includes("network") ||
          message.includes("aborted") ||
          message.includes("503") ||
          message.includes("502");

        // Rate limit errors: throw immediately, let the harness handle retries
        // (avoids double retry loops: adapter 5x * harness 10x = 50 wasted calls)
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
            `[gemini] Transient error: ${lastError.message} — retrying in ${Math.round(delay + jitter)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await sleep(delay + jitter);
        }
      }
    }

    throw lastError ?? new Error("Gemini API call failed after retries");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
