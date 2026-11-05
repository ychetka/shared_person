#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""post_report.py - read path for the post registry (issue #12).

Folds state/registry/events.jsonl into a per-post, per-platform
timeline. "What happened to post X on platform Y?" in seconds,
without grepping drafts/, queue/publish/ and published.jsonl.

  post_report.py get <post_id>           services[] timeline + errors
  post_report.py list [--status S] [--since 7d]
  post_report.py events <post_id>        raw event stream
  post_report.py orphans                 queue files / drafts with no
                                         matching registry post_id

State root resolution mirrors deploy_workflow.js: the docker volume
mountpoint (shared-person_n8n_storage -> <mp>/state); --db/--state
overrides with an explicit state dir for tests or an offline copy.

Exit codes: 0 ok, 1 post not found, 2 unreadable state dir.
"""

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

EVENTS_REL = "registry/events.jsonl"
DRAFTS_REL = "drafts"
QUEUE_REL = "../queue/publish"  # queue sits next to state/, not inside


def err(msg):
    print(msg, file=sys.stderr)


def state_root(argv):
    for i, a in enumerate(argv):
        if a in ("--db", "--state") and i + 1 < len(argv):
            return Path(argv[i + 1])
        if a.startswith("--db=") or a.startswith("--state="):
            return Path(a.split("=", 1)[1])
    try:
        mp = subprocess.run(
            [
                "docker",
                "volume",
                "inspect",
                "shared-person_n8n_storage",
                "--format",
                "{{.Mountpoint}}",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout.strip()
        if mp:
            return Path(mp) / "state"
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def load_events(events_path):
    """All parseable events in file order; torn lines skipped."""
    events = []
    warned = 0
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            warned += 1
            continue
        if isinstance(ev, dict):
            events.append(ev)
        else:
            warned += 1
    if warned:
        err(f"warning: skipped {warned} unparseable line(s) in {events_path}")
    return events


def fold(events):
    """events.jsonl -> {post_id: {services: {platform: entry},
    events: [..]}}. Dedup by event_id last-occurrence-wins (a retried
    transition re-appends the same transition identity); per platform
    the latest event by ts wins stage/status/ts/error, while
    published_at and external_ids are set-once (first non-empty wins,
    never overwritten - a published-then-failed sequence keeps its
    published_at)."""
    deduped = {}
    warned_sv = set()
    for ev in events:
        sv = ev.get("schema_v")
        if sv != 1 and sv not in warned_sv:
            warned_sv.add(sv)
            err(f"warning: schema_v={sv} - folding best-effort")
        deduped[ev.get("event_id") or json.dumps(ev, sort_keys=True)] = ev
    posts = {}
    for ev in deduped.values():
        pid = ev.get("post_id")
        if not pid:
            continue
        posts.setdefault(pid, {"services": {}, "events": []})
        posts[pid]["events"].append(ev)
    for rec in posts.values():
        rec["events"].sort(key=lambda e: str(e.get("ts") or ""))
        for ev in rec["events"]:
            plat = ev.get("platform") or "?"
            svc = rec["services"].setdefault(plat, {"platform": plat})
            if (svc.get("ts") or "") <= (ev.get("ts") or ""):
                for k in ("stage", "status", "ts", "error", "draft_id", "maybe_live", "writer"):
                    if ev.get(k) is not None:
                        svc[k] = ev[k]
                    elif k in ("error", "maybe_live"):
                        # transient fields describe the winning
                        # transition - a published-after-failed fold
                        # must not keep the stale error/maybe_live
                        svc.pop(k, None)
            # set-once fields: first non-empty value wins
            if ev.get("published_at") and not svc.get("published_at"):
                svc["published_at"] = ev["published_at"]
            if ev.get("external_ids") and not svc.get("external_ids"):
                svc["external_ids"] = ev["external_ids"]
    return posts


def resolve_state(argv):
    root = state_root(argv)
    if root is None:
        err(
            "could not resolve the n8n state dir from docker volume "
            "shared-person_n8n_storage - is docker reachable? With "
            "rootless docker set "
            "DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock, "
            "or pass --state <path>/state"
        )
        sys.exit(2)
    if not root.is_dir():
        err(f"state dir not found: {root}")
        sys.exit(2)
    return root


def events_for(root, required=True):
    ep = root / EVENTS_REL
    if not ep.is_file():
        if required:
            err(f"registry events file not found: {ep}")
            sys.exit(2 if not root.is_dir() else 1)
        return []
    return load_events(ep)


def cmd_get(argv):
    if not argv:
        err("usage: post_report.py get <post_id>")
        sys.exit(2)
    pid = argv[0]
    root = resolve_state(argv[1:])
    posts = fold(events_for(root))
    rec = posts.get(pid)
    if not rec:
        print(f"{pid}: no registry events")
        sys.exit(1)
    print(f"post {pid} - {len(rec['events'])} event(s), {len(rec['services'])} service(s)")
    for plat in sorted(rec["services"]):
        s = rec["services"][plat]
        line = f"  [{plat}] {s.get('stage', '?')}/{s.get('status', '?')} @ {s.get('ts', '?')}"
        if s.get("draft_id"):
            line += f" draft={s['draft_id']}"
        if s.get("external_ids"):
            line += f" ext={','.join(map(str, s['external_ids']))}"
        if s.get("published_at"):
            line += f" published_at={s['published_at']}"
        if s.get("maybe_live"):
            line += " MAYBE_LIVE"
        print(line)
        if s.get("error"):
            print(f"    error: {s['error']}")
    return 0


def cmd_events(argv):
    if not argv:
        err("usage: post_report.py events <post_id>")
        sys.exit(2)
    pid = argv[0]
    root = resolve_state(argv[1:])
    posts = fold(events_for(root))
    rec = posts.get(pid)
    if not rec:
        print(f"{pid}: no registry events")
        sys.exit(1)
    for ev in rec["events"]:
        print(json.dumps(ev, ensure_ascii=False, sort_keys=True))
    return 0


def cmd_list(argv):
    status = None
    since = None
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--status" and i + 1 < len(argv):
            status = argv[i + 1]
            i += 2
        elif a == "--since" and i + 1 < len(argv):
            since = argv[i + 1]
            i += 2
        else:
            rest.append(a)
            i += 1
    cutoff = None
    if since:
        unit = since[-1]
        try:
            n = int(since[:-1])
        except ValueError:
            n = 0
        days = n * {"d": 1, "w": 7, "h": 1 / 24}.get(unit, 0)
        if not days or n < 0:
            err(f"bad --since value: {since} (use e.g. 7d, 24h, 2w)")
            sys.exit(2)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    root = resolve_state(rest)
    posts = fold(events_for(root))
    shown = 0
    for pid in sorted(posts):
        rec = posts[pid]
        latest = max((str(e.get("ts") or "") for e in rec["events"]), default="")
        ts = parse_ts(latest)
        if cutoff and (ts is None or ts < cutoff):
            continue
        if status:
            if not any(s.get("status") == status for s in rec["services"].values()):
                continue
        stages = ", ".join(
            f"{p}:{s.get('status', '?')}" for p, s in sorted(rec["services"].items())
        )
        print(f"{pid}  {latest}  {stages}")
        shown += 1
    if not shown:
        print("(no posts match)")
    return 0


def cmd_orphans(argv):
    root = resolve_state(argv)
    posts = fold(events_for(root))
    known = set(posts)
    rows = []
    # drafts carry post_id directly (written by Prepare Draft)
    drafts = {}
    ddir = root / DRAFTS_REL
    if ddir.is_dir():
        for f in sorted(ddir.glob("*.json")):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if isinstance(d, dict):
                drafts[d.get("id") or f.stem] = d
    # queue payloads carry post_id since the registry ship; older
    # files resolve via id -> draft.post_id; neither -> pre-registry
    qroot = (root / QUEUE_REL).resolve()
    orphans = 0
    pre = 0
    for d in sorted(qroot.glob("**/*.json")) if qroot.is_dir() else []:
        try:
            q = json.loads(d.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if not isinstance(q, dict):
            continue
        pid = q.get("post_id")
        src = "queue"
        if not pid:
            did = q.get("id") or d.stem
            pid = (drafts.get(did) or {}).get("post_id")
            if not pid:
                pre += 1
                rows.append(f"  {d.name} [{src}] pre-registry (no post_id)")
                continue
        if pid not in known:
            orphans += 1
            rows.append(f"  {d.name} [{src}] orphan post_id={pid}")
    for did, d in drafts.items():
        pid = d.get("post_id")
        if not pid:
            pre += 1
            rows.append(f"  {did} [draft] pre-registry (no post_id)")
        elif pid not in known:
            orphans += 1
            rows.append(f"  {did} [draft] orphan post_id={pid}")
    print(f"orphans: {orphans}, pre-registry: {pre}")
    for r in rows:
        print(r)
    return 0


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "get":
        return cmd_get(rest)
    if cmd == "events":
        return cmd_events(rest)
    if cmd == "list":
        return cmd_list(rest)
    if cmd == "orphans":
        return cmd_orphans(rest)
    err(f"unknown command: {cmd}")
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
