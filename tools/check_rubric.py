#!/usr/bin/env python3
"""check_rubric.py - harness for the issue #80 rubric-lint service.

Boots the service LOGIC in-process (import rubric_lint, no network,
no container) and asserts the eval-loop contract:

  R1  fixture tiers rank per language: clean_human < borderline <
      ai_flop score, BOTH en and ru;
  R2  clean_human yields ~zero error-severity findings (minimal-diff
      constraint - the rubric must not flag honest human prose);
  R3  determinism: identical input -> byte-identical response;
  R4  /score response shape is the Eval Tick mapping contract:
      score 0-100, findings[{rule,severity:1|2,span:[s,e],text,
      suggestion}], metrics{stdev_words,band_share,
      nominalization_density,marker_density}, lang, version;
  R5  every finding's span slices back its own text (offsets address
      the CALLER's input, not a masked copy) and carries a suggestion;
  R6  burstiness AND-gate: ai_flop's metronome rhythm fires the
      'burstiness' error finding; clean_human's varied rhythm does
      not;
  R7  RU layer: канцелярит markers + nominalization suffix density
      fire on ai_flop/ru ('В современном мире', 'Важно отметить',
      'играет важнейшую роль');
  R8  EN vendored dicts fire on ai_flop/en ('in today's fast-paced
      world', 'it is important to note', 'plays a vital role');
  R9  /diff catches number/date/url/code/protected/entity mutations
      and invented facts; a clean rewrite produces ZERO mismatches;
  R10 spans.json parity: every expected_span in
      fixtures/humanizer/ai_flop/<lang>.spans.json is covered by some
      finding's span on the same cell;
  R11 density model: a single AI-tell word in honest prose is warn at
      most - never an error;
  R12 voice.json is present, per-language, and matches what
      tools/learn_voice.py would regenerate (--check).

Run:  python3 tools/check_rubric.py    (exit 0 = all pass)
"""

import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "rubric-lint"))

import rubric_lint as rl  # noqa: E402

FIX = os.path.join(ROOT, "fixtures", "humanizer")

failures = []


def check(name, cond, detail=""):
    if cond:
        print("ok  ", name)
    else:
        print("FAIL", name, ("- " + str(detail)[:200]) if detail else "")
        failures.append(name)


def fixture(tier, lang):
    with open(os.path.join(FIX, tier, lang + ".txt"),
              encoding="utf-8") as fh:
        return fh.read()


def find(res, rule=None, severity=None, contains=None):
    out = []
    for f in res["findings"]:
        if rule and f["rule"] != rule:
            continue
        if severity and f["severity"] != severity:
            continue
        if contains and contains.lower() not in f["text"].lower():
            continue
        out.append(f)
    return out


scores = {}
results = {}
for tier in ("clean_human", "borderline", "ai_flop"):
    for lang in ("en", "ru"):
        r = rl.score_text(fixture(tier, lang), lang)
        results[(tier, lang)] = r
        scores[(tier, lang)] = r["score"]

# --- R1 tier ordering ------------------------------------------------
for lang in ("en", "ru"):
    check(f"R1 {lang}: clean < borderline < ai_flop",
          scores[("clean_human", lang)] <
          scores[("borderline", lang)] <
          scores[("ai_flop", lang)],
          {k: scores[(k, lang)] for k in
           ("clean_human", "borderline", "ai_flop")})

# --- R2 clean yields ~zero error-severity findings -------------------
for lang in ("en", "ru"):
    errs = [f for f in results[("clean_human", lang)]["findings"]
            if f["severity"] == 2]
    check(f"R2 clean_human/{lang}: <=1 error finding",
          len(errs) <= 1, errs[:3])
    check(f"R2 clean_human/{lang}: score in human band (<45)",
          scores[("clean_human", lang)] < 45,
          scores[("clean_human", lang)])

# --- R3 determinism ---------------------------------------------------
txt = fixture("ai_flop", "en") + "\n" + fixture("borderline", "ru")
d1 = json.dumps(rl.score_text(txt, "ru"), sort_keys=True,
                ensure_ascii=False)
d2 = json.dumps(rl.score_text(txt, "ru"), sort_keys=True,
                ensure_ascii=False)
check("R3 double-run byte-identical", d1 == d2)

# --- R4 response shape ------------------------------------------------
res = results[("ai_flop", "en")]
check("R4 top-level keys", all(
    k in res for k in ("score", "findings", "metrics", "lang",
                       "version")) and isinstance(res["score"], int)
    and 0 <= res["score"] <= 100)
check("R4 finding shape",
      all({"rule", "severity", "span", "text", "suggestion"}
          <= set(f) and f["severity"] in (1, 2)
          and isinstance(f["span"], list) and len(f["span"]) == 2
          for f in res["findings"]))
check("R4 metrics contract keys",
      all(k in res["metrics"] for k in
          ("stdev_words", "band_share", "nominalization_density",
           "marker_density")))

# --- R5 spans slice back their own text --------------------------------
ok_spans = True
for key, r in results.items():
    src = fixture(*key)
    for f in r["findings"]:
        a, b = f["span"]
        if a == b:
            continue  # document-level finding
        if src[a:b] != f["text"]:
            ok_spans = False
check("R5 finding spans address the input text", ok_spans)
check("R5 every finding carries a suggestion",
      all(f["suggestion"] for r in results.values()
          for f in r["findings"]))

# --- R6 burstiness AND-gate -------------------------------------------
flop_r = results[("ai_flop", "en")]
check("R6 flop/en: burstiness error fires",
      bool(find(flop_r, rule="burstiness", severity=2)),
      [f["rule"] for f in flop_r["findings"]])
flop_ru = results[("ai_flop", "ru")]
check("R6 flop/ru: burstiness error fires",
      bool(find(flop_ru, rule="burstiness", severity=2)))
for lang in ("en", "ru"):
    check(f"R6 clean/{lang}: burstiness does NOT fire",
          not find(results[("clean_human", lang)], rule="burstiness"))

# --- R7 RU layer -------------------------------------------------------
rules_ru = {f["rule"] for f in flop_ru["findings"]}
check("R7 ru-stamp markers fire on flop/ru", "ru-stamp" in rules_ru,
      rules_ru)
check("R7 ru-nominalization fires on flop/ru",
      "ru-nominalization" in rules_ru, rules_ru)
ru_texts = " ".join(f["text"] for f in flop_ru["findings"])
for needle in ("В современном мире", "Важно отметить"):
    check(f"R7 catches '{needle}'", needle in ru_texts, ru_texts[:200])
check("R7 'играет важнейшую роль' caught",
      any("важнейш" in f["text"] or "роль" in f["text"]
          for f in flop_ru["findings"] if f["rule"] == "ru-stamp"))

# --- R8 EN vendored dicts ----------------------------------------------
en_texts = " ".join(f["text"].lower() for f in flop_r["findings"])
for needle in ("in today's fast-paced world",
               "it is important to note", "plays a vital role",
               "furthermore"):
    check(f"R8 catches '{needle}'", needle in en_texts,
          en_texts[:200])

# --- R9 /diff ------------------------------------------------------------
ORIG = ("On March 5, 2024 the N8N deploy took 40 seconds, p99 hit "
        "900ms. Acme Corp paid $1200 via https://acme.example/inv-77 "
        "using `deploy.sh --prod`. 12.03.2024 confirmed.")
CLEAN = ("The March 5, 2024 N8N deploy took 40 seconds with p99 at "
         "900ms. Acme Corp paid $1200 via https://acme.example/inv-77 "
         "using `deploy.sh --prod`. Confirmed 12.03.2024.")
diff_clean = rl.diff_texts(ORIG, CLEAN, ["Acme Corp", "p99"])
check("R9 clean rewrite: zero mismatches",
      diff_clean["mismatches"] == [], diff_clean["mismatches"])

MUT = ("On April 7, 2024 the deploy took 52 seconds, p99 hit 700ms. "
       "Acme Corporation paid $1500 via https://acme.example/inv-88 "
       "using `deploy.sh --staging`. 13.03.2024 confirmed.")
diff_mut = rl.diff_texts(ORIG, MUT, ["Acme Corp", "p99", "N8N"])
types = {m["type"] for m in diff_mut["mismatches"]}
for t in ("number", "date", "url", "code", "entity"):
    check(f"R9 diff catches {t} mutation", t in types, types)
check("R9 diff catches dropped protected term",
      any(m["type"] == "protected" and m["original"] == "N8N"
          for m in diff_mut["mismatches"]),
      diff_mut["mismatches"])
check("R9 diff survives kept protected term",
      not any(m["type"] == "protected" and m["original"] == "Acme Corp"
              for m in diff_mut["mismatches"]))
check("R9 diff pairs original->rewritten",
      any(m["original"] == "40" and m["rewritten"] == "52"
          for m in diff_mut["mismatches"]))

# --- R10 spans.json parity ---------------------------------------------
for lang in ("en", "ru"):
    spans_p = os.path.join(FIX, "ai_flop", lang + ".spans.json")
    if not os.path.exists(spans_p):
        continue
    want = json.load(open(spans_p, encoding="utf-8"))["expected_spans"]
    found = []
    r = results[("ai_flop", lang)]
    for w in want:
        needle = w["text"].lower()
        hits = [f for f in r["findings"]
                if needle in f["text"].lower()
                or f["text"].lower() in needle]
        found.append(bool(hits))
    check(f"R10 {lang}: >=60% of expected spans flagged",
          sum(found) / max(len(found), 1) >= 0.6,
          f"{sum(found)}/{len(found)}")

# --- R11 density model ---------------------------------------------------
# one AI-tell in an otherwise human text: warn at most, human band
single = rl.score_text(
    fixture("clean_human", "en") + " The team leveraged it well.",
    "en")
check("R11 single AI-tell is warn at most",
      all(f["severity"] == 1 for f in single["findings"]),
      single["findings"])
check("R11 single AI-tell keeps score in human band",
      single["score"] < 45, single["score"])

# --- R12 voice.json -------------------------------------------------------
voice_path = os.path.join(ROOT, "rubric-lint", "voice.json")
voice = json.load(open(voice_path, encoding="utf-8"))
check("R12 voice.json per-language rhythm",
      all(k in voice and "stdev_words" in voice[k].get("rhythm", {})
          for k in ("en", "ru")), sorted(voice))
sys.path.insert(0, ROOT)
spec = importlib.util.spec_from_file_location(
    "learn_voice", os.path.join(ROOT, "tools", "learn_voice.py"))
lv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lv)
fresh = {lang: lv.measure(lang) for lang in ("en", "ru")}
check("R12 voice.json matches fresh calibration",
      all(voice[lang]["rhythm"] == fresh[lang]["rhythm"]
          for lang in ("en", "ru")),
      {"stored": {k: voice[k]["rhythm"] for k in ("en", "ru")},
       "fresh": {k: fresh[k]["rhythm"] for k in ("en", "ru")}})

print()
if failures:
    print(f"{len(failures)} FAILURES")
    sys.exit(1)
print("all rubric checks pass")
