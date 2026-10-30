#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["matplotlib>=3.8,<3.9", "numpy<2"]
# ///
# Pins explained: the render host (AMD A8-3870, no AVX) SIGILLs on current
# numpy/matplotlib wheels. numpy 1.26 + matplotlib 3.8 are the last lines
# built for the baseline x86-64 ISA, and they need Python <= 3.12
# (uv fetches a managed 3.12 automatically).
"""render_viz.py - render chart spec JSON into PNG visualizations.

Part of the shared_person session-post pipeline: the viz-spec role
(roles/viz-spec.yaml) emits chart specs that reference viz_data[]
datasets from a content brief; this tool draws them with matplotlib
(dark minimal style, readable at Telegram preview size). Numbers come
only from viz_data - nothing is invented here.

Usage:
  render_viz.py spec.json [--out DIR]     # spec from file
  cat spec.json | render_viz.py           # spec from stdin
  render_viz.py --serve [--port 8791]     # HTTP daemon mode

Input JSON:
{
  "draft_id": "abc123",
  "specs": [{"type": "bar|line|pipeline|stat-cards", "viz_id": "...",
             "title": "...", "caption": "...", "options": {}}],
  "viz_data": [{"id": "...", "kind": "stats|series|distribution|topology",
                "title": "...", "unit": "...", "data": {...}}]
}

Output: PNG files <out>/<draft_id>_<i>_<viz_id>.png, and a JSON result
on stdout / in the HTTP response: {"paths": ["materials/viz/..."], ...}.
Returned paths are relative ("materials/viz/...") so the n8n moderation
workflow resolves them against its read-only /home/node/materials mount.

Run via uv (PEP 723 header pulls matplotlib automatically):
  uv run tools/render_viz.py --serve
Host-side daemon: the n8n container has no python3 - it POSTs specs to
http://10.0.2.2:8791/render (10.0.2.2 = slirp gateway to the real host
inside rootless docker's shared netns). See tools/README.md.
"""

import argparse
import json
import re
import sys
import textwrap
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

# --- style -----------------------------------------------------------------

BG = "#0d1117"
PANEL = "#161b22"
EDGE = "#30363d"
FG = "#e6edf3"
MUTED = "#8b949e"
ACCENT = "#58a6ff"
GOOD = "#3fb950"
BAD = "#f85149"
SERIES_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff"]

plt.rcParams.update(
    {
        "figure.facecolor": BG,
        "axes.facecolor": PANEL,
        "savefig.facecolor": BG,
        "text.color": FG,
        "axes.edgecolor": EDGE,
        "axes.labelcolor": FG,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "axes.grid": True,
        "grid.color": EDGE,
        "grid.linewidth": 0.6,
        "font.family": "DejaVu Sans",
        "font.size": 11,
    }
)

# default output: <project>/materials/viz (repo root = parents[1] of tools/)
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "materials" / "viz"

MAX_SPECS = 2


# --- helpers ----------------------------------------------------------------


def fmt_num(v):
    """Compact human number: 2593 -> '2,593', -1.06 -> '-1.06'."""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int) or (isinstance(v, float) and v.is_integer()):
        return f"{int(v):,}"
    if isinstance(v, float):
        s = f"{v:.2f}".rstrip("0").rstrip(".")
        return s
    return str(v)


def wrap(s, width=16):
    return textwrap.fill(str(s), width=width, break_long_words=False)


def slugify(s, maxlen=40):
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", str(s)).strip("-").lower()
    return s[:maxlen] or "chart"


def new_fig(w=8.0, h=4.5):
    fig = plt.figure(figsize=(w, h), dpi=160)
    return fig


def finish(fig, title, out):
    if title:
        fig.suptitle(
            textwrap.fill(str(title), 60), color=FG, fontsize=13, fontweight="bold", y=0.98
        )
    fig.savefig(out, bbox_inches="tight", pad_inches=0.25)
    plt.close(fig)


def signed_colors(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    if vals and any(v < 0 for v in vals):
        return [BAD if (isinstance(v, (int, float)) and v < 0) else GOOD for v in values]
    return [ACCENT] * len(values)


# --- chart renderers ---------------------------------------------------------
# Each takes (spec, dataset, out_path). Return True on success.


def chart_stat_cards(spec, ds, out):
    items = (ds.get("data") or {}).get("items") or []
    items = [i for i in items if isinstance(i, dict) and "value" in i][:6]
    if not items:
        return False
    n = len(items)
    cols = min(n, 3)
    rows = (n + cols - 1) // cols
    fig = new_fig(8.0, 1.4 + 1.5 * rows)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")
    ax.set_xlim(0, cols)
    ax.set_ylim(0, rows)
    unit = ds.get("unit") or ""
    for k, it in enumerate(items):
        r, c = divmod(k, cols)
        y = rows - 1 - r
        card = FancyBboxPatch(
            (c + 0.06, y + 0.08),
            0.88,
            0.84,
            boxstyle="round,pad=0.02,rounding_size=0.08",
            facecolor=PANEL,
            edgecolor=EDGE,
            linewidth=1,
        )
        ax.add_patch(card)
        val = fmt_num(it["value"]) + (f" {unit}" if unit else "")
        ax.text(
            c + 0.5,
            y + 0.56,
            val,
            ha="center",
            va="center",
            fontsize=22,
            fontweight="bold",
            color=ACCENT,
        )
        ax.text(
            c + 0.5,
            y + 0.24,
            wrap(it.get("label", ""), 22),
            ha="center",
            va="center",
            fontsize=10,
            color=MUTED,
        )
    finish(fig, spec.get("title") or ds.get("title"), out)
    return True


def _series_parts(data):
    """Normalize series/stats/distribution payloads to (labels, named_series)."""
    if "items" in data:  # stats -> single unnamed series
        items = data["items"] or []
        return (
            [str(i.get("label", "")) for i in items],
            [("value", [i.get("value") for i in items])],
        )
    if "series" in data:
        x = [str(v) for v in (data.get("x") or [])]
        sers = [
            (str(s.get("name", f"s{i}")), list(s.get("data") or []))
            for i, s in enumerate(data["series"] or [])
        ]
        if not x and sers:
            x = [str(i + 1) for i in range(len(sers[0][1]))]
        return x, sers
    if "bins" in data and "counts" in data:
        return ([str(b) for b in data["bins"]], [("count", list(data["counts"]))])
    if "values" in data:  # raw distribution -> histogram done by caller
        return None, [("values", list(data["values"]))]
    return [], []


def chart_bar(spec, ds, out):
    data = ds.get("data") or {}
    opts = spec.get("options") or {}
    # raw values -> histogram
    if "values" in data and "series" not in data and "items" not in data:
        vals = [v for v in data["values"] if isinstance(v, (int, float))]
        if not vals:
            return False
        fig = new_fig()
        ax = fig.add_subplot(111)
        bins = min(20, max(5, int(len(vals) ** 0.5)))
        ax.hist(vals, bins=bins, color=ACCENT, edgecolor=BG)
        ax.set_xlabel(opts.get("x_label") or ds.get("unit") or "value")
        ax.set_ylabel(opts.get("y_label") or "count")
        finish(fig, spec.get("title") or ds.get("title"), out)
        return True

    labels, sers = _series_parts(data)
    if not labels or not sers or not any(s[1] for s in sers):
        return False
    fig = new_fig()
    ax = fig.add_subplot(111)
    _, vals = sers[0]
    vals = vals[: len(labels)]
    labels = labels[: len(vals)]
    colors = signed_colors(vals)
    wl = [wrap(lb, 10) for lb in labels]
    if opts.get("horizontal") or max((len(str(lb)) for lb in labels), default=0) > 12:
        ax.barh(range(len(vals)), vals, color=colors, height=0.62)
        ax.set_yticks(range(len(vals)))
        ax.set_yticklabels([wrap(lb, 24) for lb in labels], fontsize=9)
        ax.invert_yaxis()
        for i, v in enumerate(vals):
            if isinstance(v, (int, float)):
                ax.text(
                    v,
                    i,
                    " " + fmt_num(v),
                    va="center",
                    ha="left" if v >= 0 else "right",
                    fontsize=9,
                    color=FG,
                )
        if ds.get("unit"):
            ax.set_xlabel(ds["unit"])
        ax.grid(axis="y", visible=False)
    else:
        ax.bar(range(len(vals)), vals, color=colors, width=0.62)
        ax.set_xticks(range(len(vals)))
        ax.set_xticklabels(wl, fontsize=9)
        for i, v in enumerate(vals):
            if isinstance(v, (int, float)):
                ax.text(
                    i,
                    v,
                    fmt_num(v),
                    ha="center",
                    va="bottom" if v >= 0 else "top",
                    fontsize=9,
                    color=FG,
                )
        if ds.get("unit"):
            ax.set_ylabel(ds["unit"])
        ax.grid(axis="x", visible=False)
    ax.axhline(0, color=EDGE, linewidth=1)
    if opts.get("y_label"):
        ax.set_ylabel(opts["y_label"])
    if opts.get("x_label"):
        ax.set_xlabel(opts["x_label"])
    finish(fig, spec.get("title") or ds.get("title"), out)
    return True


def chart_line(spec, ds, out):
    data = ds.get("data") or {}
    labels, sers = _series_parts(data)
    if not sers or not any(s[1] for s in sers):
        return False
    fig = new_fig()
    ax = fig.add_subplot(111)
    multi = len(sers) > 1
    for i, (name, vals) in enumerate(sers[:4]):
        xs = range(len(vals))
        ax.plot(
            xs,
            vals,
            marker="o",
            markersize=4,
            linewidth=1.8,
            color=SERIES_COLORS[i % len(SERIES_COLORS)],
            label=name if multi else None,
        )
    n = max(len(s[1]) for s in sers)
    if labels and len(labels) == n:
        step = max(1, n // 8)
        ax.set_xticks(range(0, n, step))
        ax.set_xticklabels(
            [str(labels[i]) for i in range(0, n, step)], fontsize=8, rotation=30, ha="right"
        )
    if multi:
        ax.legend(facecolor=PANEL, edgecolor=EDGE, labelcolor=FG, fontsize=9)
    if ds.get("unit"):
        ax.set_ylabel(ds["unit"])
    opts = spec.get("options") or {}
    if opts.get("y_label"):
        ax.set_ylabel(opts["y_label"])
    if opts.get("x_label"):
        ax.set_xlabel(opts["x_label"])
    if opts.get("log_scale"):
        ax.set_yscale("log")
    finish(fig, spec.get("title") or ds.get("title"), out)
    return True


def _layers(nodes, edges):
    """Left-to-right layering: layer = longest path from a source."""
    preds = {n: [] for n in nodes}
    for e in edges:
        if e.get("to") in preds and e.get("from") in preds:
            preds[e["to"]].append(e["from"])
    layer = {}
    changed = True
    rounds = 0
    while changed and rounds <= len(nodes):
        changed = False
        rounds += 1
        for n in nodes:
            cand = 0 if not preds[n] else max(layer.get(p, -1) + 1 for p in preds[n])
            if cand > layer.get(n, -1):
                layer[n] = cand
                changed = True
    return {n: layer.get(n, 0) for n in nodes}


def chart_pipeline(spec, ds, out):
    data = ds.get("data") or {}
    nodes = {
        n["id"]: str(n.get("label") or n["id"])
        for n in (data.get("nodes") or [])
        if isinstance(n, dict) and "id" in n
    }
    edges = [
        e for e in (data.get("edges") or []) if e.get("from") in nodes and e.get("to") in nodes
    ]
    if not nodes:
        return False
    lay = _layers(list(nodes), edges)
    max_l = max(lay.values())
    by_layer = {}
    for n, lv in lay.items():
        by_layer.setdefault(lv, []).append(n)

    fig = new_fig(max(7.0, 2.4 * (max_l + 1)), 4.5)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")
    pos = {}
    for lv, ns in by_layer.items():
        ns.sort()
        for j, n in enumerate(ns):
            x = lv / max(max_l, 1)
            y = 1 - (j + 1) / (len(ns) + 1)
            pos[n] = (x, y)

    BW, BH = 0.9 / max(max_l + 1, 2), 0.16
    for e in edges:
        x1, y1 = pos[e["from"]]
        x2, y2 = pos[e["to"]]
        arr = FancyArrowPatch(
            (x1 + BW / 2, y1),
            (x2 - BW / 2, y2),
            arrowstyle="-|>",
            mutation_scale=14,
            color=MUTED,
            linewidth=1.4,
            connectionstyle="arc3,rad=-0.15",
            zorder=1,
        )
        ax.add_patch(arr)
        if e.get("label"):
            ax.text(
                (x1 + x2) / 2,
                (y1 + y2) / 2 + 0.05,
                wrap(e["label"], 20),
                fontsize=7.5,
                color=MUTED,
                ha="center",
                va="bottom",
                zorder=3,
            )
    for n, (x, y) in pos.items():
        box = FancyBboxPatch(
            (x - BW / 2, y - BH / 2),
            BW,
            BH,
            boxstyle="round,pad=0.02,rounding_size=0.04",
            facecolor=PANEL,
            edgecolor=ACCENT,
            linewidth=1.4,
            zorder=2,
        )
        ax.add_patch(box)
        ax.text(
            x, y, wrap(nodes[n], 16), ha="center", va="center", fontsize=9.5, color=FG, zorder=3
        )
    ax.set_xlim(-0.06, 1.06)
    ax.set_ylim(-0.06, 1.06)
    finish(fig, spec.get("title") or ds.get("title"), out)
    return True


RENDERERS = {
    "stat-cards": chart_stat_cards,
    "bar": chart_bar,
    "line": chart_line,
    "pipeline": chart_pipeline,
}


# --- driver ------------------------------------------------------------------


def render_request(payload, out_dir):
    """Render all specs in a request payload. Returns result dict."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    draft = slugify(payload.get("draft_id") or "viz")
    datasets = {
        d.get("id"): d
        for d in (payload.get("viz_data") or [])
        if isinstance(d, dict) and d.get("id")
    }
    paths, skipped = [], []
    for i, spec in enumerate((payload.get("specs") or [])[:MAX_SPECS]):
        if not isinstance(spec, dict):
            skipped.append({"spec": spec, "reason": "not-an-object"})
            continue
        stype = spec.get("type")
        ds = datasets.get(spec.get("viz_id"))
        fn = RENDERERS.get(stype)
        if ds is None:
            skipped.append({"viz_id": spec.get("viz_id"), "reason": "unknown-dataset"})
            continue
        if fn is None:
            skipped.append({"viz_id": spec.get("viz_id"), "reason": f"unknown-type:{stype}"})
            continue
        fname = f"{draft}_{i}_{slugify(spec.get('viz_id'))}.png"
        out = out_dir / fname
        try:
            ok = fn(spec, ds, out)
        except Exception as e:  # noqa: BLE001 - keep one bad chart from killing the batch
            skipped.append({"viz_id": spec.get("viz_id"), "reason": f"render-error:{e}"})
            continue
        if ok and out.exists():
            # paths are returned relative to the project materials dir so the
            # n8n moderation resolver maps them to /home/node/materials/...
            paths.append(f"materials/viz/{fname}")
        else:
            skipped.append({"viz_id": spec.get("viz_id"), "reason": "no-data"})
    return {"ok": True, "paths": paths, "skipped": skipped}


def serve(host, port, out_dir):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "out": str(out_dir)})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/render":
                self._send(404, {"error": "not found"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(n) or b"{}")
                self._send(200, render_request(payload, out_dir))
            except Exception as e:  # noqa: BLE001 - a bad request must answer 400, not kill the connection
                self._send(400, {"ok": False, "error": str(e)})

        def log_message(self, fmt, *args):
            sys.stderr.write("renderd: " + (fmt % args) + "\n")

    srv = ThreadingHTTPServer((host, port), H)
    print(f"render_viz daemon on {host}:{port}, out={out_dir}", file=sys.stderr)
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description="render viz_data chart specs to PNG")
    ap.add_argument("spec", nargs="?", help="spec JSON file (default: stdin)")
    ap.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="output dir for PNGs (default: <project>/materials/viz)",
    )
    ap.add_argument("--serve", action="store_true", help="run HTTP daemon")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8791)
    a = ap.parse_args()

    if a.serve:
        serve(a.host, a.port, a.out)
        return

    raw = Path(a.spec).read_text() if a.spec else sys.stdin.read()
    payload = json.loads(raw)
    print(json.dumps(render_request(payload, a.out)))


if __name__ == "__main__":
    main()
