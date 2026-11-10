#!/usr/bin/env python3
"""learn_voice.py - calibrate rubric-lint/voice.json (issue #80).

Measures the sentence-rhythm of OUR OWN human corpus with the
vendored nomisread sentences()/rhythm() pass, and writes the
per-language voice profile the /score burstiness check compares
against.

Corpus (round-2 review): fixtures/humanizer/clean_human/{en,ru}.txt
ONLY - the one committed, verifiably human-authored sample this repo
carries. The earlier W7 superset (prompts/, docs/, context/) was
dropped on two grounds: this repo's docs and prompts are AGENT-
written prose, so they were never evidence of a human hand, and
context/ is gitignored, so a voice.json calibrated against it could
not be reproduced on a clean checkout and broke --check in CI. A
thin-but-honest profile beats a fat-but-corrupted one.

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
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "rubric-lint"))

import rubric_lint  # noqa: E402  (engine loads vendor + data itself)
import vendor.nomisread as nomisread  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures", "humanizer", "clean_human")
VOICE_PATH = os.path.join(ROOT, "rubric-lint", "voice.json")
MIN_CAL_SENTENCES = 30


def corpus_files(lang):
    """The committed verifiably-human corpus: the clean_human cell,
    nothing else. prompts/docs are agent prose and context/ is
    gitignored - neither may feed a baseline that has to regenerate
    byte-identically on a clean checkout."""
    return [os.path.join(FIXTURES, lang + ".txt")]


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
                  "fixtures/humanizer/clean_human/{en,ru}.txt - the "
                  "only committed, verifiably human-authored corpus "
                  "in the repo (docs/prompts are agent prose, "
                  "context/ is gitignored)",
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
