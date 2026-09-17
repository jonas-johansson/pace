/** Run with npm run build && npm test. No external network or executables needed. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type RequestListener } from "node:http";
import https, { type RequestOptions } from "node:https";
import { once } from "node:events";
import { webFetchTool } from "../packages/agent/dist/tools/web-fetch.js";

const input = { url: "https://example.com/page", format: "markdown" as const, timeout: 5 };
const challenge = () => new Response("challenge", {
  status: 403,
  headers: { "cf-mitigated": "challenge" },
});

// Exercise real request/response streams locally, replacing only the HTTPS
// connection so tests don't need certificates or depend on Cloudflare's rules.
async function fallbackServer(t: TestContext, handler: RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const calls: { url: string; options: RequestOptions }[] = [];
  t.mock.method(https, "get", (url: string, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    calls.push({ url, options });
    const target = new URL(url);
    return http.get(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, {
      headers: options.headers,
      signal: options.signal,
      agent: false,
    }, callback);
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => challenge());
  return { calls, fetchMock };
}

for (const [format, expected] of [
  ["markdown", "# Hello World"],
  ["text", "Hello World"],
  ["html", "<h1>Hello World</h1>"],
] as const) {
  test(`web_fetch uses native HTTPS on persistent challenge (${format})`, async t => {
    const { calls, fetchMock } = await fallbackServer(t, (req, res) => {
      assert.equal(req.headers["user-agent"], "code-agent");
      assert.equal(req.headers["accept-encoding"], "identity");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Hello World</h1>");
    });
    const out = await webFetchTool.execute({ ...input, format }, undefined);
    assert.equal(out.content[0]!.text, expected);
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, input.url);
    assert.match(calls[0]!.options.ciphers!, /^TLS_AES_128_GCM_SHA256:/);
    assert.equal(calls[0]!.options.agent, false);
    assert.notEqual(calls[0]!.options.rejectUnauthorized, false);
    // The two challenge bodies are released before retrying.
    for (const call of fetchMock.mock.calls) {
      assert.equal((await call.result).body?.locked, false);
      assert.equal((await call.result).bodyUsed, true);
    }
  });
}

test("web_fetch leaves successful fetches on the fast path", async t => {
  const fallback = t.mock.method(https, "get", () => { throw new Error("unexpected fallback"); });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("body"));
  const out = await webFetchTool.execute(input, undefined);
  assert.equal(out.content[0]!.text, "body");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fallback.mock.callCount(), 0);
});

test("web_fetch stops retrying when the plain User-Agent succeeds", async t => {
  const fallback = t.mock.method(https, "get", () => { throw new Error("unexpected fallback"); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (++calls === 1) return challenge();
    assert.equal(options.headers["User-Agent"], "code-agent");
    return new Response("body");
  });
  const out = await webFetchTool.execute(input, undefined);
  assert.equal(out.content[0]!.text, "body");
  assert.equal(calls, 2);
  assert.equal(fallback.mock.callCount(), 0);
});

test("web_fetch does not retry ordinary HTTP errors", async t => {
  const fallback = t.mock.method(https, "get", () => { throw new Error("unexpected fallback"); });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("forbidden", { status: 403 }));
  await assert.rejects(webFetchTool.execute(input, undefined), /status 403/);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fallback.mock.callCount(), 0);
});

for (const status of [403, 404, 500]) {
  test(`web_fetch surfaces native HTTPS status ${status}`, async t => {
    await fallbackServer(t, (_req, res) => { res.writeHead(status); res.end("error"); });
    await assert.rejects(webFetchTool.execute(input, undefined), new RegExp(`status ${status}`));
  });
}

test("web_fetch follows relative and cross-origin HTTPS redirects", async t => {
  const { calls } = await fallbackServer(t, (req, res) => {
    if (req.url === "/page") res.writeHead(302, { location: "/next?q=1" }).end();
    else if (req.url === "/next?q=1") res.writeHead(307, { location: "https://other.example/final" }).end();
    else res.end("redirected");
  });
  const out = await webFetchTool.execute(input, undefined);
  assert.equal(out.content[0]!.text, "redirected");
  assert.deepEqual(calls.map(call => call.url), [input.url, "https://example.com/next?q=1", "https://other.example/final"]);
});

test("web_fetch bounds redirect loops", async t => {
  const { calls } = await fallbackServer(t, (_req, res) => res.writeHead(302, { location: "/page" }).end());
  await assert.rejects(webFetchTool.execute(input, undefined), /Too many redirects/);
  assert.equal(calls.length, 21);
});

for (const location of ["http://example.com/insecure", "file:///etc/passwd"]) {
  test(`web_fetch rejects unsafe fallback redirect ${location}`, async t => {
    await fallbackServer(t, (_req, res) => res.writeHead(302, { location }).end());
    await assert.rejects(webFetchTool.execute(input, undefined), /Redirect URL must use https/);
  });
}

test("web_fetch rejects oversized Content-Length before buffering", async t => {
  await fallbackServer(t, (_req, res) => {
    res.writeHead(200, { "content-length": 5 * 1024 * 1024 + 1 });
    res.flushHeaders(); // Don't send the advertised body.
  });
  await assert.rejects(webFetchTool.execute(input, undefined), /Response too large/);
});

test("web_fetch limits chunked responses by bytes, not characters", async t => {
  await fallbackServer(t, (_req, res) => {
    res.writeHead(200);
    res.write("é".repeat(3 * 1024 * 1024));
    res.end();
  });
  await assert.rejects(webFetchTool.execute(input, undefined), /Response too large/);
});

test("web_fetch handles bodyless fallback responses", async t => {
  await fallbackServer(t, (_req, res) => res.writeHead(204).end());
  const out = await webFetchTool.execute(input, undefined);
  assert.equal(out.content[0]!.text, "");
});

test("web_fetch skips binary images from the fallback", async t => {
  await fallbackServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  const out = await webFetchTool.execute(input, undefined);
  assert.match(out.content[0]!.text, /image\/png.*binary content skipped/);
});

for (const sendHeaders of [false, true]) {
  test(`web_fetch times out native HTTPS ${sendHeaders ? "body" : "connection"}`, async t => {
    await fallbackServer(t, (_req, res) => {
      if (sendHeaders) { res.writeHead(200); res.write("partial"); }
    });
    await assert.rejects(webFetchTool.execute({ ...input, timeout: 0.1 }, undefined), /Request timed out/);
  });
}

test("web_fetch propagates external cancellation during the fallback body", async t => {
  const controller = new AbortController();
  await fallbackServer(t, (_req, res) => {
    res.writeHead(200);
    res.write("partial");
    setImmediate(() => controller.abort());
  });
  await assert.rejects(webFetchTool.execute(input, controller.signal), { name: "AbortError" });
});

test("web_fetch surfaces fallback connection failures", async t => {
  await fallbackServer(t, req => req.socket.destroy());
  await assert.rejects(webFetchTool.execute(input, undefined), /socket hang up/);
});

// Opt-in smoke test: PACE_TEST_WEB_FETCH_LIVE=1 node --test test/web-fetch.test.ts
// Bot rules can change; keep the default suite deterministic and offline.
test("web_fetch retrieves the Booli listing using Node alone", {
  skip: process.env.PACE_TEST_WEB_FETCH_LIVE !== "1",
}, async () => {
  const out = await webFetchTool.execute({
    url: "https://www.booli.se/bostad/2443779",
    format: "markdown",
    timeout: 30,
  }, undefined);
  assert.match(out.content[0]!.text, /Bovägen 3/);
  assert.match(out.content[0]!.text, /183\s*m²/);
});
