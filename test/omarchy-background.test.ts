import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bgSgr, supportsTruecolor } from "../apps/pace/dist/color.js";
import { readOmarchyBackground } from "../apps/pace/dist/terminal-utils.js";
import { BUILT_IN_THEMES, withCanvasBackground } from "../apps/pace/dist/themes.js";

function makeHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "pace-omarchy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function env(home: string): NodeJS.ProcessEnv {
  return {
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: join(home, "config"),
  };
}

function writeColors(home: string, subdir: "state" | "config", body: string): void {
  const dir = join(home, subdir, "omarchy", "current", "theme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "colors.toml"), body);
}

test("reads the background from the current Omarchy state path", (t) => {
  const home = makeHome(t);
  writeColors(home, "state", 'mode = "dark"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\n');
  assert.equal(readOmarchyBackground(home, env(home)), "#1e1e2e");
});

test("falls back to the legacy config path", (t) => {
  const home = makeHome(t);
  writeColors(home, "config", 'background = "#FFFCF0"\n');
  assert.equal(readOmarchyBackground(home, env(home)), "#fffcf0");
});

test("prefers the state path over the legacy config path", (t) => {
  const home = makeHome(t);
  writeColors(home, "state", 'background = "#1e1e2e"\n');
  writeColors(home, "config", 'background = "#ffffff"\n');
  assert.equal(readOmarchyBackground(home, env(home)), "#1e1e2e");
});

test("returns null when no Omarchy theme is installed", (t) => {
  const home = makeHome(t);
  assert.equal(readOmarchyBackground(home, env(home)), null);
});

test("ignores commented and malformed background values", (t) => {
  const home = makeHome(t);
  writeColors(home, "state", '# background = "#ff0000"\nmode = "dark"\n');
  assert.equal(readOmarchyBackground(home, env(home)), null);

  writeColors(home, "state", 'background = "#12345"\n');
  assert.equal(readOmarchyBackground(home, env(home)), null);

  writeColors(home, "state", 'background = "not-a-color"\n');
  assert.equal(readOmarchyBackground(home, env(home)), null);
});

test("supportsTruecolor honors the PACE_TRUECOLOR override", () => {
  assert.equal(supportsTruecolor({ PACE_TRUECOLOR: "1" }), true);
  assert.equal(supportsTruecolor({ PACE_TRUECOLOR: "0", COLORTERM: "truecolor" }), false);
});

test("supportsTruecolor detects COLORTERM and known terminals", () => {
  assert.equal(supportsTruecolor({ COLORTERM: "24bit" }), true);
  assert.equal(supportsTruecolor({ TERM_PROGRAM: "ghostty" }), true);
  assert.equal(supportsTruecolor({ TERM: "xterm-kitty" }), true);
  // Omarchy's Alacritty sets neither COLORTERM nor a recognizable TERM.
  assert.equal(supportsTruecolor({ ALACRITTY_WINDOW_ID: "1" }), true);
  assert.equal(supportsTruecolor({ TERM: "xterm-256color" }), false);
  assert.equal(supportsTruecolor({}), false);
});

test("bgSgr renders numbers as 256-color in both modes", () => {
  assert.equal(bgSgr(234, true), "\x1b[48;5;234m");
  assert.equal(bgSgr(234, false), "\x1b[48;5;234m");
});

test("bgSgr renders hex as 24-bit when truecolor is available", () => {
  assert.equal(bgSgr("#1e1e2e", true), "\x1b[48;2;30;30;46m");
  assert.equal(bgSgr("#FFFCF0", true), "\x1b[48;2;255;252;240m");
});

test("bgSgr falls back to the nearest 256-color index", () => {
  // Dark neutrals collapse to the cube's black; this is why truecolor matters.
  assert.equal(bgSgr("#1e1e2e", false), "\x1b[48;5;16m");
  assert.equal(bgSgr("#eff1f5", false), "\x1b[48;5;254m");
});

test("bgSgr falls back to the terminal default for unparseable colors", () => {
  assert.equal(bgSgr("garbage", true), "\x1b[49m");
  assert.equal(bgSgr("#12345", false), "\x1b[49m");
});

test("withCanvasBackground repoints inline roles that share the canvas color", () => {
  const theme = withCanvasBackground(BUILT_IN_THEMES.dark, "#1e1e2e");
  assert.equal(theme.canvas.bg, "#1e1e2e");
  for (const role of ["assistant", "reasoning", "meta", "inlineTool"] as const) {
    assert.equal(theme.blocks[role].bg, "#1e1e2e");
  }
  // Distinct surfaces keep the built-in palette.
  assert.equal(theme.blocks.user.bg, BUILT_IN_THEMES.dark.blocks.user.bg);
  assert.equal(theme.blocks.tool.bg, BUILT_IN_THEMES.dark.blocks.tool.bg);
  assert.equal(theme.blocks.error.bg, BUILT_IN_THEMES.dark.blocks.error.bg);
});

test("withCanvasBackground follows the light theme's inline roles too", () => {
  const theme = withCanvasBackground(BUILT_IN_THEMES.light, "#FFFCF0");
  assert.equal(theme.canvas.bg, "#FFFCF0");
  assert.equal(theme.blocks.assistant.bg, "#FFFCF0");
  assert.equal(theme.blocks.tool.bg, BUILT_IN_THEMES.light.blocks.tool.bg);
});

test("withCanvasBackground does not mutate the built-in themes", () => {
  withCanvasBackground(BUILT_IN_THEMES.dark, "#000000");
  assert.equal(BUILT_IN_THEMES.dark.canvas.bg, 234);
  assert.equal(BUILT_IN_THEMES.dark.blocks.assistant.bg, 234);
});
