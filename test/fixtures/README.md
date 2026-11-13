# Test fixtures

These files imitate the markdown TinyFish Fetch returns for each registry page.
They are built from the layouts and field labels seen on the live official pages
in November 2026, not copied from raw TinyFish output.

Privacy: every person and small business in these files is invented, with an
invented address. Numbers are chosen so they should not belong to anyone:
Companies House numbers use the 99xxxxxx and NI99xxxx ranges (not yet issued),
GMC numbers start 99, CSLB numbers are 8 digits starting 99, the ABN is the
placeholder 10 000 000 000 and the Canadian corporation number is 000000-0.
These ranges were chosen by reasoning about how each register numbers its
records, not checked against every register, so a collision is unlikely but
not impossible.

Two fixtures use real, large listed companies so the layouts match pages you
can open yourself: TESCO PLC (00445790) and WOOLWORTHS GROUP LIMITED
(ABN 88 000 014 675). Their status is the public status; dates such as
accounts due dates are illustrative and may not match the live register.

Each fixture uses a different markdown shape on purpose (label on its own line,
"Label: value", tables, list items), because the parsers must handle all of them.

When a registry changes its layout, capture a fresh page with
`npm run smoke` and add it here as a new fixture file.

Two fixtures copy the exact layout of real TinyFish Fetch output saved with
`npm run dump` on 12 Nov 2026 (whole-page Markdown, links removed):
`ch-search-live-layout.md` and `abr-search-live-layout.md`. Only the Tesco and
Woolworths rows are real; every other row was replaced with an invented name,
address and placeholder number.

Four more copy the whole-page layout from a second dump the same day:

* `canada-search-live-layout.md`: the Canadian National Railway Company row is
  real (010533-3); the second row is invented, with the placeholder 000000-0.
* `canada-record-live-layout.md`: an invented corporation on the real record
  layout. It keeps the "Annual filings overdue" alert text that the live page
  shows for every corporation, because the parser must ignore it. The real
  page's director names were not copied; the one director is invented.
* `sunbiz-search-live-layout.md`: the PUBLIX SUPER MARKETS, INC. row is real
  (112252); the other rows are invented, with 2026 document numbers in the
  99999xxx range and a trademark row (T99999) that the parser must skip.
* `sunbiz-record-live-layout.md`: an invented company on the real record
  layout, where labels are glued to values ("StatusINACTIVE"). The real page's
  officer names were not copied; the agent and officer are invented.

Live pages draw horizontal rules and table separators with three hyphens.
These fixtures write them as `- - -` and `:--`, which Markdown and the
parsers treat the same way.
