#!/usr/bin/env python3
"""learn_voice.py - calibrate rubric-lint/voice.json (issue #80).

Measures the sentence-rhythm of OUR OWN human corpus with the
vendored nomisread sentences()/rhythm() pass, and writes the
per-language voice profile the /score burstiness check compares
against.

Corpus (W7 - one fixture file is too thin for a voice profile):
  * fixtures/humanizer/clean_human/{en,ru}.txt - the labelled-human
    cells, always present;
  * every *.txt/*.md under prompts/, docs/ and context/ that reads as
    human-authored - developer-written prompts and spec prose are the
    largest honest sample of this author's unassisted writing the repo
    carries. A file joins the RU pool when >=30% of its letters are
    Cyrillic, else EN.

Per-language calibration is deliberate: Russian and English prose
have different sentence-length spreads, and one profile applied to
both would misjudge at least one. voice.json is deterministic output
of this script over committed files - regenerate it whenever the
corpus changes:

    python3 tools/learn_voice.py            # write rubric-lint/voice.json
    python3 tools/learn_voice.py --check    # exit 1 if it would drift

A corpus under ~30 sentences is recorded with thin_calibration:true
and printed as a warning - a profile learned from too little is a
guess that gets applied silently, so the record must say how much
writing it actually saw.
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "rubric-lint"))

import rubric_lint  # noqa: E402  (engine loads vendor + data itself)
import vendor.nomisread as nomisread  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures", "humanizer", "clean_human")
EXTRA_DIRS = ("prompts", "docs", "context")
EXTRA_EXT = (".txt", ".md")
VOICE_PATH = os.path.join(ROOT, "rubric-lint", "voice.json")
MIN_CAL_SENTENCES = 30

_CYR = re.compile(r"[а-яё]", re.I)
_LAT = re.compile(r"[a-z]", re.I)


def _lang_of(text):
    cyr = len(_CYR.findall(text))
    lat = len(_LAT.findall(text))
    return "ru" if cyr >= 0.3 * (cyr + lat) else "en"


def corpus_files(lang):
    """clean_human cell first, then the repo's human-authored prose."""
    files = [os.path.join(FIXTURES, lang + ".txt")]
    for d in EXTRA_DIRS:
        root = os.path.join(ROOT, d)
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for name in names:
            if not name.endswith(EXTRA_EXT):
                continue
            p = os.path.join(root, name)
            try:
                if _lang_of(open(p, encoding="utf-8").read()) == lang:
                    files.append(p)
            except OSError:
                continue
    return files


def measure(lang):
    sents = []
    words = 0
    files = []
    for path in corpus_files(lang):
        try:
            body = rubric_lint.prose_body(
                open(path, encoding="utf-8").read())
        except OSError:
            continue
        sents.extend(nomisread.sentences(body))
        words += len(body.split())
        files.append(os.path.relpath(path, ROOT))
    r = nomisread.rhythm(sents)
    if not r.get("measurable"):
        raise SystemExit(
            f"{lang}: only {r.get('sentences', 0)} sentences - "
            "calibration needs >=5; refusing to record noise")
    return {
        "rhythm": {k: r[k] for k in
                   ("mean_words", "stdev_words", "band_share",
                    "shortest", "longest") if k in r},
        "samples": {"files": len(files), "words": words,
                    "sentences": r["sentences"],
                    "thin_calibration": r["sentences"] < MIN_CAL_SENTENCES,
                    "sources": files},
    }


def main():
    voice = {lang: measure(lang) for lang in ("en", "ru")}
    voice["_meta"] = {
        "source": "tools/learn_voice.py over "
                  "fixtures/humanizer/clean_human/{en,ru}.txt plus "
                  "human-authored *.txt/*.md in prompts/, docs/, "
                  "context/ (per-language by cyrillic share)",
        "use": "flat_for_you = stdev_words < rhythm.stdev_words * "
               "FLAT_FOR_YOU (vendored nomisread convention)",
    }
    out = json.dumps(voice, indent=1, ensure_ascii=False,
                     sort_keys=True) + "\n"
    thin = [lang for lang in ("en", "ru")
            if voice[lang]["samples"]["thin_calibration"]]
    if thin:
        print(f"WARNING: thin calibration for {', '.join(thin)} - "
              f"corpus under {MIN_CAL_SENTENCES} sentences; the "
              "recorded profile is a small-sample estimate",
              file=sys.stderr)
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
              f"{voice[lang]['samples']['sentences']} sentences over "
              f"{voice[lang]['samples']['files']} files")
    print("wrote", os.path.relpath(VOICE_PATH, ROOT))


if __name__ == "__main__":
    main()
