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
- `queue/publish/{,done,failed}` - approved posts waiting for drivers
- `logs/{moderation,content-gen,publish}.jsonl` - audit trail

The hands-agent queue is bind-mounted at `/home/node/hands-queue`
(host: `../hands-agent/queue/`).

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
  draft_id?}` - saves a draft, sends it to the Telegram chat with inline
  buttons Approve / Edit / Reject (`callback_data` = `ap|ed|rj:<id>`).
- `POST /webhook/tg-moderation` - Telegram webhook target:
  - Approve > writes `queue/publish/<id>.json`, marks the TG message
  - Reject > marks draft rejected, logs to `moderation.jsonl`
  - Edit > stores a pending-edit marker; the next plain-text message in
    the chat is forwarded to `/webhook/content-gen` as a rewrite request
    (mode `rewrite`, with feedback + previous draft)

### sp-trend-scout (schedule, daily 09:00)

`POST rss-reader:8788/curate?since=24h` > dedupe vs `trend_seen.json` >
top-8 digest message to Telegram. Skips silently when nothing new or
chat_id is not resolved yet. VK group top-posts are a planned extension
(iteration 2, needs the VK token).

### sp-content-gen (webhook)

`POST /webhook/content-gen` `{topic, platform, context?, mode?,
feedback?, draft_id?, image?}`. `platform`: linkedin | facebook | vk |
all.

Brief gate (source > brief > draft, see `../brief/README.md`):
`context` is expected to carry the serialized content brief or raw
source material. If `context` is missing, shorter than 200 chars, or
contains fewer than 2 digit-bearing tokens (versions, counts,
percents), generation is skipped, `stage: 'brief-gate'` is logged, and
the resolved Telegram chat gets "no material in brief". This applies to
rewrite requests too (their context is the previous draft).

Passes (all LLM calls go through llm-gateway `POST :8787/run`):

1. `extract-facts` (Gemini Flash) - raw context > strict JSON facts
2. `writer-linkedin` / `writer-fb` / `writer-vk` (Claude Sonnet) - one
   run per platform
3. anti-slop filter (banned EN/RU phrases, emoji bullets, >=2 fact
   entities) - on violations one rewrite pass with feedback
4. humanizer - deterministic cleanup: em/en dash > `-`, zero-width
   chars, smart quotes, ellipsis char, non-breaking space

Each draft is POSTed to `/webhook/moderation-draft` for moderation.

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
