#!/usr/bin/env python3
"""eyes_probe - end-to-end live proof of the eyes-agent JS-dialog
detector on the REAL dirty Habr composer (issue #121), now fully
OS-actuated per the CDP read-only directive (issue #127).

Flow (no Runtime.evaluate, no Target.*, no Page.reload anywhere):
  1. tab_ctl.open_tab_bg('https://habr.com/ru/sandbox/new/') - OS key
     chords only: ctrl+t -> type URL -> Enter -> ctrl+shift+tab back
     so the SPA initializes occluded -> settle -> verified activate.
     (Foreground INIT of this SPA can wedge the renderer - verified
     live 2026-11-12.)
  2. attach a second page ws, Page.enable, watch for dialog events
     (read-observe subscription - allowed set).
  3. make the composer dirty with REAL OS input: locate the title
     field on the screenshot (vision model) -> click -> ctrl+v paste.
     Draft autosave is harmless - the probe never approaches publish.
  4. F5 on the dirty tab -> if Habr arms beforeunload,
     Page.javascriptDialogOpening {type:'beforeunload'} fires within
     seconds while the page otherwise reads 'hung'.
  5. dismiss the in-window dialog with a real OS Return keypress
     (native dialog default = Leave), then close the tab with ctrl+w.
  6. print a JSON verdict.

Fallback: if Habr does NOT arm beforeunload on reload, the mechanism
is proven on an about:blank tab whose onbeforeunload handler is armed
by TYPING a javascript: URL in the omnibox (OS input - Chrome strips
the scheme on paste but not on typed input) + a real OS click for
user activation.

Known gaps under the directive (documented, fail-closed):
  - title-field targeting needs the vision model (GEMINI_API_KEY);
    without it the habr leg skips the dirty step and reports
    {dirty_evidence: {skipped: ...}} - an honest gap, not a fake pass.
  - 'page responsive' used to be an evaluate answer; responsiveness
    now reads as an x_window pixel capture succeeding, and the typed
    dialog event remains the real signal the probe exists for.

Env: HANDS_DISPLAY / HANDS_XAUTHORITY select the X11 session for OS
input (mutter cookie glob auto-detected when unset). EYES_CDP/HANDS_CDP
select the audit-Chrome endpoint (default http://127.0.0.1:9223).
"""

import glob
import json
import os
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EYES = os.path.join(BASE, "eyes-agent")
HANDS = os.path.join(BASE, "hands-agent")
sys.path.insert(0, EYES)
sys.path.insert(0, HANDS)

# OS-input env must be in place BEFORE hands.py reads it at import
os.environ.setdefault("HANDS_DISPLAY", ":0")
if not os.environ.get("HANDS_XAUTHORITY"):
    cookies = sorted(
        glob.glob(f"/run/user/{os.getuid()}/.mutter-Xwaylandauth.*"),
        key=os.path.getmtime,
    )
    if cookies:
        os.environ["HANDS_XAUTHORITY"] = cookies[-1]

import capture  # noqa: E402
import cdp_client  # noqa: E402
import dialog_watch  # noqa: E402
import hands  # noqa: E402
import tab_ctl  # noqa: E402

HABL_COMPOSER = "https://habr.com/ru/sandbox/new/"
PASTE_WORD = "eyes-probe"
DIALOG_WAIT_S = 15


def _wait_dialog(ws, seconds):
    """Drain watcher events until a javascriptDialogOpening arrives or
    the deadline passes. Returns the observation dict or None."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        ev = ws.poll_event(deadline - time.time())
        if ev is None:
            break
        if ev.get("method") == "Page.javascriptDialogOpening":
            return dialog_watch._observation(ev)
    return None


def _pixels_responsive():
    """Liveness proxy post-directive: an x_window capture of the Chrome
    window succeeding means the surface renders pixels. It does NOT
    prove renderer liveness the way an evaluate answer used to - a
    suspended-behind-dialog window also has pixels - so the verdict
    reports it as 'pixels_captured', a distinct honest field."""
    shot = capture.screenshot(methods=["x_window"])
    return bool(shot.get("ok"))


def _dismiss_dialog_os():
    """Answer an open in-window dialog with real key input: Return
    activates the default button (Leave/OK). Best-effort - the caller
    verifies via the javascriptDialogClosed event or the tab list."""
    hands.key("Return")
    time.sleep(1)
    return {"ok": True, "via": "os Return keypress"}


def _clipboard_text():
    """Best-effort read of the current X CLIPBOARD text so the probe
    can restore what it clobbers. Bounded wait - a stuck selection
    owner must not wedge the probe. Returns None when empty/unreadable
    or on any Gtk failure (the clobber caveat stays documented)."""
    try:
        import gi

        gi.require_version("Gdk", "3.0")
        gi.require_version("Gtk", "3.0")

        from gi.repository import Gdk, GLib, Gtk

        os.environ.setdefault("DISPLAY", hands.ENV["DISPLAY"])
        os.environ.setdefault("XAUTHORITY", hands.ENV["XAUTHORITY"])
        Gtk.init([])
        cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        got = {"text": None}
        loop = GLib.MainLoop()

        def _on_text(_cb, text, _ud):
            got["text"] = text
            loop.quit()

        cb.request_text(_on_text, None)
        GLib.timeout_add(1500, loop.quit)
        loop.run()
        return got["text"]
    except Exception:  # noqa: BLE001 - save is best-effort, never a gate
        return None


def _click_title():
    """Screenshot-driven click on the composer title field: vision-model
    locate -> real OS click at the returned coords. No DOM resolution
    exists anymore (Runtime.evaluate is banned), so without
    GEMINI_API_KEY this is an honest documented gap."""
    try:
        from mcp_server import gemini_locate
    except Exception as e:  # noqa: BLE001 - import failure = same gap
        return {"error": f"locator unavailable: {e}"}
    r = gemini_locate(
        "the empty title input field at the top of the Habr composer, "
        "with the RU 'Title' placeholder",
        hint="wide text field above the hubs selector",
    )
    if r.get("x", -1) < 0:
        return {"error": f"title field not located: {r}"}
    hands.click(r["x"], r["y"])
    return {"ok": True, "clicked": [r["x"], r["y"]]}


def _make_dirty():
    """Dirtify the composer via real OS input (trusted path - a
    synthetic el.value= assignment is invisible to React/tiptap dirty
    tracking and grants no user activation for beforeunload, and is
    now impossible anyway: evaluate is banned). The title field is a
    tiptap div located on the screenshot - click it,
    then paste a word via the OS clipboard.

    The paste overwrites the operator's real clipboard: the previous
    TEXT content is saved before the write and restored afterwards
    (best-effort - non-text content like images cannot round-trip via
    wait_for_text and is lost)."""
    # Gdk must be pinned BEFORE hands.set_clipboard's first `from
    # gi.repository import Gdk`: an unpinned import grabs Gdk 4 on this
    # box and Gtk 3.0 then fails with 'Gdk 4.0 is already loaded'.
    import gi

    gi.require_version("Gdk", "3.0")

    r = _click_title()
    if not r.get("ok"):
        return {"ok": False, "step": "click title", "detail": r}
    time.sleep(0.5)
    saved_clip = _clipboard_text()
    try:
        hands.set_clipboard(PASTE_WORD)
        time.sleep(0.2)
        hands.key("ctrl+v")
    finally:
        if saved_clip is not None:
            hands.set_clipboard(saved_clip)
    time.sleep(2.0)  # let tiptap register + autosave kick
    # read-back of the title field is gone with Runtime.evaluate; the
    # verdict records the paste action itself as dirty evidence
    return {"ok": True, "pasted": PASTE_WORD, "title_value": "<unavailable: evaluate banned>"}


def _reload_os():
    """Real F5 keypress - replaces Page.reload (a write command)."""
    hands.key("F5")


def _try_habr_variant(settle_s):
    """Real-composer leg. Returns (verdict_dict, url_substr|None,
    target_id|None) - the id binds later _force_close calls to the
    exact tab this leg created.

    Any exception mid-leg still force-closes the test tab - a thrown
    _make_dirty failure must not strand a possibly-dirty,
    beforeunload-armed tab in the operator's browser."""
    opened = tab_ctl.open_tab_bg(HABL_COMPOSER, settle_s=settle_s, activate=True)
    if not opened.get("ok"):
        return {"variant_error": opened}, None, None
    tab_sel = "habr.com/ru/sandbox"
    tid = opened.get("target_id")

    ws, aerr = _attach_watcher(tid, tab_sel)
    if ws is None:
        _force_close(tab_sel, tid)
        return {"variant_error": f"attach failed: {aerr}"}, tab_sel, tid
    try:
        dirty = _make_dirty()
        _reload_os()
        obs = _wait_dialog(ws, DIALOG_WAIT_S)
        verdict = {
            "dirty_evidence": dirty,
            "dialog_seen": obs is not None,
            "observation": obs,
            "pixels_captured_after_trigger": _pixels_responsive(),
        }
        if obs is not None:
            verdict["dismiss"] = _dismiss_dialog_os()
            time.sleep(2)
        return verdict, tab_sel, tid
    except Exception as e:  # noqa: BLE001 - close the dirty tab, then report
        _force_close(tab_sel, tid)
        return {"variant_error": f"{type(e).__name__}: {e}"}, tab_sel, tid
    finally:
        ws.close()


def _try_injected_variant():
    """Fallback: about:blank + onbeforeunload armed by TYPING a
    javascript: URL in the omnibox (Chrome strips the scheme only on
    paste, not on typed input) + real OS click for user activation ->
    F5. Same event path, no Habr dependency."""
    opened = tab_ctl.open_tab_bg("about:blank", settle_s=2, activate=True)
    if not opened.get("ok"):
        return {"variant_error": opened}, None, None
    tab_sel = "about:blank"
    tid = opened.get("target_id")

    ws, aerr = _attach_watcher(tid, tab_sel)
    if ws is None:
        _force_close(tab_sel, tid)
        return {"variant_error": f"attach failed: {aerr}"}, tab_sel, tid
    try:
        hands.key("ctrl+l")
        time.sleep(0.3)
        hands.type_text("javascript:window.onbeforeunload=()=>'eyes-probe-dirty';void 0")
        hands.key("Return")
        time.sleep(1)
        # real OS click on the page body = sticky user activation;
        # without it Chrome suppresses the beforeunload prompt
        hands.click(640, 500)
        time.sleep(0.5)
        _reload_os()
        obs = _wait_dialog(ws, DIALOG_WAIT_S)
        verdict = {"dialog_seen": obs is not None, "observation": obs}
        if obs is not None:
            verdict["dismiss"] = _dismiss_dialog_os()
            time.sleep(2)
        return verdict, tab_sel, tid
    except Exception as e:  # noqa: BLE001 - never strand the armed test tab
        _force_close(tab_sel, tid)
        return {"variant_error": f"{type(e).__name__}: {e}"}, tab_sel, tid
    finally:
        ws.close()


def _attach_watcher(target_id, tab_sel):
    """Attach the Page-enabled dialog watcher bound to our exact target
    id (review round 3): url_substr binding could land on a second tab
    sharing the url (another about:blank / another Habr page). The
    substring is only a last resort when open_tab_bg could not resolve
    a target id at all."""
    if target_id:
        return dialog_watch.attach(target_id=target_id)
    return dialog_watch.attach(url_substr=tab_sel)


def _find_target(tab_sel, target_id=None):
    """Resolve OUR test tab in /json/list: by target id when the
    open_tab_bg handshake supplied one (exact - a second Habr tab can
    share the url substring), else by url substring."""
    if target_id:
        for t in cdp_client.targets():
            if t.get("type") == "page" and t.get("id") == target_id:
                return t
        return None
    return cdp_client.find_page(tab_sel)


def _force_close(tab_sel, target_id=None):
    """Close OUR possibly-dirty test tab - verified, never blind.

    The old version assumed ctrl+9 'last tab' == our tab: any tab
    appended in the meantime made ctrl+w close an innocent. Now
    activate_tab (tab_ctl) only returns True once the ACTIVE window
    title contains our tab's title marker AND the resolved target id
    still exists with the same url; without that proof the close is
    refused rather than fired at a wrong tab.

    The dialog watcher is attached BEFORE the ctrl+w that can raise
    the beforeunload prompt (review round 3): javascriptDialogOpening
    is never replayed to sessions that attach late, so a post-chord
    watcher could never observe - let alone dismiss - a prompt our own
    chord raised, stranding the armed dirty tab. If the watcher fails
    to attach the chord is not sent at all (fail closed). When a
    prompt does appear it is answered first via the gated CDP dismiss
    (dismiss_dialog - a no-op {error} without EYES_ALLOW_DISMISS=1),
    falling back to the OS Return keypress."""
    t = _find_target(tab_sel, target_id)
    if t is None:
        return
    marker = t.get("title") or ""
    if not tab_ctl.activate_tab(marker, target=t):
        return  # unverified - do NOT ctrl+w a tab we cannot prove is ours
    ws, aerr = _attach_watcher(target_id, tab_sel)
    if ws is None:
        # fail closed: no watcher => the chord could arm a prompt we
        # would be blind to; report and leave the tab for the operator
        print(
            f">> _force_close: watcher attach failed ({aerr}) - skipping ctrl+w",
            file=sys.stderr,
        )
        return
    try:
        hands.key("ctrl+w")
        obs = _wait_dialog(ws, 5)
        if obs is not None:
            r = dialog_watch.dismiss_dialog(ws)
            if r.get("error"):
                _dismiss_dialog_os()
        time.sleep(1.5)
        if _find_target(tab_sel, target_id) is None:
            return
        t = _find_target(tab_sel, target_id)
        if t is not None and tab_ctl.activate_tab(t.get("title") or marker, target=t):
            hands.key("ctrl+w")
            obs = _wait_dialog(ws, 5)
            if obs is not None:
                r = dialog_watch.dismiss_dialog(ws)
                if r.get("error"):
                    _dismiss_dialog_os()
            time.sleep(1)
    finally:
        ws.close()


def main():
    settle = int(os.environ.get("EYES_PROBE_SETTLE", "60"))
    result = {
        "probe": "eyes_probe",
        "ts": time.time(),
        "dialog_seen": False,
        "type": None,
        "variant": None,
        "hang_without_event": None,
    }

    print(f">> habr variant: open_tab_bg settle {settle}s...", file=sys.stderr)
    habr, habr_sel, habr_tid = _try_habr_variant(settle)
    result["habr"] = habr

    if habr.get("dialog_seen"):
        result.update(
            dialog_seen=True,
            type=habr["observation"].get("sub_type"),
            variant="habr_real",
            hang_without_event=False,
        )
    else:
        # no event + pixels still capturing = habr simply doesn't arm
        # beforeunload on reload here - NOT a hang. A missing capture +
        # no event would be a real 'hang without explanation'.
        pixels = habr.get("pixels_captured_after_trigger")
        result["hang_without_event"] = (pixels is False) if pixels is not None else None
        if habr_sel:
            print(">> habr variant produced no dialog - closing test tab", file=sys.stderr)
            _force_close(habr_sel, habr_tid)

        print(">> injected variant: about:blank + typed onbeforeunload...", file=sys.stderr)
        inj, inj_sel, inj_tid = _try_injected_variant()
        result["injected"] = inj
        if inj_sel:
            _force_close(inj_sel, inj_tid)
        if inj.get("dialog_seen"):
            result.update(
                dialog_seen=True,
                type=inj["observation"].get("sub_type"),
                variant="injected_blank",
                hang_without_event=False,
            )

    # the habr test tab is dirty-but-dismissed or clean - close it last
    # so a lingering prompt can never wedge the profile
    if habr.get("dialog_seen") and habr_sel:
        _force_close(habr_sel, habr_tid)

    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    return 0 if result["dialog_seen"] else 1


if __name__ == "__main__":
    sys.exit(main())
