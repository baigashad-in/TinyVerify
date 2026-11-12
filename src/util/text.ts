import { createHash } from "node:crypto";

/**
 * Turn TinyFish markdown into clean lines that label parsers can read.
 *
 * Registry pages render the same field in several shapes:
 *   "Company status: Active"
 *   "Company status" then "Active" on the next line (definition lists)
 *   "| Company status | Active |" (tables)
 *   "**Company status** Active"
 * Table rows are kept as one line with " | " between cells so a row's
 * cells stay together (needed for history and sanction tables).
 */
export function cleanLines(text: string): string[] {
  const out: string[] = [];
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  for (let line of raw) {
    const isTable = /^\s*\|/.test(line);
    line = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links keep their text
      .replace(/<br\s*\/?>/gi, isTable ? " / " : "\n")
      .replace(/<[^>]+>/g, " ") // stray html tags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/[’‘]/g, "'")
      .replace(/\*\*|__|`/g, "")
      .replace(/ /g, " ");
    for (let part of line.split("\n")) {
      if (isTable) {
        const cells = part
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c.length > 0 && !/^:?-{2,}:?$/.test(c));
        if (cells.length === 0) continue;
        part = cells.join(" | ");
      } else {
        // Strip block markers until none are left: a list item can hold a
        // heading ("- ### TESCO PLC" on Companies House search pages).
        for (let prev = ""; prev !== part; ) {
          prev = part;
          part = part
            .replace(/^\s*#{1,6}\s+/, "")
            .replace(/^\s*>\s?/, "")
            .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")
            .replace(/^\s*\|+\s*|\s*\|+\s*$/g, "");
        }
      }
      part = part.replace(/\s+/g, " ").trim();
      if (part.length === 0 || /^[|:\-\s]+$/.test(part)) continue;
      out.push(part);
    }
  }
  return out;
}

/** Markdown headings in order, without the # marks. */
export function headings(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => /^\s*#{1,6}\s+\S/.test(l))
    .map((l) =>
      l
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\*\*|__|`/g, "")
        .trim(),
    );
}

export interface LabelHit {
  value: string;
  evidence: string;
  index: number;
}

export interface FindLabelOptions {
  from?: number;
  to?: number;
  /** Also accept "Label Value" on one line with no colon. Off by default. */
  sameLineNoColon?: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normLabel(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").replace(/\s*:\s*$/, "").trim();
}

/**
 * Find the value for a field label. Tries each label in order and returns the
 * first hit. The match is exact on the label, so "Status" does not match
 * "Status of annual filings".
 */
export function findLabel(lines: string[], labels: string[], opts: FindLabelOptions = {}): LabelHit | null {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(lines.length, opts.to ?? lines.length);
  for (const label of labels) {
    const L = normLabel(label);
    const colonRe = new RegExp(`^${escapeRegex(label)}\\s*:\\s*(.*)$`, "i");
    const spaceRe = new RegExp(`^${escapeRegex(label)}\\s+(.+)$`, "i");
    for (let i = from; i < to; i++) {
      const line = lines[i] ?? "";
      const next = lines[i + 1];
      // Table row: "Label | Value"
      if (line.includes(" | ")) {
        const cells = line.split(" | ");
        if (normLabel(cells[0] ?? "") === L) {
          const value = cells.slice(1).join(" | ").trim();
          if (value) return { value, evidence: line, index: i };
          if (next) return { value: stripLeadingColon(next), evidence: `${line} ${next}`, index: i };
        }
      }
      // Label alone on its line, value on the next line.
      if (normLabel(line) === L) {
        if (next !== undefined) {
          return { value: stripLeadingColon(next), evidence: `${line} ${next}`, index: i };
        }
        continue;
      }
      // "Label: value" (value may continue on the next line if empty here).
      const m = colonRe.exec(line);
      if (m) {
        const value = (m[1] ?? "").replace(/\s*\|\s*$/, "").trim();
        if (value) return { value, evidence: line, index: i };
        if (next !== undefined) return { value: stripLeadingColon(next), evidence: `${line} ${next}`, index: i };
      }
      if (opts.sameLineNoColon) {
        const s = spaceRe.exec(line);
        if (s && (s[1] ?? "").length <= 120) return { value: (s[1] ?? "").trim(), evidence: line, index: i };
      }
    }
  }
  return null;
}

function stripLeadingColon(s: string): string {
  return s.replace(/^\s*:\s*/, "").trim();
}

/** Index of the first line matching the pattern, or -1. */
export function indexOfLine(lines: string[], re: RegExp, from = 0): number {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) return i;
  }
  return -1;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash of the page with volatile lines removed (clock times, "as of" stamps).
 * Registry pages print the time of the search, so a raw hash changes on every
 * fetch even when the record did not change.
 */
export function stableHash(text: string): string {
  const kept = cleanLines(text).filter(
    (l) =>
      !/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(l) &&
      !/\b(?:as of|current as of|results of search on|record extracted|retrieved|generated on)\b/i.test(l),
  );
  return sha256(kept.join("\n"));
}

export function truncate(s: string, max = 240): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when url is http(s) and its host is one of the domains or a subdomain of one. */
export function isOnDomains(url: string | null | undefined, domains: string[]): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Resolve a possibly relative link against a base URL. */
export function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
