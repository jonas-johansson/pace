import { z } from "zod";
import { delay, emitEvent, fetchWithRetry } from "@pace/llm";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Search ─────────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

type ExaResponse = {
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
};

const RATE_LIMIT_ERROR = /rate.?limit|too many requests|\b429\b/i;
// Some hosted Exa errors omit isError. Match only the known notice at the
// beginning of the response, never keywords buried in ordinary search results.
const FREE_LIMIT_NOTICE = /^you['’]ve hit exa['’]s free mcp rate limit\b/i;

const failure = (text: string): ToolOutput => ({
  content: [{ type: "text", text }],
  is_error: true,
});

function resultText(data: ExaResponse): string {
  return (data.result?.content ?? [])
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n\n");
}

// Exa reports rate limits either as JSON-RPC errors inside a 200 response or,
// worse, as a *successful* MCP result whose content text says the free MCP
// rate limit was hit. The HTTP-level 429 retry in fetchWithRetry never
// triggers for either, so we detect both shapes and retry the whole request.
// Ordinary search results that merely mention rate limits must not match.
function rateLimitMessage(data: ExaResponse): string | null {
  const error = data.error?.message ?? "";
  if (data.error?.code === 429 || RATE_LIMIT_ERROR.test(error)) {
    return error || "Exa rate limit exceeded";
  }
  const content = resultText(data);
  if (
    (data.result?.isError && RATE_LIMIT_ERROR.test(content)) ||
    FREE_LIMIT_NOTICE.test(content.trimStart())
  ) {
    return content;
  }
  return null;
}

function isExaResponse(value: unknown): value is ExaResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (("result" in value &&
      typeof value.result === "object" &&
      value.result !== null) ||
      ("error" in value &&
        typeof value.error === "object" &&
        value.error !== null))
  );
}

function parseExaResponse(text: string, contentType: string): ExaResponse {
  // Some proxies omit Content-Type. JSON is also allowed by our Accept header.
  if (
    contentType.includes("application/json") ||
    text.trimStart().startsWith("{")
  ) {
    const data: unknown = JSON.parse(text);
    if (isExaResponse(data)) return data;
    throw new Error("Invalid Exa MCP response");
  }

  // SSE data fields can omit the space, span multiple lines, or be accompanied
  // by comments/notifications. Only a result/error is a tool response.
  let response: ExaResponse | undefined;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const payload = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!payload.trim() || payload.trim() === "[DONE]") continue;
    const data: unknown = JSON.parse(payload);
    if (isExaResponse(data)) response = data;
  }
  if (!response) throw new Error("No tool result in Exa MCP response");
  return response;
}

export const webSearchTool = defineTool({
  name: "websearch",
  concurrency: "safe",
  description:
    "Search the web for current information, news, facts, or any topic.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    numResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(5)
      .describe("Number of results to return (default 5)"),
  }),
  truncateOutput: false,
  showContent: false,
  titleFormatter: (input) => `websearch: ${input.query ?? ""}`,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const { query, numResults } = input;
    const apiKey = process.env.EXA_API_KEY?.trim();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    // Keep credentials out of URLs, persisted tool inputs, and prompts.
    if (apiKey) headers["x-api-key"] = apiKey;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults },
      },
    });

    // fetchWithRetry already retries HTTP-level 429 responses; what reaches
    // this loop is a successful response, so only MCP-level limits retry here.
    for (let attempt = 0; ; attempt++) {
      const response = await fetchWithRetry(
        EXA_MCP_URL,
        {
          method: "POST",
          signal,
          headers,
          body,
        },
        signal,
      );

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Exa MCP request failed with status ${response.status}: ${text.slice(0, 500)}`,
        );
      }

      const data = parseExaResponse(
        text,
        response.headers.get("content-type") ?? "",
      );

      const rateLimitMsg = rateLimitMessage(data);

      if (!rateLimitMsg) {
        if (data.error) {
          throw new Error(data.error.message ?? "Exa MCP request failed");
        }
        const output = resultText(data) || JSON.stringify(data, null, 2);
        if (data.result?.isError) return failure(output);
        return { content: [{ type: "text", text: output }] };
      }

      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `Exa rate limit persisted after ${MAX_RETRIES} retries with exponential backoff: ` +
            rateLimitMsg.slice(0, 200) +
            " — wait for the quota to reset or configure EXA_API_KEY for higher limits.",
        );
      }

      const waitMs =
        Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt)) +
        Math.random() * 1000;
      emitEvent("rate-limit-retry", {
        url: EXA_MCP_URL,
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        waitMs,
      });
      await delay(waitMs, signal);
    }
  },
});
