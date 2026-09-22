/**
 * Regression test: markdown tables containing flag emoji (regional indicator
 * pairs) used to be measured one glyph too wide — each half of the pair was
 * counted as a two-cell character, so cells containing flags were over-padded
 * and the table borders drifted out of alignment.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownRows } from "../apps/pace/dist/tui.js";

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** Visible width counting each regional indicator pair as one 2-cell glyph. */
function visibleWidth(line: string): number {
  const text = line.replace(ANSI_PATTERN, "");
  let width = 0;
  let inFlagPair = false;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) {
      inFlagPair = !inFlagPair;
      if (inFlagPair) {
        width += 2;
      }
      continue;
    }
    inFlagPair = false;
    // ✅ (U+2705) and ❌ (U+274C) have emoji presentation and render 2 cells.
    if (codePoint === 0x2705 || codePoint === 0x274c || codePoint > 0xffff) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

const TABLE = [
  "| Provider | Region | ZDR |",
  "| --- | --- | --- |",
  "| Berget AI | 🇸🇪 Sweden (EU) | ✅ On by default |",
  "| TensorX | 🇪🇺 EU | ❌ No |",
].join("\n");

test("markdown table rows with flag emoji align with the borders", () => {
  const rows = renderMarkdownRows(TABLE, 120).map((row) =>
    row.map((segment) => segment.text).join(""),
  );
  assert.ok(rows.length > 0);

  const widths = new Set(rows.map(visibleWidth));
  assert.equal(widths.size, 1, `rows have mismatched widths: ${[...widths].join(", ")}\n${rows.join("\n")}`);
});

test("markdown table with flag emoji is not wider than the terminal", () => {
  for (const width of [60, 80, 120]) {
    const rows = renderMarkdownRows(TABLE, width).map((row) =>
      row.map((segment) => segment.text).join(""),
    );
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `row exceeds ${width} columns:\n${row}`);
    }
  }
});

test("flag emoji is never split across wrapped table rows", () => {
  const rows = renderMarkdownRows(TABLE, 40).map((row) =>
    row.map((segment) => segment.text).join(""),
  );
  for (const row of rows) {
    // A dangling regional indicator (unpaired surrogate content) would mean a
    // flag was split across rows.
    const regionalIndicators = Array.from(row.replace(ANSI_PATTERN, "")).filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
    });
    assert.equal(regionalIndicators.length % 2, 0, "flag emoji split across rows");
  }
});
