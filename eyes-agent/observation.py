#!/usr/bin/env python3
"""Observation schema for eyes-agent (per roadmap PRIORITY-0 spec).

An observation answers exactly one question: "what is on screen / in
the page right now, and how stale is this answer?". Eyes-agent owns
detection ONLY - arbitration (blocker detected vs 'page hung' vs CDP
idle) and all decisions belong to the driver loop.

Schema:
  {
    ts: float,                     # when the observation was produced
    screenshot_ref: str|None,      # path of the captured image (if any)
    capture_method: str|None,      # which capture method produced it
    detected_blocker: {            # null when nothing is detected
      class: str,                  # js_dialog | err_page | overlay | ...
      sub_type: str|None,          # alert|confirm|prompt|beforeunload
      confidence: float,
      source: str,                 # cdp_event | template | ocr
      text: str|None,
    } | None,
    cdp_state: {
      reachable: bool,             # did the page answer CDP at all
      readyState: str|None,
      url: str|None,
      title: str|None,
    },
    generation: int,               # anti-staleness counter, bumps each
                                   # observe(); a driver that holds an
                                   # older generation knows it is stale
  }

Pull model (service shape, next phase): the service keeps a latest
observation + generation per target; the driver asks 'fresher than T?'
instead of blocking on a fresh capture. This library-first spike
exposes observe() as the synchronous probe the pull service will wrap.
"""

import time

import capture
import detector

# Pull model keeps latest observation + generation PER TARGET, so the
# counter is keyed by the observe() selector (url_substr) rather than
# one global sequence - a driver must be able to use generation to
# detect staleness of ITS target, not of an unrelated tab. The
# get/increment pair is only incidentally atomic under the GIL - fine
# for this spike; the threaded service should hold its own per-target
# counter under a lock.
_GENERATIONS = {}


def _cdp_state(url_substr=None):
    """Read-only page state from the /json/list endpoint - the cheap
    channel. Runtime.evaluate (the old readyState probe) is banned by
    the CDP read-only directive, so readyState is no longer available:
    `reachable` now means 'a live page target is listed', and the
    suspended-renderer signal comes from the x_window capture +
    dialog-watch channels instead of an evaluate timeout."""
    import cdp_client

    state = {"reachable": False, "readyState": None, "url": None, "title": None}
    try:
        t = cdp_client.find_page(url_substr) if url_substr else None
        if t is None:
            pages = [x for x in cdp_client.targets() if x.get("type") == "page"]
            t = pages[0] if pages else None
        if t is None:
            return state
        state["url"] = t.get("url")
        state["title"] = t.get("title")
        state["reachable"] = True
    except Exception:  # noqa: BLE001 - an unreachable CDP endpoint is a valid observation
        pass
    return state


def observe(url_substr=None, max_age_ms=None, last=None, methods=None):
    """Produce one observation dict.

    url_substr: selects the CDP target for page-level capture/state.
    max_age_ms + last: pull-model convenience - if `last` (a previous
    observation dict) is fresher than max_age_ms it is returned as-is,
    so a driver can cheaply ask 'fresh enough?' without forcing a new
    capture cycle.
    methods: capture chain subset passthrough (e.g. ['cdp'] to skip
    OS-level paths known-dead on this host).
    """
    if last is not None and max_age_ms is not None:
        if (time.time() - last.get("ts", 0)) * 1000 <= max_age_ms:
            return last

    gen_key = url_substr or "__default__"
    generation = _GENERATIONS.get(gen_key, 0) + 1
    _GENERATIONS[gen_key] = generation

    cdp_state = _cdp_state(url_substr)
    shot = capture.screenshot(source=url_substr, methods=methods)

    blocker = None
    if shot["ok"]:
        hit = detector.match(shot["path"])
        if hit:
            blocker = {
                "class": hit["class"],
                "sub_type": None,
                "confidence": hit["confidence"],
                "source": "template",
                "text": None,
            }

    return {
        "ts": time.time(),
        "screenshot_ref": shot["path"] if shot["ok"] else None,
        "capture_method": shot["method"],
        "detected_blocker": blocker,
        "cdp_state": cdp_state,
        "generation": generation,
        "capture_attempts": shot["attempts"],
    }
