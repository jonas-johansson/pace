/**
 * Tests for the Xiaomi MiMo provider: catalog metadata and wire format.
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
const { XiaomiProvider } = require("@pace/llm/providers/xiaomi") as {
  XiaomiProvider: new () => TestProvider;
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

test("xiaomi/mimo-v2.6-pro carries Xiaomi's published model metadata", () => {
  const config = getModelConfig("xiaomi/mimo-v2.6-pro");
  assert.ok(config, "xiaomi/mimo-v2.6-pro should exist in the catalog");
  assert.equal(config.provider, "xiaomi");
  assert.equal(config.providerModel, "mimo-v2.6-pro");
  assert.equal(config.contextWindow, 1_048_576);
  assert.equal(config.maxOutputTokens, 131_072);
  assert.equal(config.supportsImages, true);
  assert.deepEqual(config.pricing, {
    inputPerMTok: 0.435,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.0036,
    outputPerMTok: 0.87,
  });
  assert.deepEqual(config.variants?.think.providerOptions, { thinking: { type: "enabled" } });
  assert.deepEqual(config.variants?.nothink.providerOptions, { thinking: { type: "disabled" } });
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
    model: "mimo-v2.6-pro",
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools,
    maxTokens: 131_072,
  });
}

test("sends MiMo's Chat Completions wire format", async () => {
  const requests: CapturedRequest[] = [];
  const restore = captureRequests(requests);
  const priorKey = process.env.XIAOMI_API_KEY;
  const priorBaseUrl = process.env.XIAOMI_BASE_URL;
  process.env.XIAOMI_API_KEY = "test-key";
  delete process.env.XIAOMI_BASE_URL;
  try {
    await streamOnce(new XiaomiProvider());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(requests[0].headers["Authorization"], "Bearer test-key");

    const body = requests[0].body;
    assert.equal(body.model, "mimo-v2.6-pro");
    assert.equal(body.stream, true);
    // MiMo documents the token cap as `max_completion_tokens` only.
    assert.equal(body.max_completion_tokens, 131_072);
    assert.equal(body.max_tokens, undefined);
  } finally {
    restore();
    if (priorKey === undefined) delete process.env.XIAOMI_API_KEY;
    else process.env.XIAOMI_API_KEY = priorKey;
    if (priorBaseUrl === undefined) delete process.env.XIAOMI_BASE_URL;
    else process.env.XIAOMI_BASE_URL = priorBaseUrl;
  }
});

test("XIAOMI_BASE_URL overrides the endpoint (Token Plan)", async () => {
  const requests: CapturedRequest[] = [];
  const restore = captureRequests(requests);
  const priorKey = process.env.XIAOMI_API_KEY;
  const priorBaseUrl = process.env.XIAOMI_BASE_URL;
  process.env.XIAOMI_API_KEY = "tp-test-key";
  process.env.XIAOMI_BASE_URL = "https://token-plan-ams.xiaomimimo.com/v1";
  try {
    await streamOnce(new XiaomiProvider());
    assert.equal(requests[0].url, "https://token-plan-ams.xiaomimimo.com/v1/chat/completions");
  } finally {
    restore();
    if (priorKey === undefined) delete process.env.XIAOMI_API_KEY;
    else process.env.XIAOMI_API_KEY = priorKey;
    if (priorBaseUrl === undefined) delete process.env.XIAOMI_BASE_URL;
    else process.env.XIAOMI_BASE_URL = priorBaseUrl;
  }
});

test("throws a helpful error when XIAOMI_API_KEY is missing", () => {
  const priorKey = process.env.XIAOMI_API_KEY;
  delete process.env.XIAOMI_API_KEY;
  try {
    assert.throws(() => new XiaomiProvider(), /XIAOMI_API_KEY/);
  } finally {
    if (priorKey !== undefined) process.env.XIAOMI_API_KEY = priorKey;
  }
});
