/**
 * Provider-agnostic types and interface.
 */

// ── Content blocks ───────────────────────────────────────────────────────────

export type TextBlock = {
  type: "text";
  text: string;
};

export type ImageBlock = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultPart = {
  type: "text";
  text: string;
} | ImageBlock;

export type ToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultPart[];
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock;

// ── Messages ─────────────────────────────────────────────────────────────────

export type UserMessage = {
  role: "user";
  content: Array<TextBlock | ImageBlock | ToolResultContent>;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
  /**
   * Provider-specific metadata needed to faithfully continue conversations.
   * Examples: Anthropic raw content blocks, OpenAI Responses output items,
   * OpenCode Zen reasoning_content.
   */
  providerMetadata?: unknown;
};

export type ProviderMessage = UserMessage | AssistantMessage;

// ── Streaming events ─────────────────────────────────────────────────────────

export type TextStartEvent = {
  type: "text_start";
  text: string;
};

export type TextDeltaEvent = {
  type: "text_delta";
  text: string;
};

export type ReasoningStartEvent = {
  type: "reasoning_start";
  text: string;
};

export type ReasoningDeltaEvent = {
  type: "reasoning_delta";
  text: string;
};

export type ToolUseStartEvent = {
  type: "tool_use_start";
  id: string;
  name: string;
};

export type ToolInputDeltaEvent = {
  type: "tool_input_delta";
  id: string;
  partialJson: string;
};

export type BlockStopEvent = {
  type: "block_stop";
  id?: string;
};

export type StreamEvent =
  | TextStartEvent
  | TextDeltaEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolInputDeltaEvent
  | BlockStopEvent;

// ── Usage / response ─────────────────────────────────────────────────────────

export type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type ProviderResponse = {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use";
  usage: UsageInfo;
  providerMetadata?: unknown;
};

export type ProviderStream = {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  finalMessage(): Promise<ProviderResponse>;
};

// ── Tool definition (provider-agnostic) ──────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Content blocks a tool may return to the model. Providers map these into
 * their own wire formats.
 */
export type ToolOutputContent = Array<TextBlock | ImageBlock>;

// ── Output budget ────────────────────────────────────────────────────────────

/**
 * Reserve this many tokens in the context window for tokenization differences
 * between Pace's estimates and the provider's count. Without it, a request
 * whose input plus advertised output limit exactly fits the window can still
 * be rejected upstream.
 */
export const OUTPUT_BUDGET_SAFETY_MARGIN_TOKENS = 4_000;

/**
 * Cap a model's advertised output limit so `input + requested_output` stays
 * inside the context window.
 *
 * Some models advertise output limits that consume the entire context window
 * (e.g. gemini-4-argon allows 943,718 output tokens in a 1,048,576-token
 * window). Providers that validate requests against the context length reject
 * any request where the input prompt plus the output budget overshoots the
 * window, even when the input alone is far below the limit. Pass the current
 * request's input size (as reported by a prior response's usage) to keep the
 * output budget within the remaining window.
 *
 * Accepts a raw number so callers that already track input tokens can apply it
 * without building a request first. When `contextWindow` is unknown (<= 0),
 * the advertised limit is returned unchanged.
 */
export function capOutputTokensForContext(
  contextWindow: number,
  maxOutputTokens: number,
  inputTokens: number,
): number {
  if (contextWindow <= 0) return maxOutputTokens;
  const remaining = contextWindow - inputTokens - OUTPUT_BUDGET_SAFETY_MARGIN_TOKENS;
  return Math.min(maxOutputTokens, Math.max(1, remaining));
}

// ── Provider interface ───────────────────────────────────────────────────────

export interface Provider {
  stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    /** Provider-native options for the selected model variant. */
    providerOptions?: Record<string, unknown>;
    signal?: AbortSignal;
    /**
     * Stable identifier for the current conversation, when the caller tracks
     * one. Providers that support session affinity (e.g. OpenCode Go's
     * `x-opencode-session`) use it for routing and prompt caching; others
     * ignore it.
     */
    sessionId?: string;
  }): Promise<ProviderStream>;
}
