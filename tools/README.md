# tools

Host-side utilities for the shared_person stack.

## render_viz.py - generated charts for session posts and articles

Session-type drafts get GENERATED visualizations, not archive photos:
the extractor puts measured datasets into `brief.viz_data[]`, the
`viz-spec` role picks 0-2 chart specs, and this tool draws them with
matplotlib into `../materials/viz/<draft_id>_<i>_<viz_id>.png`. The
moderation workflow sends them via `sendPhoto` like any other media.

Article drafts (docs/content-article-spec.md) skip viz-spec: the
writer emits a `visuals[]` task list with INLINE datasets in its JSON
output, and Generate Drafts registers each as a synthetic `viz_data`
entry before POSTing here - same `/render` contract, up to 4 tasks
(B2 matrix / B3 timeline / B4 topology / B5 metric).

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
  "specs": [{"type": "bar|line|pipeline|stat-cards|timeline|matrix",
             "viz_id": "...", "title": "...", "caption": "...",
             "options": {}}],
  "viz_data": [{"id": "...", "title": "...", "unit": "...",
                "kind": "stats|series|distribution|topology|timeline"
                "|matrix", "data": {...}}]
}
```

Response: `{"ok": true, "paths": ["materials/viz/<file>.png", ...],
"skipped": [...]}`. Paths are returned relative to the project
`materials/` dir on purpose - the n8n moderation resolver maps
`materials/...` onto its read-only `/home/node/materials` mount.

Chart types: `stat-cards` (big-number cards from `stats`),
`bar` (categories / histogram from `stats`, `series`, `distribution`),
`line` (trends from `series`, `distribution`), `pipeline` (node/edge
diagram from `topology`), `timeline` (milestone arc from `timeline`,
pivot milestones draw red) and `matrix` (options x criteria table from
`matrix`). Max 4 specs per request; session posts still pick 0-2 via
viz-spec, the extra headroom serves article visuals.

### Env

- `VIZ_RENDERER_URL` (n8n container env, optional) - override the
  render endpoint; default `http://10.0.2.2:8791/render`.

## check_sync.js - SYNC-marker drift check for Code-node helpers

n8n Code nodes cannot share a prelude, so the same helper is
hand-copied across six nodes in `n8n/workflows/*.json` (the plain
`writeJsonAtomic` in five nodes plus Publish Tick's hardened 0o600
variant, the `secretOk` padded compare in three nodes, the
bounded-append counter in two). Drift between copies was policed by
prose comments only; now each shared body is bracketed by
`// SYNC-BEGIN: <group>` / `// SYNC-END: <group>` marker lines inside
the jsCode and this script verifies every copy in a group is identical
after group-specific identifier normalization (the constant names each
copy binds legitimately differ per node - `DRAFT_SECRET` vs
`WEBHOOK_SECRET`, `ctrFile` vs `REJECT_CTR`).

```bash
node tools/check_sync.js   # exit 0 = all groups consistent, 1 = drift
```

Not wired to CI - the deploy_workflow.js preflight is the gate; run
it by hand after touching any SYNC'd helper.
Groups, expected member counts and normalizations live in the `GROUPS`
table at the top of the script; a marker group with no table entry
fails the run, so new shared helpers must be registered there.

## check_fig_numbering.js - article-visuals figure contract harness

Sandbox harness for the `[See Fig N]` / `[см. Fig N]` pointer contract
(issue #51): extracts the 'Generate Drafts' jsCode from
`n8n/workflows/sp-content-gen.json` and runs it under a stubbed
Code-node environment (`require('fs')`, `$input.all()`, `$env`,
`this.helpers.httpRequest` - all faked, nothing touches disk or the
network). Asserts on the moderation-draft dispatch body: pointers
renumber to the FINAL `media` attach order, failed renders drop their
pointer and surface `fig N render failed` in `draft.warnings`,
`caption_note` lists rendered figures in attach order, and an empty
`visuals[]` keeps the legacy dispatch byte-identical. Issue #52 adds
the critic-side contract: the verifier payload carries one flattened
claim line per `visuals[]` task so diagram numbers are fact-checked
like the draft text, and keeps its legacy shape (no `visuals` key)
when the task list is empty. Issue #64 adds the `perf_summary.json`
read side: a seeded analytics file feeds up to 5 trimmed
`top_performers` into the writer brief for matching platforms only,
marks the card `perf-informed`, logs `{action:'perf-summary'}` once,
and a missing/corrupt file fails open with a byte-identical brief.

```bash
node tools/check_fig_numbering.js   # exit 0 = all checks pass
```

## check_analytics.js - collector registry harness

Sandbox harness for the collector registry in sp-analytics's
'Analytics Tick' (issue #64): extracts the real jsCode and runs a full
tick under a stubbed Code-node environment (in-memory `fs` seeded with
registry events, `$env`, `this.helpers.httpRequest` routed to VK /
LinkedIn API fakes - nothing touches disk or the network). Asserts the
`metrics.jsonl` contract: linkedin `GET /v2/socialActions/<urn>` maps
`likesSummary`/`commentsSummary` onto a `measured` row while
views/reposts stay absent (not exposed for member shares); a missing
`LINKEDIN_ACCESS_TOKEN`, a 401/403 auth/perm rejection, a 404 and a
transient failure produce `unsupported`/`gone`/`error` verdicts
respectively; facebook (and the `fb` alias) get the explicit
'no facebook api creds (meta app pending)' unsupported row with zero
HTTP calls; the vk collector, the unsupported counter and the
`perf_summary.json` write keep working unchanged.

```bash
node tools/check_analytics.js   # exit 0 = all checks pass
```

## check_li_media.js - LinkedIn image-upload driver harness

Sandbox harness for the LinkedIn media path in sp-publish's
`publishLinkedin` driver (issue #50): extracts the real 'Publish
Tick' jsCode from `n8n/workflows/sp-publish.json` and runs a full
tick under a stubbed Code-node environment (in-memory `fs` seeded
with the queue payload plus `/home/node/materials` media, `$env`,
`this.helpers.httpRequest` routed to LinkedIn API fakes - nothing
touches disk or the network). Asserts the whole contract:
`PUBLISH_SIMULATE=1` produces `sim-urn:li:share:` + `sim-asset-<n>`
ids with zero HTTP calls; the real path runs
`assets.registerUpload` -> binary `PUT` to the returned `uploadUrl`
-> `media[]` of `urn:li:digitalmediaAsset` urns under
`shareMediaCategory: IMAGE`; a per-file upload failure still
publishes with the surviving assets (VK-driver semantics) and names
the drops in `media_failed`; media caps at 4; a transient upload
error requeues the claim before `ugcPosts` ran; and dry-run resolves
media with no calls at all.

```bash
node tools/check_li_media.js   # exit 0 = all checks pass
```

## check_matrix_padding.py - chart_matrix ragged-rows harness

Row-normalization harness for `render_viz.py`'s `matrix` renderer
(issue #52): rows shorter than `len(columns)` used to leave holes in
the rendered table (matplotlib only draws the cells it is given). The
script stubs `matplotlib`/`pyplot`/`patches` in `sys.modules` - the
pinned wheels are not needed - runs the real `chart_matrix` and
asserts the `cellText` grid handed to `ax.table` is rectangular:
short rows padded with `-`, long rows truncated, empty-label rows
dropped, degenerate datasets still declined.

```bash
python3 tools/check_matrix_padding.py   # exit 0 = all checks pass
```

## deploy_workflow.js

SQLite deployer for `n8n/workflows/*.json` - see `n8n/README.md`.
The target DB defaults to the `shared-person_n8n_storage` docker
volume mountpoint (resolved via `docker volume inspect`, not a
hardcoded host path - the volume's `_data` tree can live under an
unrelated project's docker dir); override with `--db <path>` or
`--db=<path>`. `--update` also reactivates a deactivated workflow: it upserts
`workflow_published_version` and re-registers
`workflow_publication_trigger_status` plus `webhook_entity` rows
(schema-adaptive `INSERT OR REPLACE`, same helper as the create path),
all gated on the spec's `active` flag - an inactive spec instead clears
those registry rows, mirroring an n8n deactivate.

## verify_workflows.js

Drift check for the "git is the source of truth" policy (issue #13):
deep-compares every `n8n/workflows/*.json` spec against the
`workflow_published_version` snapshot the live DB actually executes,
reporting per-workflow `ok`/`FAIL` (with the differing node names),
workflows missing from the DB, and DB workflows with no repo spec.
Read-only (`DatabaseSync` with `readOnly: true`) - safe while n8n runs.
Same `--db`/docker-volume resolution as `deploy_workflow.js`.
Exit 0 = everything in DB matches git; 1 = drift (reconcile with
`deploy_workflow.js --update`, never by editing git backwards).
Usage and the wipe-and-restore procedure: `n8n/README.md` section
"Git is the source of truth; the volume is a cache".

## post_report.py - post registry read path (issue #12)

Folds `state/registry/events.jsonl` (append-only lifecycle events
written by sp-content-gen / sp-tg-moderation / sp-publish via the
SYNC'd `registryEvent` helper) into a per-post, per-platform
timeline. Answers "what happened to post X on platform Y?" without
grepping `drafts/`, `queue/publish/` and `published.jsonl`. Design:
`docs/post-registry-design.md`.

```bash
# state dir resolves via `docker volume inspect
# shared-person_n8n_storage` like deploy_workflow.js; --state
# overrides for an offline copy or tests
python3 tools/post_report.py get <post_id>            # services[] timeline
python3 tools/post_report.py events <post_id>         # raw event stream
python3 tools/post_report.py list [--status failed] [--since 7d]
python3 tools/post_report.py orphans                  # drafts/queue files
                                                      # with no registry events
```

The fold dedups by `event_id` last-occurrence-wins, then per platform
keeps the latest event by `ts` for stage/status/ts/error while
`published_at` and `external_ids` are set-once (a published-then-
failed sequence keeps its stamp). Torn tail lines are skipped with a
stderr warning. Exit codes: 0 ok, 1 post not found, 2 unreadable
state dir. PEP 723 stdlib-only - runs under plain `python3` too.

## vk_token_service.py - VK token provider for sp-publish

The VK wall.post driver needs a working access token; the standalone
token in ENV expires. This daemon serves a fresh web-session token
extracted from the logged-in VK tab in the operator's Chrome via CDP
(`VK_CDP_URL`, default `http://127.0.0.1:9223`). Tabs are matched by
URL hostname (`vk.ru`/`vk.com` and subdomains only) and every matching
tab is tried until one yields a token - a logged-out first tab does not
hide a valid session in another one. The web token carries
`wall` scope (post/getById/delete verified). The localStorage scan
prefers the canonical `*:web_token:login:auth` key shape; the generic
`web_token` fallback is gated on the `<app_id>:` key prefix being
6287487 (the VK web client app id) - `users.get` accepts any live
token, so a web_token minted for a different VK app would pass the
validity check yet fail every `wall.post`. On VK error 5 the service
reloads the tabs once and re-extracts. Self-heal: a tab whose
WebSocket accepts `Runtime.evaluate` but never answers it (wedged
below the page - reload cannot reach it either) is recycled via
`PUT /json/new` on the same URL + `/json/close` on the dead target,
and freshly opened tabs get one bounded eval pass inside the shared
get_token() budget.

```bash
uv run tools/vk_token_service.py --port 8792          # daemon
uv run tools/vk_token_service.py --once                # print token JSON
```

Endpoints: `GET /health`, `GET /vk-token` ->
`{"ok": true, "access_token": "..."}`, and `POST /vk-photo-upload`
(issue #36) -> `{"ok": true, "attachment": "photo<owner>_<id>"}`.
Binds host loopback:8792; the n8n
container reaches it through the slirp gateway as `http://10.0.2.2:8792`
(same reachability quirk as the viz renderer).

`/vk-photo-upload` is the wall-photo hop the n8n Code node cannot do
itself (a real multipart body does not survive the task-runner proxy -
the same reason the TG preview uses a dedicated HTTP node for
sendPhoto). It takes the same `X-Shared-Token` gate as `/vk-token` and
a JSON body `{"rel": "<materials-relative path>"}` - the caller never
sends bytes or a token: the service resolves `rel` under
`VK_MATERIALS_DIR` (default `<repo>/materials`, the same host dir the
container mounts read-only at `/home/node/materials`) with a realpath
under-root check, mints a token via the normal `get_token()` path, then
runs `photos.getWallUploadServer` -> multipart POST ->
`photos.saveWallPhoto` and returns the attachment string for
`wall.post`. Bad paths are 400, transient VK/upload failures answer
503 retryable like the token endpoint. Image extensions only
(jpg/jpeg/png/gif/webp), 15MB cap.

`/vk-token` serves a full wall-scope token, so it sits behind a
shared-secret gate: callers must send the `X-Shared-Token` header
matching the `VK_TOKEN_SECRET` env var (`hmac.compare_digest`, 401 on a
missing/invalid header). The check fails closed when `VK_TOKEN_SECRET`
is unset - an unconfigured service hands out nothing. The loopback
bind is still part of the trust boundary: never expose :8792 beyond
loopback (port forwards included). On the n8n side `VK_TOKEN_SECRET`
is passed through `docker-compose.yml` and sent by `vkRefresh()` in
sp-publish; an unset container env makes every refresh answer 401,
surfacing as `token_service_down` in `vk_status.json`.

This service is a required dependency of the `sp-publish` workflow
(`active: true`, every 2 min): when it is down, every VK publish fails
as `token_service_down` (the env `VK_ACCESS_TOKEN` fallback is a
last resort only). Run it under systemd so it survives reboots:

```bash
# the unit reads a dedicated env file with ONLY VK_TOKEN_SECRET -
# generate it from the project ENV (gitignored, never commit it).
# Parse ENV through tools/env_val.sh - the same env_val() semantics
# tg_webhook_setup.sh uses (optional 'export ', last assignment wins,
# one quote pair stripped, ' # comment' tail removed); a bare
# grep|sed would leave quote chars and comment tails inside the value
# systemd exports:
# guard on empty: a missing key resolves to '' and the env file would
# carry a blank VK_TOKEN_SECRET - the service then fails closed on
# 401 with no obvious cause. Fail loudly at install time instead:
sec="$(tools/env_val.sh VK_TOKEN_SECRET)" && [ -n "$sec" ] \
  || { echo "VK_TOKEN_SECRET missing or empty in ../ENV" >&2; exit 1; }
printf 'VK_TOKEN_SECRET=%s\n' "$sec" > deploy/vk-token.env
chmod 600 deploy/vk-token.env
mkdir -p ~/.config/systemd/user
cp deploy/vk-token.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vk-token.service
systemctl --user status vk-token.service
# so it also starts at boot without a login session:
loginctl enable-linger "$USER"
```

The unit runs `uv run tools/vk_token_service.py --port 8792` from the
checkout and reads `VK_TOKEN_SECRET` via `EnvironmentFile` pointing at
`deploy/vk-token.env` - a dedicated file holding only that one var, NOT
the project `ENV`: its ~18 secrets would otherwise all land in
`systemctl --user show -p Environment` and `/proc/<pid>/environ` of a
daemon that needs exactly one. Adjust `WorkingDirectory`/
`EnvironmentFile` in `deploy/vk-token.service` if the repo lives
elsewhere. `Restart=always` covers process death; the unit is a host
service, not part of docker-compose (it needs the project checkout and
the operator's Chrome CDP).

Cold-cache boot caveat: `uv run` resolves the script's PEP 723 deps
against the package index when its cache is cold, so an offline boot
fails on the resolver, not in the service itself. The unit sets
`RestartSec=30` so the 5-start `StartLimitBurst` budget spreads over
~2.5min of retries instead of burning out before the network is up;
on hosts that boot offline, warm the uv cache once while online
(`uv run tools/vk_token_service.py --once`) so later starts never
touch the index, or raise `RestartSec` further.

## vk_token_issue.py - standalone-token re-issue (issue #3)

Re-issues the VK standalone token documented in `../PLATFORM_ACCESS.md`
by driving the implicit-flow authorize URL end-to-end in the
operator's audit Chrome (CDP `VK_CDP_URL`, default
`http://127.0.0.1:9223`): opens the oauth tab via `PUT /json/new`,
locates the VK ID consent button by DOM-read and clicks it with a
real OS input event (xdotool - the DOM is never written to, so the
click is trusted), reads `access_token` back from the
`oauth.vk.ru/blank.html` fragment, verifies `wall` scope via
`account.getAppPermissions`, and appends `VK_ACCESS_TOKEN=` to the
env file (env_val.sh semantics: last assignment wins, so append is
the update). The token is never printed; output is masked to
user_id/len/scope bits.

```bash
DISPLAY=:1 uv run tools/vk_token_issue.py --env ../ENV
# optional: --cdp http://127.0.0.1:9223   (VK_CDP_URL env equivalent)
```

Exit codes: 0 stored, 1 no token inside the budget (consent needed a
human step - rerun and click manually), 2 token lacks `wall` (not
stored), 3 CDP unreachable. Verified end-to-end 2026-11-06:
consent click + fresh `vk1.a.*` token stored.

Note: VK ID now issues these tokens with `expires_in=86400` (~24h) -
this script is the re-issue path, `vk_token_service.py` remains the
primary provider for sp-publish.


## check_humanizer.js - humanizer eval pipeline harness (issue #78)

Sandbox harness for `sp-humanizer-eval`'s 'Eval Tick': extracts the
real jsCode and runs it under the stubbed Code-node environment
(same in-memory `fs`/`$env`/`this.helpers.httpRequest` contract as
check_pangram.js) against the REAL fixture corpus in
`fixtures/humanizer/<tier>/<lang>.txt`. Asserts the run state
machine end to end: idempotent seeding (`<chain>__<tier>-<lang>.json`
runs for `HUMANIZER_CHAINS` - 'baseline' score-only vs 'editor'
rewrite), clean_human zero-iteration pass (partner never invoked),
ai_flop convergence in <=2 iterations with the
scoring->decide->rewriting->rescoring trace, borderline
'max_iterations' escalate with best-so-far and no threshold
oscillation, the score ledger row contract
(`state/humanizer_scores.jsonl`), the pangram scorer path (enqueue
`pangram-<run>-<seq>.json`, ceil(words/100) shared-credit charge,
result consumption, `credit_cap` and missing-queue stub fallback),
the inhouse partner `/run` call + 422 'partner_failed' escalate,
declared-but-unconfigured external stages -> 'unavailable' cell +
'stage_unavailable' with zero outbound calls, and the
regression->revert decide branch. Also covered: the SCORE_STALE_MS
claim window (one re-enqueue then 'scorer_failed'), the per-task-id
charge ledger (a crash between inbox rename and run write re-arms
the same task without double-spending), the crash-after-consume
`.consumed` re-read, the vetoed rewrite settle on nonce mismatch,
the `roles/humanizer-partner.yaml` manifest+schema contract compiled
through ajv (full output shape incl. plan-mode pass-through), the
partner's `detector_payload {ai_score, marker_spans[]}` input shape,
>=150-word fixture cells with parsable `*.spans.json` annotations,
the `humanizer-seed` lock race guard, cross-backend 'best'
separation (pangram vs stub scores never compare), the 0-100
threshold clamp, and the spec shipping `active: false`. Issue #82
adds the composite `rubric+judge` scorer (blend `max(rubric,
judge*0.8)`, atomic `scorer_failed` on either leg, judge spans
unioned into `marker_spans`), the `chain_a`/`stage_a` blind-label
non-leakage assertions, and the `roles/fluency-judge.yaml` schema
contract compiled through ajv.

```bash
node tools/check_humanizer.js   # exit 0 = all checks pass
```

## check_judge.py - fluency-judge validation harness (issue #82)

Fixture-tier validation for `roles/fluency-judge.yaml` before the
composite `rubric+judge` scorer trusts the LLM verdict: asserts the
strict output contract (`{score 0-100 higher=WORSE, rationale,
issues[]}`, `additionalProperties:false`), then ranks the EN fixture
tiers `clean_human < borderline < ai_flop`. Default mode replays
recorded verdicts - no network, CI-safe; `--live` POSTs the real
role to `$LLM_GATEWAY_URL/run` (`JUDGE_ROLE` env override) for each
tier, prints the ranking report and asserts the same ordering
against the live model.

```bash
python3 tools/check_judge.py         # mock mode (exit 0 = pass)
python3 tools/check_judge.py --live  # hits the real gateway
```

## port_fwd.sh / port_fwd.py


Host-to-rootless-netns port bridging - see `../README.md`.
