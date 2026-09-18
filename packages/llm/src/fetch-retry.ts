/**
 * Shared fetch helper with automatic retry on rate-limit (429) responses.
 */

import { emitEvent } from "./events";

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, { ...init, signal });

    if (response.status !== 429) {
      return response;
    }

    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `Rate limit (429) persisted after ${MAX_RETRIES} retries with exponential backoff. ` +
        `The server is still too busy — try again in a moment.`,
      );
    }

    // Honor Retry-After if present (seconds or HTTP-date); otherwise
    // exponential backoff + jitter. An unparseable header falls back to
    // backoff instead of NaN-delaying into a hot retry loop.
    const retryAfterMs = retryAfterDelay(response.headers.get("retry-after"));
    const backoff =
      Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt)) +
      Math.random() * 1000; // jitter
    // Do not retry earlier than requested or leave the process asleep for
    // hours. Long server cooldowns are surfaced to the caller instead.
    if (retryAfterMs !== null && retryAfterMs > 120_000) {
      throw new Error(
        `Rate limit (429): retry after ${Math.ceil(retryAfterMs / 1000)} seconds. ` +
        "The server asked for a long cooldown — try again later.",
      );
    }
    const waitMs = Math.max(backoff, retryAfterMs ?? 0);

    emitEvent("rate-limit-retry", {
      url,
      attempt: attempt + 1,
      maxRetries: MAX_RETRIES,
      waitMs,
    });
    await delay(waitMs, signal);
    attempt++;
  }
}

function retryAfterDelay(value: string | null): number | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
