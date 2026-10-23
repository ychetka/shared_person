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
  Response: `{items: [...score, angle, reason], curated: true}`.
- `GET /feeds`, `PUT /feeds {feeds: [...]}`

## Docker

See `../docker-compose.yml`. The image copies prebuilt `dist/` -
build on the host first (`npm install && npm run build`), the
Dockerfile does not run npm install.
