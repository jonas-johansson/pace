/**
 * TensorX provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://api.tensorx.ai/v1/chat/completions. Model IDs are the
 * org-qualified names shown in the TensorX catalogue
 * (e.g. "z-ai/glm-5.3-flash").
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://api.tensorx.ai/v1";

export class TensorXProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "tensorx",
      displayName: "TensorX",
      apiKey: process.env.TENSORX_API_KEY,
      missingKeyMessage:
        "Missing API key for TensorX. Set the TENSORX_API_KEY environment variable.",
      baseUrl: process.env.TENSORX_BASE_URL ?? DEFAULT_BASE_URL,
      useFetchRetry: true,
    });
  }
}
