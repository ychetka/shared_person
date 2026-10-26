# Role manifests

Each `*.yaml` in this directory describes one LLM role consumed by
`llm-gateway` (and `quant-partner`). A manifest decouples the prompt text
(`../prompts/<name>.txt`) from execution params, so model, temperature and
output contract can be tuned per role without touching code.

## Schema

```yaml
name: extract-facts            # role id, used in POST /run {"role": "..."}
description: what the role does
backend: gemini                # direct Google generativelanguage API
model: gemini-3.5-flash        # Gemini model id (no models/ prefix)
temperature: 0.2
max_tokens: 4096
prompt: extract-facts          # file ../prompts/extract-facts.txt
context_slots:                 # optional named injections before the prompt
  - style_guide                # ../context/style_guide.md
  - writer_style               # ../context/writer_style.md
  - client_context             # ../context/client_context.md
output:
  type: json                   # json => response is validated as JSON
  schema: {}                   # optional JSON Schema for strict validation
```

`output.type: json` instructs the gateway to request a JSON response and
parse it; when `schema` is present the payload is validated and the call
fails loudly on mismatch (n8n sees HTTP 422 with validation details).

## Model mapping

Writer roles run on the pro-tier model; extraction, review and selection
stay on flash. Fallbacks are tried in order when the primary fails.

| Role | Primary | Fallbacks |
| ---- | ------- | --------- |
| writer-linkedin / writer-fb / writer-vk | gemini-3.1-pro-preview | gemini-3.6-flash, gemini-3.5-flash |
| all other roles | gemini-3.5-flash | gemini-3.6-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-flash-lite-latest |

Context slot files live in `../context/` (not committed - they may hold
private material). A missing slot file resolves to an empty string.
