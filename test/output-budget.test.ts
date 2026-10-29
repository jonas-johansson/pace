/**
 * Tests for the output-budget cap that keeps request input plus requested
 * output inside the model's context window.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { capOutputTokensForContext, OUTPUT_BUDGET_SAFETY_MARGIN_TOKENS } from "@pace/llm";

test("keeps the full advertised output limit when the input is small", () => {
  // gemini-4-argon advertises 943,718 output tokens in a 1,048,576-token
  // window; with a small input there is plenty of room.
  assert.equal(
    capOutputTokensForContext(1_048_576, 943_718, 20_000),
    943_718,
  );
});

test("shrinks the output budget as the input fills the window", () => {
  // 113,465 input tokens + the full 943,718 output limit would overshoot the
  // 1,048,576-token window, which is exactly the OpenRouter 400 that motivated
  // this cap. The budget must shrink so input + output fits.
  const capped = capOutputTokensForContext(1_048_576, 943_718, 113_465);
  assert.ok(capped < 943_718);
  assert.ok(capped + 113_465 <= 1_048_576 - OUTPUT_BUDGET_SAFETY_MARGIN_TOKENS);
  assert.ok(capped > 0);
});

test("leaves at least a token of output budget even near the window edge", () => {
  assert.equal(capOutputTokensForContext(100_000, 90_000, 100_000), 1);
});

test("returns the advertised limit when the context window is unknown", () => {
  assert.equal(capOutputTokensForContext(0, 64_000, 500_000), 64_000);
  assert.equal(capOutputTokensForContext(-1, 64_000, 500_000), 64_000);
});