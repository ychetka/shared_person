---
# writer-routing-calibrate.md - one file per PR, public-safe content only.
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
dev_summary: Route writers' group Telegram updates upstream from sp-tg-moderation's single real webhook to sp-writer-dispatch's writer-submit intake (raw update forward carrying the same x-telegram-bot-api-secret-token contract, fail-closed on unset WRITERS_CHAT_ID, forward errors logged scrubbed and never breaking the ack), and add a /calibrate command to Handle Submission - 3 .txt/.md samples per writer scored by the same SYNC'd pangramApiCheck, sha256-dedup'd and 5MB-capped under a per-writer mutex, median -> pangram_base with >0.75 no-onboard flag to the owner chat, task-card replies still taking the task path mid-calibration; check_sync.js gains a 4th pangram-gate copy and a new pangram-api-client group over the three client copies. Review hardening (PR #148): the writer profile link is explicit - a numeric task.writer_id (the assignee's Telegram user id, per the dispatch-path contract) rejects submissions from anyone else before an attempt is consumed, while a non-numeric writer_id falls back to the submitter's own /calibrate profile; calibrate samples enforce the SYNC'd PANGRAM_MIN_WORDS=150 floor; /calibrate@OtherBot is ignored via a getMe-cached username (fail closed: unresolved name accepts only the bare command); calibrate state carries a run_id generation so a mid-scan /calibrate reset discards in-flight results; and the writers' upstream route now matches edited_message and callback_query as well as message.
# why: motivation/decision in one or two sentences. For fix/docs/
# chore this file serves as the micro-ADR - make why carry it.
why: The writers' group traffic arrives on the bot's only real Telegram webhook (tg-moderation), so it must be split upstream before moderation state touches it; and writer_interface_spec.md requires a per-writer Pangram baseline before any production task - without /calibrate there is no way to populate writer_profiles/<id>.json, so Gate Pangram would escalate every draft as UNCALIBRATED.
# refs: task IDs, issue/PR, directive/decision links.
refs: "issue #147, .devin/writer_interface_spec.md"
---

## Spec impact
-
