# llm-gateway

Single HTTP entry point for all LLM calls. Role manifests (YAML) in
`../roles/` describe which backend, model, prompt file and context slots
to use - callers just POST a role name plus input.

## Run

```bash
npm install
npm run build
GEMINI_API_KEY=... npm start   # :8787
```

## Config (env)

- `LLM_GATEWAY_PORT` - listen port (default `8787`)
- `GEMINI_API_KEY` - backend key (direct generativelanguage API); a
  role fails if the key is missing
- `ROLES_DIR`, `PROMPTS_DIR`, `CONTEXT_DIR` - directory overrides
  (default `../roles`, `../prompts`, `../context`)
- `REQUEST_TIMEOUT_MS` - upstream call timeout (default `120000`)

## Role manifest (roles/<name>.yaml)

```yaml
name: extract-facts            # required
description: ...               # shown in GET /roles
backend: gemini                # required (direct Google API)
model: gemini-3.5-flash        # required
fallback_models: [m1, m2]      # tried in order when primary fails
temperature: 0.3
max_tokens: 4096
prompt: extract-facts          # prompts/<stem>.txt|md - required
context_slots: [style_guide]   # context/<stem>.md|txt, optional,
                               # injected as <context name="...">
output:
  type: json                   # json -> parsed, validated, fence-stripped
  schema: { ...JSON Schema... } # validated via AJV
```

## API

- `GET /health` -> `{ok}`
- `GET /roles` -> `[{name, description, backend, model, temperature}]`
- `POST /run {role, input, system_extra?}`
  - `system_extra` is appended to the rendered system prompt
  - response `{role, model, backend, text}` or
    `{role, model, backend, json}` for `output.type: json`
  - `422` when the model returns non-JSON or fails the schema

## Docker

Same pattern as rss-reader: `npm install && npm run build` on the host,
image only copies `dist/`. In `../docker-compose.yml` the repo root is
mounted read-only at `/app/code`, so role/prompt/context edits on the
host are picked up without a rebuild (roles are cached per process -
restart the container to reload manifests).
