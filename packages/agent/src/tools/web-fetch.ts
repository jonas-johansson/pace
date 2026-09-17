import { z } from "zod";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Fetch ──────────────────────────────────────────────────────────────

const WEB_FETCH_MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const WEB_FETCH_DEFAULT_TIMEOUT = 30_000;
const WEB_FETCH_MAX_TIMEOUT = 120_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// Some Cloudflare rules challenge Node's default TLS cipher fingerprint even
// with a different User-Agent. Retry with a browser-style cipher preference via
// Node's HTTPS client instead. This is not full browser impersonation and cannot
// solve interactive challenges. Keep the transport lazy-loaded for fast startup.
const BROWSER_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

async function fetchViaHttps(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  redirects = 0,
): Promise<Response> {
  const { default: https } = await import("node:https");
  throwIfAborted(signal);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    https.get(url, {
      headers: { ...headers, "Accept-Encoding": "identity" },
      ciphers: BROWSER_CIPHERS,
      // Don't reuse a connection with the default TLS fingerprint.
      agent: false,
      signal,
    }, resolve).on("error", reject);
  });

  try {
    const status = response.statusCode ?? 502;
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) responseHeaders.append(name, item);
      } else if (value !== undefined) {
        responseHeaders.set(name, value);
      }
    }

    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      if (redirects >= 20) throw new Error("Too many redirects");
      const nextUrl = new URL(response.headers.location, url);
      if (nextUrl.protocol !== "https:") {
        throw new Error("Redirect URL must use https://");
      }
      response.destroy();
      return await fetchViaHttps(nextUrl.href, headers, signal, redirects + 1);
    }

    // Error and bodyless responses need no buffering.
    if (status < 200 || status >= 300 || status === 204 || status === 205) {
      return new Response(null, { status, headers: responseHeaders });
    }
    if (Number(response.headers["content-length"]) > WEB_FETCH_MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5 MB limit)");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > WEB_FETCH_MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }
      chunks.push(buffer);
    }
    return new Response(Buffer.concat(chunks), { status, headers: responseHeaders });
  } finally {
    response.destroy();
  }
}

function buildAcceptHeader(format: "text" | "markdown" | "html"): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import("turndown");
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  td.remove(["script", "style", "meta", "link"]);
  return td.turndown(html);
}

function htmlToText(html: string): string {
  return html
    .replace(
      /<(script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

async function formatBody(
  content: string,
  contentType: string,
  format: "text" | "markdown" | "html",
): Promise<string> {
  const isHtml = contentType.includes("text/html");
  switch (format) {
    case "markdown":
      return isHtml ? await htmlToMarkdown(content) : content;
    case "text":
      return isHtml ? htmlToText(content) : content;
    case "html":
      return content;
  }
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  concurrency: "safe",
  description:
    "Fetch the content of a URL and return it as text, markdown, or raw HTML. " +
    "Use this when the user asks you to read, summarize, or extract information from a specific URL. " +
    "HTTP URLs are automatically upgraded to HTTPS.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in. Defaults to markdown."),
    timeout: z
      .number()
      .default(30)
      .optional()
      .describe("Request timeout in seconds (max 120). Defaults to 30."),
  }),
  showContent: false,
  titleFormatter: (input) => `web_fetch: ${input.url ?? ""}`,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const { url, format, timeout } = input;

    const resolvedUrl = url.startsWith("http://")
      ? url.replace("http://", "https://")
      : url;

    if (!resolvedUrl.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    const timeoutMs = Math.min(
      (timeout ?? WEB_FETCH_DEFAULT_TIMEOUT / 1000) * 1000,
      WEB_FETCH_MAX_TIMEOUT,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Link the external cancellation signal to our internal controller
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const headers = {
        "User-Agent": BROWSER_UA,
        Accept: buildAcceptHeader(format),
        "Accept-Language": "en-US,en;q=0.9",
      };

      const initial = await fetch(resolvedUrl, {
        signal: controller.signal,
        headers,
      });

      // Retry with a plain UA if Cloudflare blocks us.
      let response = initial;
      if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
        await response.body?.cancel();
        response = await fetch(resolvedUrl, {
          signal: controller.signal,
          headers: { ...headers, "User-Agent": "code-agent" },
        });
      }

      if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
        await response.body?.cancel();
        response = await fetchViaHttps(
          resolvedUrl,
          { ...headers, "User-Agent": "code-agent" },
          controller.signal,
        );
      }

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        parseInt(contentLength, 10) > WEB_FETCH_MAX_RESPONSE_SIZE
      ) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > WEB_FETCH_MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }

      const contentType = response.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

      if (isImageMime(mime)) {
        return {
          content: [{ type: "text", text: `Image content at ${resolvedUrl} (${mime}) - binary content skipped` }],
        };
      }

      const content = new TextDecoder().decode(arrayBuffer);
      return {
        content: [{ type: "text", text: await formatBody(content, contentType, format) }],
      };
    } catch (error) {
      // If abort was triggered by our external signal, propagate as AbortError
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (controller.signal.aborted) {
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  },
});
