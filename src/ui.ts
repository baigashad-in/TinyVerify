import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The web page is one HTML file with its CSS and script inline, so there is
 * no build step. The Content-Security-Policy allows only those exact inline
 * blocks (by SHA-256 hash), Google Fonts, and calls back to this server.
 */
export interface UiPage {
  html: string;
  csp: string;
}

const PAGE_URL = new URL("../public/index.html", import.meta.url);

function hashOf(html: string, tag: "script" | "style"): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(re)].map((m) => `'sha256-${createHash("sha256").update(m[1] ?? "", "utf8").digest("base64")}'`);
}

export function buildCsp(html: string): string {
  return [
    "default-src 'none'",
    `script-src ${hashOf(html, "script").join(" ")}`,
    `style-src ${hashOf(html, "style").join(" ")} https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

let cached: UiPage | null | undefined;

/** Reads public/index.html once. Returns null if the file is missing. */
export function loadUiPage(): UiPage | null {
  if (cached !== undefined) return cached;
  try {
    const html = readFileSync(PAGE_URL, "utf8");
    cached = { html, csp: buildCsp(html) };
  } catch {
    cached = null;
  }
  return cached;
}
