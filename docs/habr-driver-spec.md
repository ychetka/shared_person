# Habr - publish driver spec for sp-publish

Design input for a future `platform: "habr"` driver in sp-publish's
Publish Tick. All platform interaction goes through hands-agent on the
logged-in desktop browser profile - there is no API anywhere in this
chain, by developer decision. The platform mechanics (composer flow,
hub model, karma, moderation tiers, AI-content policy, rate limits)
are researched in `docs/habr-integration-spec.md`; this spec does NOT
duplicate them - it defines the driver contract on top of them.

Status: spec (2026-11-08), no implementation. Platform research:
complete, see docs/habr-integration-spec.md. Headline constraint:
Habr rule #4 bans generated text, so the TG moderation card is the
accountable human gate - the driver publishes only card-approved
text, and the card decision travels with the draft as an explicit
field, not an implied gate.

## 1. Platform research (pointer, not a copy)

See `docs/habr-integration-spec.md` sections 1-3. The facts the
driver contract depends on, in one line each:

- No write API of any kind - all interaction is browser automation on
  the logged-in profile (spec 1.1, developer decision).
- Composer: "Написать" -> type (article/news/translation) -> 1-5 hubs
  -> title -> markdown/HTML body -> tags -> "Предпросмотр" ->
  "Опубликовать" (spec 1.1).
- Posts format: 10-4000 chars, no title, no cut; unlocks at
  Read&Comment tier (spec 1.1).
- Rate limit: after 3 publications inside 24h the next is blocked for
  24h (spec 1.1) - a scheduling constraint, not a driver error.
- Karma gates non-profile hubs and "Я пиарюсь" (spec 1.2); anti-promo
  rule #1 applies to every field (spec 1.3).
- Rule #4 bans AI-generated text; the human moderation card is the
  accountability mechanism (spec 1.4).
- First-ever publication may sit behind the ReadOnly sandbox - a
  manual milestone, never an automation target (spec 1.2, 2.1).

## 2. Integration spec

### 2.1 Flow

```
draft (platform "habr")
  -> TG moderation card (mandatory, non-bypassable - the rule-#4
     human gate; 4 actions, see 2.5)
  -> Approve -> queue/publish/<id>.json
  -> Publish Tick -> publishHabr(t, fname)
       -> HABR_VIA=hands (default): {"recipe": "habr_post", ...}
          dropped into hands-agent/queue/inbox/; the recipe runs the
          full composer INCLUDING the final "Опубликовать" click
       -> result channel queue/done/<task_id>.result.json -> {url}
          -> external_ids
```

Unlike the TradingView spec there is NO `manual` hand-off path and no
`autopublish` split: the accountable human click on Habr is the TG
card's Approve, not a second click inside the composer. Once the card
records a human decision, the recipe owns the mechanics end-to-end -
a recipe that stops before "Опубликовать" would leave a filled
composer no one is scheduled to finish, and the rule-#4 obligation is
already discharged upstream (see 2.5).

### 2.2 Driver contract

`publishHabr(t, fname)` inside Publish Tick, dispatched from the same
per-file loop on `p === 'habr'` alongside the existing
`vk`/`linkedin` dispatch. Enabling the platform touches ALL FOUR
copies of the SYNC'd `enabled-platforms` group (tools/check_sync.js
`expect: 4`): the identical ALL_PLATFORMS/PLATFORM_ALIAS/ENABLED gate
blocks in Publish Tick (sp-publish), Handle TG Update and Compose
Message (sp-tg-moderation - the card's LIVE/SIM tag reads it), plus
Generate Drafts' MAP (sp-content-gen) as a `habr:
['writer-habr']` key and a `MAP.all` entry. The token also joins
`PLATFORM_TOKEN_RE` in tools/check_sync.js.

Queue payload:
`{id, platform: "habr", post_id, title, text_md, hubs[], tags[],
image_path?, media[]?, kind: "article"|"post", dry_run?/mock?,
test?, retries?}`.

- `kind` selects the composer surface: `article` (default) is the
  long-read in `habr.com/ru/articles/`; `post` is the short format in
  `habr.com/ru/posts/` (10-4000 chars, no title, no cut). The driver
  fails closed on a `post` payload carrying a title, on an `article`
  payload missing `title` or `hubs`, and on `hubs` outside the 1-5
  bound - same discipline as the empty-text guard in the live
  drivers; a malformed composer fill is a content-contract bug, not
  a retry.
- Same `PUBLISH_PLATFORMS` gate: disabled -> `skipped/`; enabled but
  driverless -> `skipped/` + `no driver for platform habr`.
- Ledger, status file (`state/habr_status.json` + `habrStatus` writer
  + end-of-tick merge), and registry events as in the existing
  drivers - `platform: 'habr'`. Status vocabulary reuses the shared
  ranking.
- `HABR_VIA` env: `hands` (default). Reserved for a future `api`
  value only if Habr ever ships one - today any other value is a
  config error that fails closed. Optional `HABR_PROFILE_URL` - the
  account's publications page; reserved for the `maybe_live`
  read-back probe (2.6). No credentials of any kind (2.3).
- `PUBLISH_SIMULATE`: records `simulated` with `sim-habr-<draft_id>`
  and does NOTHING external - zero recipe enqueue (a dropped recipe
  would publish for real), zero profile visits. Registry
  `publish/simulated`, done/-file stamped `simulated: true`,
  re-approvable after go-live - identical marking rules to the other
  drivers.
- `dry_run: true`/`mock: true`: claim -> param build -> ledger
  `dry-run` -> done/, zero recipe writes, registry `publish/dry-run`.
- `test: true`: recipe publishes, reads back the article URL, then
  moves the publication back to drafts via the pencil icon (Habr has
  no delete - "unpublish" = revert to drafts; spec 1.1). Ledger
  `test-published-retracted` -> registry `test-deleted` (the
  self-cleaning analog of the VK/LI test-delete); a failed retract
  records `test-retract-failed` and the article stays LIVE - the same
  visibility rule as `test-delete-failed` elsewhere.
- postLink: the Habr external_id IS the article URL
  (`https://habr.com/ru/articles/<id>/` or `/ru/posts/<id>/`), so it
  renders verbatim; `sim-habr-*` stays literal with the ` (sim id)`
  tail.
- Media: `image_path` is the КДПВ (header image); `media[]` carries
  inline figures. All paths resolve through the same
  `resolveMedia`/under-root rules; the recipe gets the resolved
  absolute paths only (see 2.4) - never raw draft paths. Boundary
  rule: `resolveMedia` returns CONTAINER paths under the n8n mount
  (`/home/node/materials/<rel>`), but hands-agent and its
  file-chooser attach run on the HOST where the same tree is the
  compose bind-mount source (docker-compose.yml:
  `../materials:/home/node/materials:ro`). The driver must
  translate at enqueue - `/home/node/materials/<rel>` ->
  `<repo>/../materials/<rel>` (the host-side materials dir) - so
  the queue payload carries the host-side path only.

### 2.3 Auth model - no API, no credentials

- There is nothing to store: Habr interaction is the hands-agent
  recipe driving the persistent desktop browser profile on DISPLAY
  :1 (habr-integration-spec 2.3). The session already exists; recipes
  never log in.
- Credentials never enter queue payloads, recipes, params, ledger,
  logs, registry or TG output - there is no `HABR_*` secret env var
  and none may be added. `../ENV` gains only `HABR_VIA` and optional
  `HABR_PROFILE_URL`.
- Registration, email confirmation, 2FA prompts and CAPTCHA are OUT
  OF SCOPE for the driver: a recipe hitting any of them aborts to
  `queue/failed/` and escalates to the operator (hands-agent never
  solves captchas, spec 2.2). From the driver's view this is a
  definite failure -> `failed/` + operator message, never a retry.

### 2.4 Recipe contract (`HABR_VIA=hands`)

Driver drops
`{"recipe": "habr_post", "params": {"title": ..., "hubs": [...],
"text_md": ..., "image_path": ..., "media": [...], "kind": ...,
"tags": [...], "test": bool}}` into `hands-agent/queue/inbox/` - the
queue contract of habr-integration-spec 2.4, extended with `media[]`
(inline figures) and `kind`/`test`/`tags` so the recipe does not
re-derive them. Poller lands the task file in `done/`/`failed/`.

Result channel (precondition, spec 2.4): on success the worker writes
`queue/done/<task_id>.result.json` carrying `{"url":
"https://habr.com/ru/.../<id>/"}`. The driver polls for it and folds
`url` into `external_ids`. Without the result channel every publish
is a blind `maybe_live` - the channel is a hard precondition, not a
nice-to-have.

Recipe mechanics are spec'd in habr-integration-spec 2.2 (composer
steps, locate/verify hub multi-select, `set_clipboard` for the body,
file-chooser media attach, preview shot, exact-match the publish button,
post-publish shot). **CDP read-only invariant (issue #127):** the
recipe contains zero CDP writes - no Runtime.evaluate, no Target.\*,
no DOM-driven steps. Tabs open via `open_tab_bg` (OS key chords -
the background-load trick for the foreground-init renderer wedge);
element targeting is `locate` (screenshot -> coords) + OS `click`;
the URL read-back is the `/json` tab listing (`tab_url`). The driver adds:

- 1 publication per recipe run (spec 2.3 pacing).
- Scheduling constraint, enforced at the sp-publish level BEFORE
  enqueue: no more than 3 Habr publications per rolling 24h. The
  recipe must not discover the block - a site-side "blocked for 24h"
  banner after a full composer fill is a wasted run and a moderation
  smell. The driver reads recent `published`/done records for
  `platform: habr` and requeues (retryable) when the window is full,
  bounded by `t.retries`/`RETRY_MAX`.
- Recipe landing in `queue/failed/` AFTER the publish click is the
  transport-loss analog -> `failed/` + `maybe_live` (2.6).

### 2.5 Moderation path - the accountable human gate

Habr rule #4 (habr-integration-spec 1.4) is why this is not optional.
Every Habr-bound draft passes the shipped TG moderation card, whose
four actions map to the spec vocabulary:

| Card action | Spec meaning | Draft records |
|---|---|---|
| Approve | ALLOW - publish the draft as-is | `moderation/approved` |
| Edit -> Approve | EDIT - human-edited text is what publishes | `moderation/edited` then `approved` |
| Rework | REJECT+rework - back to the pipeline with comments | `moderation/edited` (rewrite dispatch) |
| Reject | REJECT+cancel - terminal, no publication | `moderation/cancelled` |

- The draft carries the recorded human decision in the moderation
  payload - an explicit field, not an implied gate (spec 4
  acceptance). The queue payload only ever exists because an Approve
  wrote it.
- Nothing reaches `queue/inbox/` without Approve: the driver has no
  path around the card and SIMULATE is the only mode that touches a
  queue file without external effect.
- The card assigns accountability; it does not by itself make a draft
  rule-compliant - Habr moderators may still return a published
  article to drafts (post-publish review, spec 1.2). That outcome is
  an operator matter, not a driver status.

### 2.6 Orphan probe / maybe_live

A recipe failure after the "Опубликовать" click is the transport-loss
analog: the article may be live while the result file never arrived.
Probe (habr-integration-spec 2.4): open the profile publications page
(`HABR_PROFILE_URL`) via `open_tab_bg`, `locate` the publication title
on the screenshot, click it with real OS input, and read the landed
article URL back from the `/json` tab listing (`tab_url`). Exact title
match bounded by a recency
window (recent entries on the publications page only). "Habr titles
are unique per account" is an assumption to verify at probe-build
time, not a documented platform guarantee - the recency bound is
what removes the ambiguity the API probes handle with
normalized-prefix rules. A hit recovers the article URL into
`external_ids` on a
`failed` + `maybe_live` registry event - same fold semantics as the
VK/LI/X probes. An empty probe leaves `external_ids` absent and the
operator hand-off names the last confirmed recipe step.

### 2.7 Article-format mapping (content-article-spec -> Habr markup)

The 6-block article (content-article-spec.md) is Habr's native
format - the only platform where it lands uncompressed. The Habr
editor accepts markdown-like markup natively (spec 1.1), so the
writer's `text` maps mechanically:

| Article element | Habr markup |
|---|---|
| `[NN / Title]` block markers | `##`/`###` headings |
| B1 hook -> feed | `<habracut>` placed immediately after the B1 hook equivalent - feed shows hook + title only |
| Code (B5 snippet, <=20 lines) | fenced blocks; in HTML editor mode `<source lang="...">` (the `<code>`/`<source>` pair is the Habr-highlighted variant) - whichever the recipe's editor mode accepts, pinned per recipe, never mixed in one body |
| Lists / emphasis | markdown `-`/`*`, `**` - native |
| `[See Fig N]` pointers | INLINE on Habr - figures upload through the editor and sit at their pointer position with `Fig N` captions, NOT a bottom grid |
| B1 hero | КДПВ (header image) via `image_path` - the composer file-chooser slot, separate from inline figures |
| `hubs[]` | 1-5 hub picks in the composer multi-select (mandatory - hubless publication is effectively invisible, spec 1.1) |
| `tags[]` | composer tag field after the body |

- `text_md` arrives already assembled (block headers, pointers,
  `<habracut>` in place) - the driver does not re-render markup; it
  validates the cut exists for `kind: "article"` and fails closed if
  not.
- Visuals: the render_viz pipeline diagrams (timeline/matrix/
  topology/stat charts from `tools/render_viz.py`) attach as inline
  article images with `Fig N` captions - upload through the editor
  image insert, not the КДПВ slot. Inline-image upload through the
  editor is part of the `habr_post` recipe's file-chooser family.
- Figure numbering: the `[See Fig N]` -> final attach order rewrite
  from issue #51 applies unchanged; a figure whose render failed must
  already be pointer-free before the draft reaches the driver
  (content-gen's job - the driver only checks no dangling pointer
  survives into `text_md`).
- Facts-only, first-person, banned-lexicon and the live-vs-simulated
  honesty rule carry over unchanged - on Habr they are also the
  rule-#4 compliance checklist (spec 1.4).

### 2.8 Failure surface

- Recipe lands in `queue/failed/` before the publish click ->
  definite failure -> `failed/`, `publish/failed` event, scrubbed
  `error` (<=300 chars). Retryable only when the failure
  provably precedes any mutating step (inbox enqueue I/O error) -
  same `e.retryable`/`RETRY_MAX=5` bound; everything past the
  composer fill is ambiguous by default.
- Recipe failure after the click, or result-file timeout -> `failed/`
  + `maybe_live` + orphan probe (2.6).
- CAPTCHA / verification interstitial / logged-out session -> recipe
  abort -> `failed/` + operator escalation message via `tg()`; never
  retried, never "solved".
- Karma/hub rejections (site blocks publication into a hub the
  account can't post to) are terminal content-contract errors - the
  operator picks different hubs, not a retry.
- The 3-posts/24h window is prevented, not handled (2.4) - but a
  site-side block banner surfacing anyway classifies as retryable
  requeue, not failure.

## 3. Preconditions (hands-agent/queue extensions)

Tracked in the driver issue - none of this exists today
(habr-integration-spec 4):

1. `set_clipboard` (PyGObject Gtk clipboard holder) - article bodies
   are far beyond jittered-type size. A CDP `insert_text` action is
   NOT an option: Input.\*/Runtime.evaluate are banned by the read-only
   directive.
2. `tab_url` location read-back (read-only `/json` listing) - for the
   URL read-back and the future `habr_metrics` counters. The probe's
   title check is `locate` + OS click + `tab_url` on the landed tab.
3. Worker result channel `queue/done/<task_id>.result.json` - without
   it `external_ids` cannot be recorded and every publish is blind.

Until all three land, `HABR_VIA=hands` can enqueue but the driver
records every outcome as `maybe_live`-class at best - ship order is
preconditions first, driver second.

## 4. Risks / open questions

- Rule #4 detection is the standing risk: even card-approved text can
  be flagged as generated post-publish (spec 3). Mitigation lives in
  content (artifact-first substance), not in the driver - but the
  driver must never weaken the gate (e.g. a future "auto-approve"
  flag is a spec violation, not a convenience).
- Composer DOM drift: the hub multi-select and the editor are the
  likely drift points (spec 3); locate/verify + per-step `shot` trail
  makes failures diagnosable.
- Sandbox tier: if the account is still ReadOnly, the first article
  goes through `habr.com/ru/sandbox/` - a DIFFERENT composer and a
  supervised manual milestone. The `habr_post` recipe must detect the
  sandbox surface and abort to the operator rather than adapt on the
  fly.
- `kind: "post"` depends on the account having unlocked the format
  (Read&Comment tier) - the driver cannot verify that from n8n; a
  locked format surfaces as a recipe failure, operator investigates.
- Result-channel absence today means the driver literally cannot
  close a publish - the precondition is load-bearing (section 3).
- `media[]`/`kind`/`test` extend the spec'd `habr_post` params beyond
  habr-integration-spec 2.4 - reconcile at recipe-build time (the
  recipe ignores unknown params harmlessly, but the contract should
  name them).

## 5. Acceptance criteria (for the future driver issue)

Preconditions: section 3 - all three hands-agent/queue extensions
land first.

Then:

- `platform: "habr"` drafts reach `publishHabr` when `habr` is in
  `PUBLISH_PLATFORMS`; otherwise park in `skipped/`, driverless
  reports `no driver for platform habr`.
- Approve -> `habr_post` recipe enqueued with the full param set ->
  result-channel `url` lands in `external_ids` -> registry
  `publish/published` + `published_at`.
- `PUBLISH_SIMULATE=1`: `sim-habr-<draft_id>` record only - ZERO
  recipe enqueues, registry `publish/simulated`, done/-file stamped
  `simulated: true`, re-approvable after go-live.
- `dry_run: true`: ledger `dry-run`, zero `queue/inbox/` writes.
- `test: true`: publish -> URL read-back -> revert to drafts ->
  `test-deleted` registry event; retract failure leaves the article
  live and records `test-retract-failed`.
- Recipe failure before click -> `failed/`; after click / result
  timeout -> `failed/` + `maybe_live` + profile-page title probe
  recovering the URL when the article landed.
- CAPTCHA/2FA/logged-out abort -> `failed/` + operator escalation,
  never retried.
- 3-per-24h window enforced pre-enqueue (retryable requeue, not a
  burned recipe run).
- `kind: "article"` without `<habracut>`/`title`/`hubs`, or
  `kind: "post"` with a title or outside 10-4000 chars, fails closed
  before any enqueue.
- No credentials anywhere in the chain (there is nothing to store);
  the draft's recorded moderation decision is present in the payload
  chain end-to-end.

## 6. Sources

- Platform mechanics, moderation model, AI-content policy, recipe
  map, queue contract, preconditions: `docs/habr-integration-spec.md`
  (research complete 2026-11) - the authoritative source; this spec
  distills, it does not re-research.
- Article format: `docs/content-article-spec.md` (6-block skeleton,
  visual mapping, figure-pointer rewrite issue #51).
- Driver/registry conventions mirrored from
  `n8n/workflows/sp-publish.json` Publish Tick (publishVk/
  publishLinkedin), `docs/post-registry-design.md` (events, fold,
  `test-deleted`), `docs/tradingview-driver-spec.md` and
  `docs/x-twitter-driver-spec.md` (hands-path contract, result
  channel, sim marking), `PLATFORM_ACCESS.md` (audit browser, env
  conventions).
