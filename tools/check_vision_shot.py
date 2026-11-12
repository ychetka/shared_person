#!/usr/bin/env python3
"""check_vision_shot.py - mock-tier checks for the vision.screenshot()
Wayland fallback chain (import -> gnome-screenshot -> CDP).

vision.py depends on cv2 and the hands-agent cdp module, neither of
which is guaranteed present off the fleet machine, so the harness
stubs BOTH before importing vision: cv2.imread reports black/good by
a byte marker the fake capture commands write into the output file,
and `cdp` is replaced by a recording stub (the `import cdp` inside
_cdp_screenshot resolves through sys.modules). Dependency-free,
CI-safe - NO display, NO browser, NO network:

    python3 tools/check_vision_shot.py    # exit 0 = pass

Scenarios:
  S1  import exits non-zero, no gnome-screenshot -> CDP
        Page.captureScreenshot is called and its PNG lands at path;
  S2  import exits 0 but writes a black frame (the silent Xwayland
        failure) -> still reaches the CDP fallback;
  S3  every method fails -> the ORIGINAL import CalledProcessError
        propagates (fail closed);
  S4  import writes a good frame -> returned as-is, CDP untouched;
  S5  import fails, gnome-screenshot present and writes a good frame
        -> used BEFORE CDP, CDP untouched;
  S6  black frame + all fallbacks fail -> RuntimeError (nothing to
        re-raise - import itself did not error).
"""

import base64
import os
import subprocess
import sys
import types
from unittest import mock

HANDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hands-agent")
sys.path.insert(0, os.path.abspath(HANDS))

GOOD = b"PNG-GOOD-FRAME"
BLACK = b"BLACK-FRAME"


class _Img:
    def __init__(self, mean):
        self._mean = mean

    def mean(self):
        return self._mean


def _imread(path, _flag=0):
    """Fake cv2.imread: classify the capture file by its marker bytes."""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
    except OSError:
        return None
    if head.startswith(BLACK[:6]):
        return _Img(0)
    if head.startswith(GOOD[:6]):
        return _Img(200)
    return None


cv2_stub = types.ModuleType("cv2")
cv2_stub.imread = _imread
sys.modules["cv2"] = cv2_stub

import vision  # noqa: E402 - sys.path/cv2 stub must be set first

FAILS = []


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        FAILS.append(name)


def _read(path):
    with open(path, "rb") as f:
        return f.read()


def cdp_stub(targets=None, result=None, calls=None):
    m = types.ModuleType("cdp")
    m.targets = lambda: targets or []

    def _call(ws_url, method, params=None):
        calls.append((ws_url, method, params))
        return result or {}

    m._call = _call
    return m


def run_write(payload):
    def _run(cmd, **_kw):
        with open(cmd[-1], "wb") as f:
            f.write(payload)

    return _run


def run_import_fails(cmd, **_kw):
    raise subprocess.CalledProcessError(1, cmd, stderr=b"root window denied")


PAGE = {"type": "page", "webSocketDebuggerUrl": "ws://t1"}
CDP_OK = {"result": {"data": base64.b64encode(GOOD).decode()}}

# S1: import fails -> CDP captures the page.
calls = []
with (
    mock.patch.object(vision.subprocess, "run", side_effect=run_import_fails),
    mock.patch.object(vision.shutil, "which", return_value=None),
    mock.patch.dict(sys.modules, {"cdp": cdp_stub([PAGE], CDP_OK, calls)}),
):
    p = vision.screenshot()
check("S1 cdp path returns file", os.path.exists(p))
check("S1 file holds cdp png", _read(p) == GOOD)
check(
    "S1 Page.captureScreenshot called",
    calls == [("ws://t1", "Page.captureScreenshot", {"format": "png"})],
)
os.unlink(p)

# S2: import exits 0 but writes a black frame -> still falls to CDP.
calls = []
with (
    mock.patch.object(vision.subprocess, "run", side_effect=run_write(BLACK)),
    mock.patch.object(vision.shutil, "which", return_value=None),
    mock.patch.dict(sys.modules, {"cdp": cdp_stub([PAGE], CDP_OK, calls)}),
):
    p = vision.screenshot()
check("S2 black frame detected -> cdp used", calls and _read(p) == GOOD)
os.unlink(p)

# S3: everything fails -> original import error propagates.
with (
    mock.patch.object(vision.subprocess, "run", side_effect=run_import_fails),
    mock.patch.object(vision.shutil, "which", return_value=None),
    mock.patch.dict(sys.modules, {"cdp": cdp_stub([], None, [])}),
):
    try:
        vision.screenshot()
        check("S3 raises original import error", False)
    except subprocess.CalledProcessError:
        check("S3 raises original import error", True)

# S4: import writes a good frame -> returned directly, CDP untouched.
calls = []
with (
    mock.patch.object(vision.subprocess, "run", side_effect=run_write(GOOD)),
    mock.patch.object(vision.shutil, "which", return_value=None),
    mock.patch.dict(sys.modules, {"cdp": cdp_stub([PAGE], CDP_OK, calls)}),
):
    p = vision.screenshot()
check("S4 good import frame used, cdp skipped", _read(p) == GOOD and not calls)
os.unlink(p)


# S5: import fails, gnome-screenshot present -> used before CDP.
def run_gnome(cmd, **kw):
    if cmd[0] == "import":
        run_import_fails(cmd, **kw)
    else:
        run_write(GOOD)(cmd, **kw)


calls = []
with (
    mock.patch.object(vision.subprocess, "run", side_effect=run_gnome),
    mock.patch.object(vision.shutil, "which", return_value="/usr/bin/gnome-screenshot"),
    mock.patch.dict(sys.modules, {"cdp": cdp_stub([PAGE], CDP_OK, calls)}),
):
    p = vision.screenshot()
check("S5 gnome-screenshot beats cdp", _read(p) == GOOD and not calls)
os.unlink(p)

# S6: black frame + all fallbacks fail -> RuntimeError (import did not error).
with (
    mock.patch.object(vision.subprocess, "run", side_effect=run_write(BLACK)),
    mock.patch.object(vision.shutil, "which", return_value=None),
    mock.patch.dict(sys.modules, {"cdp": cdp_stub([], None, [])}),
):
    try:
        vision.screenshot()
        check("S6 black+no fallbacks raises RuntimeError", False)
    except RuntimeError:
        check("S6 black+no fallbacks raises RuntimeError", True)

print(f"\n{len(FAILS)} failure(s)")
sys.exit(1 if FAILS else 0)
