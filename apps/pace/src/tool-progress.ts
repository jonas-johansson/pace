/**
 * Streaming tool-call progress.
 *
 * - While a tool call's arguments stream in from the model (e.g. the content
 *   of a large `write`), append the number of bytes received so far to the
 *   live tool title so the spinner shows progress.
 * - While a tool runs, its output streams into the tool block; the live
 *   preview is capped so a runaway command cannot grow it without bound.
 */

import { visualizeToolPartialTitle } from "@pace/agent";

/** Minimum interval between live title updates while arguments stream (ms). */
export const STREAM_TITLE_UPDATE_MS = 33;

export type StreamingToolTitleInput = {
  name: string;
  inputJson: string;
  inputBytes: number;
  showBytes: boolean;
};

/**
 * Live title for a tool call whose arguments are still streaming. Extends the
 * partial title with the streamed byte count.
 */
export function streamingToolTitle(input: StreamingToolTitleInput): string {
  const base = visualizeToolPartialTitle(input.name, input.inputJson);
  if (!input.showBytes) {
    return base;
  }
  return `${base} · ${input.inputBytes} B`;
}

// ── Live tool output preview ─────────────────────────────────────────────────

/**
 * Maximum number of characters of live tool output kept in a tool block.
 * Commands can stream arbitrary volumes (a runaway loop once produced 1.4 GB
 * in a single call); without a cap the accumulated string eventually exceeds
 * V8's maximum string length and the app throws
 * `RangeError: Invalid string length`, and every render has to re-wrap the
 * whole preview. The final tool result replaces the preview with the
 * (already truncated) persisted output.
 */
export const MAX_STREAMED_TOOL_CONTENT_CHARS = 64 * 1024;

/**
 * Append a chunk of live tool output to the block preview, keeping only the
 * most recent {@link MAX_STREAMED_TOOL_CONTENT_CHARS} characters so the
 * preview can never grow unbounded. Callers can compare the result with the
 * input to skip rendering when the preview did not change.
 *
 * The cap counts UTF-16 code units (`String#length`), not bytes: it only
 * bounds the preview, and the check stays O(1) per chunk instead of scanning
 * the accumulated string.
 */
export function appendStreamedToolContent(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_STREAMED_TOOL_CONTENT_CHARS) {
    return combined;
  }
  return trimDanglingSurrogates(combined.slice(combined.length - MAX_STREAMED_TOOL_CONTENT_CHARS));
}

function trimDanglingSurrogates(text: string): string {
  let start = 0;
  let end = text.length;
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) {
    start += 1;
  }
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  if (start === 0 && end === text.length) {
    return text;
  }
  return text.slice(start, end);
}
