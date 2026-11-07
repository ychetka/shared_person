# TradingView - publish driver spec for sp-publish

Design input for a future `platform: "tradingview"` driver in
sp-publish's Publish Tick. The account is registered and logged-in
inside the audit Chrome profile (CDP :9223,
`~/.chrome-audit-profile`, launched via `tools/chrome-audit.sh`).

Status: research complete (2026-11-07), spec only, no
implementation. Headline finding: TradingView has NO official
programmatic publish path - there is nothing to promise an API
around. This spec therefore defines a MANUAL/hands-agent path and
keeps the registry honest about it.

## 1. Platform research (verified 2026-11-07)

### 1.1 What TradingView exposes programmatically

| Surface | Write to platform? | Notes |
|---|---|---|
| Public data/write REST API | NO | Dev FAQ verbatim: "We don't have an API that gives access to data." No official endpoint creates ideas, scripts or any community content. |
| Embeddable widgets | NO | Free chart/ticker/screener/calendar embeds, TradingView-branded; display only, read direction. |
| Lightweight Charts | NO | Apache-2.0 OSS charting lib (~45 KB per the project's own headline figure), you supply the data; renders in OUR product, unrelated to publishing. |
| Advanced Charts / Trading Platform | NO | Licensed charting libraries for companies; you implement the Datafeed API to feed them. |
| Broker REST API | NO (for us) | A spec for BROKERS behind a signed integration agreement - the broker implements `/accounts`, `/config`, `/instruments`, `/orders`, `/state` server-side so users trade FROM TradingView. It is trading integration, not content publishing, and requires being a broker partner. |
| Alert webhooks | outbound only | TradingView POSTs an alert message to YOUR URL (2FA required, ports 80/443 only, 3s response budget). Data leaves TradingView; nothing writes into it. |
| Pine Script | NO | Scripts run on TradingView servers; `request.seed()` can pull from your GitHub, but publishing a script or idea is not API-exposed. |

### 1.2 Official MCP server (newest surface, checked)

Public beta since 2026-09-16: `https://mcp.tradingview.com/mcp`,
OAuth 2.1 sign-in with the TradingView account, Essential plan and
above. ~35 tools total:

- Read (~25): delayed quotes/OHLCV (<=5000 bars/call), symbol
  search, screener + technical ratings, fundamentals, analyst
  forecasts, news, filings, earnings transcripts, calendars.
- Write (~10): watchlist management and simple price alerts ONLY.

Verified gaps relevant to us: NO idea publishing, NO Pine
read/write, NO Strategy Tester reads, NO trade placement. Beta
limits: delayed data, ~100 calls/min, tool list explicitly
limited. Re-check the tool list periodically - it is the only
surface where an official write path could plausibly appear.

### 1.3 Unofficial surfaces (rejected)

- `tv-scraper`-style readers hit private/undocumented endpoints
  (ideas listing, cookie auth for captcha bypass) - read-only
  anyway, and unsanctioned: breaks without notice, ToS risk.
- A community "TradingView MCP" drives the desktop app through a
  remote-debugging port (Pine compile, Strategy Tester reads) -
  its own README warns it relies on undocumented internal APIs.
  Neither publishes ideas through a supported path.

Both are excluded: the project never builds publishing on
undocumented endpoints (same fail-closed stance that rejects
credential-in-queue shortcuts elsewhere).

### 1.4 The manual publish surface (what the recipe drives)

Public idea composer (support doc 43000589083): from a chart,
"Publish idea" captures the CURRENT chart view as the idea's
snapshot image, then a form requires:

- title (required), description (required), category (required),
  direction mark long/neutral/short (required);
- optional: related ideas, smart tags;
- published ideas are editable for 15 min after publish (typos
  only);
- House Rules apply - peer-review community, self-promo and
  low-substance ideas are moderated/removed.

Scripts (Pine) publish through their own manual composer - out of
scope; the spec covers ideas only.

CONCLUSION: no official publish path exists as of 2026-11-07. The
spec defines a human-in-the-loop path; nothing below pretends
otherwise.

## 2. Integration spec

### 2.1 Flow

```
draft (platform "tradingview")
  -> TG moderation card (existing gate, non-bypassable)
  -> Approve -> queue/publish/<id>.json
  -> Publish Tick -> publishTradingview(t, fname)
       -> TV_VIA=hands : hands-agent recipe drives the idea composer,
          STOPS before the final Publish click (recommended)
       -> TV_VIA=manual (default): registry 'manual' + operator
          hand-off message with paste-ready text
```

Either way the pipeline's job ends at "everything an operator
needs is composed and in front of them"; the publish click stays
human by default - same fail-closed human-gate philosophy as the
Habr spec (the pipeline drafts, the human decides; an unreviewed
auto-published idea is the highest-risk surface on a peer-review
platform).

### 2.2 Driver contract

`publishTradingview(t, fname)` inside Publish Tick, dispatched on
`p === 'tradingview'`. Enabling the platform touches ALL FOUR
copies of the SYNC'd `enabled-platforms` group
(tools/check_sync.js `expect: 4`): the identical
ALL_PLATFORMS/PLATFORM_ALIAS/ENABLED gate blocks in Publish Tick
(sp-publish), Handle TG Update and Compose Message
(sp-tg-moderation - the card's LIVE/SIM tag reads it), plus the
platform list inside Generate Drafts' MAP (sp-content-gen) as a
`tradingview: ['writer-tradingview']` key and a `MAP.all` entry.
The new platform token also joins `PLATFORM_TOKEN_RE` in
tools/check_sync.js or the token-set check cannot police it.
Queue payload:
`{id, platform: "tradingview", post_id, title, text (=
description), direction, category, tags[]?, media[], chart_url?,
dry_run?/mock?, retries?}`.

- Same `PUBLISH_PLATFORMS` gate: disabled -> `skipped/`; enabled
  but driverless -> `skipped/` + `no driver for platform
  tradingview`.
- Ledger, status file (`state/tradingview_status.json` +
  `tvStatus` writer + end-of-tick merge), and registry events as
  in the existing drivers - `platform: 'tradingview'`.
- `TV_VIA` env: `manual` (default) or `hands`. Optional
  `TV_HANDLE` - the account's handle without `@`; no live use yet,
  reserved for the profile-page read-back probe the hands path
  uses to disambiguate a `maybe_live` (section 4).
- `PUBLISH_SIMULATE`: records `simulated` with `sim-tv-<draft_id>`
  and does NOTHING external - no recipe enqueue, no hand-off
  message (the card already rendered SIM mode; a sim hand-off
  would read as a real task). Registry `publish/simulated`,
  done/-file stamped `simulated: true`, re-approvable after
  go-live - identical marking rules to the other drivers.
- `dry_run: true`/`mock: true`: claim -> param build -> ledger
  `dry-run` -> done/, zero recipe/hand-off writes, registry
  `publish/dry-run`.
- No `test: true` publish-delete cycle exists (nothing to delete
  programmatically); a `test` draft takes the same manual/hands
  path marked test.

### 2.3 Registry status `manual`

New publish-stage status (extends the registry vocabulary in
post-registry-design.md - additive `status` value, `schema_v`
unchanged, forward-tolerant readers pass it through):

- Meaning: automation finished its share; the publish click is
  now a human task. Terminal and NON-failure - the queue file
  lands in `done/`, not `failed/`.
- Carries no `published_at` and no `external_ids` (nothing was
  published; recording one would be a lie). The service entry reads
  `publish/manual` - post_report shows the truth: "composed,
  handed to operator".
- If the operator later supplies the published idea URL (see
  hand-off below), a follow-up `publish/published` event with the
  URL in `external_ids` may be emitted by whatever records it -
  last-occurrence-wins dedup folds it correctly. Until then the
  service stays `manual`, never silently promoted.
- Status ranking: informational, level with `simulated` (rank 1 -
  below every failure, above `ok`/`skipped`): a tick whose only
  outcome is a hand-off headlines `manual`, a real failure in the
  same tick still outranks it.

### 2.4 Path B - operator hand-off (default)

On Approve (and `TV_VIA=manual`), the driver:

1. Composes the paste-ready artifact and sends it to the operator
   chat via the tick's existing `tg()` channel:

```
=== [MANUAL PUBLISH - tradingview] ===
draft <id> | <post_id>

TITLE: <title>
DIRECTION: long|neutral|short
CATEGORY: <category>
CHART: <chart_url or materials path>
TAGS: <tags>

--- DESCRIPTION (paste as-is) ---
<description text>
---

Steps: open the chart in the audit browser (tools/chrome-audit.sh
session), "Publish idea", fill the fields above, attach/verify
snapshot, click Publish. Then drop the idea URL here / note it in
the draft for the registry.
```

2. Writes ledger `status: 'manual'` + registry
   `{stage: publish, status: manual}` + `tvStatus('manual', ...)`,
   moves the file to `done/`.
3. Operator replies/edits happen outside automation; the published
   URL is recorded when the operator supplies it (today: note it
   for post_report; future: hands-agent read-back of the profile's
   idea list).

### 2.5 Path A - hands-agent recipe (`TV_VIA=hands`)

`{"recipe": "tradingview_idea", "params": {"title": ...,
"description": ..., "direction": ..., "category": ...,
"tags": [...], "chart_url": ..., "autopublish": false}}` into
`hands-agent/queue/inbox/`; same
queue contract + `done/failed` landing and result-channel
precondition (`queue/done/<task_id>.result.json` carrying the idea
`url`) the Habr spec already requires - build once, share.

Recipe shape (audit-profile tab on `tradingview.com`, `dom_find`/
`click_dom` via cdp.py + OS-level input; per-step `shot` into
`queue/done/`; dismiss overlays first; locate/verify loops, never
fixed coordinates):

1. Open `chart_url` (operator-prepared chart or saved layout).
2. Click "Publish idea" -> the composer snapshots the chart.
3. Fill title, description (description can exceed jittered-type
   size - same `set_clipboard` precondition as Habr applies),
   direction, category, optional tags.
4. `shot` of the composed form (the moderation-audit record).
5. `autopublish !== true` (the default and recommendation): STOP
   here - the recipe leaves the filled composer on screen for the
   operator's final review + Publish click, and reports
   `awaiting_human` in the result file. `autopublish: true` clicks
   Publish itself and reads back the resulting idea URL.

### 2.6 Automatable vs human

| Step | Owner | Rationale |
|---|---|---|
| Idea text composition (title/description/direction/category/tags) | pipeline | Same writer contract as every platform; facts-only. |
| Field fill + snapshot trigger in the composer | hands-agent recipe | Pure mechanics, full shot audit trail. |
| Chart preparation (symbol, timeframe, drawings, layout) | HUMAN | The chart IS the idea's evidence; picking what the market view should show is judgment, not mechanics. `chart_url` points at what the operator arranged. A pipeline-rendered viz PNG may ride in `media[]` as supplementary evidence for the hand-off, but the idea's snapshot comes from the live TV chart - it cannot be substituted. |
| Final "Publish" click | HUMAN (recommended) / recipe only when `autopublish:true` | Default fail-closed: last human eyes on the exact composed form on a peer-review platform. Matches the Habr model - automation prepares, human releases. |
| House-rules compliance, replies to comments | HUMAN | Peer-review surface; auto-replies and promo-flavoured content get moderated away. |
| Login, captcha, verification | HUMAN | Sessions live in the audit profile; recipes never log in, abort+escalate on captcha. |

### 2.7 Content contract

An idea is NOT the 6-block article. Writer contract
(`prompts/writer-tradingview.txt` when the platform is added):

- `title`: <=120 chars, the analytical claim, no clickbait.
- `description`: compact analysis note - hook, thesis, the numbers
  behind it (real facts from the brief only), invalidation ("this
  fails if..."). Descriptive and thorough per House Rules;
  first-person practitioner tone and the banned lexicon carry over
  unchanged, as does the live-vs-simulated honesty rule (an idea
  built on simulated telemetry says so).
- `direction`: `long|neutral|short` - mandatory on the platform.
- `category`: the composer's required pick (the instrument class
  the idea charts) - mandatory on the platform, so the draft
  carries it explicitly and the driver fails closed on a missing
  one rather than leaving the operator to guess.
- `tags`: optional smart-tag list the recipe may fill.
- `chart_url`/`media[]`: the evidence; the draft is incomplete
  (driver fails closed like the empty-text guard) without at least
  a chart reference - a TradingView idea without a chart is not a
  viable post.

## 3. Risks / open questions

- API watch: the official MCP server is the one place a write
  surface could appear (beta tool list is explicitly "limited").
  Re-check its tools each release; if idea publishing ever lands,
  this spec's path A/B gets an API sibling with the same
  ledger/registry contract.
- ToS boundary: the recipe automates the operator's own logged-in
  session in a visible browser - same accepted stance hands-agent
  takes for LI/FB (no scraping, no private endpoints, real OS
  input). House-rules moderation is the live risk, not ToS
  enforcement - keep ideas substantive, non-promo, low cadence.
- Composer DOM drift: form fields and the publish button are the
  likely drift points; locate/verify + shot trail make failures
  diagnosable.
- `manual` is a new registry status: readers that enumerate
  statuses must tolerate it (schema is forward-tolerant by design;
  `post_report.py` prints unknown statuses verbatim - verify at
  build time).
- Script publishing (Pine) is a separate manual composer and a
  possible later recipe - explicitly out of scope here.

## 4. Acceptance criteria (for the future driver issue)

- `platform: "tradingview"` drafts reach `publishTradingview` when
  `tradingview` is in `PUBLISH_PLATFORMS`; otherwise park in
  `skipped/`.
- `TV_VIA=manual`: Approve -> hand-off message in the operator
  chat containing title/description/direction/chart/steps -> queue
  file in `done/` -> ledger `manual` -> registry
  `publish/manual`, no `published_at`, no `external_ids`.
- `TV_VIA=hands`: recipe enqueued with the full param set; result
  channel URL lands in `external_ids`; `autopublish` absent/false
  leaves the composed form for a human click; recipe failure ->
  `failed/` (post-publish ambiguity -> `maybe_live` + profile-page
  probe).
- `PUBLISH_SIMULATE=1`: `sim-tv-<id>` record only - zero recipe
  enqueues, zero hand-off messages.
- `dry_run: true`: ledger `dry-run`, zero external writes.
- No credentials anywhere in the chain (TradingView uses session
  auth only - nothing to store in `../ENV` beyond optional
  `TV_VIA`/`TV_HANDLE`); no secrets in payloads, ledger, logs or
  TG output.

## 5. Sources

- TradingView developer FAQ / support: "We don't have an API that
  gives access to data"; REST API = broker integration only.
- Idea composer fields + 15-min edit window:
  tradingview.com/support/solutions/43000589083 (accessed
  2026-11-07).
- Broker REST API endpoint spec (agreement-gated):
  github.com/tradingview/rest_integrations_docs.
- Official MCP server: TradingView blog 2026-09-16 public-beta
  announcement + help center MCP folder; ~35 tools, write tools
  limited to watchlists/alerts (verified via launch coverage
  2026-11-07).
- Unofficial surfaces rejected: tv-scraper docs; community
  desktop-driving MCP (undocumented internal APIs).
- Driver/registry conventions mirrored from
  `n8n/workflows/sp-publish.json` Publish Tick,
  `docs/post-registry-design.md`, `docs/habr-integration-spec.md`,
  `PLATFORM_ACCESS.md` (audit browser).
