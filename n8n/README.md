# n8n content pipeline

Workflow specs live in `workflows/` (deploy format documented in
`../n8n-workflows/README.md`). Deploy with the offline SQLite deployer:

```bash
docker stop shared-person-n8n
node ../tools/deploy_workflow.js workflows/<name>.json           # insert
node ../tools/deploy_workflow.js workflows/<name>.json --update  # new version
docker compose --env-file ../../ENV up -d n8n
```

All state files live inside the n8n storage volume under
`/home/node/.n8n/` (container view; on the host it is the volume root,
not the nested `.n8n/` that holds `database.sqlite`):

- `state/tg.json` - resolved Telegram chat_id
- `state/drafts/<id>.json` - moderation drafts
- `state/trend_seen.json` - trend-scout dedupe (7 days)
- `state/digest.json` - last digest items keyed by date + index,
  resolved by the `post N` reply (3 days kept)
- `queue/publish/{,done,failed}` - approved posts waiting for drivers
- `logs/{moderation,content-gen,publish}.jsonl` - audit trail

The hands-agent queue is bind-mounted at `/home/node/hands-queue`
(host: `../hands-agent/queue/`). The project `materials/` directory is
bind-mounted read-only at `/home/node/materials` (host:
`../../materials/`) - media candidates from briefs resolve there for
the moderation `sendPhoto` step.

## Workflows

### sp-tg-setup (manual)

One-time bootstrap. Reads `getUpdates` (works only before a webhook is
registered), saves the last chat_id, then calls `setWebhook` pointing at
`/webhook/tg-moderation` on `WEBHOOK_URL`.

Run it manually after the user sends `/start` to @shared_person_bot.
If the webhook is already registered, chat_id self-heals from the first
incoming update handled by sp-tg-moderation instead.

### sp-tg-moderation (webhooks)

- `POST /webhook/moderation-draft` `{platform, text, image?, topic?,
  draft_id?, scope?, warnings?, media?, caption_note?}` - saves a draft,
  sends it to the Telegram chat with inline buttons Approve / Edit /
  Reject (`callback_data` = `ap|ed|rj:<id>`). `scope` is rendered above
  the text; `warnings[]` (verifier flags) are appended as a block under
  the text and stored in the draft meta.
  - `media[]` - selected media paths (from the media-selector pass).
    Each path is resolved inside the container: literal path, anything
    under `materials/` maps to the read-only `/home/node/materials`
    mount, bare filenames are looked up in `materials/photos/`.
    Resolvable files go to the chat via `sendPhoto` (multipart upload
    built in the Code node, before the text message). Files that fail
    resolution or upload are listed in the message text instead, and
    the draft meta keeps `media`, `caption_note` and `media_sent`.
  - On Approve the `media[]` list is carried into the publish queue
    file so platform drivers can attach the same files.
- `POST /webhook/tg-moderation` - Telegram webhook target:
  - Approve > writes `queue/publish/<id>.json`, marks the TG message
  - Reject > marks draft rejected, logs to `moderation.jsonl`
  - Edit > stores a pending-edit marker; the next plain-text message in
    the chat is forwarded to `/webhook/content-gen` as a rewrite request
    (mode `rewrite`, with feedback + previous draft)
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
chat_id is not resolved yet. VK group top-posts are a planned extension
(iteration 2, needs the VK token).

### sp-content-gen (webhook)

`POST /webhook/content-gen` `{topic, platform, context?, mode?,
feedback?, draft_id?, image?, scope?, accents?, links?, media?,
source_type?, viz_data?}`.
`platform`: linkedin | facebook | vk | all. `scope` (string),
`accents[]` and `links[]` bound the writers; when `context` carries a
serialized brief per `../brief/schema.json`, these fields are picked up
from it automatically - explicit payload fields win. `media[]` lists
candidate files (paths or `{path, desc}` objects); the same merge rule
applies when a serialized brief carries `media[]`. `source_type` and
`viz_data[]` likewise come from the payload or the serialized brief.

Brief gate (source > brief > draft, see `../brief/README.md`):
`context` is expected to carry the serialized content brief or raw
source material. If `context` is missing, shorter than 200 chars, or
contains fewer than 2 digit-bearing tokens (versions, counts,
percents), generation is skipped, `stage: 'brief-gate'` is logged, and
the resolved Telegram chat gets "no material in brief". This applies to
rewrite requests too (their context is the previous draft).

Passes (all LLM calls go through llm-gateway `POST :8787/run`):

1. `extract-facts` (Gemini Flash) - raw context > strict JSON facts
2. `writer-linkedin` / `writer-fb` / `writer-vk` (Gemini Flash) - one
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
6. media - two paths depending on the source:
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
   - other posts (retro/archive): the `media-selector` role runs only
     when candidates exist (payload `media[]` or brief `media[]`). It
     gets the finished draft text + accents + `{path, desc}` candidates
     and picks 0-2 files matching the draft's accents; an empty
     selection is valid.

   Selected/generated paths plus `caption_note` are attached to the
   draft meta and forwarded to moderation, which delivers them via
   `sendPhoto`.

Each draft is POSTed to `/webhook/moderation-draft` for moderation
with `scope`, `warnings`, `media` and `caption_note` fields.

Generated media status: chart visualizations from `viz_data` are live
(matplotlib, see `../tools/README.md`). AI image-gen candidates
(Gemini image model, e.g.
gemini-3.1-flash-image) are still blocked on llm-gateway - it only has
text backends (openrouter chat/completions, gemini generateContent);
needs an image backend (gemini `:predict`/`generateContent` with
responseModalities). Until then non-chart media comes from the
brief/payload candidate list only, and the legacy `image` field on
moderation-draft still accepts a pre-made local path/URL.

### sp-publish (schedule, every 2 min)

Scans `queue/publish/` and routes per platform:

- `vk` - `wall.post` via VK API when `VK_ACCESS_TOKEN` is set
- `linkedin` - `/rest/posts` when `LINKEDIN_ACCESS_TOKEN` +
  `LINKEDIN_PERSON_URN` are set, else hands-agent fallback
- `facebook` / `instagram` / `tiktok` / `linkedin` fallback - writes
  `<id>.json` to `/home/node/hands-queue/inbox/` in the hands-agent task
  format `{"recipe": "<platform>_post", "params": {"text": ...,
  "image_path": ...}}`

Processed files move to `done/` or `failed/` and are logged to
`publish.jsonl`; results are summarized to Telegram.

## Secrets

All tokens come from container env (`../ENV` via compose
`--env-file`), read in Code nodes with `$env` - never hardcoded in node
parameters. Required compose vars: `TELEGRAM_BOT_TOKEN`,
`OPENROUTER_API_KEY` (llm-gateway), `VK_ACCESS_TOKEN`, `VK_USER_ID`,
`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` (last four optional -
publish falls back to hands-agent when absent). Code nodes need
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (set in docker-compose.yml).
