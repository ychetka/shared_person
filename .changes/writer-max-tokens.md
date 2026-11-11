---
# type: fix | feat | refactor | chore | docs
type: fix
scope: llm-gateway
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Raised max_tokens from 4096 to 16384 for the four writer-* roles (habr, linkedin, fb, vk); other roles unchanged.
why: The sp-content-gen workflow calls llm-gateway /run with writer-habr; the gateway sets maxOutputTokens from role.max_tokens. At 4096 Gemini's JSON article output is reliably truncated mid-string, returning HTTP 422 "model returned non-JSON" and failing the write stage (two live webhook runs verified). Long-form writer roles need the headroom; short-output roles stay at current limits.
refs: "fix/writer-max-tokens"
---

## Spec impact
-
