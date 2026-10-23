# code/ - all profile-growth system code

Self-contained stack. Everything runs in docker containers on the shared
rootless docker daemon - nothing from this project runs bare on the host
(except hands-agent, which needs a real screen/keyboard).

## Stack layout

- `docker-compose.yml` - the `shared-person` project: n8n (:5780),
  llm-gateway (:8787), rss-reader (:8788). Start:
  `docker compose --env-file ../ENV up -d`
- `tools/port_fwd.sh` - bridges host ports into the rootless inner netns
  (shared dockerd runs its own netns; without forwards host cannot reach
  containers). Needs `sudo -n`. Re-run if rootless-docker restarts.
- `tools/deploy_workflow.js` - deploys `n8n-workflows/workflows/*.json`
  into the n8n SQLite DB (n8n REST needs auth). Run with n8n stopped:
  `docker stop shared-person-n8n && node tools/deploy_workflow.js <file> [--update]`

## Services

- `llm-gateway/` - AI harness. `POST /run {role, input}` resolves a role
  manifest from `roles/`, renders context slots from `context/`, calls the
  configured backend (OpenRouter or direct Gemini), validates output.
  `GET /roles`, `GET /health`.
- `rss-reader/` - standalone RSS/Atom digest microservice: `GET /digest`,
  `GET/PUT /feeds`, `POST /curate` (scores items through llm-gateway role
  `feed-curator`). Generic - reusable outside this project.
- `roles/` - LLM role manifests (yaml: prompt, model, temperature,
  output_schema, max_tokens, context_slots).
- `prompts/` - prompt texts referenced by manifests.
- `context/` - private context slots (symlinks to project-root docs,
  never committed).
- `quant-partner/` - Gemini MCP server on the same manifests.
- `n8n-workflows/` - exported workflow JSON specs.
- `hands-agent/` - python OS-level automation (the one host component).
- `scripts/` - utilities.

## Env

All project secrets/config live in `../ENV` (gitignored):
`TELEGRAM_BOT_TOKEN` (@shared_person_bot), `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`, `GITHUB_PAT`.
