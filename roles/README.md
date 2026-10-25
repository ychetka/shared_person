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

Context slot files live in `../context/` (not committed - they may hold
private material). A missing slot file resolves to an empty string.
