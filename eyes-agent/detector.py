#!/usr/bin/env python3
"""Template-match detector for eyes-agent.

Match a captured image against the exemplar library in templates/.
Exemplar schema lives in templates/manifest.json - only entries with
detect:'template' carry image files; entries like js_dialog declare
detect:'cdp_event' and are handled by dialog_watch (no pixels exist
for a native dialog - honest split: events for JS dialogs, templates
for in-page blockers).

cv2 is already a hands-agent dependency and importable on this box
(4.10.0); no new installs. OCR is an OPTIONAL escalation: pytesseract
is NOT installed here, so ocr() reports {available:false} instead of
hard-requiring it - the MVP runs template-match only per the
determinism directive.
"""

import json
import os

import cv2

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE_DIR = os.path.join(BASE, "templates")

# multi-scale sweep like vision.py - blocker chrome is rendered at
# fixed OS scale, but a shot taken at a different window size shifts
# proportions; +-25% covers the realistic spread
_SCALES = (1.0, 0.9, 1.1, 0.8, 1.25)


def load_manifest(template_dir=DEFAULT_TEMPLATE_DIR):
    path = os.path.join(template_dir, "manifest.json")
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    return [e for e in entries if e.get("detect") == "template" and e.get("file")]


def match(image_path, template_dir=DEFAULT_TEMPLATE_DIR, classes=None):
    """Run cv2.matchTemplate for every template exemplar in the library.

    classes: optional allow-list of blocker classes to try (e.g.
    ['err_page'] when the caller already suspects a navigation error).

    Returns the best hit above the exemplar's own match_threshold:
      {class, confidence, template_id, bbox: [x, y, w, h], scale}
    or None when nothing reaches threshold. Never returns a
    below-threshold 'best effort' - a miss must stay a miss so the
    driver sees 'unidentified' instead of a confident wrong class.
    """
    img = cv2.imread(image_path, 0)
    if img is None:
        return None
    best = None
    for ex in load_manifest(template_dir):
        if classes and ex.get("class") not in classes:
            continue
        tpl_path = os.path.join(template_dir, ex["file"])
        tpl0 = cv2.imread(tpl_path, 0)
        if tpl0 is None:
            continue
        threshold = float(ex.get("match_threshold", 0.85))
        for s in _SCALES:
            tpl = cv2.resize(tpl0, None, fx=s, fy=s)
            if tpl.shape[0] > img.shape[0] or tpl.shape[1] > img.shape[1]:
                continue
            res = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(res)
            if mx >= threshold and (best is None or mx > best["confidence"]):
                h, w = tpl.shape
                best = {
                    "class": ex["class"],
                    "confidence": round(float(mx), 4),
                    "template_id": ex["id"],
                    "bbox": [loc[0], loc[1], w, h],
                    "scale": s,
                }
    return best


def ocr(image_path, region=None):
    """OPTIONAL OCR escalation - reads button/title text in a
    suspicious region when no template matches. NOT required for MVP.

    pytesseract is absent on this box (checked 2026-11-12); the stub
    reports availability honestly instead of crashing the detector
    chain. When present it would run tesseract on `region`
    [x, y, w, h] or the full frame.
    """
    try:
        import pytesseract
    except ImportError:
        return {
            "available": False,
            "reason": "pytesseract not installed - OCR escalation disabled",
        }
    img = cv2.imread(image_path)
    if img is None:
        return {"available": True, "ok": False, "reason": "unreadable image"}
    if region:
        x, y, w, h = region
        img = img[y : y + h, x : x + w]
    text = pytesseract.image_to_string(img)
    return {"available": True, "ok": True, "text": text.strip()}
