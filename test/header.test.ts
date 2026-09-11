/**
 * Regression test: the TUI header row must paint all `columns` cells so its
 * background reaches the right edge. It previously reserved a two-cell
 * margin in the padding math without emitting those cells, leaving a gap of
 * terminal-default background at the top-right corner.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Tui } from "../apps/pace/dist/tui.js";

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** `renderHeaderLine` is private; the test drives it directly. */
function renderHeaderLine(columns: number, title: string, starred = false): string {
  const tui = new Tui({ cwd: "/tmp/project" });
  const internals = tui as unknown as {
    sessionTitle: string;
    sessionStarred: boolean;
    renderHeaderLine(columns: number): string;
  };
  internals.sessionTitle = title;
  internals.sessionStarred = starred;
  return internals.renderHeaderLine(columns);
}

function visibleWidth(line: string): number {
  return Array.from(line.replace(ANSI_PATTERN, "")).length;
}

test("header row fills the terminal width", () => {
  for (const columns of [40, 80, 120]) {
    assert.equal(visibleWidth(renderHeaderLine(columns, "Short title")), columns);
  }
});

test("header row fills the terminal width when the title is truncated", () => {
  const longTitle = "A session title with a middle dot · that is far too long for the header";
  for (const columns of [40, 80]) {
    assert.equal(visibleWidth(renderHeaderLine(columns, longTitle)), columns);
  }
});

test("header row fills the terminal width when the session is starred", () => {
  assert.equal(visibleWidth(renderHeaderLine(80, "Short title", true)), 80);
});
