/** Run with npm run build && npm test. No external network or executables needed. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { onEvent } from "../packages/llm/dist/events.js";
import { webSearchTool } from "../packages/agent/dist/tools/web-search.js";

const input = { query: "HTTP rate limits", numResults: 1 };
const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...headers },
  });
const success = (text = "Found it") => json({ result: { content: [{ type: "text", text }] } });

function setup(t: TestContext, responses: Array<() => Response>) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  t.mock.method(Math, "random", () => 0);
  let requests = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    const response = responses[requests++] ?? responses[responses.length - 1]!;
    return response();
  });
  return { fetch, requests: () => requests };
}

async function advance(t: TestContext, ms: number) {
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(ms);
  await new Promise(resolve => setImmediate(resolve));
}

for (const text of [
  "Title: HTTP rate limits explained\nHighlights: Handling 429 responses.",
  "Title: exa-labs/exa-mcp-server\nHighlights: The hosted MCP server works anonymously with rate limits.",
  "Title: Errors\nYou've hit Exa's free MCP rate limit. This article explains why.",
]) {
  test(`ordinary search content is not retried: ${text.split("\n")[0]}`, async t => {
    const { fetch, requests } = setup(t, [() => success(text)]);
    const out = await webSearchTool.execute(input, undefined);
    assert.equal(out.content[0]!.type, "text");
    assert.equal((out.content[0] as { text: string }).text, text);
    assert.equal(out.is_error, undefined);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(requests(), 1);
  });
}

test("SSE supports CRLF, multiline data, no space, and trailing notifications", async t => {
  setup(t, [() => new Response(
    ': keepalive\r\n\r\ndata:{"result":\r\ndata: {"content":[{"text":"Found it"}]}}\r\n\r\n' +
    'data: {"method":"notifications/progress"}\r\n\r\ndata: [DONE]\r\n\r\n',
    { headers: { "content-type": "text/event-stream" } },
  )]);
  const out = await webSearchTool.execute(input, undefined);
  assert.equal((out.content[0] as { text: string }).text, "Found it");
});

for (const data of [
  { error: { message: "rate limit exceeded" } },
  { error: { code: 429, message: "Slow down" } },
  { result: { isError: true, content: [{ text: "Too many requests" }] } },
  { result: { content: [{ text: "You've hit Exa's free MCP rate limit. To continue using Exa, create your own API key." }] } },
]) {
  test(`retries rate-limit response: ${JSON.stringify(data)}`, async t => {
    const { fetch } = setup(t, [() => json(data), () => success()]);
    const retries: number[] = [];
    const off = onEvent("rate-limit-retry", () => retries.push(1));
    const pending = webSearchTool.execute(input, undefined);
    await advance(t, 999);
    assert.equal(fetch.mock.callCount(), 1);
    await advance(t, 1);
    const out = await pending;
    off();
    assert.equal((out.content[0] as { text: string }).text, "Found it");
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(retries.length, 1);
  });
}

test("persistent MCP rate limit stops after six retries with capped exponential delays", async t => {
  const { fetch } = setup(t, [() => json({ error: { message: "rate limit exceeded" } })]);
  const retries: Array<{ attempt: number; waitMs: number }> = [];
  const off = onEvent("rate-limit-retry", (event) => retries.push(event));
  // The mocked clock only advances when ticked, so drain the backoff delays
  // concurrently with the pending execution.
  const pending = assert.rejects(
    () => webSearchTool.execute(input, undefined),
    /after 6 retries with exponential backoff/,
  );
  for (let i = 0; i < 10; i++) await advance(t, 30_000);
  await pending;
  off();
  assert.equal(fetch.mock.callCount(), 7);
  assert.deepEqual(retries.map(retry => retry.waitMs), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.deepEqual(retries.map(retry => retry.attempt), [1, 2, 3, 4, 5, 6]);
});

test("HTTP 429 honors a long Retry-After by surfacing it instead of sleeping", async t => {
  const { fetch } = setup(t, [() => new Response("Slow down", {
    status: 429,
    headers: { "retry-after": "3600" },
  })]);
  await assert.rejects(
    webSearchTool.execute(input, undefined),
    /retry after 3600 seconds/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test("HTTP 429 with an unparseable Retry-After falls back to backoff, not a hot loop", async t => {
  const { fetch } = setup(t, [
    () => new Response("Slow down", { status: 429, headers: { "retry-after": "invalid" } }),
    () => success(),
  ]);
  const pending = webSearchTool.execute(input, undefined);
  await advance(t, 999);
  assert.equal(fetch.mock.callCount(), 1);
  await advance(t, 1);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal((await pending).is_error, undefined);
});

test("HTTP 429 with a date Retry-After waits until the stated time", async t => {
  const { fetch } = setup(t, [
    () => new Response("Slow down", {
      status: 429,
      headers: { "retry-after": new Date(1_800_000_005_000).toUTCString() },
    }),
    () => success(),
  ]);
  const pending = webSearchTool.execute(input, undefined);
  await advance(t, 4999);
  assert.equal(fetch.mock.callCount(), 1);
  await advance(t, 1);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal((await pending).is_error, undefined);
});

test("MCP isError propagates with all text blocks and without retrying", async t => {
  const { fetch } = setup(t, [() => json({ result: { isError: true, content: [
    { type: "text", text: "Invalid request" },
    { type: "text", text: "Query is required" },
  ] } })]);
  const out = await webSearchTool.execute(input, undefined);
  assert.equal((out.content[0] as { text: string }).text, "Invalid request\n\nQuery is required");
  assert.equal(out.is_error, true);
  assert.equal(fetch.mock.callCount(), 1);
});

for (const response of [
  () => json({ error: { message: "Invalid tool" } }),
  () => new Response("Unauthorized", { status: 401 }),
  () => json({ method: "notifications/progress" }),
  () => new Response("data: not json\n\n"),
]) {
  test("non-rate-limit failures are not retried", async t => {
    const { fetch } = setup(t, [response]);
    await assert.rejects(() => webSearchTool.execute(input, undefined));
    assert.equal(fetch.mock.callCount(), 1);
  });
}

for (const apiKey of [undefined, "test-exa-key"]) {
  test(`Exa authentication: ${apiKey ? "API key header" : "anonymous"}`, async t => {
    const original = process.env.EXA_API_KEY;
    t.after(() => {
      if (original === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = original;
    });
    if (apiKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = apiKey;
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      requests++;
      assert.equal(String(url), "https://mcp.exa.ai/mcp");
      assert.equal(new Headers(init?.headers).get("x-api-key"), apiKey ?? null);
      assert.equal(String(init?.body).includes("test-exa-key"), false);
      return success();
    });
    const out = await webSearchTool.execute(input, undefined);
    assert.equal(out.is_error, undefined);
    assert.equal(requests, 1);
  });
}
