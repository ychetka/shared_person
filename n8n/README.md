# n8n content pipeline

Workflow specs live in `workflows/` (deploy format documented in
`../n8n-workflows/README.md`). Deploy with the offline SQLite deployer:

```bash
docker stop shared-person-n8n
node ../tools/deploy_workflow.js workflows/<name>.json           # insert
node ../tools/deploy_workflow.js workflows/<name>.json --update  # new version
docker compose --env-file ../../ENV up -d n8n
```

## Git is the source of truth; the volume is a cache

Policy: `workflows/*.json` in this repo is the ONLY definition of the
pipeline. The n8n volume (`shared-person_n8n_storage`) is disposable -
its `database.sqlite` holds no state worth backing up for workflow
definitions. Manual UI edits are drift: the next `--update` deploy
overwrites them silently, so never treat the UI as editable
production.

### Drift check

```bash
node ../tools/verify_workflows.js           # repo vs live published versions
```

Deep-compares each spec's `nodes`/`connections` against the
`workflow_published_version` snapshot the DB actually executes and
reports `ok` / `FAIL <file>: nodes differ (changed: <node names>)` /
missing workflows / foreign DB workflows with no repo spec. Exit 1 on
drift. Read-only - safe with the container running. A `FAIL` means
the live DB runs an older snapshot than git; reconcile with
`deploy_workflow.js workflows/<name>.json --update` (container
stopped), not by editing git backwards.

### Restore on a fresh/wiped volume

The volume also carries operational state (`state/`, `queue/`,
`logs/`) - a wipe loses drafts, publish queue and audit trails, so
prefer `docker volume rm` only after copying those dirs out if they
matter. Then:

```bash
docker compose --env-file ../../ENV rm -sf n8n      # container must go first -
                                                  # docker refuses to remove a
                                                  # volume still in use
docker volume rm shared-person_n8n_storage          # optional: only on real loss
docker compose --env-file ../../ENV up -d n8n       # creates a fresh volume + DB schema
```

Now open the n8n UI once and complete the owner setup: on a fresh
volume the `project` row (the personal project every `shared_workflow`
row binds to) does not exist until first login, and deploying before
it would skip the owner binding - restored workflows would exist but
stay invisible in the UI, and sp-tg-setup could not be run at all.

```bash
docker stop shared-person-n8n                        # deployer needs n8n stopped
for f in workflows/*.json; do
  node ../tools/deploy_workflow.js "$f"
done
node ../tools/verify_workflows.js                    # expect: all ok
docker compose --env-file ../../ENV up -d n8n
```

After the workflows are back, re-run the one-time setup: register the
Telegram webhook (`../tools/tg_webhook_setup.sh`) and execute
sp-tg-setup once (writes `state/tg.json`). Secrets come from `../../ENV`
via compose as usual - they are not stored in the volume.

All state files live inside the n8n storage volume under
`/home/node/.n8n/` (container view; on the host it is the volume root,
not the nested `.n8n/` that holds `database.sqlite`):

- `state/tg.json` - operator Telegram chat_id (written by sp-tg-setup;
  compat fallback for the pinned `TELEGRAM_CHAT_ID` env)
- `state/drafts/<id>.json` - moderation drafts
- `state/trend_seen.json` - trend-scout dedupe (7 days)
- `state/digest.json` - last digest items keyed by date + index
  (RSS and VK items share the index space), resolved by the `post N`
  reply (3 days kept)
- `queue/publish/{,done,failed,skipped,processing}` - approved posts
  waiting for drivers; non-enabled platforms land in `skipped/`;
  `processing/` holds files claimed by a running tick. A claim stuck
  there after a crash is auto-recovered to `failed/` after ~10min
  with a `maybe_live` ledger note - the `wall.post` may already have
  landed, so check the VK wall first, then approve the draft again to
  re-publish. Never move a stuck claim back to the queue root
  manually: that skips the wall check and can duplicate the post
- `logs/{moderation,content-gen,publish}.jsonl` - audit trail

The hands-agent queue is bind-mounted at `/home/node/hands-queue`
(host: `../hands-agent/queue/`). The project `materials/` directory is
bind-mounted read-only at `/home/node/materials` (host:
`../../materials/`) - media candidates from briefs resolve there for
the moderation `sendPhoto` step. The fixture corpus is bind-mounted
read-only at `/home/node/fixtures` (host: `./fixtures/`) - the
humanizer eval tick reads `<tier>/<lang>.txt` cells from it.

## Workflows

### sp-tg-setup (manual)

One-time bootstrap. Resolves the operator chat_id - `TELEGRAM_CHAT_ID`
env first, `state/tg.json` from a previous run next, and only when
neither exists AND no webhook is registered yet, a `getUpdates`
self-heal that takes the LAST sender's chat_id. That fallback pins
whoever messaged the bot last, so a third party writing between the
operator's `/start` and the setup run would become "operator" - the
result `note` carries an explicit WARNING when `getUpdates` saw more
than one distinct chat. Writes the id to `state/tg.json`, then calls
`setWebhook` pointing at `/webhook/tg-moderation` on `WEBHOOK_URL`
with `secret_token=$TG_WEBHOOK_SECRET`.

`TG_WEBHOOK_SECRET` is REQUIRED: the workflow aborts with an explicit
error when it is unset. Registering without `secret_token` would leave
every delivery unsigned while the tg-moderation gate fails closed -
a silent dead pipeline that still reports "webhook registered".

Run it manually after the user sends `/start` to @shared_person_bot.
Repeatable CLI equivalent: `tools/tg_webhook_setup.sh` - registers the
same URL + `secret_token` and prints `getWebhookInfo`; run it again
after rotating `TG_WEBHOOK_SECRET`.

Since the authenticity gate landed, `tg-moderation` drops every update
whose `X-Telegram-Bot-Api-Secret-Token` header does not match
`TG_WEBHOOK_SECRET` (fail closed - the bot goes quiet when the env is
missing), and only acts on updates from the pinned operator chat
(`TELEGRAM_CHAT_ID` env, `state/tg.json` fallback). Updates are never
used to learn `chat_id` - the old self-heal let any posted message
rewrite `tg.json` and hijack previews.

### sp-tg-moderation (webhooks)

- `POST /webhook/moderation-draft` `{platform, text, image?, topic?,
  draft_id?, scope?, warnings?, media?, caption_note?, test?}` - saves a draft,
  sends it to the Telegram chat with four inline buttons Approve /
  Edit / Rework / Reject (`callback_data` = `ap|ed|rw|rj:<id>:<ver>`,
  `ver` = the `preview_v` binding for that exact preview).
  Card layout (issue #43): the service header is one line -
  `[DRAFT <id> | <platform> | <post_id>] <chars>/<platform_limit> chars`
  (`| N visuals` appended when media exist; the `/<limit>` part is
  omitted for platforms with no known text cap rather than guessed)
  with explicit `| SIMULATE` / `| TEST` mode tags when they apply -
  followed by the TEST banner for `test: true` drafts, an action
  semantics line (`Approve = LIVE PUBLISH to <platform>`, or
  `Approve = SIMULATED PUBLISH (no real post)` when `PUBLISH_SIMULATE`
  is truthy - same `1`/`true`/`yes` parse the publish tick uses),
  `Scope:` when set, and a `----------` separator. Inside the text
  preview a `--- "See more" fold ---` marker lands at the platform's
  feed-fold position (~300 chars for vk, ~210 for linkedin) so the
  operator sees what readers get above the fold. `warnings[]`
  (verifier flags) are appended as a block under the text, then the
  `[media]` tail; the assembled message is still capped at 3900 chars
  + `[truncated]` under Telegram's 4096 limit. For drafts whose text
  alone is over ~3800 chars the card instead publishes the full text
  to an anonymous telegra.ph page (createAccount once, token cached
  in `state/telegraph.json`; createPage per draft, paragraph-node
  content) and shows hook (first ~600 chars) + `Full text: <url>`;
  a Telegraph failure falls back to the truncated card.
  - shared-secret gate: the endpoint is reachable through the public
    edge proxy, so every call must carry `X-Shared-Token` or
    `X-TG-Draft-Secret` matching `DRAFT_WEBHOOK_SECRET` (constant-time
    compare, fails closed when the env is unset). Without it unlimited
    draft previews with live Approve buttons could be pushed into the
    operator chat. The internal caller (sp-content-gen) sends
    `X-Shared-Token`; a rejected call answers `{ok:false}` and nothing
    is written or sent.
  - `draft_id` overwrite guard: the webhook is public, so an existing
    `state/drafts/<id>.json` may only be replaced when its moderation
    is already decided AND a rewrite is expected - `status` must be
    `rejected` (dead draft, id free for reuse), `rewrite` (set by
    Handle TG Update when a Rework/comment-mode rewrite is dispatched
    to content-gen, which reuses the same `draft_id`), or a delivery
    status (`delivering` when saved pre-sendMessage, `deliver-failed`
    when the preview send failed - no Approve button ever reached the
    operator, so a retry under the same `draft_id` must get through).
    `pending`, `approved` or any unknown status refuses the write
    (`{ok: false, error: "draft exists ..."}`) - otherwise a caller
    could swap the text under a preview the operator is about to
    Approve (the queue payload snapshots `d.text` at Approve time).
    `pending` itself is only persisted after the preview `sendMessage`
    is confirmed (`tg_ok`): a draft born `pending` would wedge the
    `draft_id` on any delivery failure, since the file blocks
    overwrite while no moderation buttons exist for it.
    `rewrite` is a bounded window, not a standing permit: the draft
    carries `rewrite_issued_at` from dispatch, and ~15min later the
    window expires - the draft is then SEALED to `rewrite-expired`
    (persisted) and the arriving write is refused
    (`{ok: false, error: "rewrite window expired ..."}`).
    `rewrite-expired` is deliberately NOT one of the rewritable
    statuses - flipping to `rejected` would leave the decided
    `draft_id` publicly overwritable forever, since `rejected` is
    itself rewritable. A slow-but-legit rewrite landing after the
    seal is refused, but the refusal is not silent: the caller
    (content-gen) surfaces it to the operator, who revives the draft
    via Reject/Edit on the preview or picks a fresh `draft_id`.
    A corrupt/unreadable draft file is refused outright
    (`{ok: false, error: "draft file exists but is unreadable"}`) -
    never treated as absent.
  - `media[]` - selected media paths (from the media-selector pass).
    Each path is resolved inside the container: literal path, anything
    under `materials/` maps to the read-only `/home/node/materials`
    mount, bare filenames are looked up in `materials/photos/`.
    Resolvable files go to the chat captionless and silent: exactly
    one file rides a `sendPhoto` item, 2-10 files ride ONE
    `sendMediaGroup` request (issue #60 - the HTTP node's body
    parameter list is a per-item expression, which is how a dynamic
    file count fits a single request). The mediaGroup node runs
    `onError: continueRegularOutput`, so every album lands exactly
    one in-order item on Merge Media's album input - a send result
    or an `{error}` - and a failed album additionally fans out into
    the captionless `sendPhoto` fallback chain via Fan Out Album
    (which pairs bare `{error}` items back to the pre-send album
    item through `pairedItem`, since the regular output never merges
    the input json back). Since issue #43 the media goes out with
    `disable_notification` - the old per-photo `[DRAFT ...] media i/n`
    caption messages are gone - and the card's `sendMessage` replies
    to the FIRST delivered photo's `message_id` (the media group's
    `result[0]` for an album, else the first fallback photo) so the
    batch + card read as one thread. The anchor id is persisted as
    `media_message_id` on the draft file so the Edit re-preview
    threads under the same photo. A stale anchor (deleted anchor
    photo 400s the `reply_to_message_id` send) retries the card once
    WITHOUT the reply field - the card outranks the thread; the
    fallback is logged in Handle TG Update
    (`preview-reply-stale-anchor`). Files that fail resolution or
    upload are listed in the message text instead, and the draft meta
    keeps `media`, `caption_note` and `media_sent`.
  - On Approve the `media[]` list is carried into the publish queue
    file so platform drivers can attach the same files.
- `POST /webhook/tg-moderation` - Telegram webhook target. Every update
  must carry `X-Telegram-Bot-Api-Secret-Token` matching
  `TG_WEBHOOK_SECRET` (registered via `setWebhook`'s `secret_token`,
  see `tools/tg_webhook_setup.sh`) and come from the pinned operator
  chat (`TELEGRAM_CHAT_ID` env, `state/tg.json` fallback) - anything
  else is dropped before it can touch drafts or the publish queue.
  Signed updates are also deduplicated on `update_id` (atomic marker
  files under `state/seen_updates/`, ~24h TTL, capped at 1000
  entries): the webhook answers only at workflow end, so a Telegram
  retry of a slow `post N` generation would otherwise re-dispatch the
  whole handler - duplicate LLM spend plus a second draft batch:
  - Approve > writes `queue/publish/<id>.json` (carries `test: true`
    through from the draft meta when set), marks the TG message. A
    draft whose platform is not in `PUBLISH_PLATFORMS` is refused with
    one uniform answer
    (`platform "x" is disabled in the publish tick - Reject to close
    the draft, or enable it first and approve again`) whether the
    Approve is fresh or a re-approve
    from `skipped/` - 'Queued for publish' would misreport a publish
    that only parks in `skipped/` on the next tick. Before enqueueing,
    Approve also consults `state/published.jsonl` for the draft id:
    `done/` records are pruned after 30 days but the ledger is
    append-only and never pruned, so a late Approve on an old preview
    still answers `already published` instead of re-queueing a
    duplicate `wall.post`.
    When a queue file already exists (root or `processing/`) and its
    payload differs from the current draft - e.g. an Edit + rewrite
    regenerated the draft under the same `draft_id` after the first
    Approve - the queued file's payload is synced to the latest draft
    in place (atomic dot-tmp + rename) instead of refusing, so the
    corrected text is what reaches the wall. An identical payload
    still answers `already queued`. The same comparison runs on the
    exclusive enqueue's EEXIST branch: when `link()` loses the
    single-writer race (a root file appeared after the probes - a
    busy-requeue can leave pre-edit text there), the existing file's
    payload fields are compared to the current draft; a stale payload
    is atomically overwritten and answered `queue payload updated`,
    an identical one keeps `already queued`. The sync guards the same
    race the enqueue path does: the tick-owned dirs are checked right
    before AND after the rename, and if a competing `<id>.json` copy
    shows up in `processing/` or a terminal dir (the tick
    claimed/moved the old file in the gap), the fresh file is
    retracted instead of becoming a second queue entry - otherwise
    both payloads would reach the wall. A copy whose payload already
    matches the fresh write is the tick claiming OUR file (root >
    `processing/`): that is the single intended publish, not a
    duplicate.
  - Reject > terminal cancel: marks the draft `rejected` (kept as the
    internal status - it is one of Prepare Draft's rewritable
    statuses, so the `draft_id` stays revivable), strips the preview
    keyboard, stamps `[REJECTED]`, retracts a queued publish, and
    writes a registry event `stage: "moderation", status:
    "cancelled"` to `events.jsonl` (the draft-file status name and
    the registry event status deliberately differ).
  - Edit > REPLACE mode (issue #42): arms a `pending_edit` marker
    with `mode: "replace"`; the operator's next message IS the
    corrected post text. The instruction message carries the raw
    `draft.text` inside a `<pre>` code block (`parse_mode: "HTML"` -
    the workflow's first parse_mode; HTML chosen over `Markdown`
    because legacy Markdown has no escape mechanism and `draft_id`s
    containing `_` or text markup would break it) for one-tap copy
    (issue #43). The copy is never truncated: text over the ~3800
    per-block budget splits into as many `<pre>` messages as needed,
    each tagged `[text part i/N]`; when instruction + a single block
    exceed ~3900 the instruction goes alone first. A
    service-line sanitizer strips every chrome
    artifact the preview card can emit - lines matching `^[DRAFT`,
    `^Approve =`, `^Scope:`, `^TEST POST`, `^[media]`, `^attach failed:`,
    `^[truncated`, `^Full text: https://telegra.ph/`, the exact
    `----------` separator and `--- "See more" fold ---` marker (a
    bare `^---` prefix would eat legit horizontal-rule lines in post
    text), plus the copy-block chrome `^``` `, `^</?pre>` and
    `^[text part `, plus the `[WARNINGS` header and
    its `- ` bullet
    lines (a `- ` line is only chrome inside that block - lists in
    the post body survive) - plus surrounding whitespace (so a
    pasted-back preview card works), then the remainder becomes
    `draft.text` VERBATIM - no
    LLM pass, no content-gen dispatch. The draft is re-previewed
    in place through the same card assembly as Compose Message
    (fresh `preview_v`, four-button keyboard, status back to
    `pending`) and a registry `edited` event is written. Stripped
    lines are logged to `moderation.jsonl` (`edit-sanitized` with
    `removed_count` + `removed_preview`); `draft.warnings` is cleared
    on replace since the flags were computed on the old text. An
    empty post-sanitize reply is refused and the marker stays armed.
  - Rework > COMMENT mode (issue #42): arms `pending_edit` with
    `mode: "comment"`; the operator's reply is forwarded to
    `/webhook/content-gen` as a rewrite request (mode `rewrite`,
    feedback + previous draft) - the original single-Edit behavior.
    Edit and Rework share the same press-side guards: refused while
    the publish is already decided - a draft in
    `status: "approved"` or with a `queue/publish/<id>.json` copy in
    the root, `processing/` or `done/` answers `already
    queued/published - Reject first to edit` before any marker is
    armed (copies in `failed/`/`skipped/` stay editable - dead
    records, not live publishes; a `done/` copy stamped
    `simulated: true` is a PUBLISH_SIMULATE rehearsal and does not
    block either). The flow is Reject first for a decided publish:
    Reject retracts the queued publish and flips the draft to
    `rejected`, which Edit/Rework then revives. On an editable draft
    either button stores a pending-edit marker and still runs a
    press-time `retractQueued`
    as a race-catcher for a queue copy that slipped in after the
    refusal probes; the next
    plain-text message in the chat is then consumed per the armed
    mode. On the Rework path the draft flips
    to `status: "rewrite"` and stamps `rewrite_issued_at` at dispatch
    so the regenerated version can reclaim the same `draft_id` under
    the (time-bounded) overwrite guard above. If the dispatch call
    itself fails, the draft reverts to its previous status - the
    window closes immediately instead of expiring on the clock. The
    same ~15min window bounds Approve too: while it is live Approve is
    refused `rewrite in flight`; once expired (the rewrite never
    arrived) the draft flips to `rewrite-expired` - a terminal,
    non-rewritable seal so the public overwrite path closes for good -
    the preview keyboard is restored, and the operator decides fresh:
    Approve again publishes the last text, or Edit / Reject.
    `status: "approved"` is only persisted after the queue file is
    confirmed to exist - a hard enqueue failure leaves the draft in
    its previous status instead of stuck `approved` with nothing
    behind it.
  - `post N` (plain text) > resolves item N from `state/digest.json`
    (newest stored day first), builds a `source_type: "hype"` brief
    (facts = source/published/metrics/angle/summary, links, scope,
    accents) and calls `/webhook/content-gen` with `platform: all`.
    Drafts come back through the normal moderation flow. Unknown N or
    missing digest gets a "no digest item" reply. `post N` is matched
    before the pending-edit state - an exact command never becomes
    edit feedback.

### sp-trend-scout (schedule, daily 09:00)

`POST rss-reader:8788/curate?since=24h` > dedupe vs `trend_seen.json` >
top-8 digest message to Telegram. Items arrive pre-scored: the
rss-reader attaches engagement metrics (Habr article stats, HN points)
and a `hype` 0-100 score - see `../rss-reader/README.md` for the
formula - and orders by hype desc. Each digest line shows
`[hype NN | fit S.S]`, a metrics line when available
(`views | comments | votes`), and the curator `angle`. Item #1 is
marked `> POST CANDIDATE`; the footer says
`Reply: post N - to generate hype-commentary draft on item N`.
The top-8 items are cached to `state/digest.json` so the reply path in
sp-tg-moderation can resolve them. Skips silently when nothing new or
chat_id is not resolved yet.

VK branch (`VK Top Posts` Code node between `Curate Feed` and
`Format Digest`, needs `VK_ACCESS_TOKEN` + `VK_USER_ID`):

- Community list comes from the live subscription scan:
  `groups.get` (extended) filtered by a pillar keyword expression
  (n8n/automation, frontend/programming, algo trading, dev/it).
  When the scan fails or matches nothing, a fallback list of public
  walls is used instead (`habr_com`, `webstandards_ru`, `proglib`,
  `smart_lab` - edit the `FALLBACK` array in the node).
- Per community (max 8) `wall.get` pulls the last 20 posts; only
  posts from the last 48h count, pinned posts and ads are skipped.
- Scoring is engagement only (no rss-reader curator), mirroring the
  rss-reader log-normalized shape:
  `0.45*ln1p(comments)/ln1p(300) + 0.35*ln1p(likes)/ln1p(2000) +
  0.2*ln1p(views)/ln1p(100000)`; `hype` = 100 * engagement.
  Top 2 posts per community are kept, then capped at 6 VK items total.
- VK items render as a `VK communities` section under the RSS list.
  They share the same index space (`post N` resolves them) and the
  same `digest.json` / `trend_seen.json` state (vk ids look like
  `vk:-<group_id>_<post_id>`).
- API failures degrade quietly: a rejected token (error 5) flips
  `vk_status` to `auth_error`, other failures land in `vk_error` /
  `vk_errors`, flood control (error 9) gets one delayed retry per
  call. The RSS digest still goes out; the VK section is replaced by
  a one-line skip note.

### sp-content-gen (webhook)

`POST /webhook/content-gen` `{topic, platform, context?, mode?,
feedback?, draft_id?, image?, scope?, accents?, links?, media?,
source_type?, viz_data?, gen_image?}`.
`platform`: linkedin | facebook | vk | all. `scope` (string),
`accents[]` and `links[]` bound the writers; when `context` carries a
serialized brief per `../brief/schema.json`, these fields are picked up
from it automatically - explicit payload fields win. `media[]` lists
candidate files (paths or `{path, desc}` objects); the same merge rule
applies when a serialized brief carries `media[]`. `source_type` and
`viz_data[]` likewise come from the payload or the serialized brief.

Shared-secret gate: the endpoint is reachable through the public edge
proxy, so every call must carry an `X-Content-Gen-Secret` header
matching `CONTENT_GEN_WEBHOOK_SECRET` (constant-time compare, fails
closed when the env is unset - a refused call answers
`{ok:false, stage:'auth'}` and is rejected before the brief gate or
any LLM call). Without it a forged POST would make the workflow
itself dispatch attacker text to `moderation-draft` carrying the
valid `DRAFT_WEBHOOK_SECRET` - a live Approve button in the operator
chat plus free LLM spend. The internal callers (the `post N` digest
dispatch and the Edit rewrite path in sp-tg-moderation's Handle TG
Update) send the header.

Brief gate (source > brief > draft, see `../brief/README.md`):
`context` is expected to carry the serialized content brief or raw
source material. If `context` is missing, shorter than 200 chars, or
contains fewer than 2 digit-bearing tokens (versions, counts,
percents), generation is skipped, `stage: 'brief-gate'` is logged, and
the resolved Telegram chat gets "no material in brief". This applies to
rewrite requests too (their context is the previous draft).

Passes (all LLM calls go through llm-gateway `POST :8787/run`):

1. `extract-facts` (gemini-3.5-flash) - raw context > strict JSON facts
2. `writer-linkedin` / `writer-fb` / `writer-vk` (gemini-3.6-flash) - one
   run per platform; the input brief carries scope/accents/links so the
   writer stays inside the article bounds
3. anti-slop filter (banned EN/RU phrases incl. "важно/критично/мелочь",
   emoji bullets, >=2 fact entities) - on violations one rewrite pass
   with feedback
4. humanizer - deterministic cleanup: em/en dash > `-`, zero-width
   chars, smart quotes, ellipsis char, non-breaking space
5. verifier pass (`critic` role) - checks the draft against brief
   facts, scope and links. Invented claims or scope violations trigger
   one rewrite attempt; remaining issues are attached to the draft as
   `warnings[]` and shown in the moderation message. A verifier outage
   marks the draft "not fact-checked" instead of blocking it.
6. media - three paths depending on the source:
   - session posts (`source_type: session` or any `viz_data[]`
     present): GENERATED charts. The `viz-spec` role gets the draft
     text + accents + `viz_data[]` and picks 0-2 chart specs
     (`bar|line|pipeline|stat-cards`, each referencing a dataset id).
     The workflow then POSTs `{draft_id, specs, viz_data}` to the
     host render daemon (`VIZ_RENDERER_URL`, default
     `http://10.0.2.2:8791/render` - `tools/render_viz.py --serve`;
     10.0.2.2 is the slirp gateway to the real host in rootless docker),
     which draws PNGs into `materials/viz/<draft_id>_*.png` and returns
     paths. Render/spec failures degrade to text-only. Each produced
     draft gets a stable id here (payload `draft_id` or generated,
     role-suffixed on multi-platform runs) so PNG names map 1:1 to
     moderation drafts.
   - generated-image posts (`gen_image: true` in the payload or the
     serialized brief, OR a non-retro non-session `source_type` like
     `hype`/`hot-topic`): the `image-gen` role gets the draft text +
     accents + topic and emits 1-2 text-to-image prompts (flat minimal
     dark tech illustration, no text in image, no logos). Each prompt
     is POSTed to llm-gateway `/image`, which renders it via a Gemini
     image model into `materials/img/<draft_id>_<i>.<ext>` and returns
     `materials/img/...` paths for sendPhoto. Generation failures
     degrade to text-only.
   - other posts (retro/archive, untyped): the `media-selector` role
     runs only when candidates exist (payload `media[]` or brief
     `media[]`). It gets the finished draft text + accents +
     `{path, desc}` candidates and picks 0-2 files matching the
     draft's accents; an empty selection is valid.

   Selected/generated paths plus `caption_note` are attached to the
   draft meta and forwarded to moderation, which delivers them via
   `sendPhoto`.

Each draft is POSTed to `/webhook/moderation-draft` for moderation
with `scope`, `warnings`, `media` and `caption_note` fields.

Generated media status: chart visualizations from `viz_data` are live
(matplotlib, see `../tools/README.md`), and AI image-gen is live via
llm-gateway `POST /image` (Gemini image models, see
`../llm-gateway/README.md`). The gateway writes files into
`materials/img/` on the host through a dedicated writable mount; the
n8n `materials` mount stays read-only. The legacy `image` field on
moderation-draft still accepts a pre-made local path/URL.

### sp-publish (schedule, every 2 min)

Scans `queue/publish/` and routes per platform. Each file is claimed
atomically before the first platform API call - renamed into
`queue/publish/processing/` - so an overlapping tick sees the file
gone and cannot double-publish. The `ENABLED` map gates execution
and is built from the
`PUBLISH_PLATFORMS` env var (comma-separated, default `vk`, injected
via `docker-compose.yml`) - the same var sp-tg-moderation's Handle TG
Update reads for its requeue gate, so the two cannot drift. Every
non-enabled platform's queue file is moved to
`queue/publish/skipped/` with a
`platform not enabled` log line - nothing goes to FB/IG/TikTok.
A platform that IS listed in `PUBLISH_PLATFORMS` but has no
implemented driver lands in `skipped/` too: it passes the ENABLED
gate, then the tick parks the file with a `no driver for platform
<p>` log reason and `skipped` in the platform's status file - a
config-only gap is parked, not failed. `vk` and `linkedin` ship
drivers today, so `PUBLISH_PLATFORMS=all` parks fb/ig/tiktok files
this way.
After enabling a platform, re-approve its parked drafts to re-queue
them - the Approve path drops the stale `skipped/` copy and writes a
fresh queue file (it refuses while the platform is still disabled).

Simulated publish mode (issue #41): real publishing is OFF by
developer decision (2026-11-07) until an explicit go-live - the
docker-compose default is ON (`PUBLISH_SIMULATE=${PUBLISH_SIMULATE:-1}`),
so going live requires explicitly setting `PUBLISH_SIMULATE=0` in
`../ENV`; that flip IS the go-live decision. `PUBLISH_SIMULATE`
(`1`/`true`/`yes`, case-insensitive; anything else = real mode)
replaces ONLY the external API layer in both
drivers - no token refresh, no VK photo upload / `wall.post` /
`wall.getById` / `wall.delete`, no LinkedIn
`assets.registerUpload` / binary PUT / `ugcPosts` / verify GET /
test `DELETE` - while the claim -> media resolve -> ledger -> status
file -> registry -> Telegram pipeline runs unchanged and the
`PUBLISH_PLATFORMS` gate stays authoritative. Every artifact is
marked: the ledger records `status: "simulated"` + `simulated: true`
with the synthetic `external_id`, registry events fold as
`publish/simulated` (never `published`, no `published_at`), the
platform status file reports `simulated`, the Telegram line says
`-> SIMULATED publish sim-<id>`, and `test: true` drafts record
`simulated` without any DELETE. Synthetic external ids always carry
a `sim-` prefix (`sim-<draft_id>` for VK,
`sim-urn:li:share:<draft_id>` for LinkedIn, and `sim-asset-<n>` for
each resolvable LinkedIn media file in the ledger `media_assets`
list) so they can never be confused with a real numeric post id /
share URN / asset URN. Simulated
artifacts never count as publish proof on the moderation side
either: `publishedIds()` in sp-tg-moderation skips `simulated`/
`sim-` ledger rows, and the queue payload is stamped
`simulated: true` before the `done/` move so the Approve path's
dir probes treat an all-sim `done/` as rehearsal history - a draft
simulated pre-go-live stays re-approvable and will publish for
real after `PUBLISH_SIMULATE=0`.

VK driver flow per queue file `{platform: "vk", text, media[], test?,
dry_run?}`:

0. Dry-run first: `dry_run: true` (or `mock: true`, strict booleans)
   exercises claim -> media resolve -> param build with ZERO VK calls
   and no host-service contact either - the CI/smoke path. The file
   lands in `done/`, the ledger gets a `dry-run` record
   (`media_resolved`/`media_failed` counts, `text_len`), and the
   registry event folds as `publish/dry-run` - never `published`, so
   analytics does not chase metrics for a post that never existed.
1. Media attach (issue #36): `media[]` plus the legacy `image` field
   resolve through the same `resolveMedia`/underRoot rules the TG
   preview used (shared `media-resolve` SYNC block). Each resolved
   file goes to `POST $VK_UPLOAD_URL` (default
   `http://10.0.2.2:8792/vk-photo-upload`, the host
   `vk_token_service.py`) with a materials-relative path and the same
   `X-Shared-Token` gate - the n8n Code node cannot send multipart
   itself (Buffer bodies do not survive the task-runner proxy) and
   the VK token never crosses the container boundary: the service
   mints it host-side. Returned `photo<owner>_<id>` strings attach to
   `wall.post` via `attachments=`. Per-file failures are non-fatal -
   the post still publishes and the drop is reported as
   `media attached: N/M (k failed)` - but a queue file with no text
   AND no attached media is terminal: no empty wall.post.
2. `wall.post` with `owner_id=$VK_USER_ID`, `message=text` and
   `attachments=` when media uploaded.
3. Ledger-first: a `post-created` record carrying `external_id` is
   appended to `state/published.jsonl` immediately after `wall.post`
   returns - before verification - so a later failure cannot orphan a
   live wall post without a recorded id.
4. Post-publish verification: `wall.getById` on `<owner>_<post_id>`
   must read the post back. A verify failure is appended as a
   `verify-failed` record and tolerated (the post is live either way);
   otherwise the `published` record gets `verified: true`. Records
   look like `{ts, id, platform, external_id, status, verified, test,
   deleted, media_count, media_attached, media_failed}` - minimal
   ledger until the full registry lands (issue #12).
5. Test posts (`test: true` in the queue file, passed through from the
   draft meta by moderation - the flag is a strict JSON boolean, only
   `true` counts; `"yes"`/`1` are treated as real posts): after the
   `published` record the driver calls `wall.delete` and appends a
   second record - status `test-published-deleted` on success, or
   `test-delete-failed` + `delete_error` when the delete call fails.
   A delete failure still lands the file in `done/`: the earlier
   records already hold the published+verified evidence and the wall
   post id.
6. `state/vk_status.json` reflects the full outcome: `ok` only on a
   fully clean run - `publish_unverified` when wall.getById could not
   confirm the post, `test_delete_failed` when a test post stayed
   live, `auth_error` on a persistent VK error 5.

VK API calls send `access_token` in the POST body (form-encoded),
never in the request URL, and every error string written to
`publish.jsonl`, the ledger or the Telegram summary is scrubbed of
`access_token=` values first.

VK token handling: the Code node prefers the cached token in
`state/vk_token.json`, falls back to `VK_ACCESS_TOKEN` env. On VK
error 5 (expired/rejected) it calls the host refresh service
`tools/vk_token_service.py` at `VK_TOKEN_REFRESH_URL` (default
`http://10.0.2.2:8792/vk-token`), persists the fresh token to
`vk_token.json` and retries once. A persistent error 5 marks
`state/vk_status.json` as `auth_error` and the file lands in `failed/`.
The fresh token is installed only AFTER `vk_token.json` is persisted:
a state-write failure (ENOSPC/EACCES on the state volume) is flagged
`state_write_error` in `vk_status.json` - a local FS problem, not a
token-service outage - and the file lands in `failed/` pointing at the
state dir instead of burning the token-service retry budget.
The service serializes refreshes under a lock and answers HTTP 503
`{retryable: true}` when another get_token() is still in flight
(e.g. two overlapping ticks refreshing on the same stale token). That
answer is transient, not a failure: the tick moves the claimed file
from `processing/` back to the queue root so the NEXT tick retries it,
writes a `retry-requeued` note to `publish.jsonl` and reports
`token_service_busy` in `vk_status.json` - never `token_service_down`
and never `failed/`.

LinkedIn driver flow per queue file `{platform: "linkedin", text,
media[], test?, dry_run?}` (issue #38, image upload issue #50):

0. Dry-run first: `dry_run: true` (or `mock: true`) exercises claim
   -> media resolve -> param build with ZERO LinkedIn calls and no
   token requirement - the CI/smoke path. The file lands in `done/`,
   the ledger gets a `dry-run` record (`media_resolved`/
   `media_failed` counts, `text_len`) and the registry event folds
   as `publish/dry-run`.
1. Media attach (issue #50): `media[]` plus the legacy `image` field
   resolve through the same `resolveMedia`/underRoot rules the TG
   preview and the VK driver use (shared `media-resolve` SYNC
   block), capped at 4 images - the same `MEDIA_MAX` ceiling
   content-gen's `mediaSel` enforces when it builds `draft.media`;
   over-cap entries are reported dropped without reaching the API.
   Each resolved file goes through the official asset flow:
   `POST /v2/assets?action=registerUpload` (recipe
   `urn:li:digitalmediaRecipe:feedshare-image`, `owner` =
   `LINKEDIN_PERSON_URN`, `serviceRelationships`
   `OWNER`/`urn:li:userGeneratedContent`) returns an `uploadUrl`
   plus the `urn:li:digitalmediaAsset:<id>` urn; a binary `PUT` of
   the file bytes to that URL (`Authorization: Bearer`, image
   Content-Type, plus any recipe-provided media headers) ships the
   bytes. `w_member_social` covers asset registration for member
   shares - no extra scope. The VK photo hop is host-side because a
   Code node cannot send a multipart body across the task-runner
   proxy; this PUT is a raw binary Buffer body, which issue #50 runs
   in-driver - if the proxy strips Buffer bodies the upload fails
   visibly (a host-side endpoint is the documented fallback), never
   silently.
   Per-file failures are non-fatal, same semantics as the VK photo
   upload - the post still publishes with what attached and every
   drop is named in the `media_failed` ledger list + a
   `media-upload-failed` log line, reported to the operator as
   `media attached: N/M (k failed)` - but a transient failure (no
   HTTP status = transport loss, or the 429/5xx family) rethrows
   retryable BEFORE ugcPosts ran, so the file requeues bounded by
   `RETRY_MAX` (5) exactly like a VK upload transient; a 401/403 on
   the asset PUT is the same dead-credential `auth_error` verdict
   `liCall` assigns. A queue file with no text AND no attached
   media is terminal: no empty share.
2. `POST https://api.linkedin.com/v2/ugcPosts` with a
   `com.linkedin.ugc.ShareContent` body: `author` =
   `LINKEDIN_PERSON_URN` (bare member ids are normalized to
   `urn:li:person:<id>`), `shareCommentary.text` = text,
   `shareMediaCategory` = `IMAGE` with `media[]` =
   `[{status: "READY", media: <asset urn>, title: {text:
   <filename>}}]` when assets uploaded (else `NONE`),
   `visibility` = PUBLIC. Auth is
   `Authorization: Bearer $LINKEDIN_ACCESS_TOKEN` +
   `X-Restli-Protocol-Version: 2.0.0`.
3. Ledger-first like VK: `post-created` with the returned share URN
   is appended before verification. A response without an id falls
   into the orphan probe: `GET /v2/ugcPosts` with
   `q=authors&authors=List(<author>)` is scanned for a recent post
   matching the text prefix, and a hit records `maybe-live` +
   `orphan_id`.
4. Verification: `GET /v2/ugcPosts/{id}`. LinkedIn may 403 the read
   back (r_member_social is not granted) - a verify failure is
   tolerated and appended as `verify-failed`; the `published`
   record then carries `verified: false` and
   `linkedin_status.json` reports `publish_unverified`.
5. Test posts (`test: true`): after `published` the driver calls
   `DELETE /v2/ugcPosts/{id}` (204 = success), appends
   `test-published-deleted` and the registry event folds as
   `test-deleted`. A delete failure records `test-delete-failed`
   and the post stays live - flagged for manual removal.
6. Error classes: POST/GET 401/403 are terminal `api_error`
   (re-issue the token via the OAuth flow in
   `../PLATFORM_ACCESS.md` - no automatic retry burns budget);
   429/5xx are transient `api_transient` - the file is requeued to
   the queue root for the next tick up to `RETRY_MAX` (5), then
   lands in `failed/`.
7. `state/linkedin_status.json` mirrors `vk_status.json` (same
   `{status, ts, last_tick, file, reason, files[]}` shape) via its
   own writer - LinkedIn outcomes never overwrite VK status and
   vice versa.

Processed files move to `done/` or `failed/` and are logged to
`publish.jsonl` (the logged `status` mirrors the ledger:
`published` / `test-published-deleted` / `test-delete-failed`, not a
flat `published` for test drafts); results are summarized to Telegram.
The summary's post reference is operator-facing (issue #43): a VK
`external_id` `<owner>_<post>` renders as the clickable
`https://vk.com/wall<owner>_<post>`; a LinkedIn share URN is not a
URL so it renders labeled as `LinkedIn post URN: <urn>`; simulated
ids stay literal (`sim-... (sim id)`).

Housekeeping runs inside the same tick: stale `processing/` claims and
orphaned `*.tmp-*` staging files are pruned, terminal dirs drop records
older than 30 days, and a stale-draft GC rejects `state/drafts/` files
stuck in `pending` or `delivering` longer than `STALE_DRAFT_MS`
(default 7 days). A stale draft's preview keyboard is disarmed via
`editMessageReplyMarkup` before the status flip so no live Approve
button survives on an old preview; the draft lands in `rejected`
(which is REWRITABLE, so the draft_id frees up) and the tick report
notes `stale draft auto-rejected`.

### sp-analytics (schedule, every 6 h)

Post-performance collector on top of the post registry (issue #8).
Each tick folds `state/registry/events.jsonl` with the same contract
as `tools/post_report.py` (event_id dedup last-wins, latest ts per
post+platform, `error`/`maybe_live` transient, `published_at`/
`external_ids` set-once; torn lines skipped) and picks services whose
latest publish-stage verdict is `published` with `external_ids`
recorded - or `failed` + `maybe_live` with recovered `external_ids`,
since the recovered orphan may be live and tracking it answers the
recovery question for free. `test-deleted` posts are excluded by
definition.

Collectors live behind a per-platform registry. `vk` is implemented:
`wall.getById` batched at 100 posts/call returns views/likes/
comments/reposts, a deleted post records `gone`. Platforms without a
collector (`linkedin`, `fb`, ... - credentials pending on issues
#2/#3) record `unsupported` rows instead of failing the tick.

Every measurement appends to `state/analytics/metrics.jsonl`:
`{schema_v, ts, post_id, platform, external_id, status,
views, likes, comments, reposts, error}`. Two derived artifacts:

- `state/analytics/perf_summary.json` - top-20 posts by engagement
  (likes+comments+reposts, views tiebreak) inside
  `ANALYTICS_WINDOW_DAYS` (default 30). This is the feedback-signal
  file content-gen accents will read; the consumption side is a
  later iteration.
- `state/analytics/status.json` - last-tick counts for ops checks.

Telegram digest: gated by `state/analytics/digest_cursor.json` - the
6h tick collects, but a digest goes out only every
`ANALYTICS_DIGEST_MS` (default 24h) and only when at least one post
measured. Top-10 by engagement. The cursor advances ONLY after a
confirmed `sendMessage`, so a TG failure retries next tick instead
of silently dropping the digest. Chat resolution is the same as
sp-publish: `TELEGRAM_CHAT_ID` env, `state/tg.json` fallback.

VK credentials mirror sp-publish: cached `state/vk_token.json`,
`VK_ACCESS_TOKEN` fallback, `vk_token_service` refresh through
`VK_TOKEN_REFRESH_URL` gated by `VK_TOKEN_SECRET`. A refreshed token
is kept in memory for the tick only - sp-publish owns the token file
and its 0o600 write contract.

### sp-humanizer-eval (schedule, every 2 min - SHIPS INACTIVE)

Issue #78 humanizer evaluation loop. The spec deploys with
`"active": false` ON PURPOSE: activating the schedule is a deliberate
operator step taken when a live eval run is scheduled, never an
accidental side effect of `deploy_workflow.js` on a fresh volume.
To run an eval, deploy as usual, then activate the workflow in the
n8n UI (or flip `active` and `--update` with intent). Leave it
inactive afterwards - an idle active workflow still ticks every 2
minutes against the fixture corpus.

Each tick seeds `<chain>__<tier>-<lang>.json` run records under
`state/humanizer_runs/` for every fixture cell x enabled chain
(seeding is serialized under a `humanizer-seed` state lock so
overlapping ticks cannot wipe progress), then steps each live run
through `scoring -> decide -> rewriting -> rescoring`. Fixture cells
are `<tier>/<lang>.txt` under the read-only `/home/node/fixtures`
mount (host `./fixtures/`; `HUMANIZER_FIXTURES` overrides the path),
with optional `<lang>.spans.json` marker annotations next to them.
Texts must be >=150 words - Pangram's own reliability floor, enforced
in the tick before any enqueue.

Env knobs (compose passes them through; stub defaults mean a plain
deploy burns nothing):

- `HUMANIZER_SCORER` - `stub` (default, deterministic offline scorer
  that reports the flagged phrases as `marker_spans`) or `pangram`
  (enqueues `pangram_check` tasks into the hands-queue mount, charges
  `ceil(words/100)` into the shared `state/pangram_credits.json`
  ledger, consumes `done|failed/<task>.result.json`; falls back to
  stub when the queue mount is missing). A pangram task with no
  landed artifact after ~10min is a dead claim: one re-enqueue
  attempt (per-claim budget - a landed score resets it), then
  `scorer_failed` escalation. Charge dedupe is per task-id, so a
  crash between the inbox rename and the run write re-arms the same
  task without spending the credit twice; the `charged[]` ledger is
  per-day and resets with the daily counter in every credits loader.
  A once-per-tick sweep consumes `pangram-<run>-<seq>` result files
  no run still claims (`consumed-late` ledger notes) so late landing
  artifacts don't pile up.
- `HUMANIZER_PARTNER` - `stub` (default, one deterministic edit per
  call) or `inhouse` (POSTs `{role: humanizer-partner, input}` to
  `LLM_GATEWAY_URL` `/run`; the input carries
  `detector_payload: {ai_score, marker_spans[]}` - the contracted
  scorer view, never the raw score blob). The partner's
  `recommendation: escalate_to_human` is honored - the run escalates
  `partner_escalate` with the partner's confidence/caveats/
  unchanged_reason recorded and the rewrite never applied. A
  byte-identical `rewritten_text` + `unchanged_reason` counts one
  `partner_unchanged` attempt and stalls into escalation without a
  rescore (rescoring identical text only re-measures the same score).
- `HUMANIZER_CHAINS` - comma list, default `baseline,editor`;
  `baseline` scores only, `editor` rewrites via the configured
  partner, any other name is a '+'-separated stage list resolved
  from `HUMANIZER_EXT_<NAME>_URL` (unset = 'unavailable' cell +
  `stage_unavailable` escalate, no fake calls).
- `HUMANIZER_DAILY_CREDITS` - this consumer's share of the daily
  Pangram estimate cap (default 20, explicit 0 = zero).
- `HUMANIZER_THRESHOLD` - ai_score pass threshold, clamped to 0-100
  (default 50). `HUMANIZER_MAX_ITERS` - rewrite cap before
  `max_iterations` escalation with best-so-far (default 2).
  `LLM_GATEWAY_URL` - inhouse partner endpoint (default
  `http://127.0.0.1:8787` - all services run `network_mode: host`,
  so the `llm-gateway` container name is unresolvable).

Terminal runs land `done` (`pass`/`reverted`) or `escalated`
(`no_rewrite_stage`/`max_iterations`/`partner_failed`/`credit_cap`/
`scorer_failed`/`scorer_inconclusive`/`stage_unavailable`/
`partner_escalate`/`partner_unchanged`) carrying
the best-so-far text+score - best/regression comparisons are only
made within one scorer backend, so a mid-run pangram->stub fallback
resets to a fresh baseline (noted in the run trace). Every scored
cell appends a row to `state/humanizer_scores.jsonl`; escalations
also log a `humanizer-escalate` line to
`logs/humanizer-eval.jsonl`. Harness: `tools/check_humanizer.js`
runs the real Eval Tick jsCode against the real fixtures.

## Secrets

All tokens come from container env (`../ENV` via compose
`--env-file`), read in Code nodes with `$env` - never hardcoded in node
parameters. `PUBLISH_PLATFORMS` (comma-separated, default `vk`) is the
single source for the ENABLED gates in sp-publish and
sp-tg-moderation. `PUBLISH_SIMULATE` (`1`/`true`/`yes`; compose
default ON, an explicit `0` is the go-live flip) makes both
sp-publish drivers simulate instead of calling the platform APIs -
real publishing is OFF by developer decision until explicit go-live
(issue #41); simulated runs write `sim-*` external_ids and
`SIMULATED`/`simulated` markers everywhere. Required compose vars: `TELEGRAM_BOT_TOKEN`,
`GEMINI_API_KEY` (llm-gateway), `VK_ACCESS_TOKEN`, `VK_USER_ID`,
`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` (optional at compose
level: `VK_ACCESS_TOKEN` and the `LINKEDIN_*` pair - VK can run on the
refresh-service token alone, and non-VK platforms go to `skipped/` via
the ENABLED gate regardless of env vars; `VK_USER_ID` is required -
docker-compose fails `up` without it via `${VK_USER_ID:?}`).
`VK_TOKEN_REFRESH_URL`
is an optional override for the VK token refresh endpoint (default
`http://10.0.2.2:8792/vk-token`). `TG_WEBHOOK_SECRET` is REQUIRED for
moderation to work - it is the `secret_token` Telegram signs webhook
deliveries with (`tools/tg_webhook_setup.sh` registers it; without it
the tg-moderation gate fails closed). `DRAFT_WEBHOOK_SECRET` is
REQUIRED for draft delivery - it gates `POST /webhook/moderation-draft`
(`X-Shared-Token`/`X-TG-Draft-Secret` header; fails closed when unset)
and sp-content-gen sends it on the internal dispatch.
`CONTENT_GEN_WEBHOOK_SECRET` is REQUIRED for content generation - it
gates `POST /webhook/content-gen` (`X-Content-Gen-Secret` header; fails
closed when unset) and the internal callers in sp-tg-moderation's
Handle TG Update (`post N`, Edit rewrite) send it.
`TELEGRAM_CHAT_ID` pins the
operator chat (`state/tg.json` is the fallback).
`ANALYTICS_DIGEST_MS` and `ANALYTICS_WINDOW_DAYS` are optional
sp-analytics knobs (digest interval and summary window; defaults
24h and 30 days). Code nodes need
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (set in docker-compose.yml).
