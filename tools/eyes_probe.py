#!/usr/bin/env python3
"""eyes_probe - end-to-end live proof of the eyes-agent JS-dialog
detector on the REAL dirty Habr composer (issue #121).

Flow:
  1. open_tab('https://habr.com/ru/sandbox/new/') via CDP - background
     createTarget, ~60s settle, activate (the recipe's nav pattern:
     foreground INIT of this SPA can wedge the renderer).
  2. attach a second page ws, Page.enable, watch for dialog events.
  3. make the composer dirty with REAL OS input: click_dom
     'Заголовок' -> set_clipboard -> ctrl+v (trusted input; draft
     autosave is harmless - the probe never approaches publish).
  4. Page.reload the dirty tab -> if Habr arms beforeunload,
     Page.javascriptDialogOpening {type:'beforeunload'} fires within
     seconds while the page otherwise reads 'hung'.
  5. dismiss via Page.handleJavaScriptDialog(accept=True) - CDP
     dismissal is fine HERE (test-only per spec), then close the tab.
  6. print a JSON verdict.

Fallback: if Habr does NOT arm beforeunload on reload (an earlier
probe saw dirty tabs close cleanly via closeTarget - ambiguous), the
mechanism is still proven on an about:blank tab with an injected
window.onbeforeunload handler + a real OS click for user activation.
The verdict reports which variant produced the event.

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

import cdp_client  # noqa: E402
import dialog_watch  # noqa: E402

HABL_COMPOSER = "https://habr.com/ru/sandbox/new/"
PASTE_WORD = "eyes-probe"
DIALOG_WAIT_S = 15


def _reload(ws):
    """Fire Page.reload on the watcher's socket WITHOUT waiting for a
    reply - a suspended renderer (dialog open) never sends one, so a
    normal request/reply would just burn the timeout."""
    ws.ws.send(json.dumps({"id": 999, "method": "Page.reload", "params": {"ignoreCache": True}}))


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


def _page_responsive(ws_url, timeout=6):
    """Quick liveness probe: a page behind a native dialog cannot
    answer Runtime.evaluate - that non-answer IS the 'hung' symptom
    the worker misdiagnoses today."""
    r = cdp_client._call(
        ws_url,
        "Runtime.evaluate",
        {"expression": "document.readyState", "returnByValue": True},
        timeout=timeout,
    )
    return not r.get("error")


def _click_el(target_id, expr):
    """Resolve an element via CDP (JS expression -> element), map its
    rect center to SCREEN coords (chrome offset + dpr, same formula as
    hands-agent dom_rect), and fire a real OS click there. Self-
    contained: mainline hands-agent click_dom does not cover
    [data-placeholder] fields, which is what the tiptap title is."""
    import hands

    t = next(
        (x for x in cdp_client.targets() if x.get("type") == "page" and x.get("id") == target_id),
        None,
    )
    if not t:
        return {"error": f"no page target {target_id}"}
    ws = t["webSocketDebuggerUrl"]
    try:
        raw = cdp_client.eval_js(
            ws,
            """(() => {
          const el = __EL_EXPR__;
          if (!el) return 'null';
          const r = el.getBoundingClientRect();
          return JSON.stringify({
            x: r.x + r.width/2, y: r.y + r.height/2,
            sx: window.screenX, sy: window.screenY,
            oy: window.outerHeight - window.innerHeight,
            ox: window.outerWidth - window.innerWidth,
            dpr: window.devicePixelRatio
          });
            })()""".replace("__EL_EXPR__", expr),
        )
    except Exception as e:  # noqa: BLE001 - eval_js raises on transport failure too
        return {"error": f"eval: {e}"}
    if not raw or raw == "null":
        return {"error": "element not found"}
    p = json.loads(raw)
    dpr = p.get("dpr", 1) or 1
    hands.click(
        round(p["x"] * dpr + p["sx"] + p["ox"]),
        round(p["y"] * dpr + p["sy"] + p["oy"]),
    )
    return {"ok": True}


def _clipboard_text():
    """Best-effort read of the current X CLIPBOARD text so the probe
    can restore what it clobbers. Bounded wait - a stuck selection
    owner must not wedge the probe. Returns None when empty/unreadable
    or on any Gtk failure (the clobber caveat stays documented)."""
    try:
        import gi

        gi.require_version("Gdk", "3.0")
        gi.require_version("Gtk", "3.0")

        import hands
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


def _make_dirty(target_id):
    """Dirtify the composer via real OS input (trusted path - a
    synthetic el.value= assignment is invisible to React/tiptap dirty
    tracking and grants no user activation for beforeunload). The
    title field is a tiptap div[data-placeholder=Заголовок], not an
    input - click it, then paste a word via the OS clipboard.

    The paste overwrites the operator's real clipboard: the previous
    TEXT content is saved before the write and restored afterwards
    (best-effort - non-text content like images cannot round-trip via
    wait_for_text and is lost)."""
    # Gdk must be pinned BEFORE hands.set_clipboard's first `from
    # gi.repository import Gdk`: an unpinned import grabs Gdk 4 on this
    # box and Gtk 3.0 then fails with 'Gdk 4.0 is already loaded'.
    import gi

    gi.require_version("Gdk", "3.0")
    import hands

    title_sel = "document.querySelector('div[data-placeholder=\"Заголовок\"]')"
    r = _click_el(target_id, title_sel)
    if not r.get("ok"):
        return {"ok": False, "step": "click title", "detail": r}
    time.sleep(0.5)
    saved_clip = _clipboard_text()
    try:
        hands.set_clipboard(PASTE_WORD)
        time.sleep(0.2)
        hands.key("ctrl", "v")
    finally:
        if saved_clip is not None:
            hands.set_clipboard(saved_clip)
    time.sleep(2.0)  # let tiptap register + autosave kick
    # read-back: the title field should now hold the pasted word
    try:
        t = next(
            (
                x
                for x in cdp_client.targets()
                if x.get("type") == "page" and x.get("id") == target_id
            ),
            None,
        )
        val = cdp_client.eval_js(
            t["webSocketDebuggerUrl"],
            "(document.querySelector('div[data-placeholder=\"Заголовок\"]')||{})"
            ".innerText || '<empty>'",
        )
    except Exception as e:  # noqa: BLE001 - read-back is evidence, not a gate
        val = f"<read-back failed: {e}>"
    return {"ok": True, "title_value": val}


def _try_habr_variant(settle_s):
    """Real-composer leg. Returns (verdict_dict, target_id|None).

    Any exception mid-leg still force-closes the test tab - a thrown
    _make_dirty/eval failure must not strand a possibly-dirty,
    beforeunload-armed tab in the operator's browser."""
    opened = cdp_client.open_tab(HABL_COMPOSER, settle_s=settle_s, activate=True)
    if not opened.get("ok"):
        return {"variant_error": opened}, None
    tid = opened["target_id"]

    ws, aerr = dialog_watch.attach(target_id=tid)
    if ws is None:
        cdp_client.close_tab(tid)
        return {"variant_error": f"attach failed: {aerr}"}, tid
    try:
        dirty = _make_dirty(tid)
        _reload(ws)
        obs = _wait_dialog(ws, DIALOG_WAIT_S)
        responsive = _page_responsive(ws.url)
        verdict = {
            "dirty_evidence": dirty,
            "dialog_seen": obs is not None,
            "observation": obs,
            "page_responsive_after_trigger": responsive,
        }
        if obs is not None:
            # same-session dismiss - handleJavaScriptDialog only works
            # from a Page-enabled session (verified live: a fresh
            # connection gets -32602 'No dialog is showing')
            d = dialog_watch.dismiss_dialog(ws, accept=True)
            verdict["dismiss"] = d
            time.sleep(2)
        return verdict, tid
    except Exception as e:  # noqa: BLE001 - close the dirty tab, then report
        _force_close(tid)
        return {"variant_error": f"{type(e).__name__}: {e}"}, tid
    finally:
        ws.close()


def _try_injected_variant():
    """Fallback: about:blank + injected onbeforeunload + real OS click
    for user activation -> Page.reload. Same event path, no Habr
    dependency. Returns (verdict_dict, target_id|None)."""
    import hands

    opened = cdp_client.open_tab("about:blank", settle_s=2, activate=True)
    if not opened.get("ok"):
        return {"variant_error": opened}, None
    tid = opened["target_id"]

    ws, aerr = dialog_watch.attach(target_id=tid)
    if ws is None:
        cdp_client.close_tab(tid)
        return {"variant_error": f"attach failed: {aerr}"}, tid
    try:
        t = cdp_client.find_page("about:blank")
        cdp_client.eval_js(
            t["webSocketDebuggerUrl"],
            "window.onbeforeunload = () => 'eyes-probe-dirty'; 'armed'",
        )
        # real OS click on the page body = sticky user activation;
        # without it Chrome suppresses the beforeunload prompt
        hands.click(640, 500)
        time.sleep(0.5)
        _reload(ws)
        obs = _wait_dialog(ws, DIALOG_WAIT_S)
        verdict = {"dialog_seen": obs is not None, "observation": obs}
        if obs is not None:
            verdict["dismiss"] = dialog_watch.dismiss_dialog(ws, accept=True)
            time.sleep(2)
        return verdict, tid
    except Exception as e:  # noqa: BLE001 - never strand the armed test tab
        _force_close(tid)
        return {"variant_error": f"{type(e).__name__}: {e}"}, tid
    finally:
        ws.close()


def _force_close(tid):
    """Close a possibly-dirty test tab. Target.closeTarget can itself
    arm beforeunload - if the tab survives the first close request,
    attach a watcher, answer the dialog (accept = leave), retry."""
    if not any(t["id"] == tid for t in cdp_client.targets()):
        return
    cdp_client.close_tab(tid)
    time.sleep(1.5)
    if not any(t["id"] == tid for t in cdp_client.targets()):
        return
    ws, _aerr = dialog_watch.attach(target_id=tid)
    if ws is not None:
        obs = _wait_dialog(ws, 5)
        if obs is not None:
            dialog_watch.dismiss_dialog(ws, accept=True)
        ws.close()
    time.sleep(1)
    if any(t["id"] == tid for t in cdp_client.targets()):
        cdp_client.close_tab(tid)


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

    print(f">> habr variant: open_tab settle {settle}s...", file=sys.stderr)
    habr, habr_tid = _try_habr_variant(settle)
    result["habr"] = habr

    if habr.get("dialog_seen"):
        result.update(
            dialog_seen=True,
            type=habr["observation"].get("sub_type"),
            variant="habr_real",
            hang_without_event=False,
        )
    else:
        # page stayed responsive but no event = habr simply doesn't arm
        # beforeunload on reload here; a responsive page + no event is
        # NOT a hang. A non-responsive page + no event would be a real
        # 'hang without explanation' - report it either way.
        responsive = habr.get("page_responsive_after_trigger")
        # None = the variant errored before responsiveness was probed;
        # that is 'unknown', not a False verdict
        result["hang_without_event"] = (responsive is False) if responsive is not None else None
        if habr_tid:
            print(">> habr variant produced no dialog - closing test tab", file=sys.stderr)
            _force_close(habr_tid)

        print(">> injected variant: about:blank + onbeforeunload...", file=sys.stderr)
        inj, inj_tid = _try_injected_variant()
        result["injected"] = inj
        if inj_tid:
            _force_close(inj_tid)
        if inj.get("dialog_seen"):
            result.update(
                dialog_seen=True,
                type=inj["observation"].get("sub_type"),
                variant="injected_blank",
                hang_without_event=False,
            )

    # the habr test tab is dirty-but-dismissed or clean - close it last
    # so a lingering prompt can never wedge the profile
    if habr.get("dialog_seen") and habr_tid:
        _force_close(habr_tid)

    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    return 0 if result["dialog_seen"] else 1


if __name__ == "__main__":
    sys.exit(main())
