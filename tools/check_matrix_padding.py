#!/usr/bin/env python3
"""check_matrix_padding.py - harness for the chart_matrix ragged-rows
contract (issue #52).

Matrix rows shorter than len(columns) used to reach ax.table as-is and
leave HOLES in the rendered table (matplotlib only draws the cells it
is given). This harness stubs matplotlib in sys.modules - the pinned
wheels are not needed to exercise row normalization - then runs the
REAL chart_matrix from tools/render_viz.py and inspects the cellText
grid handed to ax.table:

  1. the grid is rectangular - every body row has len(columns) + 1
     cells (row label + one cell per column);
  2. missing cells are padded with '-' (the 'no data' marker);
  3. over-long rows still truncate at len(columns);
  4. rows with an empty label are dropped as before;
  5. zero-column or zero-row datasets still decline the render.

Run:  python3 tools/check_matrix_padding.py    (exit 0 = all pass)
"""

import sys
import tempfile
import types
from pathlib import Path

TOOLS = Path(__file__).resolve().parent


def _stub_matplotlib():
    """Register minimal matplotlib/pyplot/patches fakes so render_viz
    imports without the heavy wheels. Every created figure is recorded
    so the table grid can be inspected afterwards."""
    figs = []

    class _Text:
        def set_color(self, c):
            pass

        def set_fontweight(self, w):
            pass

    class _Cell:
        def set_edgecolor(self, c):
            pass

        def set_facecolor(self, c):
            pass

        def get_text(self):
            return _Text()

    class _Table:
        def __init__(self, cell_text):
            self.cell_text = cell_text

        def auto_set_font_size(self, v):
            pass

        def set_fontsize(self, s):
            pass

        def scale(self, a, b):
            pass

        def get_celld(self):
            return {
                (ri, ci): _Cell()
                for ri, row in enumerate(self.cell_text)
                for ci, _ in enumerate(row)
            }

    class _Ax:
        def __init__(self):
            self.tables = []

        def axis(self, *a, **k):
            pass

        def table(self, cellText=None, loc=None, cellLoc=None, **k):
            t = _Table(cellText)
            self.tables.append(t)
            return t

    class _Fig:
        def __init__(self):
            self.axes = []

        def add_axes(self, *a, **k):
            ax = _Ax()
            self.axes.append(ax)
            return ax

        def add_subplot(self, *a, **k):
            ax = _Ax()
            self.axes.append(ax)
            return ax

        def suptitle(self, *a, **k):
            pass

        def savefig(self, out, *a, **k):
            Path(out).write_bytes(b"png-stub")

    mpl = types.ModuleType("matplotlib")
    mpl.use = lambda *a, **k: None
    plt = types.ModuleType("matplotlib.pyplot")
    plt.rcParams = {}

    def figure(*a, **k):
        f = _Fig()
        figs.append(f)
        return f

    plt.figure = figure
    plt.close = lambda *a, **k: None
    patches = types.ModuleType("matplotlib.patches")
    patches.FancyArrowPatch = object
    patches.FancyBboxPatch = object
    mpl.pyplot = plt
    mpl.patches = patches
    sys.modules["matplotlib"] = mpl
    sys.modules["matplotlib.pyplot"] = plt
    sys.modules["matplotlib.patches"] = patches
    return figs


FIGS = _stub_matplotlib()
sys.path.insert(0, str(TOOLS))
import render_viz  # noqa: E402

fails = 0


def check(name, cond, detail=None):
    global fails
    if cond:
        print("ok   " + name)
    else:
        print("FAIL " + name + (" - " + str(detail) if detail else ""))
        fails += 1


def run(spec, ds):
    with tempfile.TemporaryDirectory() as td:
        return render_viz.chart_matrix(spec, ds, str(Path(td) / "m.png"))


def last_grid():
    return FIGS[-1].axes[0].tables[0].cell_text


SPEC = {"type": "matrix", "viz_id": "m1", "title": "opts matrix"}

# S1: ragged rows - short dict row pads, over-long dict row truncates,
# short list row pads, empty-label row drops; the grid is rectangular.
ok = run(
    SPEC,
    {
        "kind": "matrix",
        "data": {
            "columns": ["speed", "cost", "ops"],
            "rows": [
                {"label": "opt-a", "values": ["fast"]},
                {"label": "opt-b", "values": ["slow", "$$", "high", "extra"]},
                ["opt-c", "mid"],
                {"label": "", "values": ["ghost"]},
            ],
        },
    },
)
check("S1 render succeeds on ragged rows", ok is True)
grid = last_grid()
check(
    "S1 grid is rectangular: header + 3 body rows x 4 cells",
    len(grid) == 4 and all(len(r) == 4 for r in grid),
    grid,
)
check(
    "S1 short dict row pads '-' up to len(columns)",
    grid[1] == ["opt-a", "fast", "-", "-"],
    grid[1],
)
check(
    "S1 over-long dict row still truncates at len(columns)",
    grid[2] == ["opt-b", "slow", "$$", "high"],
    grid[2],
)
check(
    "S1 short list row pads '-' the same way",
    grid[3] == ["opt-c", "mid", "-", "-"],
    grid[3],
)
check("S1 empty-label row still dropped", all(r[0] != "ghost" for r in grid))

# S2: degenerate inputs still decline the render (no table drawn).
check(
    "S2 no columns -> render declined",
    run(SPEC, {"kind": "matrix", "data": {"rows": [{"label": "a", "values": [1]}]}}) is False,
)
check(
    "S2 no rows -> render declined",
    run(SPEC, {"kind": "matrix", "data": {"columns": ["c"]}}) is False,
)

print(
    "matrix-padding: all checks pass" if not fails else f"matrix-padding: {fails} check(s) failed"
)
sys.exit(1 if fails else 0)
