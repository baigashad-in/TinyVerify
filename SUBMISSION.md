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
| Accuracy | Live reads (`ttl: 0`) of the official page; deterministic parsers keep verbatim evidence lines; the page must show the requested number (Agent results without it are rejected); the opened record must match the chosen search row and the request; ABN check digit |
| Coverage | 6 curated registries, 3 record types, 4 countries; discovery for other places |
| Ambiguity | `multiple_matches`, `no_match` with scored near misses, `name_mismatch`, "CA" checked as both Canada and California, longer place names read with a disclosed assumption, name variants and previous names; an unread name form gives `source_unavailable`, never `no_match` |
| Monitor reliability | Field diff ignores timestamp noise; flags and actions compared only between reads of the same kind, so switching between Fetch and Agent raises no false alerts; Agent escalation behind bot walls; forced Agent re-reads for registries found by Search; one `record_unreadable` alert then `record_recovered`; dedupe and token check |
| Trust and reuse | Every record has `source.url`, `checked_at`, evidence and the TinyFish call log; one JSON Schema for every response |

## TinyFish endpoints doing real work

Fetch (record and search pages), Agent (search forms, bot-protected pages, parser fallback), Search (finding official registries for uncovered places), Monitor (scheduled page checks with webhooks). Browser is not used.

## Before you submit

1. Run `npm test` (should be 81 passing).
2. Run `npm run smoke` with your key and read `samples/live-<date>/summary.json`. Open each `source.url` and compare status and numbers by hand.
3. Run `SMOKE_MONITOR=1 npm run smoke` once Monitor is enabled on your account.
4. Start the server with a public `PUBLIC_BASE_URL` (a tunnel is fine), watch one record, and wait for one scheduled run. If the server log shows "TinyFish webhook ignored", the payload shape differs from the docs; map the logged keys in `handleWebhook` (`src/monitor/service.ts`).
5. Things not yet confirmed live: the ABN Lookup name-search URL (`/Search/ResultsActive`), whether Sunbiz detail links stay valid, and how GMC and CSLB pages render through Fetch. Each falls back to TinyFish Agent if wrong, but check the `extraction` field in the smoke output.
6. Post on LinkedIn tagging TinyFish, and share in #showcase on the TinyFish Discord.

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
