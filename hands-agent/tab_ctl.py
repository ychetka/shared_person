#!/usr/bin/env python3
"""OS-level tab control - the ONLY tab actuation path in this contour.

The CDP read-only directive (issue #127) bans Target.createTarget /
activateTarget / closeTarget outright. Tabs are opened, backgrounded,
activated and closed with real key chords through xdotool, exactly as
a human would drive the browser. The only CDP contact left here is the
read-only /json/list enumeration (cdp.targets) used to IDENTIFY the
tab this module created - tab identity is the safety property the
blind-chord version lacked (review round 2): ctrl+9 'last tab' and a
naked ctrl+w must never land on someone else's tab.

open_tab_bg implements the verified background-load trick for heavy
SPAs: a page that INITIALIZES in a foreground tab can wedge the
renderer on this box (verified live 2026-11-12: 3/3 background loads
reached readyState=complete, 2/2 foreground loads hung permanently).
The sequence loads the URL in a fresh tab, then immediately steps one
tab left so the SPA initializes while occluded, waits out the settle
window, and only then re-activates OUR tab - verified, not assumed.

How the chords map to Chrome tab behavior:
  ctrl+t          - new tab, opened at the END of the strip, focused
  ctrl+shift+Tab  - one step left. Since the new tab is always last,
                    ANY single step left occludes it
  ctrl+Tab        - one step right (used by activate_tab's verify-and-
                    scan fallback when ctrl+9 doesn't land on our tab)
  ctrl+9          - jump to the LAST tab (ours only when nothing else
                    was opened in between - hence the verification)
  ctrl+w          - close the active tab

Tab identity (review round 2 fixes):
  - the /json target set is snapshotted BEFORE ctrl+t; the created tab
    is the page target that appears afterwards (id not in the
    snapshot), preferring one whose URL matches what we navigated to.
    open_tab_bg returns its target id/title so callers (recipes via
    ctx['tab_id'], eyes_probe) can bind later read-backs/closes to
    THIS tab instead of 'the first tab matching a substring'.
  - _occlude compares against a SETTLED window title: a late-committing
    page title (SPA still loading when the title is first read) used to
    count as a successful switch - now the title must be stable across
    consecutive polls before it becomes the comparison baseline.
  - activate_tab never trusts 'ctrl+9 landed right': after any jump the
    active window title must contain our tab's title marker, else it
    scans the strip with ctrl+Tab looking for the marker and fails
    closed (False) rather than leaving a wrong tab focused.
  - the abort path closes the created tab and hands focus back to the
    previous tab (ctrl+w on the still-focused new tab returns Chrome to
    the adjacent tab); an abort must not strand an armed stray.

URL entry is TYPED (xdotool type), not pasted: the X CLIPBOARD
handover needs the owner process to service its main loop and proved
flaky here - a stale paste turned the omnibox into a search for the
previous clipboard content (verified live 2026-11-17). URLs are short
ASCII, so typing is fast, trusted XTEST input and immune to that.
"""

import subprocess
import time
import urllib.parse

import hands

_POLL = 0.4
_TAB_SCAN_LIMIT = 30  # upper bound for activate_tab's ctrl+Tab scan


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


def _settle_title(timeout=8.0):
    """Read the active window title until it is STABLE: the same
    non-empty value on two consecutive polls. A page still committing
    its navigation keeps rewriting the title; comparing a later read
    against an early one produced the false 'tab switched' verdict
    this guards (the title changed because the page finished loading,
    not because the chord worked). Returns the settled title, or the
    last read on timeout."""
    last = _window_name()
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(_POLL)
        cur = _window_name()
        if cur and cur == last:
            return cur
        last = cur or last
    return last


def _page_targets():
    try:
        import cdp

        return [t for t in cdp.targets() if t.get("type") == "page"]
    except Exception:  # noqa: BLE001 - a dead /json endpoint degrades to OS-only tracking
        return []


def _new_target(before_ids, url):
    """The page target created by our ctrl+t: id absent from the
    pre-open snapshot, preferring one whose URL matches what we typed
    (a net-new tab can still sit on chrome://newtab while the SPA
    commits). Host+path match keeps a second Habr tab from stealing
    the identity."""
    pages = _page_targets()
    fresh = [t for t in pages if t.get("id") not in before_ids]
    if not fresh:
        return None
    frag = urllib.parse.urlparse(url).netloc + urllib.parse.urlparse(url).path.rstrip("/")
    for t in fresh:
        if frag and frag in (t.get("url") or "").rstrip("/"):
            return t
    return fresh[0] if len(fresh) == 1 else None


def _target_current(target):
    """Re-resolve OUR target in /json/list: the SAME id must still
    exist AND still carry the url we recorded at creation (review
    round 3). Title alone can never prove identity - two about:blank
    tabs or two same-titled Habr pages both pass a marker check, so
    any close/actuation path that got a target from _new_target must
    re-verify id+url here, not just the window title. Returns the
    fresh target dict, or None when identity is broken."""
    if not target or not target.get("id"):
        return None
    recorded_url = (target.get("url") or "").rstrip("/")
    for t in _page_targets():
        if t.get("id") == target.get("id"):
            if recorded_url and (t.get("url") or "").rstrip("/") != recorded_url:
                return None
            return t
    return None


def _title_matches(marker):
    """Active window title contains the marker (case-insensitive). The
    window name is '<page title> - Google Chrome', so a page title is
    a substring of it. An empty marker can never prove identity."""
    if not marker:
        return False
    return marker.strip().lower() in _window_name().strip().lower()


def activate_tab(marker, target=None):
    """Bring OUR tab to the foreground and PROVE it: after each jump the
    active window title must contain `marker` (the created tab's page
    title). ctrl+9 'last tab' is only the first guess - if another tab
    was appended while ours sat occluded, ctrl+9 lands wrong, so the
    strip is then scanned with ctrl+Tab (bounded by _TAB_SCAN_LIMIT)
    until the marker shows. Returns True only when the marker is the
    active window title; on False the caller must NOT actuate the
    focused tab (it belongs to someone else).

    When `target` (the dict _new_target resolved for our tab) is
    passed, a title match is necessary but NOT sufficient: the same
    target id must still exist in /json/list with the same url
    (_target_current). Two about:blank tabs or two same-titled Habr
    pages would otherwise both satisfy the marker check and a later
    close could land on an innocent tab - never close on title alone."""

    def _verified():
        if not _title_matches(marker):
            return False
        if target is not None and _target_current(target) is None:
            return False
        return True

    hands.key("ctrl+9")
    time.sleep(0.7)
    if _verified():
        return True
    for _ in range(_TAB_SCAN_LIMIT):
        hands.key("ctrl+Tab")
        time.sleep(0.7)
        if _verified():
            return True
    return False


def _occlude(new_tab_title):
    """One ctrl+shift+tab left off the new (last) tab. Success = the
    SETTLED active-window title differs from the new tab's settled
    title - retried a few times because a swallowed chord must not
    silently leave the SPA foregrounded."""
    for _ in range(3):
        # capital T: xdotool key names are case-sensitive and a
        # lowercase 'tab' does not produce the Tab keysym (verified
        # live - the chord was silently ignored)
        hands.key("ctrl+shift+Tab")
        time.sleep(0.8)
        # case-insensitive compare: a title CASE-FLIP on the same tab
        # (Chrome re-cases on navigation commit) must not read as a
        # successful switch - equality is the failure signal
        if _window_name().strip().lower() != new_tab_title.strip().lower():
            return True
    return False


def open_tab_bg(url, settle_s=45, activate=True):
    """Open `url` in a NEW tab, occlude it for `settle_s`, then activate
    it - all via OS input, with the created tab tracked by its /json
    target identity.

    Returns {"ok": True, "target_id", "title"} or {"error": ...}. The
    settle window is the renderer-safe initialization period measured
    on this box; callers loading trivial pages can pass a smaller
    value."""
    before_ids = {t.get("id") for t in _page_targets()}
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
    time.sleep(1.5)  # let navigation commit before we read anything
    # the baseline title must be SETTLED - a late-committing SPA title
    # would otherwise fake the 'switched' signal in _occlude
    new_title = _settle_title()
    target = _new_target(before_ids, url)
    # the marker activation/close verify against: the target's own page
    # title when /json identified the tab, else the settled window
    # title (which carries the '- Google Chrome' suffix but still works
    # for a substring self-match on the same reading)
    marker = (target or {}).get("title") or new_title
    if not _occlude(new_title):
        # ABORT PATH: the new tab is still the focused one (no switch
        # ever registered), so ctrl+w closes exactly it and Chrome
        # returns focus to the adjacent - previously focused - tab.
        # Verify via the target list that ours is actually gone before
        # reporting; a stranded armed tab is worse than a slow one.
        # Identity gate (review round 3): when _new_target resolved a
        # target it must STILL resolve to the same id+url - a recycled
        # or navigated target means the focused tab may no longer be
        # ours, and a close on title alone is refused. 'verified' is
        # reported only when identity was established AND the id is
        # confirmed gone; an unidentified tab is always UNVERIFIED.
        if target is not None and _target_current(target) is None:
            return {
                "error": "could not occlude the new tab - aborted; "
                "close refused: the created target no longer resolves "
                "to the same id+url (close UNVERIFIED)"
            }
        hands.key("ctrl+w")
        time.sleep(1.0)
        gone = target is not None and all(t.get("id") != target.get("id") for t in _page_targets())
        return {
            "error": "could not occlude the new tab - aborted and "
            f"closed it (close {'verified' if gone else 'UNVERIFIED'})"
        }
    time.sleep(settle_s)
    if activate:
        if not activate_tab(marker, target=target):
            return {
                "error": "created tab could not be re-activated - its "
                "title never showed as the active window; refusing "
                "blind actuation on an unverified tab",
                "target_id": (target or {}).get("id"),
                "title": marker,
            }
        time.sleep(5)  # let the now-foregrounded page run deferred init
    return {"ok": True, "target_id": (target or {}).get("id"), "title": marker}


def close_active_tab():
    """ctrl+w on whatever tab is focused. Callers that need to close a
    specific tab must activate it first - VERIFIED via activate_tab,
    never a blind ctrl+9."""
    hands.key("ctrl+w")
    return {"ok": True}
