# TinyVerify

Check a licence or registration on the **official registry**, get back a structured record with proof, and get an alert when it changes.

TinyVerify takes a person or business name, a record type and a place. It finds the right official registry, reads the record live through TinyFish, and returns status, number, dates, disciplinary actions, the source link and the time it checked. It never guesses: no match and several matches come back as clear outcomes. TinyFish Monitor then watches the record page and TinyVerify turns page changes into field-level alerts.

Built for TinyFish Bounty Drop 002 (TinyVerify). Uses four TinyFish endpoints: **Fetch, Agent, Search, Monitor**.

## What it answers

| Question | Registry used |
| :-- | :-- |
| Is this doctor licensed in the UK? | GMC medical register |
| Is this California contractor in good standing? | CSLB Check a License |
| Is this UK company still registered? | Companies House |
| Is this Australian business's ABN active? | ABN Lookup (Australian Business Register) |
| Is this Canadian federal corporation active? | Corporations Canada |
| Is this Florida company active? | Sunbiz (Florida Division of Corporations) |
| Anything else, anywhere | TinyFish Search finds the official government registry, TinyFish Agent reads it. Results are labelled `curated: false`. |

## Quick start

Needs Node.js 20.12 or newer and a TinyFish API key from https://agent.tinyfish.ai/api-keys.

```bash
npm install
cp .env.example .env        # put your TINYFISH_API_KEY in .env
npm run build
npm start                   # http://localhost:8787
```

```bash
curl -s -X POST localhost:8787/verify \
  -H 'content-type: application/json' \
  -d '{"name":"Tesco PLC","record_type":"company","jurisdiction":"UK"}'
```

Or from the command line:

```bash
npm run cli -- verify --name "Tesco PLC" --type company --jurisdiction UK
npm run cli -- verify --name "Woolworths Group Limited" --type abn --jurisdiction Australia --number "88 000 014 675"
npm run cli -- registries
```

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
| `source_unavailable` | The registry could not be read (bot wall, outage). This is never reported as "no match". |
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

The response also lists `sources_checked` (every registry page consulted and what happened) and `tinyfish_calls` (every TinyFish call made for this answer).

Example outputs, built from fictional test fixtures to show the shape: [`samples/fixture-examples/`](samples/fixture-examples/). Run `npm run smoke` to produce live results in `samples/live-<date>/`.

## How TinyFish is used

| Endpoint | What it does in TinyVerify |
| :-- | :-- |
| **Fetch** | Reads registry pages live (`ttl: 0`, markdown). Used for record pages with a stable URL (Companies House, ABN Lookup, GMC, CSLB, Corporations Canada) and for GET search pages (Companies House, ABN Lookup). A deterministic parser per registry turns the page into fields and keeps the exact lines it used as evidence. |
| **Agent** | Handles everything Fetch cannot: search forms (GMC, CSLB, Corporations Canada, Sunbiz), bot-protected pages (stealth browser, local proxy country), and any page the parser cannot read. Runs use `output_schema` so results come back as typed JSON with a verbatim `evidence_quote`, and a `page_state` field so a CAPTCHA or error page is reported as unavailable instead of "not found". |
| **Search** | Finds the official registry for places without a curated adapter (for example a Texas nursing licence). Only government domains and known statutory regulators pass; aggregators like OpenCorporates are rejected. If no official source is found, the answer is `unsupported`, never a third-party site. |
| **Monitor** | `POST /watch` verifies a record, then creates a Page Monitor on the record's own URL with a plain-English `purpose` and a webhook. Each scheduled run posts the fresh page to `/webhooks/tinyfish`. TinyVerify parses it, compares fields with the last known record and raises typed change events. |

Not used: the Browser API. Agent covers the interactive work, so adding Browser would only pad the endpoint count.

### Fetch first, Agent second

For each record TinyVerify tries the cheap, exact path first: TinyFish Fetch plus a parser. If the page cannot be parsed (layout change, bot wall, redirect to a search form), it falls back to TinyFish Agent on the same official URL. The result says which path produced it (`extraction: deterministic_parser` or `agent_structured_output`), so a reviewer knows how much to trust it.

## Matching and ambiguity

TinyVerify only picks a record when the evidence is clear:

1. With a `licence_number`, it opens that record directly, then checks the name. The names must match, or one must be a shorter form of the other ("Woolworths" for WOOLWORTHS GROUP LIMITED, a doctor's middle name on the register), with a warning. Different legal forms ("Tesco PLC" for TESCO STORES LIMITED) or too few shared words give `name_mismatch`, not `verified`.
2. Without a number, it searches with a few name variants: as typed, without legal suffixes ("Ltd", "Inc", "Pty"), titles removed ("Dr"), "Last First" for registers that list people that way, "&" and "and" swapped.
3. Names are compared after removing case, accents and punctuation and making legal forms uniform, so "Exampleworks Ltd" equals "EXAMPLEWORKS LIMITED" and "SMITH, John" equals "John Smith".
4. One exact match, or one strong match well ahead of the rest, is opened. The record page must show the same entity (same number, or the same name as the search row) and a name that matches the request. Otherwise the answer is `name_mismatch`. A search row alone is never treated as proof. One exception, with a warning: when the register's own search tied the name to that number and the record shows the same number but another holder name (CSLB lists a person under the licence of the business they work for).
5. If any name form could not be searched (bot wall, error), the answer is `source_unavailable`, not `no_match`, because the unread form may be the one the register needs.
6. Two or more exact or close matches: **multiple_matches**, with every candidate's name, number, status and link. Nothing is chosen.
7. Only weak matches: **no_match**, with near misses shown and scored.
8. Matches on a company's previous name, and result pages that list more matches than were compared, are reported in `warnings`.

Short name parts must match exactly ("Jon" is not "John"), because a one-letter difference in a short name is often a different person.

## Accuracy and trust

* **Live and official only.** Every read is a fresh TinyFish call to the registry's own domain. Links from agents or search results outside the registry's domains are dropped.
* **Evidence with every answer.** Records carry the exact registry lines behind the status, dates and actions, a hash of the page, and the registry's own "data current as of" stamp when it prints one.
* **Identity checks.** When a number was requested, the page must show that number. A parsed page with a different number is rejected, and an Agent result is rejected if it reports a different number or none at all.
* **Agent results are labelled.** Agent runs are asked to copy the status line into `evidence_quote`. That quote is kept as evidence when the agent gives it, but it is model output and is not checked against the page. The evidence list marks the agent's own status report as `Agent reported status: "..."`.
* **Not found vs not readable.** A CAPTCHA, outage or redirect is `source_unavailable`. "No match" is only reported when the registry itself says so, and "not found" wording is only trusted on a page that lacks the record's own labels. On ABN Lookup, whose name search can hide cancelled ABNs, a no-results page is confirmed with TinyFish Agent first. When several registries are checked and one could not be read, the overall answer is `source_unavailable`, not `no_match`.
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
* **Bot walls.** If Monitor's page cannot be parsed, TinyVerify re-reads the record with TinyFish Agent (`read_via: tinyfish_monitor+agent`). If that also fails, it raises one `record_unreadable` warning and keeps the last known status, then `record_recovered` when reading works again.
* **Registries found by Search** have no parser, so each check needs an Agent read. To save cost, the Agent is skipped while the Monitor page is unchanged, but never when the page is a bot wall or nearly empty, and never more than 6 runs in a row.
* **Safe webhooks.** The webhook URL carries a secret token (TinyFish does not sign payloads). Baseline runs, duplicate deliveries and unknown monitors are ignored.
* **On demand.** `POST /watches/:id/recheck` uses TinyFish Monitor "run now" and processes the result immediately. Useful for demos and when the server has no public URL.

Monitor is in beta and enabled per TinyFish account. If your key gets a 403, ask TinyFish support to enable Monitor.

## API

| Method and path | Purpose |
| :-- | :-- |
| `POST /verify` | Verify. Body: the request above. |
| `GET /registries` | Curated registries, what they cover, how each is read |
| `POST /watch` | `{ "request": {...}, "schedule_cron": "...", "callback_url": "https://..." }` |
| `GET /watches`, `GET /watches/:id` | Watches and their events |
| `POST /watches/:id/recheck` | Run the Monitor now and diff |
| `DELETE /watches/:id` | Stop watching and delete the TinyFish Monitor |
| `GET /events?since=ISO&watch_id=` | Change events |
| `POST /webhooks/tinyfish?token=` | TinyFish Monitor webhook receiver |
| `GET /schema` | JSON Schema for request, result and change event |

Set `TINYVERIFY_API_TOKEN` to require `Authorization: Bearer <token>` on every route except the webhook and `/health`. For webhooks while developing locally, expose the server with a tunnel and set `PUBLIC_BASE_URL`.

## Coverage details

| Registry id | Place | Record types | Identifier | Search via | Record via | Monitor watches |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `uk-companies-house` | UK | business_registration | Company number | Fetch, Agent fallback | Fetch, Agent fallback | `/company/{number}` |
| `uk-gmc` | UK | medical_licence | GMC reference number | Agent | Fetch, Agent fallback | `/registrants/{number}` |
| `au-abr` | Australia | business_registration | ABN | Fetch, Agent fallback | Fetch, Agent fallback | `/ABN/View?abn={abn}` |
| `us-ca-cslb` | California, US | contractor_licence | CSLB licence number | Agent | Fetch, Agent fallback | `cslb.ca.gov/{number}` |
| `ca-corporations-canada` | Canada (federal) | business_registration | Corporation number | Agent | Fetch, Agent fallback | `fdrlCrpDtls.html?corpId={number}` |
| `us-fl-sunbiz` | Florida, US | business_registration | Document number | Agent (stealth) | Agent (stealth) | detail URL returned by Agent (long-term stability not confirmed; Agent re-reads by document number if it breaks) |
| `discovered:<host>` | anywhere | any | as shown | Search then Agent | Agent | record URL returned by Agent |

## Known limits

* **Layouts change.** Parsers are written against each registry's field labels as seen in November 2026. When a layout changes, reads fall back to TinyFish Agent and keep working, marked `agent_structured_output`. Add a fixture and update the parser to get back to the deterministic path.
* **Agent extraction is model based.** It is constrained by a schema, must report the record number when one was requested, and links off the official domain are dropped. Its quotes are not checked against the page, so for high-stakes decisions open `source.url` and confirm.
* **Place names are read by rules.** Countries beat states, states beat cities, and the last place in the text wins a tie. The chosen reading is shown in `warnings` when another was possible. US date order (month first) is used for `.gov` and `.us` hosts and US state names, which reads a country such as Georgia wrongly.
* **Monitor webhook shape.** The webhook receiver accepts the documented payload (`fetch_monitor_id`, `id`, `results`) and a few likely variants. Payloads it cannot match are logged and acknowledged with 202, not processed.
* **Corporations Canada is federal only.** Provincially incorporated companies are in provincial registries; the no-match message says so.
* **CSLB** is offline Sundays 8 p.m. to Mondays 6 a.m. Pacific, and complaint disclosure is limited by California law (B&P 7124.6).
* **Sunbiz** is behind bot protection, so reads and Monitor checks use TinyFish Agent, which costs more per check than Fetch.
* **ABN Lookup** name search may show active ABNs only. Search by ABN to check a cancelled one.
* **First page only.** Only the first page of search results is compared; a warning says when the registry reports more.
* **Discovered registries** pass an official-domain check but are not hand-verified; they carry a warning and `curated: false`.
* This is a lookup tool, not legal advice.

## Privacy

* No personal data is committed. Every person and small business in the test fixtures is invented, with invented addresses and numbers from ranges the registers have not issued (see `test/fixtures/README.md`). The only real entities are two large listed companies, Tesco PLC and Woolworths Group Limited.
* `data/` (watched records) and `samples/live-*` (live results) are git-ignored. Person registers are opt-in in the smoke test.

## Development

```bash
npm test            # 81 tests: parsers, matching, routing, pipeline outcomes, Monitor diffing, webhooks, API, regressions
npm run typecheck
npm run examples    # regenerate samples/fixture-examples from fixtures
npm run smoke       # live checks through TinyFish (needs TINYFISH_API_KEY); SMOKE_MONITOR=1 also tests Monitor
```

Tests use a fake TinyFish gateway (`test/helpers.ts`) so they run offline. `src/tinyfish/gateway.ts` is the only file that talks to TinyFish, through the official `@tiny-fish/sdk`.

```text
src/
  verify/pipeline.ts      routing, matching, Fetch then Agent, result assembly
  registries/*.ts         one adapter per registry: URLs, parser, status mapping, Monitor purpose
  registries/discovery.ts official-domain check for registries found by Search
  monitor/service.ts      watch, webhook, recheck, escalation to Agent
  monitor/diff.ts         field-level change detection
  tinyfish/gateway.ts     TinyFish SDK calls and the per-answer call log
  tinyfish/agentSchemas.ts output_schema and goals for Agent runs
  app.ts, server.ts, cli.ts
```

## License

MIT
