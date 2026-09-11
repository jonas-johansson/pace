/**
 * color.ts — Color helpers shared by TUI rendering and terminal detection.
 *
 * A color is either an ANSI 256-color index (number) or a "#rrggbb" string.
 * Hex colors render as 24-bit SGR when the terminal supports truecolor and as
 * the nearest 256-color index otherwise.
 */

/** ANSI 256-color index or "#rrggbb". */
export type TuiColor = number | string;

/** Parse "#RRGGBB" (with or without #) → [R, G, B] or null. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = hex.replace(/^#/, "").match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/**
 * Map a CSS hex color (e.g. "#569CD6") to the nearest ANSI 256-color index.
 * Uses the 6×6×6 RGB cube (indices 16–231) and the 24-step grayscale ramp
 * (indices 232–255).
 */
export function hexToAnsi256(hex: string): number {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  // Grayscale ramp (232–255): use when all channels are close to each other.
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8)   return 16;   // nearest black in color cube
    if (r > 248) return 231;  // nearest white in color cube
    return Math.round(((r - 8) / 247) * 24) + 232;
  }

  // 6×6×6 color cube (16–231): channel steps are 0, 95, 135, 175, 215, 255.
  const steps = [0, 95, 135, 175, 215, 255];
  const nearest = (v: number) =>
    steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);

  return 16 + 36 * nearest(r) + 6 * nearest(g) + nearest(b);
}

/**
 * Whether the terminal supports 24-bit color.
 *
 * Checks, in order: the PACE_TRUECOLOR override, COLORTERM, terminal programs
 * that do not set COLORTERM (Alacritty, kitty, Ghostty, WezTerm, iTerm).
 */
export function supportsTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PACE_TRUECOLOR === "1") return true;
  if (env.PACE_TRUECOLOR === "0") return false;

  if (env.COLORTERM && /truecolor|24bit/i.test(env.COLORTERM)) return true;

  if (env.TERM_PROGRAM && /^(iTerm\.app|WezTerm|ghostty|kitty)$/i.test(env.TERM_PROGRAM)) {
    return true;
  }

  if (env.TERM && /(foot|kitty|ghostty|alacritty|direct|truecolor)/i.test(env.TERM)) {
    return true;
  }

  // Omarchy's Alacritty sets neither COLORTERM nor a recognizable TERM.
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return true;
  if (env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE) return true;

  return false;
}

/**
 * Background SGR sequence for a color value.
 *
 * Numbers always render as 256-color. Hex colors render as 24-bit when
 * truecolor is enabled and as the nearest 256-color index otherwise. Values
 * that cannot be parsed fall back to the terminal default background.
 */
export function bgSgr(color: TuiColor, truecolor: boolean): string {
  if (typeof color === "number") return `\x1b[48;5;${color}m`;

  const rgb = parseHex(color);
  if (!rgb) return "\x1b[49m";

  return truecolor
    ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `\x1b[48;5;${hexToAnsi256(color)}m`;
}
