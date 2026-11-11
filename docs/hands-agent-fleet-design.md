# hands-agent fleet service - infrastructure roadmap & extraction design

Task 265. Status: DESIGN ONLY - no code changes, no deployments. This
document defines the target architecture for extracting hands-agent
into a shared, multi-tenant fleet service, plus the compatibility
contract that keeps Shared Person working through the migration.

**What exists vs. what is designed** is flagged per section:
`[RUNNING]` = implemented and live today, `[DESIGN]` = proposed here,
not built.

## 1. Current state `[RUNNING]`

hands-agent lives inside this repository at `code/hands-agent/`. It
is a single-host, single-session desktop automation engine:

- `mcp_server.py` - MCP stdio server exposing tools (`screenshot`,
  `click`, `type_text`, `find`, `locate`, `run_recipe`, `dom_text`,
  `js_click`, `set_clipboard`, `task_status`, ...) plus a queue
  poller thread (`queue_worker`) that consumes
  `queue/inbox/*.json` into `queue/{done,failed}/`.
- `hands.py` - OS-level input via `xdotool` (XTEST trusted events):
  Bezier mouse paths, jittered typing, key combos, wheel scroll,
  PyGObject clipboard load for ctrl+v long-body paste.
- `vision.py` - screenshots (imagemagick) + OpenCV multi-scale
  template matching; `locate` falls back to a Gemini vision model
  when `GEMINI_API_KEY` is set.
- `cdp.py` - Chrome DevTools Protocol client against
  `http://127.0.0.1:9223`: read-only DOM targeting (element rect ->
  screen coords for real OS clicks), `dom_text` read-back, and the
  `js_click` escape hatch for React surfaces.
- `recipes/*.yaml` - per-platform step scripts in a mini-DSL
  (`habr_post`, `habr_probe`, `facebook_post`, `linkedin_post`,
  `x_post`, `x_app_onboarding`, `pangram_check`, ...).

Consumers today, both on the same host:

| Consumer | Channel | Mechanism |
|---|---|---|
| n8n workflows | File queue | `docker-compose.yml` bind-mounts `./hands-agent/queue` to `/home/node/hands-queue`; workflows drop `<task_id>.json` into `inbox/`, poll `done|failed/<task_id>.result.json` (habr-driver-spec 2.4 result channel) |
| Devin session | MCP stdio | `mcp_server.py` launched as an MCP stdio server; tools called directly |

There are NO containers, NO isolation, NO leases: one physical X11
session (`DISPLAY=:1`), one browser profile, one account state, one
queue. Two tasks executing concurrently would fight over the same
mouse, keyboard, and screen.

## 2. Required baseline: Docker-per-session `[DESIGN]`

The earlier MVP recommendation of BrowserContext-only isolation (one
browser, many contexts) is **explicitly superseded**. The required
baseline is:

> **Each automation session = its own container**, carrying:
>
> - its own display stack: `Xvfb` (virtual framebuffer) + `x11vnc`
>   (or equivalent, e.g. Xpra/weston-headless - Xvfb+x11vnc is the
>   reference pick because hands.py already speaks X11/xdotool);
> - its own browser instance with its own `--remote-debugging-port`
>   and `--user-data-dir`;
> - its own account state directory (cookies/profile), mounted per
>   lease;
> - its own copy of the engine (`mcp_server.py` adapted to run the
>   recipe runner + a per-session control channel).

Rationale: xdotool input is screen-global - two contexts in one
browser still share one mouse, one clipboard, one focused window.
Only separate X servers serialize input correctly per session.
BrowserContext isolation MAY be added *inside* each container as an
extra layer (e.g. separating two tabs' storage), never as the
primary isolation boundary.

Session container reference composition:

| Layer | Component | Notes |
|---|---|---|
| Display | Xvfb :0 (1400x1050x24) | matches current screenshot geometry assumptions |
| VNC (optional) | x11vnc localhost-only | operator watch/debug; bound to container loopback, proxied read-only by the API for live-view |
| Browser | Chromium/Chrome, `--remote-debugging-port=9223` bound to loopback | cdp.py unchanged - `HANDS_CDP` env already parameterized |
| Engine | recipe runner + queue adapter + HTTP control shim | mcp stdio stays for Devin-mode sessions |
| State | `/state` volume | per-lease account dir mounted here |
| User | non-root (`uid!=0`), `init: true` | reaps Xvfb/browser zombies |

## 3. Service architecture `[DESIGN]`

```
                 +------------------ hands-fleet API (HTTP, auth) ------------------+
 directors ----> | lease mgmt | session pool | bounded queue + sem | reaper | store |
                 +-----------------+----------------------------+-------------------+
                                   | docker /containerd control (host-side only)
                 +-----------------+-----------------+------------------+
                 | session container 1 (Xvfb+browser+engine+state A)     |
                 | session container 2 (Xvfb+browser+engine+state B) ... |
                 +------------------------------------------------------+
```

### 3.1 Components

- **Fleet API** - the only public surface. AuthN per director
  (token/mTLS), authZ scoping leases to the owning director.
- **Lease manager** - directors request a lease; the API returns a
  `session_handle` + TTL. Leases are single-owner, renewable,
  explicitly releasable, and expire on TTL (reaper takes over).
- **Session pool** - warm pool of pre-started containers (bounded by
  `max_sessions`); cold-start path when pool is empty.
- **Bounded queue + semaphore** - task submissions land in a bounded
  queue (`queue_full` -> 429 with retry-after); a semaphore of
  `max_sessions` admits tasks to session slots. One task per lease at
  a time inside a session (input is inherently serial).
- **Cancellation API** - `DELETE /tasks/<id>` or lease-scoped cancel;
  kills the in-flight recipe step loop and releases the slot.
- **Reaper** - periodic sweep: expired leases -> stop container,
  archive artifacts, release proxy/account-state bindings; zombie
  containers (no lease, still running past grace) -> force-remove.
- **Artifact store** - screenshots, `result.json`, step logs per
  task, keyed `{director}/{lease}/{task}` with retention TTL
  (default proposal: artifacts 14d, logs 30d, then hard delete -
  account screenshots can carry PII).

### 3.2 HTTP API sketch

| Endpoint | Semantics |
|---|---|
| `POST /leases` | `{director, recipe_set?, proxy_profile?, account_profile?, ttl_s}` -> `{lease_id, session_handle, expires_at}` |
| `DELETE /leases/{id}` | release; container reclaimed |
| `POST /leases/{id}/renew` | extend TTL |
| `POST /leases/{id}/tasks` | `{recipe, params}` -> `{task_id}` (or 429) |
| `GET /leases/{id}/tasks/{task_id}` | status + result (same shape as `<task_id>.result.json`) |
| `DELETE /leases/{id}/tasks/{task_id}` | cancel |
| `GET /leases/{id}/artifacts` | list/download screenshots + logs |
| `GET /leases/{id}/view` | optional live-view stream (VNC proxy, read-only) |

### 3.3 Per-lease networking and state

- **Proxy assignment (optional)**: each lease may carry a
  `proxy_profile`; the container's egress is pinned to that proxy
  (per-container proxy env / sidecar / netns route). Without it, all
  sessions share host egress - see section 5.
- **Account state isolation**: cookies/profile live under
  `/state/<account_profile>`; a lease mounts exactly one account
  dir, read-write, owned by that director. Same account leased by
  two leases concurrently is rejected (`account_busy`) - parallel
  sessions on one account is a fingerprinting red flag anyway.

## 4. Security model `[DESIGN]`

| Control | Requirement |
|---|---|
| Privilege | Session containers run non-root; `no-new-privileges`; drop all caps. Browser sandbox needs either `--no-sandbox` (inside the already-isolated container, acceptable) or a seccomp profile - never run privileged for it. |
| Docker socket | **The host Docker socket is NEVER mounted into session containers.** Container lifecycle is owned by the fleet API on the host only. |
| Secrets | Broker pattern: secrets (account passwords, TOTP seeds, API keys like `GEMINI_API_KEY`) live in a secrets store; the API injects them into the container env/mount at lease start. Task payloads NEVER carry secrets - recipes reference a logical `secret_ref` resolved at injection time. |
| Resources | `memory` limit, `pids_limit`, `shm_size` (browsers die at default 64MB shm - plan >= 512MB), CPU quota, `init: true`, tmpfs `/tmp`. |
| Mounts | Engine + recipes read-only inside the image; only `/state` and the artifact dir writable; media inputs mounted read-only (the current `../materials:ro` pattern generalizes). |
| Network | Session containers on an isolated bridge; only egress + API callback allowed; no inbound except the loopback control channel via the API. |

## 5. Honest limits of isolation `[DESIGN]`

This section is a disclaimer, not a feature list.

- **Containers do NOT defeat site fingerprinting.** Canvas/WebGL,
  fonts, timezone, `navigator.*`, TLS/JA3, and behavioral signals are
  all still observable. A container is a process boundary, not an
  identity boundary. Mitigation is per-account profile hygiene,
  consistent locale/timezone per account, and human-speed pacing -
  not container count.
- **Containers do NOT fix the shared egress IP.** Without per-lease
  proxies, N sessions egress from one host IP; to a platform, N
  accounts on one IP looks like a botnet regardless of how clean the
  containers are. Per-lease proxy assignment (3.3) is the only
  egress fix, and it buys diversity of exit IP - not trust.
- What containerization DOES buy: input serialization (one X server
  per session), blast-radius containment (a crashed/hung browser
  cannot wedge other sessions), per-account state separation,
  resource caps, and a clean revocation story (kill the container =
  the session is gone).

## 6. Extraction contract & acceptance plan `[DESIGN]`

hands-agent is extracted into a shared fleet service (separate
deployment, potentially separate repo). **Shared Person remains a
consumer, not the owner.**

### 6.1 Compatibility contract

The existing file-queue contract is frozen as the v0 adapter:

- Task shape: `queue/inbox/<task_id>.json` =
  `{"recipe": <name>, "params": {...}}`.
- Result channel: `queue/{done,failed}/<task_id>.result.json`
  carrying `{ok, url?, error?, log?, last_step, publish_step?, ...emitted}`
  plus the moved `<task_id>.json`.
- Semantics preserved: `marks: publish` classification boundary,
  `emit` fields surviving into failed results, `if:` step gating,
  `optional` probes.

Two adapter modes during migration:

| Mode | How it works | For |
|---|---|---|
| (a) File adapter | A fleet-side adapter process polls the SAME `inbox/` dirs (bind-mounted into the adapter, not the session containers) and submits through the lease API internally, writing results back to `done|failed/`. n8n sees zero change. | Existing n8n workflows (habr publish, pangram gate) |
| (b) HTTP consumer | New consumers call `POST /leases` + `POST /tasks` directly, get results via `GET` or webhook. | New directors, sp-publish v2 |

Recipe portability: recipes stay YAML, same DSL; the recipe set is
versioned in the session image (or mounted per director), so
`habr_post.yaml` runs unmodified inside a session container -
`HANDS_DISPLAY`, `HANDS_CDP` env vars already parameterize the
display and CDP endpoint.

### 6.2 Migration phases

1. **Phase 0 (now)**: single host, file queue + MCP stdio. `[RUNNING]`
2. **Phase 1**: containerize the engine image (Xvfb + browser +
   runner); run ONE session container manually; file adapter in
   front; n8n unchanged. Validates the Docker-per-session baseline.
3. **Phase 2**: fleet API + leases + bounded queue; Shared Person
   still on the file adapter; Devin gets a lease for MCP-style
   sessions (stdio bridge or HTTP tool shim).
4. **Phase 3**: multi-tenant - Quant Partner and other directors get
   credentials, proxies, account profiles; Shared Person may
   migrate hot paths to the HTTP API opportunistically.
5. **Phase 4**: decommission in-repo execution; `hands-agent/` in
   this repo shrinks to recipes + the queue adapter contract docs.

### 6.3 Acceptance criteria checklist

- [ ] A recipe that passes today on `DISPLAY=:1` (e.g. `habr_probe`)
      passes identically inside a session container (same result
      JSON shape, `last_step`/`publish_step` semantics intact).
- [ ] File adapter: an n8n workflow dropping `inbox/<id>.json` gets
      `done|failed/<id>.result.json` with the SAME fields the
      current poller writes - verified on a real habr publish and a
      forced failure.
- [ ] Two concurrent leases run two recipes on two accounts without
      input cross-talk (screenshots show separate screens).
- [ ] Lease TTL expiry -> reaper stops the container within grace;
      artifacts still retrievable until retention TTL.
- [ ] Queue saturation -> bounded 429, no unbounded task buildup.
- [ ] Cancel mid-recipe -> session released, result marked
      `cancelled`.
- [ ] No session container has the host Docker socket (checked via
      mount inspection); secrets absent from task payloads and
      `docker inspect` env beyond injected refs.
- [ ] Resource limits enforced (memory/pids/shm) - a runaway browser
      is killed, not the host.
- [ ] `GEMINI_API_KEY` injected via broker; `locate` works in-session.

## 7. Multi-tenant director model `[DESIGN]`

A **director** is a configurable tenant: a project that owns agents,
a workspace, and a set of capabilities.

| Director (examples) | Agents | Workspace | hands-agent access | Extras |
|---|---|---|---|---|
| Shared Person | sp-publish n8n workflows, moderation, Devin sessions | existing Docker/n8n stack in this repo | file adapter today, HTTP API later | Telegram moderation bot |
| Quant Partner | trading agents | separate Docker OS workspace | HTTP lease API, own account profiles | optional dialer, Telegram |

Coordination with the **ai_controller orchestrator**: the
orchestrator owns the director registry and capability graph. When a
director needs a capability it lacks (e.g. Quant Partner needs a
browser session for a new platform, or a dialer channel), it files a
capability request THROUGH the orchestrator - never by directly
mutating another tenant's config. The fleet API consumes the
orchestrator's director registry for authN/authZ; it does not define
tenancy itself.

Per-director isolation rules:

- credentials are scoped: a director's token lists/submits only on
  its own leases;
- account profiles are owned: director A cannot mount director B's
  cookies;
- rate budgets and `max_sessions` are per-director quotas on top of
  the global semaphore;
- artifacts are namespaced and invisible across directors.

## 8. Running vs. designed - summary

| Capability | Status |
|---|---|
| xdotool input, OpenCV/Gemini vision, CDP helpers, YAML recipes | RUNNING |
| File queue (`inbox/done/failed` + `.result.json`) for n8n | RUNNING |
| MCP stdio tools for Devin | RUNNING |
| Session containers (Xvfb/browser/state per session) | DESIGN |
| Fleet HTTP API, leases, TTL, bounded queue/semaphore | DESIGN |
| Per-lease proxies, secrets broker, resource limits | DESIGN |
| Reaper, artifact retention, multi-tenant directors | DESIGN |
