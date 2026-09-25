/**
 * Tests for the top-level CLI help text (`pace --help`).
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PACE_USAGE } from "../apps/pace/dist/cli-help.js";

test("PACE_USAGE documents the interactive options", () => {
  assert.match(PACE_USAGE, /^Usage: pace \[options\]/m);
  assert.match(PACE_USAGE, /-r, --resume/);
  assert.match(PACE_USAGE, /--session-id <id>/);
  assert.match(PACE_USAGE, /-h, --help/);
});

test("PACE_USAGE points at the headless runner help", () => {
  assert.match(PACE_USAGE, /pace run --help/);
});
