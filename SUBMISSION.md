# TinyVerify: bounty submission notes

## Requirements

| Requirement | Where it is met |
| :-- | :-- |
| Takes a person or business name, a licence or record type, and a jurisdiction | `POST /verify` and `tinyverify verify` (`name`, `record_type`, `jurisdiction`, optional `licence_number`) |
| Checks at least two official registries or licensing boards | Six curated registries in four countries (UK Companies House, UK GMC, Australia ABN Lookup, California CSLB, Corporations Canada, Florida Sunbiz), plus any official registry found by TinyFish Search |
| Structured record: status, number, expiry, disciplinary actions, source link, checked time | `records[]` in schema `tinyverify.v1` (`GET /schema`) |
| Uses TinyFish Monitor to flag status changes | `POST /watch` creates a Page Monitor per record; `/webhooks/tinyfish` diffs fields and emits `status_changed` and other events |
| Explains how Agent, Fetch and Monitor are used | README, "How TinyFish is used" |

## Judging criteria

| Criterion | How TinyVerify handles it |
| :-- | :-- |
| Accuracy | Live reads (`ttl: 0`) of the official page, with a whole-page re-read before any Agent fallback; deterministic parsers keep verbatim evidence lines; the page must show the requested number (Agent results without it are rejected); the opened record must match the chosen search row and the request; ABN check digit |
| Coverage | 6 curated registries, 3 record types, 4 countries; discovery for other places |
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
| Canadian National Railway by name | verified, annual filing overdue flag | yes | none |
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
| Canadian National Railway by name | verified | yes | none |
| "CA" Canadian National Railway | multiple_matches (Agent listed only subsidiaries); 5 min on a San Francisco info page | partly | discovery asks for the Secretary of State search and skips pages that do not look like a register |
| Publix on Sunbiz | verified (Agent) | yes | Sunbiz detail page added to `npm run dump` to write a parser |
| Pfizer in New York | no_match | no: the Agent said the page never loaded | an Agent "no results" with a failure note is `source_unavailable` |

## Before you submit

1. Run `npm test` (should be 106 passing).
2. Run `npm run dump` (Fetch only, inside TinyFish's free daily Fetch allowance). It prints whether each parser reads the real Fetch output, for the default and the whole-page version. If a line says a parser failed, send the matching file from `samples/raw/`.
3. Add TinyFish credit if the wallet is empty, then run `npm run smoke` and read `samples/live-<date>/summary.json`. Each line now shows the `expected` outcome. Open each `source.url` and compare status and numbers by hand.
4. Monitor create and run-now were confirmed live on 11 Nov 2026 (Tesco watch, no change reported). Run `SMOKE_MONITOR=1 npm run smoke` for the full create, recheck and delete cycle.
5. Start the server with a public `PUBLIC_BASE_URL` (a tunnel is fine), watch one record, and wait for one scheduled run. If the server log shows "TinyFish webhook ignored", the payload shape differs from the docs; map the logged keys in `handleWebhook` (`src/monitor/service.ts`).
6. Still not confirmed live: Sunbiz and Corporations Canada searches through Fetch (probes are in `npm run dump`), whether Sunbiz detail links stay valid, and how GMC and CSLB pages render through Fetch. Each falls back to the Agent if wrong; check `extraction` and `calls` in the smoke output.
7. Post on LinkedIn tagging TinyFish, and share in #showcase on the TinyFish Discord.

## LinkedIn post draft

> I built TinyVerify for the TinyFish student bounty: give it a person or business, a licence type and a place, and it returns a verified record from the official registry, then watches it for changes.
>
> It covers UK Companies House, the UK GMC medical register, Australia's ABN Lookup, California's contractor board, Corporations Canada and Florida's Sunbiz, and uses TinyFish Search to find the official registry anywhere else.
>
> How it uses TinyFish:
> Fetch reads record pages live and a parser keeps the exact lines as evidence.
> Agent handles search forms and bot-protected sites, with structured output.
> Search finds official government registries, never aggregators.
> Monitor watches each record page, and TinyVerify turns page changes into field-level alerts like "Active to Liquidation".
>
> It never guesses: several matches or no match come back as clear answers with the candidates listed.
>
> Code: <your repo link>
> @TinyFish #TinyFish #webagents #compliance
