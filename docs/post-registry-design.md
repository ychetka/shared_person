# Post registry - design (issue #12)

Single operational record of every post across platforms. Solves the
current triage pain - state scattered across `state/drafts/*.json`,
`queue/publish/` and `state/published.jsonl` - and lays the contract
that issue #8 (analytics) and pr_manager (cadence/metrics) will read.

Status: design, approved-in-review pending implementation.

## Goals / non-goals

Goals:

- Canonical `post_id` minted at content-gen fan-out; every lifecycle
  transition of every platform draft lands in one auditable log.
- "What happened to post X on platform Y?" answerable in seconds via a
  host CLI, without grepping three dirs.
- Fail-open: a broken registry must never block moderation or publish.

Non-goals (deferred, see Deferred):

- Analytics rollups (views/likes) - #8 stores its own metrics keyed by
  `(post_id, platform)`; the registry is lifecycle state, not a
  time-series store.
- Materialized snapshot files, TG `/post` command, compaction,
  retroactive migration, retry orchestration. The registry observes;
  it never schedules.

## Identity model

- `post_id` - minted by content-gen when a brief fans out to N
  platform writers (`p_<epoch>_<rand6>`, e.g. `p_1730640000_k4f2qa`).
  This is the only point where "these drafts belong together" is
  known; deriving grouping later from timestamps/brief hash is fragile
  under retries.
- `draft_id` stays the per-platform moderation key (unchanged).
  Draft files gain one field: `post_id`. Moderation and publish
  operate on `draft_id` exactly as today - they never need to resolve
  `post_id`; they only tag registry events with it.
- One `post_id` -> up to one service entry per platform. If a future
  platform splits one post into a thread, `external_ids` is already an
  array.

## Storage

All under `/home/node/.n8n/state/registry/` (same named volume as the
existing state; host reaches it via `docker volume inspect`, the
`deploy_workflow.js` pattern).

- `events.jsonl` - the single source of truth. Append-only, one JSON
  object per line, one line per state transition. Appends use the same
  discipline as `logs/*.jsonl` today (single append per transition,
  `fs.appendFileSync` - race-safe because O_APPEND is atomic for these
  sizes on Linux). Writers NEVER read-modify-write a shared document:
  concurrent tg-moderation + publish-tick writes cannot lose updates
  because there is no shared document to lose.

Event schema (`schema_v: 1`):

```json
{
  "schema_v": 1,
  "event_id": "sha1:<post_id>:<platform>:<stage>:<status>:<writer>",
  "post_id": "p_1730640000_k4f2qa",
  "draft_id": "dabc123",
  "platform": "vk",
  "stage": "draft|moderation|publish",
  "status": "pending|approved|rejected|edited|published|failed|skipped|test-deleted",
  "ts": "2026-11-02T15:04:05.123Z",
  "writer": "sp-content-gen|sp-tg-moderation|sp-publish",
  "error": "optional, scrubbed, <=300 chars",
  "maybe_live": false,
  "external_ids": ["12345_678"],
  "published_at": "2026-11-02T15:09:00.000Z"
}
```

- `event_id` - deterministic dedup key over the TRANSITION identity
  (`post_id+platform+stage+status+writer`), deliberately NOT the
  timestamp: an n8n retry recomputes `ts` and a ts-keyed event_id
  would defeat dedup. Same transition firing twice collapses to one
  event; a genuine repeat transition (e.g. approve > edit > approve)
  also collapses - and dedup is LAST-OCCURRENCE-WINS, so the fold
  still lands on the correct terminal status and a probe-recovered
  `failed` event's `external_ids`/`maybe_live` overwrite the first
  failure's empty fields rather than being dropped.
- `maybe_live` - orthogonal flag on `status=failed` publish events
  (mirrors today's ledger: transport loss where the post may have
  landed). `external_ids` carries the recovered id when the orphan
  probe found the post; absent when the probe came back empty.
- `skipped` - service parked for a disabled platform (queue file lands
  in `queue/publish/skipped/` today); without it a disabled-platform
  service would sit at `draft/pending` forever.
- `external_ids` - array from day one (VK single id = 1-element array;
  future thread-posts append).
- `published_at` - written once on the `published` event and never
  overwritten; later status changes keep the original stamp.
- Optional fields absent when empty (not `null`) so readers default,
  not branch.

Materialized view: `state/registry/posts/<post_id>.json` with
`{schema_v, post_id, created_at, services: [{platform, stage, status,
ts, error, external_ids, published_at}]}` - a pure fold of that post's
events, marked `"_generated": true`. DEFERRED to phase 2: the only
named reader today is the incident CLI, which folds live at trivial
cost. A snapshot becomes worth building when a second low-latency
consumer (TG command, pr_manager bulk reads) appears; building it now
buys a stale-cache failure mode for zero users.

## Writers and transitions

| writer | moment | event |
|---|---|---|
| sp-content-gen | draft file written per platform | `stage=draft, status=pending` (+post_id into draft json) |
| sp-tg-moderation | Approve | `stage=moderation, status=approved` |
| sp-tg-moderation | Reject | `stage=moderation, status=rejected` |
| sp-tg-moderation | Edit dispatch / rewrite landed | `stage=moderation, status=edited` |
| sp-publish | wall.post success | `stage=publish, status=published, external_ids, published_at` |
| sp-publish | definite failure | `stage=publish, status=failed, error` |
| sp-publish | transport loss, probe found it | `stage=publish, status=failed, maybe_live=true, external_ids` (no external_ids when probe empty) |
| sp-publish | disabled-platform queue file parked | `stage=publish, status=skipped, error="platform disabled"` |
| sp-publish | test post verified+deleted | `stage=publish, status=test-deleted` |

Write semantics: each writer appends ONE event at the transition and
moves on. `writer` uses the real workflow names (`sp-content-gen`,
`sp-tg-moderation`, `sp-publish`) so events grep-join to the workflows
that emitted them. Registry failures are swallowed and logged to the writer's
own `logs/*.jsonl` (`registry_append_failed`) - the publish/moderation
flow never retries, never throws on registry errors. Registry is
observability, not a gate.

Where the append lives in code: a `registryEvent(fields)` helper added
to the SYNC'd prelude group in each workflow's Code nodes (registered
in `tools/check_sync.js` GROUPS so the copies cannot drift).

## Schema versioning

- Every event carries `schema_v`. Current: `1`.
- Forward-tolerant readers: unknown fields pass through, missing
  fields get defaults, unknown `schema_v` values still fold best-effort
  with a warning - a newer writer must never brick an older reader.
- The version check lives in exactly one place: the fold function.
  Writers do not branch on schema_v.

## Read path: `tools/post_report.py`

Host-side PEP 723 script (no deps beyond stdlib), resolves the volume
via `docker volume inspect` mountpoint like `deploy_workflow.js`
(`--db <path>` override for the same file tree).

```
post_report.py get <post_id>          # services[] timeline + errors
post_report.py list [--status failed] [--since 7d]
post_report.py events <post_id>       # raw event stream
post_report.py orphans                # queue files / drafts with no
                                      # matching registry post_id
```

- `orphans` join key: tg-moderation stamps `post_id` into the queue
  payload at Approve time (queue files already carry `id` (the draft id);
  `post_id` is added next to `id`), so orphans joins queue files and
  drafts to events directly on `post_id`. Pre-registry queue files
  have no `post_id` and resolve via `id -> draft.post_id`;
  a queue file whose draft also lacks `post_id` is reported as
  pre-registry, not an error.
- MVP includes printing `post_id` in TG moderation previews/notifications
  so the operator can paste it into the CLI (it was tempting to defer
  this with the `/post` command, but the read path is useless if the
  id never reaches the operator's surface).

- Folds `events.jsonl` live (the fold is ~15 lines: dedup by
  event_id last-occurrence-wins, merge per (platform,stage) into
  services[], sort by ts). Single code path = no stale-snapshot mode to test.
- Corrupt-line tolerance: unparseable lines are skipped with a warning
  to stderr (a killed process can leave a torn tail line; it must not
  kill triage).
- Exit codes: 0 ok, 1 post not found, 2 unreadable state dir - CI and
  scripts can distinguish.

## Concurrency notes

- Append is the only shared mutation; O_APPEND keeps each write intact
  under concurrent writers only while a line fits PIPE_BUF (4KB -
  strictly the pipe/FIFO guarantee, applied here to the regular file
  as a conservative cap). The `registryEvent` helper enforces this
  instead of assuming it: required fields (`schema_v`, `event_id`,
  `post_id`, `draft_id`, `platform`, `stage`, `status`, `ts`,
  `writer`) are never dropped; if the serialized event exceeds ~3.5KB
  it truncates `error` first, then `external_ids` shrinks to its first
  element, then `published_at`/`maybe_live` are dropped, logging a
  `registry_event_oversized` line to the writer's own log.
- Draft files keep their existing updateDraft/sameDraftSnapshot
  discipline - the registry does not touch draft write paths beyond
  content-gen adding one field.
- `published.jsonl` stays as-is for now (the publish node's internal
  evidence ledger); registry events are additive. Deduping them is a
  cleanup, not part of this issue.

## Deferred (explicit "not now")

- `posts/<post_id>.json` snapshot + reconciler (build when a second
  low-latency reader exists).
- TG `/post <id>` command (build when phone triage is actually felt;
  `post_id` in moderation notifications is MVP, see Read path).
- `events.jsonl` compaction/archival (review at ~50k lines; quarterly
  manual shard at most).
- Retroactive migration of `published.jsonl`/old drafts (only if #8
  needs history before its first run).
- Registry-driven retries/scheduling - never; it observes state.

## Acceptance criteria

- Approving a draft in TG produces `draft/pending` +
  `moderation/approved` + `publish/published` events reachable via
  `post_report.py get <post_id>` showing one VK service entry with
  `external_ids` and `published_at`.
- Rejecting a draft produces a terminal `rejected` service entry -
  rejected drafts are in the registry from creation, so approval-rate
  metrics are computable later.
- Killing the publish node mid-append leaves at most one torn line;
  `post_report.py` still answers.
- `check_sync.js` covers the `registryEvent` helper group; no drift.
- Writing registry events with a full/corrupt state dir fails open:
  publish and moderation complete, a `registry_append_failed` line
  lands in the writer's own log.
