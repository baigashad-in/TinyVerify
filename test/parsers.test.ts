import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abr, parseAbrRecord, parseAbrSearch } from "../src/registries/abr.js";
import { companiesHouse, parseCompaniesHouseRecord, parseCompaniesHouseSearch } from "../src/registries/companiesHouse.js";
import { corporationsCanada, parseCanadaRecord } from "../src/registries/corporationsCanada.js";
import { cslb, parseCslbRecord } from "../src/registries/cslb.js";
import { gmc, parseGmcRecord } from "../src/registries/gmc.js";
import { parseSunbizRecord } from "../src/registries/sunbiz.js";
import type { ParseOutcome } from "../src/registries/types.js";
import { page } from "./helpers.js";

function ok(p: ParseOutcome) {
  assert.ok(p.ok, p.ok ? "" : `expected a parsed record, got: ${p.reason}`);
  return p.record;
}

describe("Companies House", () => {
  it("parses an active company", () => {
    const r = ok(parseCompaniesHouseRecord(page(companiesHouse.recordUrl("00445790") as string, "ch-tesco.md")));
    assert.equal(r.name, "TESCO PLC");
    assert.equal(r.identifier, "00445790");
    assert.equal(r.status_raw, "Active");
    assert.equal(r.status, "active");
    assert.equal(r.issue_date, "1947-11-27");
    assert.equal(r.details.company_type, "Public limited Company");
    assert.equal(r.compliance_flags.length, 0);
    assert.ok(r.evidence.some((e) => e.includes("Company status")));
  });
  it("parses a dissolved company from a table", () => {
    const r = ok(parseCompaniesHouseRecord(page("https://x/company/99345678", "ch-dissolved.md")));
    assert.equal(r.status, "dissolved");
    assert.equal(r.status_effective_date, "2026-03-03");
    assert.equal(r.identifier, "99345678");
  });
  it("flags strike-off and overdue accounts", () => {
    const r = ok(parseCompaniesHouseRecord(page("https://x/company/99876543", "ch-strike-off.md")));
    assert.equal(r.status, "active");
    assert.equal(r.status_raw, "Active - Proposal to Strike off");
    const codes = r.compliance_flags.map((f) => f.code).sort();
    assert.deepEqual(codes, ["filing_overdue", "proposal_to_strike_off"]);
  });
  it("does not treat a bot wall as a record or as not found", () => {
    const p = parseCompaniesHouseRecord(page("https://x/company/00445790", "bot-wall.md"));
    assert.ok(!p.ok);
    assert.ok(!p.ok && p.blocked && !p.notFound);
  });
  it("parses search results with previous-name matches", () => {
    const s = parseCompaniesHouseSearch(page("https://x/search", "ch-search-example.md"));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.equal(s.total, 78);
    assert.equal(s.candidates.length, 4);
    const first = s.candidates[0];
    assert.equal(first?.name, "EXAMPLEWORKS LIMITED");
    assert.equal(first?.identifier, "99153983");
    assert.ok(first?.matched_previous_name);
    assert.equal(s.candidates[3]?.identifier, "NI995706");
    assert.equal(s.candidates[3]?.status_raw, "Dissolved");
  });
  it("validates company numbers", () => {
    assert.equal(companiesHouse.normalizeIdentifier("445790"), "00445790");
    assert.equal(companiesHouse.normalizeIdentifier("sc123456"), "SC123456");
    assert.equal(companiesHouse.normalizeIdentifier("ABC"), null);
  });
});

describe("GMC", () => {
  it("parses a registered doctor", () => {
    const r = ok(parseGmcRecord(page(gmc.recordUrl("9912345") as string, "gmc-registered.md")));
    assert.equal(r.identifier, "9912345");
    assert.equal(r.name, "Jane EXAMPLE");
    assert.equal(r.status, "active");
    assert.equal(r.status_raw, "Registered with a licence to practise");
    assert.equal(r.renewal_due_date, "2027-04-23");
    assert.equal(r.expiry_date, null);
    assert.equal(r.disciplinary_actions.length, 0);
    assert.equal(r.registry_timestamp, "04 Nov 2026 at 09:12");
  });
  it("parses an erased doctor with the sanction", () => {
    const r = ok(parseGmcRecord(page(gmc.recordUrl("9954321") as string, "gmc-erased.md")));
    assert.equal(r.status, "revoked");
    assert.equal(r.disciplinary_actions.length, 1);
    const a = r.disciplinary_actions[0];
    assert.equal(a?.kind, "erasure");
    assert.equal(a?.start_date, "2026-08-28");
    assert.ok(!r.disciplinary_actions.some((x) => x.kind === "suspension"), "history rows are not sanctions");
  });
});

describe("ABN Lookup", () => {
  it("parses an active ABN from split table cells", () => {
    const r = ok(parseAbrRecord(page(abr.recordUrl("88000014675") as string, "abr-woolworths.md")));
    assert.equal(r.name, "WOOLWORTHS GROUP LIMITED");
    assert.equal(r.identifier, "88000014675");
    assert.equal(r.status, "active");
    assert.equal(r.status_effective_date, "1999-11-01");
    assert.equal(r.identifiers.acn, "000014675");
    assert.equal(r.registry_timestamp, "04 Nov 2026");
  });
  it("parses a cancelled ABN", () => {
    const r = ok(parseAbrRecord(page(abr.recordUrl("10000000000") as string, "abr-cancelled.md")));
    assert.equal(r.status, "cancelled");
    assert.equal(r.status_effective_date, "2025-06-30");
    assert.ok(r.compliance_flags.some((f) => f.code === "gst_not_registered"));
  });
  it("parses search rows and merges business names into one ABN", () => {
    const s = parseAbrSearch(page("https://abr/search", "abr-search.md"));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.equal(s.candidates.length, 1);
    assert.equal(s.candidates[0]?.name, "WOOLWORTHS GROUP LIMITED");
    assert.equal(s.candidates[0]?.status_raw, "Active");
  });
});

describe("CSLB", () => {
  it("parses an active licence from a table with <br> cells", () => {
    const r = ok(parseCslbRecord(page(cslb.recordUrl("99123456") as string, "cslb-active.md")));
    assert.equal(r.identifier, "99123456");
    assert.equal(r.name, "EXAMPLE BUILDERS INC");
    assert.equal(r.status, "active");
    assert.equal(r.issue_date, "2015-04-23");
    assert.equal(r.expiry_date, "2027-04-30");
    assert.equal(r.disciplinary_actions.length, 0, "disclaimer text must not count as an action");
    assert.deepEqual(r.details.classifications, ["B - GENERAL BUILDING", "C10 - ELECTRICAL"]);
    assert.equal(r.registry_timestamp, "11/3/2026 6:40:38 PM");
  });
  it("parses an expired licence with a suspension and a legal action", () => {
    const r = ok(parseCslbRecord(page(cslb.recordUrl("99654321") as string, "cslb-suspended.md")));
    assert.equal(r.status, "expired");
    assert.equal(r.name, "SAMPLE ROOFING");
    const kinds = r.disciplinary_actions.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["legal_action", "suspension"]);
    assert.equal(r.disciplinary_actions.find((a) => a.kind === "suspension")?.start_date, "2025-05-02");
    assert.ok(r.compliance_flags.some((f) => f.code === "workers_comp_exempt"));
  });
  it("treats the search-form redirect as unreadable, not as no match", () => {
    const p = parseCslbRecord(page(cslb.recordUrl("99123456") as string, "cslb-search-form.md"));
    assert.ok(!p.ok && !p.notFound);
  });
});

describe("Corporations Canada", () => {
  it("parses status; alert wording alone is not a flag", () => {
    const r = ok(parseCanadaRecord(page(corporationsCanada.recordUrl("0000000") as string, "canada-alerts.md")));
    assert.equal(r.name, "Northwind Example Friendship Association");
    assert.equal(r.identifier, "0000000");
    assert.equal(r.identifiers.corporation_number, "000000-0");
    assert.equal(r.identifiers.business_number, "000000000RC0001");
    assert.equal(r.status, "active");
    // Every live record page carries the "Annual filings overdue" alert text,
    // compliant or not (see live-run-3.test.ts), so it is not evidence.
    assert.deepEqual(r.compliance_flags, []);
  });
});

describe("Sunbiz", () => {
  it("maps INACTIVE plus admin dissolution to dissolved", () => {
    const r = ok(parseSunbizRecord(page("https://search.sunbiz.org/x", "sunbiz-inactive.md")));
    assert.equal(r.name, "EXAMPLE MARINE SUPPLY, INC.");
    assert.equal(r.identifier, "P26999999999");
    assert.equal(r.status_raw, "INACTIVE");
    assert.equal(r.status, "dissolved");
    assert.equal(r.status_effective_date, "2024-09-27");
    assert.equal(r.details.last_annual_report_year, "2023");
    assert.ok(r.compliance_flags.some((f) => f.code === "administrative_dissolution"));
  });
});
