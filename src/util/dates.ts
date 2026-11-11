const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

export type DateOrder = "DMY" | "MDY";

function iso(y: number, m: number, d: number): string | null {
  if (y < 1800 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Find the first date in a string and return it as YYYY-MM-DD.
 * Numeric dates are read with the registry's convention: California and
 * Florida print MM/DD/YYYY, UK and Australian registries print day first.
 */
export function toIsoDate(raw: string | null | undefined, order: DateOrder = "DMY"): string | null {
  if (!raw) return null;
  const s = raw.trim();

  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(s);
  if (m) {
    const mon = MONTHS[(m[2] ?? "").toLowerCase()];
    if (mon) return iso(Number(m[3]), mon, Number(m[1]));
  }

  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m) {
    const mon = MONTHS[(m[1] ?? "").toLowerCase()];
    if (mon) return iso(Number(m[3]), mon, Number(m[2]));
  }

  m = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    return order === "MDY" ? iso(y, a, b) : iso(y, b, a);
  }
  return null;
}

/** All dates in a string, in order of appearance. */
export function allIsoDates(raw: string, order: DateOrder = "DMY"): string[] {
  const out: string[] = [];
  const re =
    /(\d{4}-\d{2}-\d{2})|(\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b)|(\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b)|(\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\b)/g;
  for (const m of raw.matchAll(re)) {
    const d = toIsoDate(m[0], order);
    if (d) out.push(d);
  }
  return out;
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
