/**
 * Tests for the TensorX provider: catalog metadata and wire format.
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { getModelConfig } from "@pace/llm";
import type { ProviderMessage, ToolDefinition } from "@pace/llm";

// @pace/llm compiles to CommonJS without named ESM exports; use createRequire
// for the runtime class (type-only imports from the same package are fine).
const require = createRequire(import.meta.url);
const { TensorXProvider } = require("@pace/llm/providers/tensorx") as {
  TensorXProvider: new () => TestProvider;
};

interface TestProvider {
  stream(req: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<AsyncIterable<unknown>>;
}

const tools: ToolDefinition[] = [
  {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

// ── Catalog ─────────────────────────────────────────────────────────────────

test("tensorx/z-ai/glm-5.3-flash carries TensorX's published model metadata", () => {
  const config = getModelConfig("tensorx/z-ai/glm-5.3-flash");
  assert.ok(config, "tensorx/z-ai/glm-5.3-flash should exist in the catalog");
  assert.equal(config.provider, "tensorx");
  assert.equal(config.providerModel, "z-ai/glm-5.3-flash");
  assert.equal(config.contextWindow, 1_000_000);
  assert.equal(config.maxOutputTokens, 131_072);
  assert.equal(config.supportsImages, true);
  assert.deepEqual(config.pricing, {
    inputPerMTok: 0.20,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.05,
    outputPerMTok: 0.50,
  });
  assert.deepEqual(config.variants?.low.providerOptions, { reasoning_effort: "low" });
  assert.deepEqual(config.variants?.high.providerOptions, { reasoning_effort: "high" });
  assert.deepEqual(config.variants?.max.providerOptions, { reasoning_effort: "max" });
});

// ── Wire format ─────────────────────────────────────────────────────────────

type CapturedRequest = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function captureRequests(requests: CapturedRequest[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(init?.body as string),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function streamOnce(provider: TestProvider) {
  await provider.stream({
    model: "z-ai/glm-5.3-flash",
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools,
    maxTokens: 131_072,
  });
}

test("sends TensorX's Chat Completions wire format", async () => {
  const requests: CapturedRequest[] = [];
  const restore = captureRequests(requests);
  const priorKey = process.env.TENSORX_API_KEY;
  const priorBaseUrl = process.env.TENSORX_BASE_URL;
  process.env.TENSORX_API_KEY = "test-key";
  delete process.env.TENSORX_BASE_URL;
  try {
    await streamOnce(new TensorXProvider());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.tensorx.ai/v1/chat/completions");
    assert.equal(requests[0].headers["Authorization"], "Bearer test-key");

    const body = requests[0].body;
    assert.equal(body.model, "z-ai/glm-5.3-flash");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 131_072);
  } finally {
    restore();
    if (priorKey === undefined) delete process.env.TENSORX_API_KEY;
    else process.env.TENSORX_API_KEY = priorKey;
    if (priorBaseUrl === undefined) delete process.env.TENSORX_BASE_URL;
    else process.env.TENSORX_BASE_URL = priorBaseUrl;
  }
});

test("TENSORX_BASE_URL overrides the endpoint", async () => {
  const requests: CapturedRequest[] = [];
  const restore = captureRequests(requests);
  const priorKey = process.env.TENSORX_API_KEY;
  const priorBaseUrl = process.env.TENSORX_BASE_URL;
  process.env.TENSORX_API_KEY = "test-key";
  process.env.TENSORX_BASE_URL = "https://proxy.example.com/v1";
  try {
    await streamOnce(new TensorXProvider());
    assert.equal(requests[0].url, "https://proxy.example.com/v1/chat/completions");
  } finally {
    restore();
    if (priorKey === undefined) delete process.env.TENSORX_API_KEY;
    else process.env.TENSORX_API_KEY = priorKey;
    if (priorBaseUrl === undefined) delete process.env.TENSORX_BASE_URL;
    else process.env.TENSORX_BASE_URL = priorBaseUrl;
  }
});

test("throws a helpful error when TENSORX_API_KEY is missing", () => {
  const priorKey = process.env.TENSORX_API_KEY;
  delete process.env.TENSORX_API_KEY;
  try {
    assert.throws(() => new TensorXProvider(), /TENSORX_API_KEY/);
  } finally {
    if (priorKey !== undefined) process.env.TENSORX_API_KEY = priorKey;
  }
});
