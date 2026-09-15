/**
 * Tests for formatError: collapsing an error and its cause chain into one
 * clear message without stacks.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatError } from "../apps/pace/dist/errors.js";

// ── cause chains ─────────────────────────────────────────────────────────────

test("joins the cause chain into one message without stacks", () => {
  const root = new Error();
  root.name = "AggregateError";
  root.code = "ETIMEDOUT";
  const timeout = new Error(
    "Connect Timeout Error (attempted addresses: 52.9.162.82:443, timeout: 10000ms)"
  );
  timeout.name = "ConnectTimeoutError";
  timeout.cause = root;
  const error = new TypeError("fetch failed");
  error.cause = timeout;

  assert.equal(
    formatError(error),
    "TypeError: fetch failed — ConnectTimeoutError: Connect Timeout Error " +
      "(attempted addresses: 52.9.162.82:443, timeout: 10000ms) — AggregateError [ETIMEDOUT]"
  );
});

test("shows the code when the message is empty", () => {
  const error = new Error("request failed");
  error.cause = Object.assign(new Error(), { name: "AggregateError", code: "ETIMEDOUT" });
  assert.equal(formatError(error), "Error: request failed — AggregateError [ETIMEDOUT]");
});

test("does not repeat the name when the message already starts with it", () => {
  const error = new TypeError("TypeError: bad input");
  assert.equal(formatError(error), "TypeError: bad input");
});

test("skips duplicate causes from SDK error wrapping", () => {
  const root = new Error("stream ended");
  const wrapper = new Error("stream ended");
  wrapper.cause = root;
  const error = new Error("request failed");
  error.cause = wrapper;
  assert.equal(formatError(error), "Error: request failed — Error: stream ended");
});

test("includes non-Error causes", () => {
  const error = new Error("request failed");
  error.cause = "ECONNRESET";
  assert.equal(formatError(error), "Error: request failed — ECONNRESET");
});

// ── simple errors ────────────────────────────────────────────────────────────

test("keeps plain messages intact", () => {
  assert.equal(formatError(new Error("something broke")), "Error: something broke");
});

test("uses the name for messageless errors", () => {
  const error = new Error();
  error.name = "AbortError";
  assert.equal(formatError(error), "AbortError");
});

test("stringifies non-Error values", () => {
  assert.equal(formatError("boom"), "boom");
  assert.equal(formatError(42), "42");
});

// ── stacks ───────────────────────────────────────────────────────────────────

test("never includes stack frames by default", () => {
  const error = new Error("boom");
  error.cause = new Error("because");
  const text = formatError(error);
  assert.ok(!text.includes("\n    at "));
  assert.ok(!text.includes("Caused by:"));
});

test("includeOrigin appends only the throw-site frame", () => {
  const error = new Error("boom");
  const text = formatError(error, { includeOrigin: true });
  const lines = text.split("\n");
  assert.equal(lines[0], "Error: boom");
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^at .+ \(.+:\d+:\d+\)$/);
});
