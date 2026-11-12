#!/usr/bin/env python3
"""Screenshot capture for eyes-agent - all screenshot kitchen lives here.

Fallback chain (mirrors hands-agent/vision.py's shape, honest about
this box):

  0. ImageMagick `import -window <XID>` on the newest visible Chrome
     window - the PRIMARY method for this contour: real window
     pixels including browser chrome AND native dialogs (verified
     live: the beforeunload prompt is captured), which is exactly
     what the blocker observer needs. Under Xwayland the XID grab
     can return stale/black pixels for an occluded window, so the
     window is raised first (best-effort xdotool windowactivate) and
     the black-frame detector still guards the result.
  1. ImageMagick `import -window root` on HANDS_DISPLAY - X11/Xwayland
     root capture. On GNOME Wayland the Xwayland root either denies the
     grab (exit != 0) or returns an all-black frame with exit 0; the
     black-frame detector marks the result UNUSABLE rather than hand
     garbage downstream.
  2. `scrot` - same X11-only limitation, kept for completeness.
  3. `gnome-screenshot` - portal-mediated full screen, when the binary
     exists (ABSENT on this box; the path stays for portability).
  4. GNOME Shell D-Bus Screenshot - org.gnome.Shell.Screenshot.Screenshot.
     The right portable path for GNOME Wayland; on this box it returns
     AccessDenied ("Screenshot is not allowed") - recorded as
     method-unavailable evidence, not a fatal error.
  5. XDG portal Screenshot - org.freedesktop.portal.Screenshot with
     interactive:false, waiting on the Request object's Response
     signal. On this box it answers Response code 2 (error); the
     interactive:true variant pops a consent dialog - the portal
     consent UX is the known chicken-egg deferred to post-MVP.
  6. CDP Page.captureScreenshot - the RELIABLE last resort: real page
     pixels, but ONLY page content (error pages, in-page overlays,
     captcha-in-page). Never sees browser chrome or native dialogs,
     so method 'cdp' always reports usable for PAGE-level detection.

Returns a dict, never raises on a failed method:
  {ok: bool, path: str|None, method: str|None, ts: float,
   usable: bool, reason: str|None, attempts: [{method, ok, reason}]}

Honest degradation rule: a method that produced no usable pixels is
recorded in attempts with its failure reason; ok is only true when a
file with non-black content exists. Never fake success.
"""

import base64
import os
import shutil
import subprocess
import tempfile
import time

import cv2

ENV = dict(os.environ)
ENV["DISPLAY"] = os.environ.get("HANDS_DISPLAY", ":0")
ENV["XAUTHORITY"] = os.environ.get("HANDS_XAUTHORITY", os.path.expanduser("~/.Xauthority"))

# mean gray level below which a capture counts as "black" - X clients
# under Wayland can return exit 0 with an all-black frame (scrot does
# exactly that on this box). Same constant as vision.py.
_BLACK_MEAN = 5

# how long to wait for the XDG portal Request.Response signal before
# declaring the method unavailable
_PORTAL_RESPONSE_TIMEOUT_S = 6


def _is_black(path):
    img = cv2.imread(path, 0)
    return img is None or img.mean() < _BLACK_MEAN


def _run_x11(tool_args, path, timeout=20):
    """Run an X11 screenshot tool; returns (ok, reason)."""
    try:
        subprocess.run(
            [*tool_args, path], env=ENV, check=True, capture_output=True, timeout=timeout
        )
    except FileNotFoundError:
        return False, "binary not found"
    except subprocess.TimeoutExpired:
        return False, f"timeout after {timeout}s"
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode(errors="replace").strip().splitlines()
        return False, f"exit {e.returncode}: {err[-1][:120] if err else 'no stderr'}"
    if _is_black(path):
        return False, "black frame (X client sees no real pixels under Wayland)"
    return True, None


def _chrome_window_id():
    """XID of the newest visible Chrome window, or None. Shared by
    _x_window_shot and _activate_chrome_window."""
    try:
        r = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--class", "chrome"],
            env=ENV,
            check=True,
            capture_output=True,
            timeout=10,
        )
    except FileNotFoundError:
        return None
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return None
    wins = [w for w in r.stdout.decode(errors="replace").split() if w]
    return wins[-1] if wins else None


def _x_window_shot(path):
    """`import -window <XID>` on the newest visible Chrome window.

    The one method in the chain that sees the REAL browser window:
    page content AND native UI (tab strip, beforeunload/auth/prompt
    dialogs) - verified live on this box. The window is raised first
    because an occluded Xwayland window can hand back stale/black
    pixels; the black-frame check in _run_x11 still gates the
    result."""
    wid = _chrome_window_id()
    if wid is None:
        return False, "no visible chrome window (xdotool search)"
    _activate_chrome_window()  # best-effort raise - capture is attempted either way
    time.sleep(0.5)
    return _run_x11(["import", "-window", wid], path)


def _import_shot(path):
    return _run_x11(["import", "-window", "root"], path)


def _scrot_shot(path):
    return _run_x11(["scrot"], path)


def _gnome_screenshot(path):
    exe = shutil.which("gnome-screenshot")
    if not exe:
        return False, "binary not found"
    try:
        subprocess.run([exe, "-f", path], env=ENV, check=True, capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        # a pending portal permission dialog must not wedge the chain
        return False, "timeout (portal permission dialog pending?)"
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode(errors="replace").strip().splitlines()
        return False, f"exit {e.returncode}: {err[-1][:120] if err else 'no stderr'}"
    if _is_black(path):
        return False, "black frame"
    return True, None


def _bus():
    """Session D-Bus connection via PyGObject (installed on this box)."""
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio

    return Gio.bus_get_sync(Gio.BusType.SESSION, None)


def _gnome_shell_dbus(path):
    """org.gnome.Shell.Screenshot.Screenshot(include_cursor=false,
    flash=false, filename) -> (success, filename_used). AccessDenied on
    this box (verified 2026-11-12) - captured as evidence."""
    from gi.repository import GLib

    try:
        bus = _bus()
        res = bus.call_sync(
            "org.gnome.Shell",
            "/org/gnome/Shell/Screenshot",
            "org.gnome.Shell.Screenshot",
            "Screenshot",
            GLib.Variant("(bbs)", (False, False, path)),
            GLib.VariantType("(bs)"),
            0,  # Gio.DBusCallFlags.NONE
            8000,
            None,
        )
        ok, used = res.unpack()
        if not ok:
            return False, "Screenshot returned success=false"
        if _is_black(used):
            return False, "black frame"
        return True, None
    except Exception as e:  # noqa: BLE001 - D-Bus errors are the expected failure mode here
        return False, f"dbus: {str(e)[:160]}"


def _xdg_portal_shot(path):
    """org.freedesktop.portal.Screenshot.Screenshot('', {interactive:
    false, handle_token}) -> Request object -> wait for its Response
    signal. Response code 0 = success with results['uri']; code 1 =
    cancelled, code 2 = error (what this box answers - verified
    2026-11-12)."""
    import urllib.parse

    from gi.repository import Gio, GLib

    token = f"eyes{int(time.time() * 1000) % 10**8}"
    loop = GLib.MainLoop()
    verdict = {}

    try:
        bus = _bus()
    except Exception as e:  # noqa: BLE001
        return False, f"session bus: {str(e)[:120]}"

    def _on_response(_conn, _sender, obj_path, _iface, _signal, params, _ud):
        code, results = params.unpack()
        verdict["code"] = code
        verdict["results"] = dict(results) if results else {}
        loop.quit()

    sub = bus.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        None,  # any request path - the handle_token narrows it below
        None,
        Gio.DBusSignalFlags.NONE,
        _on_response,
        None,
    )
    try:
        reply = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Screenshot",
            "Screenshot",
            GLib.Variant(
                "(sa{sv})",
                (
                    "",
                    {
                        "handle_token": GLib.Variant("s", token),
                        "interactive": GLib.Variant("b", False),
                    },
                ),
            ),
            GLib.VariantType("(o)"),
            0,
            5000,
            None,
        )
        request_path = reply.unpack()[0]
        # the Response must be for OUR request object, not a stale one
        if token not in request_path:
            return False, f"unexpected request path {request_path}"
        GLib.timeout_add(_PORTAL_RESPONSE_TIMEOUT_S * 1000, loop.quit)
        loop.run()
        if "code" not in verdict:
            return False, f"no Response within {_PORTAL_RESPONSE_TIMEOUT_S}s"
        if verdict["code"] != 0:
            return False, f"portal Response code {verdict['code']}"
        uri = verdict["results"].get("uri", "")
        src = urllib.parse.urlparse(str(uri)).path
        if not src or not os.path.exists(src):
            return False, f"Response ok but uri missing: {uri!r}"
        shutil.copyfile(src, path)
        if _is_black(path):
            return False, "black frame"
        return True, None
    except Exception as e:  # noqa: BLE001 - any portal/D-Bus failure = method unavailable
        return False, f"portal: {str(e)[:160]}"
    finally:
        bus.signal_unsubscribe(sub)


def _activate_chrome_window():
    """OS-level window activation - the read-only replacement for the
    removed cdp_client.activate_tab (Target.activateTarget is a banned
    write call per the issue #127 directive).

    There is no CDP-target -> X-window mapping left (the listing gives
    no window id), so we activate the newest visible Chrome window via
    `xdotool search --onlyvisible --class chrome | tail -1` - the same
    mechanism tab_ctl/eyes_probe use to reach the browser with OS
    input. Best-effort: returns (ok, reason) and never raises - the
    caller still attempts the capture when activation fails (the tab
    may already be foreground)."""
    wid = _chrome_window_id()
    if wid is None:
        return False, "no visible chrome window (xdotool search)"
    try:
        subprocess.run(
            ["xdotool", "windowactivate", wid],
            env=ENV,
            check=True,
            capture_output=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return False, "windowactivate timeout"
    except subprocess.CalledProcessError as e:
        return False, f"windowactivate exit {e.returncode}"
    return True, None


def _cdp_shot(path, url_substr=None):
    """Page.captureScreenshot on the tab matching url_substr (or the
    first page target). Page-viewport pixels only - never browser or
    OS chrome. Read-only inspection per project policy.

    Background/occluded tabs produce no compositor frames, so the shot
    can hang on a hidden tab (verified live 2026-11-13: same tab timed
    out backgrounded, answered instantly once activated). The browser
    window is therefore raised first via OS-level xdotool
    windowactivate (the removed CDP activate_tab is banned) - a mild,
    reversible orchestration act (window focus), not a site mutation."""
    try:
        import cdp_client

        t = cdp_client.find_page(url_substr) if url_substr else None
        if t is None:
            pages = [x for x in cdp_client.targets() if x.get("type") == "page"]
            t = pages[0] if pages else None
        if t is None:
            return False, "no page target"
        act_ok, act_err = _activate_chrome_window()
        if act_ok:
            time.sleep(1.0)  # let the foregrounded surface produce a frame
        r = cdp_client._call(t["webSocketDebuggerUrl"], "Page.captureScreenshot", {"format": "png"})
        data = r.get("result", {}).get("data")
        if not data:
            why = f"no data in reply: {str(r.get('error'))[:120]}"
            if act_err:
                why += f" (window not raised: {act_err})"
            return False, why
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
    except Exception as e:  # noqa: BLE001 - any CDP/network failure just advances the chain
        return False, f"cdp: {str(e)[:160]}"
    if _is_black(path):
        return False, "black frame"
    return True, None


# chain order: the Chrome-window grab first - it is the only method
# that sees native dialogs and is verified working on this box; then
# cheap X11 tools (they fail fast on Wayland), the portable session
# paths, and CDP as the reliable page-level last resort
_CHAIN = [
    ("x_window", _x_window_shot),
    ("import_root", _import_shot),
    ("scrot", _scrot_shot),
    ("gnome-screenshot", _gnome_screenshot),
    ("gnome-shell-dbus", _gnome_shell_dbus),
    ("xdg-portal", _xdg_portal_shot),
]


def screenshot(source=None, path=None, methods=None):
    """Best-effort PNG capture.

    source: url substring selecting the CDP target for the 'cdp' method
    (None = first page target). Ignored by OS-level methods - they take
    the whole screen regardless.

    methods: override/subset of the chain, e.g. ['cdp'] to skip the
    OS-level attempts that are known-unusable on this host.

    Returns {ok, path?, method, ts, usable, reason?, attempts[]} -
    usable mirrors ok (kept explicit so a future 'pixels exist but are
    known-unreliable' state has a place to live)."""
    own_path = path is None
    if own_path:
        fd, path = tempfile.mkstemp(suffix=".png", prefix="eyes_")
        os.close(fd)
    chain = []
    for name, fn in _CHAIN:
        if methods is None or name in methods:
            chain.append((name, fn))
    if methods is None or "cdp" in methods:
        chain.append(("cdp", lambda p: _cdp_shot(p, source)))

    attempts = []
    for name, fn in chain:
        ok, reason = fn(path)
        attempts.append({"method": name, "ok": ok, "reason": reason})
        if ok:
            return {
                "ok": True,
                "path": path,
                "method": name,
                "ts": time.time(),
                "usable": True,
                "reason": None,
                "attempts": attempts,
            }
    if own_path:
        # the mkstemp placeholder (possibly holding a black/garbage
        # frame from the last failed method) must not linger when the
        # result reports path:None - all-fail means no artifact exists
        try:
            os.unlink(path)
        except OSError:
            pass
    return {
        "ok": False,
        "path": None,
        "method": None,
        "ts": time.time(),
        "usable": False,
        "reason": "all methods failed or unusable",
        "attempts": attempts,
    }
