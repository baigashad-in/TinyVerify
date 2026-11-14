# TinyVerify

Check a licence or registration on the **official registry**, get back a structured record with proof, and get an alert when it changes.

TinyVerify takes a person or business name, a record type and a place. It finds the right official registry, reads the record live through TinyFish, and returns status, number, dates, disciplinary actions, the source link and the time it checked. It never guesses: no match and several matches come back as clear outcomes. TinyFish Monitor then watches the record page and TinyVerify turns page changes into field-level alerts.

Built for TinyFish Bounty Drop 002 (TinyVerify). Uses four TinyFish endpoints: **Fetch, Agent, Search, Monitor**. For companies in countries without a built-in register, it also uses the free GLEIF API (the global LEI register and its list of about 1,200 national business registers) to find the right register.

## What it answers

| Question | Registry used |
| :-- | :-- |
| Is this doctor licensed in the UK? | GMC medical register |
| Is this California contractor in good standing? | CSLB Check a License |
| Is this UK company still registered? | Companies House |
| Is this Australian business's ABN active? | ABN Lookup (Australian Business Register) |
| Is this Canadian federal corporation active? | Corporations Canada |
| Is this Florida company active? | Sunbiz (Florida Division of Corporations) |
| Is this company registered, in any other country? | GLEIF's list of national registers names the register, the global LEI register often gives the company's number there, TinyFish Search finds the register's search page, and TinyFish Agent reads the record. Results are labelled `curated: false`. **Not yet confirmed in a live run**; see "Companies worldwide". |
| Other licences, anywhere | TinyFish Search looks for an official government board, and TinyFish Agent reads it. In live runs so far, this path has not produced a verified record. |

## Quick start

Needs Node.js 20.12 or newer and a TinyFish API key from https://agent.tinyfish.ai/api-keys.

```bash
npm install
cp .env.example .env        # put your TINYFISH_API_KEY in .env
npm run build
npm start                   # http://localhost:8787
```

Open http://localhost:8787 in a browser to use the web page (see "Web page" below), or call the API:

```bash
curl -s -X POST localhost:8787/verify \
  -H 'content-type: application/json' \
  -d '{"name":"Tesco PLC","record_type":"company","jurisdiction":"UK"}'
```

On Windows PowerShell, use `Copy-Item .env.example .env`, and call the API with `Invoke-RestMethod` (PowerShell's `curl` is a different command):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8787/verify -ContentType 'application/json' `
  -Body '{"name":"Tesco PLC","record_type":"company","jurisdiction":"UK"}'
```

Or from the command line:

```bash
npm run cli -- verify --name "Tesco PLC" --type company --jurisdiction UK
npm run cli -- verify --name "Woolworths Group Limited" --type abn --jurisdiction Australia --number "88 000 014 675"
npm run cli -- registries
```

## Web page

`npm start` also serves a small web page at http://localhost:8787 (and at `/ui`). It is one HTML file, `public/index.html`, with no framework and no build step. It uses the same API as everything else:

* **Look up a record.** Name, record type, place and an optional number. Example buttons fill in records from the live tests. A timer shows how long the check has run, because a register that needs the Agent can take minutes.
* **The answer** reads like an extract from the register: an outcome stamp (Verified, No match, Several matches, Name differs, Not readable), the status, number, dates, compliance flags and disciplinary actions, the exact lines read from the page, and a link to the source. Several matches come back as a table with a "Check this number" button for each one. Pages checked, TinyFish calls and the full JSON are one click away.
* **Watch for changes** creates a TinyFish Monitor. Under "Watched records", "Recheck now" runs it and lists any field changes, and "Stop watching" (two clicks) deletes the Monitor.

The page builds everything with `textContent`, so text from a registry is never run as HTML, and links from registry data open only if they are `http` or `https`. The server sends a Content-Security-Policy that allows only the page's own inline script and style (by SHA-256 hash), Google Fonts, and calls back to the same server. If `TINYVERIFY_API_TOKEN` is set, the page still loads, and you enter the token in the "API token" box at the top. It is kept for that browser tab only (`sessionStorage`).

In PowerShell: `npm run build; npm start`, then open http://localhost:8787.

## Companies worldwide (v12)

For a company in a place without a built-in register (Germany, Japan, New York, Ontario...), TinyVerify does this:

1. **Find the company on the global LEI register** (GLEIF, about 2.9 million entities). It searches by exact legal name, then full text (which includes other names, translations and transliterations), then a fuzzy name search. Only close matches in the requested country are kept, and branch or fund entries are dropped when the company itself is listed. An LEI record names the company's **national register** (an RA code) and its **number there**.
2. **Pick the national register** from GLEIF's Registration Authorities List (about 1,200 registers in more than 230 jurisdictions, with their websites). It uses the register in the company's LEI record. If there is none, it samples current LEI records filed in that place and uses the register most of them are filed with. A US company needs a state (companies register by state), unless its LEI record names one.
3. **Find the register's search page** with TinyFish Search, limited to that register's own website (`include_domains`).
4. **Read the record with TinyFish Agent**, by the company number when one is known (from the request or the LEI record), otherwise by name. The Agent's browser uses a proxy in that country, and it is told the site may not be in English and must copy values without translating. Status words in other languages are mapped (for example "aktiv", "gelöscht", "radiée", "ingeschreven", "en liquidation"), and the register's exact wording is always kept.

**Only the national register can make an answer `verified`.** Matching LEI entries are returned in `lei_records` with `counts_as_verified: false`, and the web page shows them as "Reference, not verified". If the national register cannot be read, the answer stays `source_unavailable`, and the message says what the LEI register shows.

If a register writes the name in another language or script (for example Japanese), the record is accepted when its number came from the LEI record and its name matches one of that LEI record's names; a warning says so.

GLEIF is called directly over HTTPS, not through TinyFish: it is a plain JSON API, so a browser or page reader would add nothing. Set `GLEIF=off` to use TinyFish Search discovery only (the v11 behaviour).

**What is and is not known.** The code is tested offline with invented companies and registers (`test/worldwide.test.ts`). It was built where the GLEIF API could not be reached, so the response parser follows GLEIF's documentation and an open-source GLEIF client. `npm run dump:gleif` checks the real API from your machine without any TinyFish credit. Whether the Agent can use each national register is not known until it is tried: some registers charge, need a login, show a CAPTCHA, or only work in their own language. Most small businesses have no LEI, so for them step 1 finds nothing and step 4 searches by name. Run `SMOKE_WORLD=1` to try 8 countries live.

## Request

| Field | Required | Meaning |
| :-- | :-- | :-- |
| `name` | yes | Person or business name, as you know it |
| `record_type` | yes | Free text: "company", "doctor", "contractor licence", "ABN", "LLC", "nurse licence"... |
| `jurisdiction` | yes | Free text: "UK", "England", "California", "NSW", "Canada", "Florida", "Texas"... |
| `licence_number` | no | Licence or registration number. Skips name matching and is the most reliable. `license_number` also works. |
| `entity_kind` | no | `person` or `business`, when the name alone is unclear |
| `registry` | no | Force one registry id (see `GET /registries`) |
| `allow_discovery` | no | Default `true`. Set `false` to use curated registries only. |

Ambiguous places are handled, not guessed. "CA" means Canada or California, so TinyVerify checks both: the curated registry where one exists for the record type (Corporations Canada for a company, CSLB for a contractor) and TinyFish Search discovery for the other place. If records turn up in both places, the answer is `multiple_matches`. Longer place names are read by their broadest part: "Sydney, New South Wales" is Australia, "London, Ontario" is Canada, and a warning says when another reading was possible.

## Output (schema `tinyverify.v1`)

Every response has the same shape, so other tools can rely on it. `GET /schema` returns the JSON Schema.

| `outcome` | Meaning |
| :-- | :-- |
| `verified` | One record found and read from the official source |
| `name_mismatch` | The number exists but belongs to a different name. The record is returned so you can see who it belongs to. |
| `multiple_matches` | Several records match. None is chosen. `candidates` lists them with numbers to re-run with. |
| `no_match` | The registry has no matching record. Near misses are listed for review, clearly scored. |
| `source_unavailable` | The registry could not be read (bot wall, outage). This is never reported as "no match". An LEI record, if found, is in `lei_records` but does not change this outcome. |
| `unsupported` | No curated registry, and search found no official government source. |
| `invalid_input` | Bad request, or a number in the wrong format (for example an ABN that fails its check digit). |

Each record in `records` contains:

* `status.normalized` (active, inactive, expired, suspended, revoked, cancelled, dissolved, insolvency, not_registered, unknown) and `status.raw`, the registry's exact wording
* `licence_number` and `identifiers` (company number, ABN, ACN, BN, document number...)
* `issue_date`, `expiry_date`, `renewal_due_date` as `YYYY-MM-DD`, plus `expiry_note` when a register has no expiry (UK companies, GMC)
* `disciplinary_actions`: kind, description, start and end date, and the registry text it came from
* `compliance_flags`: strike-off proposals, overdue filings, notices of intent to dissolve, workers' comp exemptions
* `source`: the official `url` for this exact record, `retrieved_via` (tinyfish_fetch or tinyfish_agent), `extraction` method, verbatim `evidence` lines, `content_sha256`, the registry's own timestamp, and the agent run id
* `checked_at` and `match` (how the record was matched and the score)

The response also lists `sources_checked` (every registry page and GLEIF lookup consulted and what happened), `tinyfish_calls` (every TinyFish call made for this answer) and `lei_records` (matching entries from the global LEI register, for reference only).

Example outputs, built from fictional test fixtures to show the shape: [`samples/fixture-examples/`](samples/fixture-examples/). Run `npm run smoke` to produce live results in `samples/live-<date>/`.

## How TinyFish is used

| Endpoint | What it does in TinyVerify |
| :-- | :-- |
| **Fetch** | Reads registry pages live (`ttl: 0`, markdown). Used for record pages (Companies House, ABN Lookup, GMC, CSLB, Corporations Canada, Sunbiz) and for the Companies House, ABN Lookup, Corporations Canada and Sunbiz search pages. A deterministic parser per registry turns the page into fields and keeps the exact lines it used as evidence. Fetch's default "main content" extraction can drop result lists and record tables, so a page that loads but does not parse is fetched once more as the whole page (`include_selectors: ["body"]`) before the Agent is used. |
| **Agent** | Handles everything Fetch cannot: search forms that have no result URL (GMC, CSLB), Sunbiz lookups by document number, confirming a Sunbiz "not found", bot-protected pages (stealth browser, local proxy country), and any page the parser cannot read. Runs use `output_schema` so results come back as typed JSON with a verbatim `evidence_quote`, and a `page_state` field so a CAPTCHA or error page is reported as unavailable instead of "not found". |
| **Search** | For companies in other countries, finds the search page on the national register's own website (limited with `include_domains` to the site GLEIF lists). For other record types, finds the official registry itself (for example a Texas nursing licence). Only government domains, known statutory regulators and the registers in GLEIF's list pass; aggregators like OpenCorporates are rejected. If no official source is found, the answer is `unsupported`, never a third-party site. |
| **Monitor** | `POST /watch` verifies a record, then creates a Page Monitor on the record's own URL with a plain-English `purpose` and a webhook. Each scheduled run posts the fresh page to `/webhooks/tinyfish`. TinyVerify parses it, compares fields with the last known record and raises typed change events. |

Not used: the Browser API. Agent covers the interactive work, so adding Browser would only pad the endpoint count.

### Fetch first, Agent second

For each search and record TinyVerify tries the cheap, exact path first: TinyFish Fetch plus a parser (a few seconds; TinyFish documents Fetch as free up to 1,000 URLs a day). If the default page does not parse, it fetches the whole page and tries again. Only then does it fall back to TinyFish Agent on the same official site (in live runs, Agent runs took 1 to 5 minutes, sometimes timed out at 5 minutes, and need wallet credit). A bot wall skips the second Fetch. The result says which path produced it (`extraction: deterministic_parser` or `agent_structured_output`), so a reviewer knows how much to trust it.

## Matching and ambiguity

TinyVerify only picks a record when the evidence is clear:

1. With a `licence_number`, it opens that record directly, then checks the name. The names must match, or one must be a shorter form of the other ("Woolworths" for WOOLWORTHS GROUP LIMITED, a doctor's middle name on the register), with a warning. Different legal forms ("Tesco PLC" for TESCO STORES LIMITED) or too few shared words give `name_mismatch`, not `verified`.
2. Without a number, it searches with a few name variants: as typed, without legal suffixes ("Ltd", "Inc", "Pty"), titles removed ("Dr"), "Last First" for registers that list people that way, "&" and "and" swapped.
3. Names are compared after removing case, accents and punctuation and making legal forms uniform, so "Exampleworks Ltd" equals "EXAMPLEWORKS LIMITED" and "SMITH, John" equals "John Smith".
4. One exact match, or one strong match well ahead of the rest, is opened. The record page must show the same entity (same number, or the same name as the search row) and a name that matches the request. Otherwise the answer is `name_mismatch`. A search row alone is never treated as proof. One exception, with a warning: when the register's own search tied the name to that number and the record shows the same number but another holder name (CSLB lists a person under the licence of the business they work for).
5. If any name form could not be searched (bot wall, error), the answer is `source_unavailable`, not `no_match`, because the unread form may be the one the register needs.
6. Two or more exact or close matches: **multiple_matches**, with every candidate's name, number, status and link. Nothing is chosen.
7. Only weak matches: **no_match**, with near misses shown and scored. A candidate must contain at least 75% of the requested words to count as a possible match, so "WIDGET WORKS LIMITED" is a near miss for "Zqxv Imaginary Widget Works Ltd", not a match.
8. Matches on a company's previous name, and result pages that list more matches than were compared, are reported in `warnings`.

Short name parts must match exactly ("Jon" is not "John"), because a one-letter difference in a short name is often a different person.

## Accuracy and trust

* **Live and official only.** Every read is a fresh TinyFish call to the registry's own domain. Links from agents or search results outside the registry's domains are dropped.
* **Evidence with every answer.** Records carry the exact registry lines behind the status, dates and actions, a hash of the page, and the registry's own "data current as of" stamp when it prints one.
* **Identity checks.** When a number was requested, the page must show that number. A parsed page with a different number is rejected, and an Agent result is rejected if it reports a different number or none at all.
* **Agent results are labelled.** Agent runs are asked to copy the status line into `evidence_quote`. That quote is kept as evidence when the agent gives it, but it is model output and is not checked against the page. The evidence list marks the agent's own status report as `Agent reported status: "..."`.
* **Not found vs not readable.** A CAPTCHA, outage or redirect is `source_unavailable`. "No match" is only reported when the registry itself says so, and "not found" wording is only trusted on a page that lacks the record's own labels. On ABN Lookup, whose name search can hide cancelled ABNs, a no-results page is confirmed with TinyFish Agent first, and so is a Sunbiz name list that does not contain the name. When several registries are checked and one could not be read, the overall answer is `source_unavailable`, not `no_match`.
* **Check digits.** ABNs are validated with the ATO check-digit rule before any call is made.
* **Registry facts stay registry facts.** Company registers do not publish discipline, so `disciplinary_note` says so instead of returning an empty list that looks like a clean record.

## Monitoring

```text
POST /watch -> verify -> TinyFish Monitor on the record URL (purpose + webhook + cron)
TinyFish scheduled run -> POST /webhooks/tinyfish?token=... -> parse -> diff fields -> events -> your callback_url
```

* **Field diff, not text diff.** Registry pages print the time of each search, so the raw page changes every run. TinyVerify compares status, expiry, renewal date, number, name, disciplinary actions and compliance flags. A timestamp change produces no alert; a status change from Active to Liquidation produces a `critical` `status_changed` event.
* **Same method, same yardstick.** The parser and the Agent describe one page differently (the Agent does not report compliance flags, and words actions its own way). So actions, flags and exact status wording are compared only with the last read made the same way. Status, number, name and dates are compared across both, with dates only when both reads have one.
* **Event types:** `status_changed`, `status_wording_changed`, `expiry_changed`, `renewal_due_changed`, `identifier_changed`, `name_changed`, `disciplinary_added`, `disciplinary_removed`, `flag_added`, `flag_removed`, `record_unreadable`, `record_recovered`.
* **Bot walls and unlabelled pages.** If Monitor's page cannot be parsed, TinyVerify re-reads the whole page with Fetch (`read_via: tinyfish_monitor+fetch`), then with TinyFish Agent (`read_via: tinyfish_monitor+agent`). Sunbiz always takes the Fetch step, because Monitor reads the main-content page and Sunbiz labels its fields only on the whole page. The stored record says how it was really read (`retrieved_via: tinyfish_fetch`, `extraction: deterministic_parser`), and its `content_sha256` is the hash of the page that was parsed. If that also fails, it raises one `record_unreadable` warning and keeps the last known status, then `record_recovered` when reading works again.
* **Registries found by Search** have no parser, so each check needs an Agent read. To save cost, the Agent is skipped while the Monitor page is unchanged, but never when the page is a bot wall or nearly empty, and never more than 6 runs in a row.
* **Safe webhooks.** The webhook URL carries a secret token (TinyFish does not sign payloads). Baseline runs, duplicate deliveries and unknown monitors are ignored.
* **On demand.** `POST /watches/:id/recheck` (CLI: `npm run cli -- recheck <watch id>`) uses TinyFish Monitor "run now" and processes the result immediately. Useful for demos and when the server has no public URL. `npm run cli -- unwatch <watch id>` stops a watch and deletes its TinyFish Monitor.

Monitor is in beta and enabled per TinyFish account. If your key gets a 403, ask TinyFish support to enable Monitor. Confirmed live on 13 Nov 2026 for three registries: a Monitor on a Companies House record (Tesco) and on a Corporations Canada record (Canadian National Railway) was read straight from Monitor's page, a Monitor on a Sunbiz record (Publix) was read through the whole-page Fetch step, and all three run-now rechecks correctly reported no change. A repeat run on 14 Nov 2026 confirmed that the Sunbiz recheck is recorded as a Fetch parse with the same page hash as the original verification.

## API

| Method and path | Purpose |
| :-- | :-- |
| `GET /`, `GET /ui` | The web page (browsers get it at `/`; API clients asking for JSON get the endpoint list) |
| `POST /verify` | Verify. Body: the request above. |
| `GET /registries` | Curated registries, what they cover, how each is read |
| `POST /watch` | `{ "request": {...}, "schedule_cron": "...", "callback_url": "https://..." }` |
| `GET /watches`, `GET /watches/:id` | Watches and their events |
| `POST /watches/:id/recheck` | Run the Monitor now and diff |
| `DELETE /watches/:id` | Stop watching and delete the TinyFish Monitor |
| `GET /events?since=ISO&watch_id=` | Change events |
| `POST /webhooks/tinyfish?token=` | TinyFish Monitor webhook receiver |
| `GET /schema` | JSON Schema for request, result and change event |

Set `TINYVERIFY_API_TOKEN` to require `Authorization: Bearer <token>` on every route except the webhook, `/health` and the web page itself (`GET /` and `GET /ui`). The page sends the token you type into its "API token" box. For webhooks while developing locally, expose the server with a tunnel and set `PUBLIC_BASE_URL`.

## Coverage details

| Registry id | Place | Record types | Identifier | Search via | Record via | Monitor watches |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `uk-companies-house` | UK | business_registration | Company number | Fetch, Agent fallback | Fetch, Agent fallback | `/company/{number}` |
| `uk-gmc` | UK | medical_licence | GMC reference number | Agent | Fetch, Agent fallback | `/registrants/{number}` |
| `au-abr` | Australia | business_registration | ABN | Fetch (whole page), Agent fallback | Fetch (whole page), Agent fallback | `/ABN/View?abn={abn}` |
| `us-ca-cslb` | California, US | contractor_licence | CSLB licence number | Agent | Fetch, Agent fallback | `cslb.ca.gov/{number}` |
| `ca-corporations-canada` | Canada (federal) | business_registration | Corporation number | Fetch (GET search URL), Agent fallback | Fetch, Agent fallback | `fdrlCrpDtls.html?corpId={number}` |
| `us-fl-sunbiz` | Florida, US | business_registration | Document number | Fetch (alphabetical name list), Agent to confirm "not found" and as fallback | Fetch (whole page), Agent fallback; Agent for lookups by number | detail URL linked from the search list (long-term stability not confirmed; whole-page Fetch then Agent if it stops parsing) |
| `discovered:<host>` | anywhere | any | as shown | Search then Agent | Agent | record URL returned by Agent |

## Known limits

* **What Fetch returns differs by page.** Checked live with `npm run dump` on 12 Nov 2026 and tested against those exact files: Companies House record pages parse from the default Markdown. Companies House search pages, ABN Lookup search pages and ABN Lookup record pages parse only from the whole page (the default Markdown drops the names or the main table), so for those only the whole page is fetched. A per-URL Fetch error such as `proxy_error` is retried once before the Agent is used. Corporations Canada search and record pages parse from both versions. Sunbiz search lists parse from both; Sunbiz record pages only from the whole page (the default drops the labels). GMC and CSLB pages have not been dumped yet.
* **Agent "no results" is checked.** If the Agent says there were no results but its own note says the page did not load or the search did not run, the answer is `source_unavailable`, not `no_match` (seen live on New York's registry).
* **Agent search lists vary.** The same Corporations Canada Agent search returned the exact company in one run and only two subsidiaries in another, so the second run answered `multiple_matches`. Since v7 that search is a Fetch of the registry's own result URL, which lists every match; the Agent is only the fallback. TinyVerify never picks from a list it was not shown.
* **Misread pages are not trusted.** If a search page "parses" but no result shares a word with the query, it is treated as misread and the next read method is used, because a misread page once turned a real company into `no_match`.
* **Layouts change.** Parsers are written against each registry's field labels as seen in November 2026. When a layout changes, reads fall back to TinyFish Agent and keep working, marked `agent_structured_output`. Add a fixture and update the parser to get back to the deterministic path.
* **Agent extraction is model based.** It is constrained by a schema, must report the record number when one was requested, and links off the official domain are dropped. In one live run the Agent returned the page heading "ABN Lookup Record" as the name; a labelled name field ("Entity name") from the same answer now takes priority, and the agent's own answer is kept in `details.agent_name_answer`. Its quotes are not checked against the page, so for high-stakes decisions open `source.url` and confirm.
* **Place names are read by rules.** Countries beat states, states beat cities, and the last place in the text wins a tie. The chosen reading is shown in `warnings` when another was possible. US date order (month first) is used for `.gov` and `.us` hosts and US state names, which reads a country such as Georgia wrongly.
* **Monitor webhook shape.** The webhook receiver accepts the documented payload (`fetch_monitor_id`, `id`, `results`) and a few likely variants. Payloads it cannot match are logged and acknowledged with 202, not processed.
* **Corporations Canada is federal only.** Provincially incorporated companies are in provincial registries; the no-match message says so.
* **Corporations Canada compliance flags come from the record's own rows.** Every record page carries the text of the "Annual filings overdue" alerts, even for a corporation whose filings are all "Filed" (seen live for Canadian National Railway). Up to v6 that text raised an `annual_filings_overdue` flag on every Canadian record, a false alert. Since v7 the flag comes only from year rows such as "2025 - Overdue", and status wording such as "Intent to Dissolve Filed". If you watched a Canadian record with v6, the next check reports `flag_removed` once; that is the fix, not a change at the registry.
* **CSLB** is offline Sundays 8 p.m. to Mondays 6 a.m. Pacific, and complaint disclosure is limited by California law (B&P 7124.6).
* **Sunbiz name search is an alphabetical list**, not a list of matches. It starts where a sort key puts the name. The key rule (capitals, no spaces or punctuation, no leading THE, no OF, no legal ending such as INC or LLC, 30 characters) is inferred from one live page of 20 names, not documented by Florida. So when the list has no close name, TinyVerify confirms with one TinyFish Agent search before it reports `no_match`, and reports `source_unavailable` if that Agent run fails. Trademark rows are left out. Lookups by document number still use the Agent, because the number search has not been dumped yet. Whole-page Fetch glues each label to its value ("StatusACTIVE"), so Sunbiz evidence lines show the label and value split with a colon ("Status: ACTIVE") rather than the glued text.
* **ABN Lookup** name search may show active ABNs only. Search by ABN to check a cancelled one.
* **First page only.** Only the first page of search results is compared; a warning says when the registry reports more.
* **Discovered registries** pass an official-domain check but are not hand-verified; they carry a warning and `curated: false`. An official page is used only if its address or title looks like a register search (for US companies the query asks for the Secretary of State search). For a company register the page must also say it searches ("search", "lookup", "inquiry"). Information pages, guides, forms, tax letters and agency directory cards are skipped; if nothing qualifies the answer is `unsupported` and no Agent run is started (live runs had picked a tax-letter page, a city information page and the California portal's "Secretary of State (SOS)" directory card). If the Agent run on a discovered page fails or times out, other name forms are not tried, since the page itself is the likely problem; curated registries do try them. The discovery step in `sources_checked` lists the titles and links of skipped pages, and when an ambiguous place such as "CA" is answered from one side only, a warning names the place that was not checked.
* **Companies worldwide are not yet confirmed live.** See "Companies worldwide": the GLEIF parser was written from documentation, and each national register is read by the Agent without a built-in parser. Expect some registers to fail (paid, login, CAPTCHA, or a search the Agent cannot complete); the answer is then `source_unavailable` with the LEI record shown for reference. The LEI register mostly covers larger companies.
* **TinyFish Search results vary between runs.** The same discovery query for California returned only information pages on 12 and 13 Nov 2026 (no Agent run) and `businesssearch.sos.ca.gov` on 14 Nov 2026 (one Agent run, which failed after 42 s). The output says which pages were used or skipped either way.
* **Fetch is usually fast, not always.** Live Fetch calls took 1 to 9 seconds, with one outlier of 123 seconds (a Companies House record, 12 Nov 2026) that still returned the page. TinyVerify waits up to 150 seconds for a Fetch call and retries once after a timeout or proxy error.
* **TinyFish credit.** Agent runs need wallet credit. When TinyFish reports an empty wallet, TinyVerify stops the request at once and says so, instead of trying every registry and name form.
* **The web page waits for the whole answer.** It shows a timer, not step-by-step progress, because `POST /verify` returns once at the end. If the browser tab is closed during a long Agent run, the server still finishes the check, but the page does not get the result. The page keeps no history; use "Copy JSON" to keep an answer.
* This is a lookup tool, not legal advice.

## Privacy

* No personal data is committed. Every person and small business in the test fixtures is invented, with invented addresses and numbers from ranges the registers have not issued (see `test/fixtures/README.md`). The only real entities are four large companies: Tesco PLC, Woolworths Group Limited, Canadian National Railway Company and Publix Super Markets, Inc. Officer and director names on their live pages were not copied.
* For companies outside the built-in registers, the company name and place are sent to the GLEIF API (api.gleif.org) as well as to TinyFish. `GLEIF=off` stops that.
* `data/` (watched records), `samples/live-*` (live results) and `samples/raw/` (page dumps) are git-ignored. Person registers are opt-in in the smoke test.
* The web page loads two fonts (Public Sans and IBM Plex Mono) from Google Fonts, so the browser contacts Google when the page opens. If that is blocked, the page uses system fonts and works the same. The page sends nothing else to any server but TinyVerify.

## Development

```bash
npm test            # 156 tests: parsers, matching, routing, pipeline outcomes, worldwide companies, Monitor diffing, webhooks, API, web page, regressions, live-run fixes
npm run typecheck
npm run examples    # regenerate samples/fixture-examples from fixtures
npm run smoke       # live checks through TinyFish (needs TINYFISH_API_KEY); SMOKE_MONITOR=1 also watches and rechecks a Companies House, a Corporations Canada and a Sunbiz record
npm run dump        # save TinyFish Fetch output for registry pages to samples/raw/ and test the parsers on it (Fetch only)
npm run dump:gleif  # call the GLEIF API, save the raw answers to samples/raw/gleif-<date>/ and show what TinyVerify reads (no TinyFish)
```

On Windows PowerShell, set the variable first: `$env:SMOKE_MONITOR = "1"; npm run smoke` (it stays set until the window closes, or `Remove-Item Env:SMOKE_MONITOR`). In Command Prompt, use `set "SMOKE_MONITOR=1" && npm run smoke`; without the quotes cmd stores "1 " with a space and the Monitor step is skipped.

To try companies in 8 more countries (Germany, the Netherlands, France, Japan, Singapore, New Zealand, India and Washington state), run `npm run dump:gleif` first (free, about a minute), then `$env:SMOKE_WORLD = "1"; $env:SMOKE_ONLY = "world"; npm run smoke`. Each case can start one or two Agent runs, so this uses TinyFish credit and can take 10 to 60 minutes. Clear the variables afterwards with `Remove-Item Env:SMOKE_WORLD, Env:SMOKE_ONLY`.

Tests use a fake TinyFish gateway (`test/helpers.ts`) so they run offline. `src/tinyfish/gateway.ts` is the only file that talks to TinyFish, through the official `@tiny-fish/sdk`.

```text
src/
  verify/pipeline.ts      routing, matching, Fetch then Agent, result assembly
  registries/*.ts         one adapter per registry: URLs, parser, status mapping, Monitor purpose
  registries/discovery.ts official-domain check for registries found by Search
  registries/places.ts    any country, US state or Canadian province to an ISO code
  gleif/client.ts         GLEIF API: LEI register search, register list, samples by place
  verify/worldwide.ts     companies in places without a built-in register
  monitor/service.ts      watch, webhook, recheck, escalation to Agent
  monitor/diff.ts         field-level change detection
  tinyfish/gateway.ts     TinyFish SDK calls and the per-answer call log
  tinyfish/agentSchemas.ts output_schema and goals for Agent runs
  app.ts, server.ts, cli.ts
  ui.ts                   loads the web page and builds its Content-Security-Policy
public/index.html         the web page (inline CSS and script, no build step)
```

## License

MIT
