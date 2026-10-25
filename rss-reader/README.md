# rss-reader

Standalone RSS/Atom digest microservice. Fetches configured feeds,
normalizes items, deduplicates, optionally scores them through an
LLM gateway. Not tied to this project - configure `feeds.yaml` and run
it anywhere.

## Run

```bash
npm install
npm run build
npm start            # listens on :8788
# or dev: npm run dev
```

## Config (env)

- `RSS_PORT` - listen port (default `8788`)
- `FEEDS_FILE` - path to feeds yaml (default `feeds.yaml` next to code)
- `STATE_DIR` - seen-state directory (default `state/`)
- `LLM_GATEWAY_URL` - if set, `/curate` scores items via the gateway;
  empty disables LLM curation
- `CURATE_ROLE` - gateway role used for scoring (default `feed-curator`)
- `FETCH_TIMEOUT_MS` - per-feed fetch timeout (default `15000`)

## feeds.yaml

```yaml
feeds:
  - name: n8n Blog
    url: https://blog.n8n.io/rss/
    tags: [automation, n8n]
    weight: 0.9      # 0-1 expected value, used as deterministic
                     # fallback when LLM curation is off/failed
```

The file is re-read on every request - `PUT /feeds` or editing it on
disk takes effect immediately.

## API

- `GET /health` -> `{ok, feeds}`
- `GET /digest?since=24h&tags=ai,frontend&fresh=1`
  - `since` supports `Nh`/`Nd`/`Nw` (default `24h`)
  - `tags` filters by feed tags
  - `fresh=1` returns only unseen items and marks them seen
    (state in `STATE_DIR`)
- `POST /curate {items?}` - scores items through the LLM gateway in
  25-item chunks; with no body it collects a digest first.
  Response: `{items: [...score, angle, reason, hype, hype_parts,
  metrics], curated: true}`, ordered by `hype` desc.
- `GET /feeds`, `PUT /feeds {feeds: [...]}`

## Hype score

`/curate` enriches items with engagement metrics and a `hype` score
(0-100) - how likely an item is worth a commentary post:

```
hype = 40 * theme + 30 * llm + 10 * weight + 20 * engagement
```

- `theme` - pillar keyword fit (AI agents / LLM / MCP, automation / n8n,
  React / TS frontend, algo-trading, DevOps-lite) matched on
  title+summary: 0/1/2/3+ groups -> 0 / 0.6 / 0.85 / 1.0. When no group
  matches the text but the feed tags do, `theme = 0.3`.
- `llm` - curator `score / 10`; 0 when the gateway is off or failed.
- `weight` - source weight from `feeds.yaml`.
- `engagement` - log-normalized metrics when fetchable, else 0:
  `0.5*ln1p(comments)/ln1p(150) + 0.3*ln1p(views)/ln1p(50000)
   + 0.2*ln1p(votes)/ln1p(100)`.

Engagement sources (`src/metrics.ts`):

- habr.com articles - the embedded `statistics` JSON block on the
  article page (`commentsCount`, `votesCount`, `score`, `reach`=views)
- news.ycombinator.com - Algolia HN API (`points`, `num_comments`),
  item id taken from the RSS `<comments>` link

Metrics are cached in `STATE_DIR/metrics.json` for 48h (keyed by item
id) so repeat `/curate` runs do not re-fetch article pages. Fetches
run 4-way concurrent with a 10s timeout; a failed fetch caches an
empty result for the TTL.

## Docker

See `../docker-compose.yml`. The image copies prebuilt `dist/` -
build on the host first (`npm install && npm run build`), the
Dockerfile does not run npm install.
