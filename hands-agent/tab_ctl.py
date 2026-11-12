#!/usr/bin/env python3
"""OS-level tab control - the ONLY tab actuation path in this contour.

The CDP read-only directive (issue #127) bans Target.createTarget /
activateTarget / closeTarget outright. Tabs are opened, backgrounded,
activated and closed with real key chords through xdotool, exactly as
a human would drive the browser.

open_tab_bg implements the verified background-load trick for heavy
SPAs: a page that INITIALIZES in a foreground tab can wedge the
renderer on this box (verified live 2026-11-12: 3/3 background loads
reached readyState=complete, 2/2 foreground loads hung permanently).
The sequence loads the URL in a fresh tab, then immediately steps one
tab left so the SPA initializes while occluded, waits out the settle
window, and only then activates the new tab.

How the chords map to Chrome tab behavior:
  ctrl+t          - new tab, opened at the END of the strip, focused
  ctrl+shift+Tab  - one step left. Since the new tab is always last,
                    ANY single step left occludes it - no origin-tab
                    tracking needed (title matching proved fragile:
                    window titles lag and the omnibox eats chords)
  ctrl+9          - jump to the LAST tab (the one we just opened)
  ctrl+w          - close the active tab

URL entry is TYPED (xdotool type), not pasted: the X CLIPBOARD
handover needs the owner process to service its main loop and proved
flaky here - a stale paste turned the omnibox into a search for the
previous clipboard content (verified live 2026-11-17). URLs are short
ASCII, so typing is fast, trusted XTEST input and immune to that.

No CDP calls anywhere in this module.
"""

import subprocess
import time

import hands

_POLL = 0.4


def _window_name():
    try:
        r = subprocess.run(
            ["xdotool", "getactivewindow", "getwindowname"],
            env=hands.ENV,
            check=True,
            capture_output=True,
            timeout=10,
        )
        return r.stdout.decode(errors="replace").strip()
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return ""


def _occlude(new_tab_title):
    """One ctrl+shift+tab left off the new (last) tab. The window title
    changing is a best-effort success signal - retried a few times
    because a swallowed chord must not silently leave the SPA
    foregrounded. Returns True once the title differs."""
    for _ in range(3):
        # capital T: xdotool key names are case-sensitive and a
        # lowercase 'tab' does not produce the Tab keysym (verified
        # live - the chord was silently ignored)
        hands.key("ctrl+shift+Tab")
        time.sleep(0.8)
        if _window_name() != new_tab_title:
            return True
    return False


def open_tab_bg(url, settle_s=45, activate=True):
    """Open `url` in a NEW tab, occlude it for `settle_s`, then
    activate it - all via OS input.

    Returns {"ok": True} or {"error": ...}. The settle window is the
    renderer-safe initialization period measured on this box; callers
    loading trivial pages can pass a smaller value."""
    hands.key("Escape")  # dismiss any open omnibox dropdown first
    time.sleep(0.3)
    hands.key("ctrl+t")
    time.sleep(0.8)
    # Typed, not pasted: the X CLIPBOARD handover needs main-loop
    # servicing from the owner process and proved flaky here (a stale
    # paste turned the omnibox into a search for the previous
    # clipboard content - verified live 2026-11-17). A URL is short
    # ASCII - xdotool type is trusted XTEST input and immune to that.
    subprocess.run(
        ["xdotool", "type", "--delay", "15", "--", url],
        env=hands.ENV,
        check=True,
        capture_output=True,
        timeout=30,
    )
    time.sleep(0.3)
    hands.key("Return")
    time.sleep(1.5)  # let navigation commit before we switch away
    new_title = _window_name()
    if not _occlude(new_title):
        return {
            "error": "could not occlude the new tab - aborting rather "
            "than risk a foreground SPA init"
        }
    time.sleep(settle_s)
    if activate:
        hands.key("ctrl+9")  # last tab = the one just opened
        time.sleep(5)  # let the now-foregrounded page run deferred init
    return {"ok": True}


def close_active_tab():
    """ctrl+w on whatever tab is focused. Callers that need to close a
    specific tab must activate it first (ctrl+9 for the last tab)."""
    hands.key("ctrl+w")
    return {"ok": True}
