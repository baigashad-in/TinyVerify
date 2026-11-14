/**
 * Companies in places without a built-in register (v12): GLEIF finds the
 * company and its national register, TinyFish Search finds the register's
 * search page, TinyFish Agent reads the record. Every company, LEI and
 * register code here is invented.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpGleif, parseAuthority, parseCompletions, parseLeiRecord } from "../src/gleif/client.js";
import { genericNormalizeStatus } from "../src/registries/discovery.js";
import { resolvePlace } from "../src/registries/places.js";
import type { AgentParams } from "../src/tinyfish/gateway.js";
import { VerifyResultSchema } from "../src/types.js";
import { nameScore } from "../src/util/match.js";
import { baseDomain } from "../src/util/text.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, FakeGleif, lei } from "./helpers.js";

const DE_REG = { code: "RA990001", name: "Handelsregister (Amtsgericht Beispielstadt)", local_name: null, organisation: "Amtsgericht Beispielstadt", website: "https://www.handelsregister.de/", jurisdictions: [] };
const DE_REG2 = { ...DE_REG, code: "RA990002", name: "Handelsregister (Amtsgericht Musterhausen)", organisation: "Amtsgericht Musterhausen" };
const NL_REG = { code: "RA990003", name: "Handelsregister (Kamer van Koophandel)", local_name: null, organisation: "Kamer van Koophandel", website: "https://www.kvk.nl", jurisdictions: [] };
const JP_REG = { code: "RA990004", name: "Commercial Registry", local_name: null, organisation: "Legal Affairs Bureau", website: "https://www.houjin-bangou.nta.go.jp/", jurisdictions: [] };
const NY_REG = { code: "RA990005", name: "New York Department of State, Division of Corporations", local_name: null, organisation: null, website: "https://dos.ny.gov/", jurisdictions: [] };
const DEL_REG = { code: "RA990006", name: "Delaware Division of Corporations", local_name: null, organisation: null, website: "https://corp.delaware.gov/", jurisdictions: [] };

const MUSTER = lei({ lei: "9999009900MUSTER0001", legal_name: "Musterwerk Beispiel GmbH", jurisdiction: "DE", country: "DE", registered_at: "RA990001", registered_as: "HRB 999001" });
const MUSTER_BRANCH = lei({ lei: "9999009900MUSTER0002", legal_name: "Musterwerk Beispiel GmbH", jurisdiction: "DE", country: "DE", category: "BRANCH", registered_at: "RA990002", registered_as: "HRA 1" });
const MIHON = lei({
  lei: "9999009900MIHON00001",
  legal_name: "ミホン工業株式会社",
  other_names: ["MIHON KOGYO KABUSHIKI KAISHA", "Mihon Industries Co., Ltd."],
  jurisdiction: "JP",
  country: "JP",
  registered_at: "RA990004",
  registered_as: "9999999999999",
});
const HARBOR = lei({ lei: "9999009900HARBOR0001", legal_name: "Example Harbor Holdings, Inc.", jurisdiction: "US-DE", country: "US", registered_at: "RA990006", registered_as: "9999001" });

function setup() {
  const gw = new FakeGateway();
  const gleif = new FakeGleif();
  gleif.registers = [DE_REG, DE_REG2, NL_REG, JP_REG, NY_REG, DEL_REG];
  gleif.entities = [MUSTER, MUSTER_BRANCH, MIHON, HARBOR];
  gleif.samples.set("NL", [lei({ lei: "S1", legal_name: "x", jurisdiction: "NL", registered_at: "RA990003" }), lei({ lei: "S2", legal_name: "y", jurisdiction: "NL", registered_at: "RA990003" })]);
  gleif.samples.set("US-NY", [lei({ lei: "S3", legal_name: "z", jurisdiction: "US-NY", registered_at: "RA990005" })]);
  return { gw, gleif };
}

const record = (p: Partial<Record<string, unknown>>) => ({
  status: "COMPLETED" as const,
  run_id: "run-1",
  error: null,
  result: { page_state: "record", disciplinary_actions: [], other_fields: [], ...p },
});

describe("places anywhere", () => {
  it("resolves countries, states and provinces from many spellings", () => {
    const cases: [string, string][] = [
      ["Germany", "DE"], ["Munich, Germany", "DE"], ["Deutschland", "DE"], ["the Netherlands", "NL"], ["Holland", "NL"],
      ["Japan", "JP"], ["Côte d'Ivoire", "CI"], ["Hong Kong", "HK"], ["New York", "US-NY"], ["Austin, Texas", "US-TX"],
      ["NY", "US-NY"], ["US-DE", "US-DE"], ["Toronto, Ontario, Canada", "CA-ON"], ["Ontario Canada", "CA-ON"], ["Georgia (country)", "GE"],
      ["South Korea", "KR"], ["UAE", "AE"], ["Brasil", "BR"], ["New Zealand", "NZ"], ["DE", "DE"],
    ];
    for (const [input, code] of cases) assert.equal(resolvePlace(input)?.gleifJurisdiction, code, input);
    assert.equal(resolvePlace("Narnia"), null);
  });

  it("says how it read places that could mean two things", () => {
    assert.match(resolvePlace("Georgia")?.assumption ?? "", /US state/);
    assert.match(resolvePlace("DE")?.assumption ?? "", /country Germany.*US-DE/);
  });
});

describe("names and statuses in other languages", () => {
  it("matches spelled-out legal forms and non-Latin names", () => {
    assert.ok(nameScore("Musterwerk AG", "Musterwerk Aktiengesellschaft", "business") >= 0.98);
    assert.ok(nameScore("Société Exemple S.A.", "Societe Exemple SA", "business") >= 0.98);
    assert.ok(nameScore("Beispiel GmbH", "Beispiel Gesellschaft mit beschränkter Haftung", "business") >= 0.98);
    assert.ok(nameScore("ミホン工業株式会社", "ミホン工業株式会社", "business") === 1, "non-Latin names used to normalize to nothing");
    assert.ok(nameScore("ミホン工業株式会社", "Mihon Industries", "business") < 0.5);
  });

  it("maps common status words from other languages", () => {
    const cases: [string, string][] = [
      ["aktiv", "active"], ["Eingetragen", "active"], ["gelöscht", "dissolved"], ["Radiée", "dissolved"], ["Actif", "active"],
      ["Opgeheven", "dissolved"], ["Ingeschreven", "active"], ["En liquidation", "insolvency"], ["Insolvenzverfahren eröffnet", "insolvency"],
      ["Activa", "active"], ["Extinguida", "dissolved"], ["Attiva", "active"], ["Cessata", "dissolved"], ["inaktiv", "inactive"],
    ];
    for (const [raw, want] of cases) assert.equal(genericNormalizeStatus(raw), want, raw);
  });

  it("keeps a register's own domain", () => {
    assert.equal(baseDomain("www.kvk.nl"), "kvk.nl");
    assert.equal(baseDomain("www.handelsregister.de"), "handelsregister.de");
    assert.equal(baseDomain("apps.dos.ny.gov"), "dos.ny.gov");
    assert.equal(baseDomain("app.companiesoffice.govt.nz"), "companiesoffice.govt.nz");
  });
});

describe("worldwide company checks", () => {
  it("finds the company on the LEI register, then reads its national register by number with the Agent", async () => {
    const { gw, gleif } = setup();
    gw.searchHits = [
      { position: 1, title: "Handelsregister - Normale Suche", url: "https://www.handelsregister.de/rp_web/normalesuche.xhtml", snippet: "", site_name: "handelsregister.de" },
      { position: 2, title: "Company lookup", url: "https://www.northdata.example/x", snippet: "", site_name: "northdata.example" },
    ];
    let agent: AgentParams | null = null;
    gw.agentHandler = (p) => {
      agent = p;
      return record({ name: "Musterwerk Beispiel GmbH", identifier: "HRB 999001", status_text: "aktiv", evidence_quote: "Status: aktiv", record_url: "https://www.handelsregister.de/rp_web/x" });
    };
    const r = await verify({ name: "Musterwerk Beispiel GmbH", record_type: "company", jurisdiction: "Germany" }, { gateway: gw, gleif });
    assert.equal(r.outcome, "verified", r.message);
    const a = agent as AgentParams | null;
    assert.equal(a?.url, "https://www.handelsregister.de/rp_web/normalesuche.xhtml", "starts at the search page found on the register's own site");
    assert.equal(a?.proxy_country, "DE");
    assert.match(a?.goal ?? "", /HRB 999001/);
    assert.match(a?.goal ?? "", /not be in English/);
    assert.equal(r.records[0]?.status.normalized, "active");
    assert.equal(r.records[0]?.registry.name, "Handelsregister (Amtsgericht Beispielstadt)", "the court from the LEI record, not the branch's");
    assert.equal(r.lei_records.length, 1, "the BRANCH entry with the same name is left out");
    assert.equal(r.lei_records[0]?.counts_as_verified, false);
    assert.ok(r.warnings.some((w) => /Registration Authorities List.*RA990001.*named in this company's LEI record/.test(w)), r.warnings.join(" | "));
    assert.ok(r.sources_checked.some((s) => s.step === "lei" && s.method === "gleif_api"));
    assert.ok(VerifyResultSchema.safeParse(r).success);
  });

  it("does not count the LEI record as verified when the national register cannot be read", async () => {
    const { gw, gleif } = setup();
    gw.agentHandler = () => record({ page_state: "error" });
    const r = await verify({ name: "Musterwerk Beispiel GmbH", record_type: "company", jurisdiction: "Germany" }, { gateway: gw, gleif });
    assert.equal(r.outcome, "source_unavailable");
    assert.equal(r.records.length, 0);
    assert.equal(r.lei_records[0]?.registered_as, "HRB 999001");
    assert.match(r.message, /global LEI register lists Musterwerk Beispiel GmbH \(LEI 9999009900MUSTER0001.*does not count as verified/);
  });

  it("accepts a register name in another script when it matches the LEI record for that number", async () => {
    const { gw, gleif } = setup();
    gw.agentHandler = () => record({ name: "ミホン工業株式会社", identifier: "9999999999999", status_text: "Active", evidence_quote: "Active" });
    const r = await verify({ name: "Mihon Industries Co., Ltd.", record_type: "company", jurisdiction: "Japan" }, { gateway: gw, gleif });
    assert.equal(r.outcome, "verified", r.message);
    assert.ok(r.warnings.some((w) => /register shows the name as "ミホン工業株式会社".*LEI record/.test(w)));
  });

  it("checks the place asked about, and says when the LEI record is filed elsewhere", async () => {
    const { gw, gleif } = setup();
    const goals: string[] = [];
    gw.agentHandler = (p) => {
      goals.push(p.goal);
      return { status: "COMPLETED", run_id: "s", error: null, result: { page_state: "no_results", no_results_message: "No business entities were found", candidates: [] } };
    };
    const r = await verify({ name: "Example Harbor Holdings, Inc.", record_type: "corporation", jurisdiction: "New York" }, { gateway: gw, gleif });
    assert.ok(r.warnings.some((w) => /incorporated in US-DE, not New York/.test(w)), r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /New York Department of State.*sampled LEI records/.test(w)), r.warnings.join(" | "));
    assert.ok(!goals.some((g) => g.includes("9999001")), "the Delaware number is not used on the New York register");
    assert.equal(r.outcome, "no_match");
  });

  it("finds the register from LEI records filed in the place when the company has no LEI", async () => {
    const { gw, gleif } = setup();
    gw.agentHandler = (p) =>
      p.goal.includes("Return every result")
        ? { status: "COMPLETED", run_id: "s", error: null, result: { page_state: "results_list", candidates: [{ name: "Voorbeeld Handel B.V.", identifier: "99999901", status: "Ingeschreven", record_url: "https://www.kvk.nl/x/99999901" }] } }
        : record({ name: "Voorbeeld Handel B.V.", identifier: "99999901", status_text: "Ingeschreven", evidence_quote: "Ingeschreven" });
    const r = await verify({ name: "Voorbeeld Handel BV", record_type: "company", jurisdiction: "Netherlands" }, { gateway: gw, gleif });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.status.normalized, "active");
    assert.equal(r.lei_records.length, 0);
    assert.ok(r.warnings.some((w) => /Kamer van Koophandel.*2 of 2 sampled LEI records from Netherlands/.test(w)), r.warnings.join(" | "));
  });

  it("asks for the state when a US company is not on the LEI register", async () => {
    const { gw, gleif } = setup();
    const r = await verify({ name: "Unknown Example Widgets LLC", record_type: "company", jurisdiction: "United States" }, { gateway: gw, gleif });
    assert.equal(r.outcome, "unsupported");
    assert.match(r.message, /registered by state.*Delaware/);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });

  it("falls back to TinyFish Search when the GLEIF API is down, and says so", async () => {
    const { gw, gleif } = setup();
    gleif.failWith = "timed out after 20000 ms";
    gw.searchHits = [];
    const r = await verify({ name: "Musterwerk Beispiel GmbH", record_type: "company", jurisdiction: "Germany" }, { gateway: gw, gleif });
    assert.equal(r.outcome, "unsupported");
    assert.ok(r.warnings.some((w) => /GLEIF API could not be used.*TinyFish Search/.test(w)));
  });

  it("leaves licence checks and built-in registers alone", async () => {
    const { gw, gleif } = setup();
    gw.searchHits = [];
    await verify({ name: "Mary Example", record_type: "nurse licence", jurisdiction: "Germany" }, { gateway: gw, gleif });
    assert.equal(gleif.calls.length, 0, "GLEIF is for companies only");
  });
});

describe("GLEIF API parsing", () => {
  const item = {
    type: "lei-records",
    id: "9999009900PARSE00001",
    attributes: {
      lei: "9999009900PARSE00001",
      entity: {
        legalName: { name: "Parse Example SE", language: "de" },
        otherNames: [{ name: "Parse Example Europe", language: "en", type: "ALTERNATIVE_LANGUAGE_LEGAL_NAME" }],
        transliteratedOtherNames: [],
        legalAddress: { country: "DE", city: "Beispielstadt" },
        jurisdiction: "DE",
        category: "GENERAL",
        legalForm: { id: "XXXX", other: null },
        status: "ACTIVE",
        registeredAt: { id: "RA990001", other: null },
        registeredAs: "HRB 999002",
      },
      registration: { initialRegistrationDate: "2014-01-01T00:00:00Z", lastUpdateDate: "2026-09-01T00:00:00Z", status: "ISSUED", nextRenewalDate: "2027-09-01T00:00:00Z" },
    },
  };

  it("reads LEI records, registers and fuzzy completions", () => {
    const e = parseLeiRecord(item);
    assert.equal(e?.registered_at, "RA990001");
    assert.equal(e?.registered_as, "HRB 999002");
    assert.deepEqual(e?.other_names, ["Parse Example Europe"]);
    assert.equal(e?.registration_status, "ISSUED");
    const ra = parseAuthority({ attributes: { code: "RA990009", internationalName: null, localName: "Registro Ejemplo", website: "www.registro.example.es" } });
    assert.equal(ra?.name, "Registro Ejemplo");
    assert.equal(ra?.website, "https://www.registro.example.es");
    assert.deepEqual(parseCompletions({ data: [{ attributes: { value: "X" }, relationships: { "lei-records": { data: { id: "L1" } } } }, { attributes: { value: "Y" } }] }), ["L1"]);
  });

  it("tries exact name, then full text, then fuzzy, and retries once after a server error", async () => {
    const urls: string[] = [];
    let first500 = true;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const u = decodeURIComponent(url);
      if (u.includes("filter[fulltext]") && first500) {
        first500 = false;
        return new Response("busy", { status: 503 });
      }
      if (u.includes("fuzzycompletions")) return Response.json({ data: [{ attributes: { value: "Parse Example SE" }, relationships: { "lei-records": { data: { id: "9999009900PARSE00001" } } } }] });
      if (u.includes("lei-records/9999009900PARSE00001")) return Response.json({ data: item });
      return Response.json({ data: [] });
    }) as unknown as typeof fetch;
    const g = new HttpGleif({ fetchImpl });
    const out = await g.searchByName("Parse Exampel SE");
    assert.equal(out.method, "fuzzy");
    assert.equal(out.entities[0]?.lei, "9999009900PARSE00001");
    assert.equal(urls.filter((u) => decodeURIComponent(u).includes("filter[fulltext]")).length, 2, "one retry after 503");
    assert.ok(g.calls.every((c) => c.ok));
  });

  it("moves on to the next search when the results are all in another country", async () => {
    const elsewhere = { ...item, attributes: { ...item.attributes, lei: "9999009900ELSEW00001", entity: { ...item.attributes.entity, jurisdiction: "US-DE", legalAddress: { country: "US" } } } };
    const fetchImpl = (async (url: string) => {
      const u = decodeURIComponent(url);
      if (u.includes("filter[entity.legalName]")) return Response.json({ data: [elsewhere] });
      if (u.includes("filter[fulltext]")) return Response.json({ data: [item] });
      return Response.json({ data: [] });
    }) as unknown as typeof fetch;
    const out = await new HttpGleif({ fetchImpl }).searchByName("Parse Example SE", (e) => e.jurisdiction === "DE");
    assert.equal(out.method, "fulltext");
    assert.equal(out.entities[0]?.jurisdiction, "DE");
  });
});
