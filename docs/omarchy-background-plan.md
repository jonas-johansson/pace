# Omarchy background color adaptation — implementation plan

## Goal

Pace's full-screen canvas background should be exactly the active Omarchy theme's
`background` color, so the app's surface matches the terminal it runs in. Nothing
else changes: user cards, tool panels, error blocks, syntax, status bar, input
box, and overlays keep using the built-in `dark` / `light` themes exactly as
today. Block roles that the built-in themes render directly on the canvas
(agent messages, reasoning, meta, and inline tool lines) move with the canvas.

Example: with catppuccin (`background = "#1e1e2e"`) the canvas becomes `#1e1e2e`
while panels and blocks keep the built-in dark palette. With vantablack /
jonas-dark (`background = "#000000"`) it becomes `#000000`.

## Scope

In:

- Canvas background only (`TuiTheme.canvas.bg`).
- Read the value from the active Omarchy `colors.toml`.
- Exact color output (24-bit SGR) with nearest-256 fallback.

Out:

- No `system` theme, no `/theme` changes, no config options.
- No palette role changes beyond the canvas and its inline roles: user cards,
  tool panels, error blocks, overlays, status, input, syntax, glyphs.
- Shiki syntax colors untouched.

## Current state

- `terminal-utils.ts:38` (`fromTerminalConfig`) detects light/dark only. Its
  Omarchy branch (line 44) reads
  `~/.config/omarchy/current/theme/colors.toml`, but current Omarchy stages the
  active theme at `~/.local/state/omarchy/current/theme/colors.toml`, so that
  branch never fires; detection today only still works through the Alacritty
  fallback.
- `themes.ts:35` types `canvas.bg` as a `number` (ANSI 256 index); built-ins set
  `dark: 234`, `light: 231`.
- `tui.ts` paints the canvas only through `bg(currentTheme.canvas.bg)`, at 9 call
  sites: blank-line cache (4742–4750), logo row (2936), suggestion padding
  (2994, 2996), spinner/glyph rows (3955–3969), padding helpers (4849, 4855).
- `bg()` (`tui.ts` ≈5053) emits `48;5;N`, so a hex value cannot be represented
  yet. `fg()` does not need to change.
- `applyTheme` (`app.ts:624`) applies the built-in theme; startup (2313) and
  `SIGUSR2` (2355) route through `syncThemeFromTerminal()` (637). The Omarchy
  hook is already installed and signals running Pace instances.

## Why truecolor is required for a match

`hexToAnsi256` maps neutral dark colors onto the color cube's black:
`#1e1e2e` (catppuccin), `#1a1b26` (tokyo night), and `#161622` all become
index 16 = `#000000`. A 256-color canvas would visibly differ from the terminal.
Painting the exact RGB via `48;2;R;G;B` is what makes "match the terminal" true.
Terminals without truecolor keep the existing nearest-256 conversion as fallback.

## Design

### 1. Background lookup (`terminal-utils.ts`)

- `readOmarchyBackground(home?, env?): string | null` returns `#rrggbb` from the
  first existing candidate:
  1. `$XDG_STATE_HOME/omarchy/current/theme/colors.toml`
     (default `~/.local/state/...`),
  2. `$XDG_CONFIG_HOME/omarchy/current/theme/colors.toml` (legacy),
  parsing the `background = "#rrggbb"` line with the regex the light/dark
  detection already uses.
- Fix `fromTerminalConfig()` to use the same candidate list for its light/dark
  branch, so the Omarchy precedence comment becomes true again.
- Parameters default to `homedir()` / `process.env` so tests can point it at a
  temp directory.

### 2. Truecolor capability (`color.ts`, new tiny pure module)

- `supportsTruecolor(env = process.env): boolean`:
  1. `PACE_TRUECOLOR` (`1`/`0`) override;
  2. `COLORTERM` contains `truecolor` or `24bit`;
  3. known terminals that do not set `COLORTERM`: `TERM_PROGRAM`
     (`iTerm.app`, `WezTerm`, `ghostty`, `kitty`), `TERM` (`foot*`, `*kitty`,
     `xterm-ghostty`, `alacritty`, `*-direct`, `*-truecolor`),
     `ALACRITTY_WINDOW_ID` / `ALACRITTY_SOCKET` (Omarchy's Alacritty sets
     neither `COLORTERM` nor a recognizable `TERM`), `KITTY_WINDOW_ID`,
     `WEZTERM_EXECUTABLE`;
  4. otherwise `false`.
- `bgSgr(color: number | string, truecolor: boolean): string` — number →
  `48;5;N`; `#rrggbb` → `48;2;R;G;B` when truecolor, else `48;5;` plus
  `hexToAnsi256`.
- `parseHex` moves here; `terminal-utils.ts` imports it instead of keeping its
  own copy.

### 3. Type and rendering

- `themes.ts`: `canvas: { bg: number | string; panelBg: number }`. Built-in
  values stay untouched.
- `tui.ts`: `bg()` delegates to `bgSgr(color, TRUECOLOR)` with a module-level
  `TRUECOLOR = supportsTruecolor()`. `fg()` unchanged. All 9 canvas call sites
  and the blank-line cache work unchanged.

### 4. Applying the override (`app.ts`)

```ts
function applyTheme(themeName: string, showStatus = false) {
  const baseTheme = resolveTheme(themeName);
  const omarchyBg = readOmarchyBackground();
  const newTheme = omarchyBg ? withCanvasBackground(baseTheme, omarchyBg) : baseTheme;
  setTuiTheme(newTheme);
  tui.invalidateRenderCache();
  void setShikiTheme(newTheme.shikiTheme);
  if (showStatus) tui.setStatus(`Theme: ${newTheme.name}`);
}
```

`withCanvasBackground(theme, bg)` (in `themes.ts`, pure and tested) replaces
`canvas.bg` and repoints every block role whose background equals the built-in
canvas color — the "inline on the canvas" roles — so agent messages, reasoning,
meta, and inline tool lines keep sitting directly on the canvas instead of
turning into gray panels.

- Light/dark selection stays exactly as today (`detectTerminalBackground()`), so
  no other color changes.
- Missing or malformed file → built-in canvas background, no behavior change.
- `SIGUSR2` already routes through `applyTheme`, so a live theme change repaints
  the canvas; `setTuiTheme` resets the blank-line cache, keeping repaints
  correct. `withCanvasBackground` must not mutate `BUILT_IN_THEMES` — it returns
  new objects.

## Testing

New `test/omarchy-background.test.ts` (pure functions and temp dirs, no
terminal needed):

- Path preference: state dir wins, legacy config dir is the fallback, missing
  file → `null`.
- Parser: comments and spacing tolerated, malformed hex ignored, the `#` inside
  a quoted value preserved.
- `supportsTruecolor`: `PACE_TRUECOLOR` override, `COLORTERM`, the
  `ALACRITTY_WINDOW_ID` case, plain `xterm-256color` → `false`.
- `bgSgr`: numbers unchanged in both modes; hex → truecolor SGR; `#1e1e2e` with
  truecolor off falls back to index 16.
- `withCanvasBackground`: inline roles (`assistant`, `reasoning`, `meta`,
  `inlineTool`) follow the new background for both built-in themes; user, tool,
  and error blocks keep their colors; the built-in themes are not mutated.
- Existing tests keep passing (built-in themes still render via the number
  path).

## Manual checks

- Omarchy dark theme → canvas matches the terminal background exactly.
- Omarchy light theme (`omarchy theme set flexoki-light`) → light built-in
  controls, canvas `#FFFCF0`.
- Non-Omarchy terminal → behavior unchanged.
- `PACE_TRUECOLOR=0` → nearest-256 canvas, no render errors.
- `omarchy theme set ...` with a running Pace → canvas updates without restart.

## Implementation order

1. `color.ts` (`supportsTruecolor`, `bgSgr`, `parseHex`) + tests.
2. `terminal-utils.ts`: candidate paths and `readOmarchyBackground`, reused by
   the light/dark detection.
3. `themes.ts` type and `tui.ts` `bg()`.
4. `app.ts` canvas override.
5. README update: correct colors.toml path, background-only behavior.
6. `npm run lint`, `npm run build`, `npm test`.

## Risks and notes

- This deliberately paints an opaque theme background. If matching terminal
  transparency later becomes desirable, the alternative is SGR 49 (terminal
  default) instead of the hex — a one-line change in `bgSgr`, not part of this
  scope.
- If a user's terminal background was customized away from the theme's
  `background` value, Pace follows the theme file, not that override.
- Truecolor detection can only guess inside tmux/ssh; `PACE_TRUECOLOR=1` is the
  escape hatch.
