import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidAbn } from "../src/registries/abr.js";
import { isOfficialHost } from "../src/registries/discovery.js";
import { resolveJurisdiction, resolveRecordType, route } from "../src/registries/index.js";
import { allIsoDates, toIsoDate } from "../src/util/dates.js";
import { decide, nameScore, nameVariants } from "../src/util/match.js";
import { cleanLines, findLabel, stableHash } from "../src/util/text.js";

describe("dates", () => {
  it("reads registry date formats", () => {
    assert.equal(toIsoDate("27 November 1947"), "1947-11-27");
    assert.equal(toIsoDate("Active from 13 Aug 2023"), "2023-08-13");
    assert.equal(toIsoDate("04/30/2027", "MDY"), "2027-04-30");
    assert.equal(toIsoDate("04/05/2027", "DMY"), "2027-05-04");
    assert.equal(toIsoDate("Canada Not-for-profit Corporations Act - 2015-01-16"), "2015-01-16");
    assert.equal(toIsoDate("June 3, 2025"), "2025-06-03");
    assert.equal(toIsoDate("31/02/2026"), null, "invalid calendar date");
    assert.equal(toIsoDate("none"), null);
  });
  it("finds every date in a line", () => {
    assert.deepEqual(allIsoDates("Erasure | 28 Aug 2026 | 30 Aug 2027"), ["2026-08-28", "2027-08-30"]);
  });
});

describe("cleanLines and findLabel", () => {
  it("handles label/value on separate lines, colons, tables and bold", () => {
    const md = [
      "- Company status",
      "- Active",
      "Entity name: |",
      "ACME PTY LTD",
      "|",
      "| Expire Date | 04/30/2027 |",
      "**Company type** Private limited Company",
      "Status of annual filings",
      "2026 Filed",
    ].join("\n");
    const lines = cleanLines(md);
    assert.equal(findLabel(lines, ["Company status"])?.value, "Active");
    assert.equal(findLabel(lines, ["Entity name"])?.value, "ACME PTY LTD");
    assert.equal(findLabel(lines, ["Expire Date"])?.value, "04/30/2027");
    assert.equal(findLabel(lines, ["Company type"], { sameLineNoColon: true })?.value, "Private limited Company");
    assert.equal(findLabel(lines, ["Status"]), null, "Status must not match 'Status of annual filings'");
  });
  it("ignores volatile timestamps in the stable hash", () => {
    const a = "Status: Active\nData current as of 11/3/2026 6:40:38 PM";
    const b = "Status: Active\nData current as of 11/4/2026 7:02:11 AM";
    const c = "Status: Suspended\nData current as of 11/4/2026 7:02:11 AM";
    assert.equal(stableHash(a), stableHash(b));
    assert.notEqual(stableHash(a), stableHash(c));
  });
});

describe("ABN checksum", () => {
  it("accepts valid ABNs and rejects typos", () => {
    assert.ok(isValidAbn("88000014675"));
    assert.ok(isValidAbn("51824753556"));
    assert.ok(!isValidAbn("88000014676"));
    assert.ok(!isValidAbn("1234"));
  });
});

describe("name matching", () => {
  it("treats legal-form spellings and case as equal", () => {
    assert.equal(nameScore("Tesco PLC", "TESCO PLC", "business"), 1);
    assert.equal(nameScore("Exampleworks Ltd", "EXAMPLEWORKS LIMITED", "business"), 1);
    assert.equal(nameScore("Tesco PLC", "TESCO LIMITED", "business"), 0.98);
  });
  it("handles person name order and titles", () => {
    assert.equal(nameScore("Dr John Smith", "SMITH, John", "person"), 0.96);
    assert.ok(nameScore("Jonathan Smith", "Jonathon Smith", "person") >= 0.85, "typo in a long name is tolerated");
    assert.ok(nameScore("John Smith", "Jon Smith", "person") < 0.75, "short names must match exactly");
    assert.ok(nameScore("John Smith", "Jane Smythe", "person") < 0.75);
  });
  it("scores different companies low", () => {
    assert.ok(nameScore("Exampleworks Ltd", "EXAMPLEWORKS CREATIONS LTD", "business") < 0.92);
    assert.ok(nameScore("Acme Builders", "Zenith Roofing", "business") < 0.5);
  });
  it("builds useful variants", () => {
    assert.deepEqual(nameVariants("Example Widgets Ltd", "business"), ["Example Widgets Ltd", "Example Widgets"]);
    assert.deepEqual(nameVariants("Smith, John", "person", { lastFirst: true }), ["Smith John", "Smith, John", "John Smith"]);
  });
  it("never picks between two exact matches", () => {
    const d = decide([
      { item: "a", score: 1 },
      { item: "b", score: 1 },
    ]);
    assert.equal(d.kind, "multiple");
  });
  it("picks one strong match with a clear gap", () => {
    const d = decide([
      { item: "a", score: 0.97 },
      { item: "b", score: 0.6 },
    ]);
    assert.equal(d.kind, "single");
  });
  it("returns possible matches instead of guessing when nothing is strong", () => {
    const d = decide([
      { item: "a", score: 0.8 },
      { item: "b", score: 0.78 },
    ]);
    assert.equal(d.kind, "multiple");
  });
  it("returns none when nothing is close", () => {
    assert.equal(decide([{ item: "a", score: 0.3 }]).kind, "none");
  });
});

describe("routing", () => {
  it("maps free-text record types", () => {
    assert.equal(resolveRecordType("Contractor license"), "contractor_licence");
    assert.equal(resolveRecordType("doctor"), "medical_licence");
    assert.equal(resolveRecordType("company registration"), "business_registration");
    assert.equal(resolveRecordType("medical registration"), "medical_licence");
    assert.equal(resolveRecordType("real estate broker"), null);
  });
  it("flags ambiguous jurisdictions", () => {
    const j = resolveJurisdiction("CA");
    assert.ok(j.ambiguous);
    assert.deepEqual(j.keys, ["CA", "US-CA"]);
    assert.deepEqual(resolveJurisdiction("Toronto, Ontario, Canada").keys, ["CA"]);
    assert.deepEqual(resolveJurisdiction("England").keys, ["GB"]);
  });
  it("routes to the right registry", () => {
    assert.deepEqual(route({ record_type: "company", jurisdiction: "UK" }).adapters.map((a) => a.id), ["uk-companies-house"]);
    assert.deepEqual(route({ record_type: "doctor", jurisdiction: "UK" }).adapters.map((a) => a.id), ["uk-gmc"]);
    assert.deepEqual(route({ record_type: "contractor", jurisdiction: "CA" }).adapters.map((a) => a.id), ["us-ca-cslb"]);
    assert.deepEqual(route({ record_type: "company", jurisdiction: "CA" }).adapters.map((a) => a.id), ["ca-corporations-canada"]);
    assert.deepEqual(route({ record_type: "llc", jurisdiction: "Florida" }).adapters.map((a) => a.id), ["us-fl-sunbiz"]);
    assert.equal(route({ record_type: "nurse licence", jurisdiction: "Texas" }).adapters.length, 0);
  });
});

describe("official domain check", () => {
  it("accepts government and allowlisted regulator hosts only", () => {
    assert.ok(isOfficialHost("www.tmb.state.tx.us"));
    assert.ok(isOfficialHost("search.dca.ca.gov"));
    assert.ok(isOfficialHost("www.gmc-uk.org"));
    assert.ok(isOfficialHost("www.ahpra.gov.au"));
    assert.ok(!isOfficialHost("opencorporates.com"));
    assert.ok(!isOfficialHost("www.example-license-lookup.com"));
  });
});
