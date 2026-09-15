type FormatErrorOptions = {
  // Include the throw site's "at file:line" frame. Only useful when reporting
  // unexpected Pace bugs (uncaught exceptions, unhandled rejections); for
  // expected failures like provider errors the origin is noise.
  includeOrigin?: boolean;
};

// Collapse an error and its `cause` chain into one clear message, e.g.
// "TypeError: fetch failed — ConnectTimeoutError: Connect Timeout Error
// (attempted addresses: ..., timeout: 10000ms) — AggregateError [ETIMEDOUT]".
// Stacks are dropped: they point at internal wiring (undici, SDK wrappers)
// and rarely help the user.
export function formatError(
  error: unknown,
  options: FormatErrorOptions = {}
): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const message = current.message.trim();
    const code =
      typeof (current as NodeJS.ErrnoException).code === "string"
        ? (current as NodeJS.ErrnoException).code
        : undefined;
    // Only surface the code when the message is empty — for errors like
    // AggregateError the code is the only detail; for others it's noise.
    const part = message || (code ? `${current.name} [${code}]` : current.name);
    const label = message && !part.startsWith(current.name) ? `${current.name}: ${part}` : part;
    if (!parts.includes(label)) parts.push(label);
    current = current.cause;
  }
  // Non-Error causes (strings, objects) can still carry the useful detail.
  if (current !== undefined && current !== null) {
    const part = String(current).trim();
    if (part && !parts.includes(part)) parts.push(part);
  }
  const text = parts.join(" — ") || "Unknown error";
  if (!options.includeOrigin) return text;
  const origin = error.stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  return origin ? `${text}\n${origin}` : text;
}
