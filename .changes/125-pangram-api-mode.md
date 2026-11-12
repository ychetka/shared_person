---
# 125-pangram-api-mode.md - one file per PR, public-safe content only.
# type: fix | feat | refactor | chore | docs
type: feat
# scope: module/subsystem touched (llm-gateway, rss-reader,
# hands-agent, edge, n8n, prompts, tools, scripts, deploy, docs, ci)
scope: n8n
user_visible: false
breaking: false
# user_summary: one sentence for the User-facing section; required
# when user_visible is true, "-" otherwise.
user_summary: "-"
# dev_summary: one sentence for the Codebase section.
dev_summary: Pangram AI-check gains a direct REST API transport (PANGRAM_MODE=api, default) with automatic browser-recipe fallback, a standalone tools/pangram_api.js client/CLI, and a per-call JSONL ledger.
# why: motivation/decision in one or two sentences. For fix/docs/
# chore this file serves as the micro-ADR - make why carry it.
why: the hands-queue browser recipe is the fragile primary path; the documented Pangram task API delivers the same verdict synchronously at card prep, while every API failure degrades to the existing browser enqueue so coverage is never lost.
# refs: task IDs, issue/PR, directive/decision links.
refs: issue #125
---

## Spec impact
-
