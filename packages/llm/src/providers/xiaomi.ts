/**
 * Xiaomi MiMo provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://api.xiaomimimo.com/v1/chat/completions. Model IDs are the
 * all-lowercase MiMo names (e.g. "mimo-v2.6-pro"). Thinking is on by
 * default server-side and surfaces as `reasoning_content`, which the
 * shared implementation streams and replays across tool-calling turns.
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";

export class XiaomiProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "xiaomi",
      displayName: "Xiaomi MiMo",
      apiKey: process.env.XIAOMI_API_KEY,
      missingKeyMessage:
        "Missing API key for Xiaomi MiMo. Set the XIAOMI_API_KEY environment variable.",
      // Token Plan subscribers get a regional base URL alongside their key.
      baseUrl: process.env.XIAOMI_BASE_URL ?? DEFAULT_BASE_URL,
      // MiMo names the output cap `max_completion_tokens`; it bounds visible
      // and reasoning tokens together.
      maxTokensField: "max_completion_tokens",
      useFetchRetry: true,
    });
  }
}
