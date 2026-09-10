/**
 * Tests for OpenAI-compatible provider wire formatting, using a stubbed
 * fetch. Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import type { ProviderMessage, ToolDefinition } from "@pace/llm";

// @pace/llm compiles to CommonJS without named ESM exports; use createRequire
// for the runtime class (type-only imports from the same package are fine).
const require = createRequire(import.meta.url);
const { OpenAiCompatibleProvider } = require("@pace/llm/providers/openai-compatible") as {
  OpenAiCompatibleProvider: new (opts: {
    providerId: string;
    displayName: string;
    baseUrl: string;
  }) => TestProvider;
};

/** Minimal shape of the provider surface this test exercises. */
interface TestProvider {
  stream(req: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<AsyncIterable<unknown>>;
}

function captureFetch(bodies: unknown[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    return new Response(
      "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeProvider() {
  return new OpenAiCompatibleProvider({
    providerId: "test",
    displayName: "Test",
    baseUrl: "https://example.test/v1",
  });
}

const tools: ToolDefinition[] = [
  {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

function assistantWithToolCall(input: unknown): ProviderMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "go" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tc1", name: "write", input }],
    },
  ];
}

test("replays valid JSON tool arguments verbatim", async () => {
  const bodies: unknown[] = [];
  const restore = captureFetch(bodies);
  try {
    const provider = makeProvider();
    await provider.stream({
      model: "m",
      system: "s",
      messages: assistantWithToolCall({ path: "a.ts" }),
      tools,
      maxTokens: 100,
    });
    const msgs = (bodies[0] as { messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[] }).messages;
    const assistant = msgs.find((m) => m.role === "assistant");
    assert.equal(assistant!.tool_calls![0].function.arguments, JSON.stringify({ path: "a.ts" }));
  } finally {
    restore();
  }
});

test("sanitizes malformed JSON tool arguments on replay", async () => {
  const bodies: unknown[] = [];
  const restore = captureFetch(bodies);
  try {
    const provider = makeProvider();
    // Raw string input that is not valid JSON (as stored after a
    // malformed streamed tool call).
    await provider.stream({
      model: "m",
      system: "s",
      messages: assistantWithToolCall('{"path": "a.ts", broken'),
      tools,
      maxTokens: 100,
    });
    const msgs = (bodies[0] as { messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[] }).messages;
    const assistant = msgs.find((m) => m.role === "assistant");
    const args = JSON.parse(assistant!.tool_calls![0].function.arguments);
    assert.ok(typeof args === "object" && args !== null, "arguments must parse as a JSON object");
    assert.equal((args as { _raw?: string })._raw, '{"path": "a.ts", broken');
  } finally {
    restore();
  }
});

function captureFetchWithHeaders(requests: { body: unknown; headers: Record<string, string> }[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push({
      body: JSON.parse(init?.body as string),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(
      "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("sends the session header when a session id is provided", async () => {
  const requests: { body: unknown; headers: Record<string, string> }[] = [];
  const restore = captureFetchWithHeaders(requests);
  try {
    const provider = new OpenAiCompatibleProvider({
      providerId: "test",
      displayName: "Test",
      baseUrl: "https://example.test/v1",
      sessionHeader: "x-opencode-session",
    });
    await provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools,
      maxTokens: 100,
      sessionId: "session-123",
    } as Parameters<typeof provider.stream>[0]);
    assert.equal(requests[0].headers["x-opencode-session"], "session-123");
  } finally {
    restore();
  }
});

test("omits the session header when no session id is provided", async () => {
  const requests: { body: unknown; headers: Record<string, string> }[] = [];
  const restore = captureFetchWithHeaders(requests);
  try {
    const provider = new OpenAiCompatibleProvider({
      providerId: "test",
      displayName: "Test",
      baseUrl: "https://example.test/v1",
      sessionHeader: "x-opencode-session",
    });
    await provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools,
      maxTokens: 100,
    });
    assert.equal(requests[0].headers["x-opencode-session"], undefined);
  } finally {
    restore();
  }
});
