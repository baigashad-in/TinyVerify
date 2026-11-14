/**
 * GLEIF (Global Legal Entity Identifier Foundation) API client.
 *
 * Two public GLEIF data sets are used, both free and without an API key
 * (https://api.gleif.org/api/v1):
 *
 * - The LEI register: about 2.9 million legal entities worldwide. Each record
 *   names the national register the entity is filed with (`registeredAt`, an
 *   RA code) and its number there (`registeredAs`). Mostly larger companies:
 *   an LEI is needed to trade securities and derivatives, so most small
 *   businesses do not have one.
 * - The Registration Authorities List: about 1,200 business registers in more
 *   than 230 jurisdictions, each with its website.
 *
 * TinyVerify uses these to find the right national register and the company's
 * number there. An LEI record is shown as supporting information, but it is
 * never counted as "verified": only the national register itself is.
 *
 * These are plain JSON APIs, so they are called directly, not through TinyFish.
 * The parser accepts missing fields, because the sandbox this was built in
 * could not reach the API; `npm run dump:gleif` saves real responses to check.
 */

export interface LeiEntity {
  lei: string;
  legal_name: string;
  /** Other legal names, translations, transliterations and previous names. */
  other_names: string[];
  /** ISO code of the legal jurisdiction, e.g. "DE" or "US-DE". */
  jurisdiction: string | null;
  /** ISO country code of the legal address. */
  country: string | null;
  city: string | null;
  legal_form: string | null;
  /** GENERAL, BRANCH, FUND, SOLE_PROPRIETOR, ... */
  category: string | null;
  /** ACTIVE or INACTIVE. */
  entity_status: string | null;
  /** ISSUED, LAPSED, RETIRED, MERGED, ANNULLED, DUPLICATE, ... */
  registration_status: string | null;
  /** RA code of the national register, e.g. "RA000585". */
  registered_at: string | null;
  /** The entity's number in that register. */
  registered_as: string | null;
  initial_registration: string | null;
  last_update: string | null;
  next_renewal: string | null;
}

export interface RegistrationAuthority {
  code: string;
  name: string;
  local_name: string | null;
  organisation: string | null;
  website: string | null;
  /** ISO codes, when the API includes them. */
  jurisdictions: string[];
}

export interface GleifCall {
  url: string;
  ok: boolean;
  ms: number;
  count: number | null;
  error: string | null;
}

export interface Gleif {
  /**
   * Search by name: exact legal name, then full text (other names too), then
   * fuzzy. A step's results are used when `accept` passes at least one of them
   * (for example "in the requested country"); otherwise the next step runs.
   */
  searchByName(name: string, accept?: (e: LeiEntity) => boolean): Promise<{ entities: LeiEntity[]; method: "legal_name" | "fulltext" | "fuzzy" | "none" }>;
  /** A sample of current LEI records filed in one jurisdiction ("DE", "US-NY"). */
  sampleJurisdiction(code: string, size?: number): Promise<LeiEntity[]>;
  /** The Registration Authorities List. Cached. */
  authorities(): Promise<RegistrationAuthority[]>;
  /** Every HTTP call made, for the result's sources_checked. */
  readonly calls: GleifCall[];
  /** A client with its own call log for one request (shares caches). */
  forRequest?(): Gleif;
}

export const GLEIF_RECORD_PAGE = (lei: string) => `https://search.gleif.org/#/record/${encodeURIComponent(lei)}`;
/** RA codes that mean "no register" (RA888888 other, RA999999 not available). */
export const NO_REGISTER = new Set(["RA888888", "RA999999"]);

// tolerant parsing

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One item of `data` from /lei-records or /lei-records/{lei}. */
export function parseLeiRecord(item: unknown): LeiEntity | null {
  const a = obj(obj(item).attributes);
  const lei = s(a.lei) ?? s(obj(item).id);
  const e = obj(a.entity);
  const legal = s(obj(e.legalName).name) ?? s(e.legalName);
  if (!lei || !legal) return null;
  const names = [...arr(e.otherNames), ...arr(e.transliteratedOtherNames)]
    .map((n) => s(obj(n).name) ?? s(n))
    .filter((n): n is string => !!n && n !== legal);
  const reg = obj(a.registration);
  const addr = obj(e.legalAddress);
  return {
    lei,
    legal_name: legal,
    other_names: [...new Set(names)],
    jurisdiction: s(e.jurisdiction),
    country: s(addr.country),
    city: s(addr.city),
    legal_form: s(obj(e.legalForm).id) ?? s(obj(e.legalForm).other),
    category: s(e.category),
    entity_status: s(e.status),
    registration_status: s(reg.status),
    registered_at: s(obj(e.registeredAt).id) ?? s(e.registeredAt),
    registered_as: s(e.registeredAs),
    initial_registration: s(reg.initialRegistrationDate),
    last_update: s(reg.lastUpdateDate),
    next_renewal: s(reg.nextRenewalDate),
  };
}

/** One item of `data` from /registration-authorities. */
export function parseAuthority(item: unknown): RegistrationAuthority | null {
  const a = obj(obj(item).attributes);
  const code = s(a.code) ?? s(obj(item).id);
  if (!code) return null;
  const name = s(a.internationalName) ?? s(a.localName) ?? s(a.internationalOrganizationName) ?? s(a.localOrganizationName) ?? code;
  let website = s(a.website);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  const jurisdictions = arr(a.jurisdictions)
    .map((j) => s(obj(j).jurisdiction) ?? s(obj(j).countryCode) ?? s(j))
    .filter((j): j is string => !!j && /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(j));
  return {
    code,
    name,
    local_name: s(a.localName),
    organisation: s(a.internationalOrganizationName) ?? s(a.localOrganizationName),
    website,
    jurisdictions,
  };
}

/** LEIs from /fuzzycompletions. */
export function parseCompletions(body: unknown): string[] {
  return arr(obj(body).data)
    .map((d) => s(obj(obj(obj(obj(d).relationships)["lei-records"]).data).id))
    .filter((x): x is string => !!x);
}

// HTTP client

export interface HttpGleifOptions {
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Called after each request; used by the dump script. */
  onResponse?: (url: string, body: unknown) => void;
}

export class HttpGleif implements Gleif {
  readonly calls: GleifCall[] = [];
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private raCache: Promise<RegistrationAuthority[]> | null = null;

  constructor(private readonly opts: HttpGleifOptions = {}) {
    this.base = (opts.base ?? "https://api.gleif.org/api/v1").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** A fresh call log for one request, sharing the authorities cache. */
  forRequest(): HttpGleif {
    const c = new HttpGleif(this.opts);
    c.raCache = this.authorities();
    return c;
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${this.base}/${path}?${new URLSearchParams(params).toString()}`;
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { headers: { accept: "application/vnd.api+json, application/json", "user-agent": "TinyVerify" }, signal: ctrl.signal });
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (!res.ok) throw new Error(`GLEIF API ${res.status}`);
        const body: unknown = await res.json();
        this.calls.push({ url, ok: true, ms: Date.now() - started, count: arr(obj(body).data).length || (obj(body).data ? 1 : 0), error: null });
        this.opts.onResponse?.(url, body);
        return body;
      } catch (err) {
        const msg = err instanceof Error ? (err.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : err.message) : String(err);
        if (attempt === 0 && /timed out|fetch failed|ECONNRESET/i.test(msg)) continue;
        this.calls.push({ url, ok: false, ms: Date.now() - started, count: null, error: msg });
        throw new Error(`GLEIF API: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private records(body: unknown): LeiEntity[] {
    const data = obj(body).data;
    return (Array.isArray(data) ? data : data ? [data] : []).map(parseLeiRecord).filter((x): x is LeiEntity => !!x);
  }

  async searchByName(name: string, accept: (e: LeiEntity) => boolean = () => true): Promise<{ entities: LeiEntity[]; method: "legal_name" | "fulltext" | "fuzzy" | "none" }> {
    const seen: LeiEntity[] = [];
    const exact = this.records(await this.get("lei-records", { "filter[entity.legalName]": name, "page[size]": "10" }));
    if (exact.some(accept)) return { entities: exact, method: "legal_name" };
    seen.push(...exact);
    // Full text also searches other names, translations and previous names.
    const full = this.records(await this.get("lei-records", { "filter[fulltext]": name, "page[size]": "15" }));
    if (full.some(accept)) return { entities: full, method: "fulltext" };
    seen.push(...full);
    const leis = parseCompletions(await this.get("fuzzycompletions", { field: "entity.legalName", q: name })).slice(0, 5);
    const fuzzy: LeiEntity[] = [];
    for (const lei of leis) fuzzy.push(...this.records(await this.get(`lei-records/${encodeURIComponent(lei)}`, {})));
    if (fuzzy.some(accept)) return { entities: fuzzy, method: "fuzzy" };
    seen.push(...fuzzy);
    // Nothing in the requested place: return what was seen, so the caller can say so.
    return seen.length ? { entities: seen, method: "none" } : { entities: [], method: "none" };
  }

  async sampleJurisdiction(code: string, size = 50): Promise<LeiEntity[]> {
    return this.records(
      await this.get("lei-records", { "filter[entity.jurisdiction]": code, "filter[registration.status]": "ISSUED", "page[size]": String(size) }),
    );
  }

  private async loadAuthorities(): Promise<RegistrationAuthority[]> {
    const out: RegistrationAuthority[] = [];
    for (let page = 1; page <= 15; page++) {
      const body = await this.get("registration-authorities", { "page[size]": "200", "page[number]": String(page) });
      const items = arr(obj(body).data).map(parseAuthority).filter((x): x is RegistrationAuthority => !!x);
      out.push(...items);
      const last = Number(obj(obj(obj(body).meta).pagination).lastPage);
      if (items.length === 0 || (Number.isFinite(last) && page >= last)) break;
    }
    return out;
  }

  authorities(): Promise<RegistrationAuthority[]> {
    if (!this.raCache) {
      this.raCache = this.loadAuthorities().catch((err) => {
        this.raCache = null; // try again on the next request
        throw err;
      });
    }
    return this.raCache;
  }
}
