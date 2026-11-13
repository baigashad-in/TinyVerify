/**
 * Tests for the fifth live run (v7, 12 Nov 2026). Every case gave the right
 * outcome; these cover what the output did not say clearly enough.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canadaSearchUrl, corporationsCanada, parseCanadaRecord } from "../src/registries/corporationsCanada.js";
import type { SearchHit } from "../src/tinyfish/gateway.js";
import type { FetchedPage } from "../src/types.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, fixture } from "./helpers.js";

const p = (text: string, url = "https://x"): FetchedPage => ({ url, final_url: url, title: null, text });

const SEARCH = [
  "## Search Results",
  "",
  "1 results were found, 1 returned.",
  "",
  "* 1.Northwind Example Trading Inc.  ",
  "  Status: Active  ",
  "  Corporation number: 000000-0  ",
  "",
  "* Date Modified:",
].join("\n");

describe("'CA' when California has no usable register page", () => {
  const directoryCard: SearchHit = {
    position: 1,
    title: "Secretary of State (SOS)",
    url: "https://www.ca.gov/departments/275/",
    snippet: "",
    site_name: "ca.gov",
  };

  it("verifies Canada, and warns that California was not checked, naming the skipped page", async () => {
    const gw = new FakeGateway();
    const req = "Northwind Example Trading Inc.";
    gw.pages.set(canadaSearchUrl(req), p(SEARCH, canadaSearchUrl(req)));
    const rec = corporationsCanada.recordUrl("0000000") as string;
    gw.pages.set(rec, p(fixture("canada-record-live-layout.md"), rec));
    gw.searchHits = [directoryCard];
    const r = await verify({ name: req, record_type: "corporation", jurisdiction: "CA" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.ok(
      r.warnings.some((w) => /^California, United States was not checked: no official register search page was found/.test(w)),
      r.warnings.join(" | "),
    );
    assert.ok(!r.warnings.some((w) => /checked each one/.test(w)), "the old wording claimed both places were checked");
    const d = r.sources_checked.find((s) => s.step === "discover");
    assert.match(d?.detail ?? "", /"Secretary of State \(SOS\)" https:\/\/www\.ca\.gov\/departments\/275\//);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });
});

describe("Corporations Canada registered office, main-content layout", () => {
  it("reads the address lines before the 'Update registered office address' link", () => {
    // Shape of the live main-content Markdown (12 Nov 2026): no address label.
    const text = [
      "**Corporate name:**",
      "",
      "**Northwind Example Trading Inc.**",
      "",
      "**Status:**",
      "",
      "Active",
      "",
      "**Corporation number:**",
      "",
      "000000-0",
      "",
      "Get a Certificate of Compliance ",
      "Get a Certificate of Existence",
      "",
      "1 Example Street  ",
      "Exampletown PE A0A 0A0  ",
      "Canada",
      "",
      "Update registered office address",
    ].join("\n");
    const r = parseCanadaRecord(p(text));
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (r.ok) assert.equal(r.record.details.registered_office_address, "1 Example Street, Exampletown PE A0A 0A0, Canada");
  });
});
