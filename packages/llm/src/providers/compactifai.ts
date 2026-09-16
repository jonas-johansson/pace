/**
 * CompactifAI provider (Multiverse Computing) — OpenAI-compatible Chat
 * Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://api.compactif.ai/v1/chat/completions
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://api.compactif.ai/v1";

export class CompactifAiProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "compactifai",
      displayName: "CompactifAI",
      apiKey: process.env.COMPACTIFAI_API_KEY,
      missingKeyMessage:
        "Missing API key for CompactifAI. Set the COMPACTIFAI_API_KEY environment variable.",
      baseUrl: process.env.COMPACTIFAI_BASE_URL ?? DEFAULT_BASE_URL,
      // Model ids pass through as-is (e.g. "quasar-438b").
      useFetchRetry: true,
    });
  }
}
