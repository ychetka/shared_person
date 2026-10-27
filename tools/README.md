# tools

Host-side utilities for the shared_person stack.

## render_viz.py - generated charts for session posts

Session-type drafts get GENERATED visualizations, not archive photos:
the extractor puts measured datasets into `brief.viz_data[]`, the
`viz-spec` role picks 0-2 chart specs, and this tool draws them with
matplotlib into `../materials/viz/<draft_id>_<i>_<viz_id>.png`. The
moderation workflow sends them via `sendPhoto` like any other media.

Numbers come only from `viz_data` - the renderer never invents data.

### Why a host daemon

The n8n container ships no python3 at all, so rendering runs on the
host. Reachability note: rootless docker `network_mode: host` is
actually a shared slirp4netns namespace - inside the container,
loopback is the netns itself and the real host is reached through the
slirp gateway `10.0.2.2`. So the daemon binds host loopback:8791 and
n8n calls `http://10.0.2.2:8791/render` - synchronous, before
moderation fires. (Plain `docker run` setups with real host
networking can use `127.0.0.1` instead.)

### Run

```bash
# one-shot render (spec JSON from file or stdin), prints {"paths": [...]}
uv run tools/render_viz.py spec.json
cat spec.json | uv run tools/render_viz.py

# daemon mode - systemd-free loop, log to materials/viz/renderd.log
nohup uv run tools/render_viz.py --serve --port 8791 \
  >> ../materials/viz/renderd.log 2>&1 &
```

The script is a PEP 723 uv script - `uv run` pulls its deps into a
managed env automatically. Deps are pinned (`numpy<2`,
`matplotlib<3.9`, Python `<3.13`) because the render host CPU has no
AVX and current wheels SIGILL on it. No pip/venv setup needed.

If the machine restarts, relaunch the daemon the same way - it is not
part of docker-compose (host process, needs the project checkout).

### HTTP contract

- `GET /health` -> `{"ok": true, "out": "<dir>"}`
- `POST /render` with body:

```json
{
  "draft_id": "dabc123",
  "specs": [{"type": "bar|line|pipeline|stat-cards", "viz_id": "...",
             "title": "...", "caption": "...", "options": {}}],
  "viz_data": [{"id": "...", "kind": "stats|series|distribution|topology",
                "title": "...", "unit": "...", "data": {...}}]
}
```

Response: `{"ok": true, "paths": ["materials/viz/<file>.png", ...],
"skipped": [...]}`. Paths are returned relative to the project
`materials/` dir on purpose - the n8n moderation resolver maps
`materials/...` onto its read-only `/home/node/materials` mount.

Chart types: `stat-cards` (big-number cards from `stats`),
`bar` (categories / histogram from `stats`, `series`, `distribution`),
`line` (trends from `series`, `distribution`), `pipeline` (node/edge
diagram from `topology`). Max 2 specs per request.

### Env

- `VIZ_RENDERER_URL` (n8n container env, optional) - override the
  render endpoint; default `http://10.0.2.2:8791/render`.

## deploy_workflow.js

SQLite deployer for `n8n/workflows/*.json` - see `n8n/README.md`.
`--update` also reactivates a deactivated workflow: it upserts
`workflow_published_version` and re-registers
`workflow_publication_trigger_status` plus `webhook_entity` rows
(schema-adaptive `INSERT OR REPLACE`, same helper as the create path),
all gated on the spec's `active` flag - an inactive spec instead clears
those registry rows, mirroring an n8n deactivate.

## vk_token_service.py - VK token provider for sp-publish

The VK wall.post driver needs a working access token; the standalone
token in ENV expires. This daemon serves a fresh web-session token
extracted from the logged-in VK tab in the operator's Chrome via CDP
(`VK_CDP_URL`, default `http://127.0.0.1:9223`). Tabs are matched by
URL hostname (`vk.ru`/`vk.com` and subdomains only) and every matching
tab is tried until one yields a token - a logged-out first tab does not
hide a valid session in another one. The web token carries
`wall` scope (post/getById/delete verified). On VK error 5 the service
reloads the tabs once and re-extracts.

```bash
uv run tools/vk_token_service.py --port 8792          # daemon
uv run tools/vk_token_service.py --once                # print token JSON
```

Endpoints: `GET /health`, `GET /vk-token` ->
`{"ok": true, "access_token": "..."}`. Binds host loopback:8792; the n8n
container reaches it through the slirp gateway as `http://10.0.2.2:8792`
(same reachability quirk as the viz renderer). Trust assumption:
`/vk-token` serves a full wall-scope token with no auth - the loopback
bind is the whole trust boundary, so the port must never be exposed
beyond loopback (port forwards included). Not part of
docker-compose - relaunch the same way after a reboot.

## port_fwd.sh / port_fwd.py

Host-to-rootless-netns port bridging - see `../README.md`.
