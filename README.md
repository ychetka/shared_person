# code/ - all profile-growth system code

Self-contained stack. Everything runs in docker containers on the shared
rootless docker daemon - nothing from this project runs bare on the host
(except hands-agent, which needs a real screen/keyboard).

## Stack layout

- `docker-compose.yml` - the `shared-person` project: n8n (:5780),
  llm-gateway (:8787), rss-reader (:8788), edge (:8443 + :80 ACME). Start:
  `docker compose --env-file ../ENV up -d`
- `edge/` - Caddy (static binary) terminating TLS for
  `shared-person.opticode.su:8443` -> n8n :5780; gets a Let's Encrypt
  cert via HTTP-01 on :80. Cert material lives in the `edge_data`
  volume (`XDG_DATA_HOME=/data`).
- `tools/port_fwd.sh` - bridges host ports into the rootless inner netns
  (shared dockerd runs its own netns; without forwards host cannot reach
  containers). Needs `sudo -n`. Re-run if rootless-docker restarts.
- `tools/render_viz.py` - host-side chart renderer for session posts
  (matplotlib, dark PNGs into `../materials/viz/`). Runs as an HTTP
  daemon on 127.0.0.1:8791 - see `tools/README.md`.
- `tools/deploy_workflow.js` - deploys `n8n-workflows/workflows/*.json`
  into the n8n SQLite DB (n8n REST needs auth). Run with n8n stopped:
  `docker stop shared-person-n8n && node tools/deploy_workflow.js <file> [--update]`

## Services

- `llm-gateway/` - AI harness. `POST /run {role, input}` resolves a role
  manifest from `roles/`, renders context slots from `context/`, calls the
  configured backend (direct Gemini API), validates output.
  `POST /image {prompt, name?}` renders text-to-image prompts via Gemini
  image models into `../materials/img/`.
  `GET /roles`, `GET /health`.
- `rss-reader/` - standalone RSS/Atom digest microservice: `GET /digest`,
  `GET/PUT /feeds`, `POST /curate` (scores items through llm-gateway role
  `feed-curator`). Generic - reusable outside this project.
- `roles/` - LLM role manifests (yaml: prompt, model, temperature,
  output_schema, max_tokens, context_slots). `viz-spec` picks generated
  charts for session drafts; `image-gen` writes text-to-image prompts
  for generated media on hype/hot-topic drafts.
- `prompts/` - prompt texts referenced by manifests.
- `context/` - private context slots (symlinks to project-root docs,
  never committed).
- `quant-partner/` - Gemini MCP server on the same manifests.
- `n8n-workflows/` - exported workflow JSON specs.
- `hands-agent/` - python OS-level automation (the one host component).
- `scripts/` - utilities.

## Env

All project secrets/config live in `../ENV` (not part of this repo):
`TELEGRAM_BOT_TOKEN` (@shared_person_bot), `GEMINI_API_KEY`,
`GITHUB_PAT`, `N8N_OWNER_EMAIL`, `N8N_OWNER_PASSWORD`,
`VK_ACCESS_TOKEN`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN`.

**Required secrets (breaking):** `docker-compose.yml` declares seven
vars with `${VAR:?}` guards - `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`,
`VK_USER_ID` and the four generated secrets listed below - so
`docker compose up` FAILS until the compose environment provides them
(via `--env-file
../ENV` or exported vars) - previously an unset value was injected
empty and the runtime gate failed closed in silence. The guards are
evaluated for EVERY compose subcommand, not only `up`: `down`,
`stop`, `ps`, `logs`, `exec` all fail in a shell without the vars,
so keep `--env-file ../ENV` on every `docker compose` call. If
`../ENV` is unavailable and the stack must be stopped,
`docker stop <container>` works directly (every service has a pinned
`container_name`).
Generate each of the four below with `openssl rand -hex 32` and add
to `../ENV` before `compose up`:

- `TG_WEBHOOK_SECRET` - signs Telegram webhook deliveries
  (X-Telegram-Bot-Api-Secret-Token); re-register with
  `tools/tg_webhook_setup.sh` after adding/rotating.
- `DRAFT_WEBHOOK_SECRET` - shared secret on the moderation-draft
  webhook (draft delivery).
- `CONTENT_GEN_WEBHOOK_SECRET` - shared secret on the content-gen
  webhook (draft generation).
- `VK_TOKEN_SECRET` - shared secret on the host vk-token service
  (`tools/vk_token_service.py`, X-Shared-Token header).

`TELEGRAM_CHAT_ID` is deliberately NOT behind `${VAR:?}`: the setup
flow (sp-tg-setup) can legitimately discover the operator chat id and
persist it into `state/tg.json` on first run, so a fresh install must
still boot without it. The cost is a silent dead-end: with NEITHER
`TELEGRAM_CHAT_ID` NOR a populated `tg.json`, the OPERATOR_CHAT gate
in sp-tg-moderation drops every signed update and the bot looks dead
- nothing works until `tg.json` is populated (or the env var is set).
Set `TELEGRAM_CHAT_ID` in `../ENV` to pin the operator chat from the
start.

## Platform access

See `PLATFORM_ACCESS.md` - how VK/LinkedIn credentials were obtained
(via the logged-in browser through CDP), how to re-issue them, API
endpoints and caveats.

## Public ingress

`https://shared-person.opticode.su:8443` -> Calix port-forward >
MikroTik dst-nat > host :8443 > port_fwd > inner `edge` (Caddy) > n8n.
A-record at reg.ru points `shared-person` at 37.26.135.143. Port 443 is
VPN - do not use it. `:80` is forwarded for ACME HTTP-01 renewals;
the MikroTik scheduler script `le-renewal-weekly` briefly disables our
dst-nat on :80 when the router itself renews its own LE cert.
