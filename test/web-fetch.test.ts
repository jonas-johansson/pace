/**
 * Tests for the web_fetch tool's Cloudflare challenge fallback: when Node's
 * fetch gets a 403 with `cf-mitigated: challenge` even after the honest-UA
 * retry, the tool retries through a `bun` subprocess (Bun's TLS fingerprint
 * passes some sites' bot rules where Node's does not).
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { webFetchTool } from "../packages/agent/dist/tools/web-fetch.js";

function statusResponse(status: number, headers: Record<string, string>): Response {
  return new Response("body", { status, headers });
}

function withMockedFetch(fn: () => Promise<Response>): Promise<Response> {
  const original = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  return original;
}

/** Create a directory containing a fake `bun` that emits a canned response. */
function makeFakeBun(status: number, contentType: string, body: string): string {
  const dir = join(tmpdir(), `pace-webfetch-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    // first stdout line: status, second: content-type, then body
    `printf '${status}\\n${contentType}\\n${body}'`,
  ].join("\n");
  const bin = join(dir, "bun");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return dir;
}

test("web_fetch falls back to bun subprocess on persistent Cloudflare challenge", async () => {
  let fetchCalls = 0;
  const restore = withMockedFetch(async () => {
    fetchCalls++;
    return statusResponse(403, { "cf-mitigated": "challenge" });
  });
  try {
    const fakeDir = makeFakeBun(200, "text/html", "<html><body><h1>Hello World</h1></body></html>");
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${originalPath}`;
    try {
      const out = await webFetchTool.execute(
        { url: "https://example.com/page", format: "markdown", timeout: 5 },
        undefined,
      );
      assert.equal(fetchCalls, 2); // initial + honest-UA retry, then bun
      assert.match(out.content[0]!.text, /Hello World/);
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    globalThis.fetch = restore;
  }
});

test("web_fetch throws 403 when challenge persists and bun is unavailable", async () => {
  let fetchCalls = 0;
  const restore = withMockedFetch(async () => {
    fetchCalls++;
    return statusResponse(403, { "cf-mitigated": "challenge" });
  });
  try {
    const originalPath = process.env.PATH;
    // PATH with no bun in it
    process.env.PATH = "/nonexistent";
    try {
      await assert.rejects(
        webFetchTool.execute({ url: "https://example.com/page", format: "markdown", timeout: 5 }, undefined),
        /status 403/,
      );
      assert.equal(fetchCalls, 2);
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    globalThis.fetch = restore;
  }
});

test("web_fetch does not invoke bun when the first response is fine", async () => {
  let fetchCalls = 0;
  const restore = withMockedFetch(async () => {
    fetchCalls++;
    return statusResponse(200, { "content-type": "text/plain" });
  });
  try {
    const fakeDir = makeFakeBun(500, "text/plain", "should not be used");
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${originalPath}`;
    try {
      const out = await webFetchTool.execute(
        { url: "https://example.com/page", format: "text", timeout: 5 },
        undefined,
      );
      assert.equal(fetchCalls, 1);
      assert.equal(out.content[0]!.text, "body");
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    globalThis.fetch = restore;
  }
});

test("web_fetch surfaces bun's non-2xx status", async () => {
  let fetchCalls = 0;
  const restore = withMockedFetch(async () => {
    fetchCalls++;
    return statusResponse(403, { "cf-mitigated": "challenge" });
  });
  try {
    const fakeDir = makeFakeBun(403, "text/html", "still blocked");
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${originalPath}`;
    try {
      await assert.rejects(
        webFetchTool.execute({ url: "https://example.com/page", format: "markdown", timeout: 5 }, undefined),
        /status 403/,
      );
      assert.equal(fetchCalls, 2);
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    globalThis.fetch = restore;
  }
});
