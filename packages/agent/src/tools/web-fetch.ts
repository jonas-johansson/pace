import { z } from "zod";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Fetch ──────────────────────────────────────────────────────────────

const WEB_FETCH_MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const WEB_FETCH_DEFAULT_TIMEOUT = 30_000;
const WEB_FETCH_MAX_TIMEOUT = 120_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// Some sites run Cloudflare rules that challenge Node's TLS
// fingerprint (undici/JA3) no matter what headers are sent, while allowing
// Bun's BoringSSL handshake through. As a last resort, retry the fetch in a
// Bun subprocess when one is available. The script writes the response status
// on the first stdout line, the content-type on the second, and the body after.
const BUN_FETCH_SCRIPT = `\
// Under \`bun -e\`, process.argv is [bunPath, ...args]
const [url, headersJson] = process.argv.slice(process.argv.length - 2);
const response = await fetch(url, { headers: JSON.parse(headersJson) });
process.stdout.write(response.status + "\\n" + (response.headers.get("content-type") ?? "") + "\\n");
process.stdout.write(Buffer.from(await response.arrayBuffer()));
`;

async function fetchViaBun(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ status: number; contentType: string; body: string } | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("bun", ["-e", BUN_FETCH_SCRIPT, url, JSON.stringify(headers)], {
      signal,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > WEB_FETCH_MAX_RESPONSE_SIZE) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => {
      // bun not installed, spawn failed, or aborted
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const out = Buffer.concat(chunks).toString("utf-8");
      const firstNewline = out.indexOf("\n");
      const secondNewline = firstNewline === -1 ? -1 : out.indexOf("\n", firstNewline + 1);
      if (code !== 0 || secondNewline === -1) return resolve(null);
      const status = Number.parseInt(out.slice(0, firstNewline), 10);
      if (!Number.isInteger(status)) return resolve(null);
      resolve({
        status,
        contentType: out.slice(firstNewline + 1, secondNewline),
        body: out.slice(secondNewline + 1),
      });
    });
  });
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
    if (signal) {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

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

      // Retry with a plain UA if Cloudflare blocks us
      let response =
        initial.status === 403 &&
        initial.headers.get("cf-mitigated") === "challenge"
          ? await fetch(resolvedUrl, {
              signal: controller.signal,
              headers: { ...headers, "User-Agent": "code-agent" },
            })
          : initial;

      // Last resort: some sites challenge Node's TLS fingerprint itself, so
      // no header change helps. Retry through a Bun subprocess if available,
      // since Bun's TLS handshake passes those rules.
      if (
        response.status === 403 &&
        response.headers.get("cf-mitigated") === "challenge"
      ) {
        const viaBun = await fetchViaBun(
          resolvedUrl,
          { ...headers, "User-Agent": "code-agent" },
          controller.signal,
        );
        if (viaBun) {
          if (viaBun.status < 200 || viaBun.status >= 300) {
            throw new Error(`Request failed with status ${viaBun.status}`);
          }
          if (viaBun.body.length > WEB_FETCH_MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5 MB limit)");
          }
          const mime = viaBun.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
          if (isImageMime(mime)) {
            return {
              content: [{ type: "text", text: `Image content at ${resolvedUrl} (${mime}) - binary content skipped` }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: await formatBody(viaBun.body, viaBun.contentType, format),
              },
            ],
          };
        }
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
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
});
