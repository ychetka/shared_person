#!/usr/bin/env python3
"""learn_voice.py - calibrate rubric-lint/voice.json (issue #80).

Measures the sentence-rhythm of OUR OWN human corpus -
fixtures/humanizer/clean_human/{en,ru}.txt - with the vendored
nomisread sentences()/rhythm() pass, and writes the per-language voice
profile the /score burstiness check compares against.

Per-language calibration is deliberate: Russian and English prose have
different sentence-length spreads, and one profile applied to both
would misjudge at least one. voice.json is deterministic output of
this script over committed fixtures - regenerate it whenever the
clean_human corpus changes:

    python3 tools/learn_voice.py            # write rubric-lint/voice.json
    python3 tools/learn_voice.py --check    # exit 1 if it would drift
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "rubric-lint"))

import rubric_lint  # noqa: E402  (engine loads vendor + data itself)
import vendor.nomisread as nomisread  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures", "humanizer", "clean_human")
VOICE_PATH = os.path.join(ROOT, "rubric-lint", "voice.json")


def measure(lang):
    text = open(os.path.join(FIXTURES, lang + ".txt"),
                encoding="utf-8").read()
    body = rubric_lint.mask_body(text)
    sents = nomisread.sentences(body)
    r = nomisread.rhythm(sents)
    if not r.get("measurable"):
        raise SystemExit(
            f"{lang}: only {r.get('sentences', 0)} sentences - "
            "calibration needs >=5; refusing to record noise")
    return {
        "rhythm": {k: r[k] for k in
                   ("mean_words", "stdev_words", "band_share",
                    "shortest", "longest") if k in r},
        "samples": {"files": 1, "words": len(body.split()),
                    "sentences": r["sentences"]},
    }


def main():
    voice = {lang: measure(lang) for lang in ("en", "ru")}
    voice["_meta"] = {
        "source": "tools/learn_voice.py over "
                  "fixtures/humanizer/clean_human/{en,ru}.txt",
        "use": "flat_for_you = stdev_words < rhythm.stdev_words * "
               "FLAT_FOR_YOU (vendored nomisread convention)",
    }
    out = json.dumps(voice, indent=1, ensure_ascii=False,
                     sort_keys=True) + "\n"
    if "--check" in sys.argv:
        cur = ""
        try:
            cur = open(VOICE_PATH, encoding="utf-8").read()
        except OSError:
            pass
        if cur == out:
            print("voice.json is up to date")
            return
        print("voice.json would drift - rerun tools/learn_voice.py")
        raise SystemExit(1)
    with open(VOICE_PATH, "w", encoding="utf-8") as fh:
        fh.write(out)
    for lang in ("en", "ru"):
        r = voice[lang]["rhythm"]
        print(f"{lang}: stdev {r['stdev_words']} words, "
              f"band_share {r['band_share']}, "
              f"{voice[lang]['samples']['sentences']} sentences")
    print("wrote", os.path.relpath(VOICE_PATH, ROOT))


if __name__ == "__main__":
    main()
