# TinyVerify: bounty submission notes

## Requirements

| Requirement | Where it is met |
| :-- | :-- |
| Takes a person or business name, a licence or record type, and a jurisdiction | `POST /verify` and `tinyverify verify` (`name`, `record_type`, `jurisdiction`, optional `licence_number`) |
| Checks at least two official registries or licensing boards | Six curated registries in four countries (UK Companies House, UK GMC, Australia ABN Lookup, California CSLB, Corporations Canada, Florida Sunbiz). For companies elsewhere, the national register from GLEIF's list (not yet confirmed live). For other record types, an official registry found by TinyFish Search |
| Structured record: status, number, expiry, disciplinary actions, source link, checked time | `records[]` in schema `tinyverify.v1` (`GET /schema`) |
| Uses TinyFish Monitor to flag status changes | `POST /watch` creates a Page Monitor per record; `/webhooks/tinyfish` diffs fields and emits `status_changed` and other events |
| Explains how Agent, Fetch and Monitor are used | README, "How TinyFish is used" |

## Judging criteria

| Criterion | How TinyVerify handles it |
| :-- | :-- |
| Accuracy | Live reads (`ttl: 0`) of the official page, with a whole-page re-read before any Agent fallback; compliance flags only from the record's own fields; deterministic parsers keep verbatim evidence lines; the page must show the requested number (Agent results without it are rejected); the opened record must match the chosen search row and the request; ABN check digit |
| Coverage | 6 curated registries, 3 record types, 4 countries; companies in any country through GLEIF's list of national registers plus the Agent (not yet confirmed live); Search discovery for other record types |
| Ambiguity | `multiple_matches`, `no_match` with scored near misses, `name_mismatch`, "CA" checked as both Canada and California, longer place names read with a disclosed assumption, name variants and previous names; an unread name form gives `source_unavailable`, never `no_match` |
| Monitor reliability | Field diff ignores timestamp noise; flags and actions compared only between reads of the same kind, so switching between Fetch and Agent raises no false alerts; Agent escalation behind bot walls; forced Agent re-reads for registries found by Search; one `record_unreadable` alert then `record_recovered`; dedupe and token check |
| Trust and reuse | Every record has `source.url`, `checked_at`, evidence and the TinyFish call log; one JSON Schema for every response |

## TinyFish endpoints doing real work

Fetch (record and search pages), Agent (search forms, bot-protected pages, parser fallback), Search (finding official registries for uncovered places), Monitor (scheduled page checks with webhooks). Browser is not used.

## First live run (11 Nov 2026, v2) and what changed in v3

| Case | v2 result | Right? | v3 change |
| :-- | :-- | :-- | :-- |
| Tesco PLC by number | verified, Fetch only, 3 s | yes | none |
| Rolls-Royce Holdings plc by name | verified, but the search needed a 4 min Agent run | yes, slow | search page fetched again as the whole page; link-free result parser |
| Made-up company name | multiple_matches | no, should be no_match | a candidate must contain 75% of the requested words |
| Woolworths ABN by number | name_mismatch | no | Agent's labelled "Entity name" beats its page-heading answer |
| Woolworths by name | verified, name shown as "ABN Lookup Record" | record right, name wrong | same as above |
| Canadian National Railway by name | verified, annual filing overdue flag | record yes; the flag was false (found in v7, see the fourth run) | none at the time |
| "CA", Sunbiz, New York | wallet empty, not run | n/a | stops at the first billing error with a clear message |

ABN Lookup record pages also did not parse from Fetch's default Markdown in v2. v3 retries them as the whole page before using the Agent. This is not yet confirmed live.

## Second live run (12 Nov 2026, v4) and what changed in v5

`npm run dump` showed what Fetch returns. Companies House record pages parse from the default Markdown. Companies House search pages keep the company names only in the whole page. ABN Lookup record pages parse only from the whole page. ABN Lookup search pages had no result rows either way.

| Case | v4 result | Right? | v5 change |
| :-- | :-- | :-- | :-- |
| Tesco PLC by number | verified, 1 s | yes | none |
| Rolls-Royce Holdings plc by name | no_match | no | the link-free parser took section titles and addresses as names; names must now be headings, and results that share no word with the query are treated as misread |
| Made-up company name | no_match | yes, but by luck (same misread) | same fix |
| Woolworths ABN by number | verified via whole-page Fetch, no Agent | yes | none |
| Tesco Monitor recheck | no change, no Windows crash | yes | none |

ABN Lookup name search now goes straight to the Agent. `@hono/node-server` was updated to 2.x, which clears the `npm audit` warning (TinyVerify did not use the affected `serveStatic`).

## Third live run (12 Nov 2026, v5) and what changed in v6

v5 got 7 of 9 cases right. The parsers were then checked against the exact Fetch pages saved by `npm run dump`.

| Case | v5 result | Right? | v6 change |
| :-- | :-- | :-- | :-- |
| Tesco PLC by number | verified, Fetch, 2 s | yes | none |
| Rolls-Royce by name | verified, Fetch only, 22 s | yes | the default read of the search page is skipped (it never has names) |
| Made-up name | no_match, Fetch only | yes | same |
| Woolworths ABN by number | verified, but the whole-page Fetch hit `proxy_error` and a 71 s Agent run was used | yes, costly | per-URL Fetch errors are retried once; only the whole page is read |
| Woolworths by name | verified after a 211 s Agent search | yes, slow | the whole page has the result table (no links); parser reads it, so no Agent |
| Canadian National Railway by name | verified | record yes; same false flag | none at the time |
| "CA" Canadian National Railway | multiple_matches (Agent listed only subsidiaries); 5 min on a San Francisco info page | partly | discovery asks for the Secretary of State search and skips pages that do not look like a register |
| Publix on Sunbiz | verified (Agent) | yes | Sunbiz detail page added to `npm run dump` to write a parser |
| Pfizer in New York | no_match | no: the Agent said the page never loaded | an Agent "no results" with a failure note is `source_unavailable` |

## Fourth live run (12 Nov 2026, v6) and what changed in v7

All 9 outcomes were right, and 6 of 9 came back in under 25 seconds with Fetch only. Three problems remained: slow Agent searches, one wrong compliance flag, and a wasted 10 minutes on a page that was not a search. A new `npm run dump` saved the Corporations Canada and Sunbiz pages, and the parsers were written and tested against those exact files.

| Case | v6 result | Right? | v7 change |
| :-- | :-- | :-- | :-- |
| Tesco PLC by number | verified, Fetch, 1.5 s | yes | none |
| Rolls-Royce by name | verified, Fetch only, 21 s | yes | none |
| Made-up name | no_match, Fetch only, 3.5 s | yes | none |
| Woolworths ABN by number | verified, whole-page Fetch, 4 s | yes | none |
| Woolworths by name | verified, Fetch only, 8 s | yes | none |
| Canadian National Railway by name | verified after a 223 s Agent search, with an `annual_filings_overdue` flag | record yes, flag no | the search is a Fetch of the registry's own result URL; flags come from the year rows ("2024 - Filed"), not from alert text that every record page carries |
| "CA" Canadian National Railway | Canada verified (139 s Agent search, same false flag), then 10 min on ca.gov's "Secretary of State (SOS)" directory card: two 300 s Agent timeouts | record yes, slow | same Canada fixes; a company register page must say it searches, directory cards are skipped, and a discovered page is not retried with another name form |
| Publix on Sunbiz | verified in 629 s: the first Agent search timed out, the second name form worked (260 s), and the record was read by the Agent because neither Fetch version parsed | yes, slow | the name list is read with Fetch; the record parser splits labels glued to values ("StatusACTIVE") |
| Pfizer in New York | source_unavailable after two Agent runs, 9 min (`page_state=error`) | yes, slow | one Agent run on a discovered page, then stop |

How the false flag was found: the Canadian National Railway page lists its 2024, 2025 and 2026 annual filings as "Filed", yet carries the text "Two consecutive annuals filings are overdue ... notice of its intent to dissolve". Two dissolved corporations fetched for comparison carry the same text and show "2025 - Overdue" rows. So the text is a page template and the year rows are the record.

## Fifth live run (12 Nov 2026, v7) and what changed in v8

All 9 outcomes were right. 8 of 9 cases used Fetch only, and the whole run used one Agent run (New York). Canadian National Railway went from 225 s to 3 s and Publix from 629 s to 12 s, with no false flag. `npm run dump` confirmed every parser on the exact URLs v7 sends.

| Case | v7 result | Right? | v8 change |
| :-- | :-- | :-- | :-- |
| Tesco PLC by number | verified, Fetch only, 123 s: one Fetch call took 123 s (1.5 s in v6) | yes, slow once | none in code; recorded as a known limit (cause on the TinyFish side unknown) |
| Rolls-Royce by name | verified, Fetch only, 9 s | yes | none |
| Made-up name | no_match, Fetch only, 3 s | yes | none |
| Woolworths ABN by number | verified, whole-page Fetch, 4 s | yes | none |
| Woolworths by name | verified, Fetch only, 4 s | yes | none |
| Canadian National Railway by name | verified, Fetch only, 3 s; no flag; filings "2026 Filed; 2025 Filed; 2024 Filed" | yes | the registered office address is now read from the main-content page too (it was empty) |
| "CA" Canadian National Railway | verified (Canada), 7 s; for California, Search returned only ca.gov pages that were not a register search, so no Agent run | yes, but only the message said California was skipped | a warning now names the place not checked, and the discovery step lists the skipped pages' titles and links |
| Publix on Sunbiz | verified, Fetch only, 12 s | yes | none |
| Pfizer in New York | source_unavailable after one Agent run, 268 s (was two runs, 9 min) | yes, honest | the smoke expectation now says source_unavailable is the right answer when New York's search does not load |

## Sixth live run (13 Nov 2026, v8, with Monitor) and what changed in v9

All 9 verification outcomes were right again, and 8 of 9 used Fetch only (Tesco took 2 s this time, so the 123 s call in the fifth run was a one-off). For "CA", the output now names the two skipped California pages (a Franchise Tax Board letter page and the ca.gov directory card) and warns that California was not checked.

The Monitor part watched, rechecked and deleted three Monitors:

| Watch | Monitor baseline parsed? | Recheck read via | Events | Right? |
| :-- | :-- | :-- | :-- | :-- |
| Tesco PLC (Companies House) | yes | `tinyfish_monitor` | none | yes |
| Canadian National Railway (Corporations Canada) | yes | `tinyfish_monitor` | none | yes |
| Publix (Sunbiz) | no, as expected (main-content page has no labels) | `tinyfish_monitor+fetch` | none | outcome yes; two labels wrong |

Two bugs showed in the Publix files, both fixed in v9:

1. The rechecked record said `retrieved_via: tinyfish_agent` and `extraction: agent_structured_output`, although no Agent ran (the call log shows only the Monitor run and a whole-page Fetch). The code labelled every escalated read as an Agent read. This also had a real cost: flags are compared only with the last read made the same way, so on the first escalated check a new compliance flag would not have been reported. A v9 test shows v8 reporting only `status_changed` where it should also report `flag_added`. Its `content_sha256` was also the hash of Monitor's page, not of the page that was parsed.
2. The watch warning said the baseline could not be parsed because of "likely bot protection", and that each check would use TinyFish Agent. Neither was true. It now says Monitor reads the main-content page, Sunbiz only parses from the whole page, and each check uses a whole-page Fetch first and the Agent only if that fails.

## Seventh live run (14 Nov 2026, v9, with Monitor)

All 9 verification outcomes were right, and all three Monitors were rechecked with no false events. The v9 fix is confirmed live: the Publix recheck record now says `retrieved_via: tinyfish_fetch` and `extraction: deterministic_parser`, and its `content_sha256` (`eaf3269b...`) is the same as the hash of the whole page read during verification, as it should be for the same page. The watch warning gives the new, correct reason.

One case changed because TinyFish Search returned different results for the same query. For "CA", Search now offered `businesssearch.sos.ca.gov` ("Business Search - Business Entities - Business Programs"), which passed the checks, so one Agent run started. The Agent reported `page_state=error` after 42 s, and TinyVerify warned "California, United States was not checked: its register could not be read" while still verifying the Canadian record. The case took 48 s instead of 4 s. Why the Agent could not use that page is not known.

| Case | Seconds | Read with |
| :-- | :-- | :-- |
| Tesco PLC by number | 3 | Fetch |
| Rolls-Royce by name | 2 | Fetch |
| Made-up name (no_match) | 3 | Fetch |
| Woolworths ABN by number | 4 | Fetch |
| Woolworths by name | 4 | Fetch |
| Canadian National Railway by name | 6 | Fetch |
| "CA" Canadian National Railway | 48 | Fetch, Search, one Agent run (California page failed) |
| Publix on Sunbiz | 8 | Fetch |
| Pfizer in New York | 252 | Search, one Agent run (`source_unavailable`) |

## Web page (v11)

v11 adds a web page served by the same server at http://localhost:8787. It covers the whole flow without curl: look up a record, read the answer as a register extract with an outcome stamp and the evidence lines, pick one of several matches by number, watch the record, recheck it, and stop watching. It is one HTML file with no framework, no build step and no new dependencies. Text from registries is only ever set as text, and a hashed Content-Security-Policy allows only the page's own script.

How it was checked: 5 new tests (the page at `/` and `/ui`, the JSON index still served to API clients, the token rule, the CSP hashes, and that the script parses and never builds HTML from strings), and a headless Chromium run against the fake gateway and fixtures (verify with flags, several matches, no match, watch, recheck with a status change from Active to Liquidation, two-step stop, dark mode, and a 390 px phone width with no sideways scrolling). It has not yet been used against live TinyFish.

## Companies worldwide (v12)

v12 adds a general path for companies in any country without a built-in register. GLEIF's free Registration Authorities List (about 1,200 national business registers in more than 230 jurisdictions, with websites) picks the register; the global LEI register finds larger companies and their number in that register; TinyFish Search finds the register's search page on its own site; TinyFish Agent reads the record there, with a proxy in that country. Only the national register can make an answer `verified`. LEI entries are shown for reference with `counts_as_verified: false`.

Checked so far: 16 new offline tests with invented companies and registers (Germany by LEI number, a register that cannot be read, a Japanese register name matched through the LEI record, a New York request for a Delaware company, the Netherlands without an LEI, a US company with no state, GLEIF down, GLEIF response parsing with a server-error retry, and moving on when the first search only finds companies in another country). Not yet checked: the real GLEIF responses (the sandbox could not reach api.gleif.org; `npm run dump:gleif` checks them) and whether the Agent can use each national register (`SMOKE_WORLD=1`).

## Before you submit

1. Run `npm test` (should be 156 passing). Run `npm run dump:gleif` (no TinyFish credit) and send the output, so the GLEIF parser can be checked against real responses. Then `npm run build; npm start`, open http://localhost:8787, and run the Tesco example and one watch and recheck from the page.
2. Run `npm run dump` (Fetch only, inside TinyFish's free daily Fetch allowance). It prints whether each parser reads the real Fetch output, for the default and the whole-page version. If a line says a parser failed, send the matching file from `samples/raw/`.
3. Add TinyFish credit if the wallet is empty, then run `npm run smoke` and read `samples/live-<date>/summary.json`. Each line now shows the `expected` outcome. Open each `source.url` and compare status and numbers by hand.
4. Monitor was confirmed live on 13 and 14 Nov 2026 for Companies House, Corporations Canada and Sunbiz, including the v9 labels (see the sixth and seventh runs). To repeat it, run `$env:SMOKE_MONITOR = "1"; npm run smoke` in PowerShell (`SMOKE_MONITOR=1 npm run smoke` on Mac or Linux).
5. Start the server with a public `PUBLIC_BASE_URL` (a tunnel is fine), watch one record, and wait for one scheduled run. If the server log shows "TinyFish webhook ignored", the payload shape differs from the docs; map the logged keys in `handleWebhook` (`src/monitor/service.ts`).
6. Still not confirmed live: the Sunbiz sort-key rule for names unlike the 20 seen (a wrong key costs one Agent confirmation, not a wrong answer), whether Sunbiz detail links stay valid for months, and how GMC and CSLB pages render through Fetch. Each falls back to the Agent if wrong; check `extraction` and `calls` in the smoke output.
7. Post on LinkedIn tagging TinyFish, and share in #showcase on the TinyFish Discord.

## LinkedIn post draft

> I built TinyVerify for the TinyFish student bounty: give it a person or business, a licence type and a place, and it returns a verified record from the official registry, then watches it for changes.
>
> It has built-in support for UK Companies House, the UK GMC medical register, Australia's ABN Lookup, California's contractor board, Corporations Canada and Florida's Sunbiz. For companies elsewhere, it uses GLEIF's list of about 1,200 national registers to pick the right one and the TinyFish Agent to read it, and it says plainly when a register could not be read.
>
> How it uses TinyFish:
> Fetch reads record pages live and a parser keeps the exact lines as evidence.
> Agent handles search forms and bot-protected sites, with structured output.
> Search finds official government registries, never aggregators.
> Monitor watches each record page, and TinyVerify turns page changes into field-level alerts like "Active to Liquidation".
>
> A small web page shows each answer like an extract from the register, with the exact lines it read and a link to the source.
>
> It never guesses: several matches or no match come back as clear answers with the candidates listed.
>
> Code: <your repo link>
> @TinyFish #TinyFish #webagents #compliance
