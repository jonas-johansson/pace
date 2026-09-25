/**
 * OpenRouter provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://openrouter.ai/api/v1/chat/completions. Model IDs are the
 * vendor-qualified OpenRouter slugs (e.g. "xiaomi/mimo-v2.6-pro") and pass
 * through unmodified.
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "openrouter",
      displayName: "OpenRouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      missingKeyMessage:
        "Missing API key for OpenRouter. Set the OPENROUTER_API_KEY environment variable.",
      baseUrl: process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL,
      // OpenRouter model slugs ("vendor/model") are used verbatim.
      mapModel: (model) => model,
      // Prefer Fireworks as the upstream provider; OpenRouter may still route
      // to other providers when Fireworks is unavailable for the model.
      defaultBody: {
        provider: { order: ["Fireworks"], allow_fallbacks: true },
      },
      // Optional attribution headers OpenRouter uses for app rankings.
      extraHeaders: { "X-Title": "Pace" },
      useFetchRetry: true,
    });
  }
}
