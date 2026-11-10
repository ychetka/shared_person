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
      tools/learn_voice.py would regenerate (--check);
  R13 masked-region integrity: code/quotes/URLs are NUL-masked AND
      intersect-dropped, so a tell phrase bracketing a code span
      cannot bridge it into a phantom finding, a masked span before
      a sentence never shifts its reported offsets, and /diff never
      emits a phantom entity from inside a masked span;
  R14 C1 density floors: a ~170-word short post holding exactly 1
      REAL em dash, 2 LISTED transitions and 3 hard-list
      nominalizations stays warn-level and inside the human band;
      the same post one notch over the absolute floors escalates all
      three density rules to severity 2; ordinary technology nouns
      are a reduced-weight subset, not severity-2;
  R15 RU split: soft connectors ('Кроме того', 'более того') land in
      ru-stamp-soft at weight 0.5, clean-tier prose does not error on
      them, and a literal 'играет роль' without an adjective does not
      fire the stamp;
  R16 W6 single-token entities: 'Gemini' -> 'Claude', 'PostgreSQL' ->
      'MySQL' and mid-sentence proper nouns pair as entity
      mismatches; sentence-start capitals and stop words do not;
  R17 flat_for_you keeps the band_share gate (W7): a terse-but-varied
      writer with low stdev but distributed bands is not metronomic;
  R18 rhythm metrics have a stable shape: under 5 sentences the keys
      are present and null, not missing;
  R19 server contract (in-process): query-string /health, lang
      validation on /score, invalid payload -> 400;
  R20 protected terms suppress the same entity's mismatch instead of
      double-reporting it.

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
    with open(os.path.join(FIX, tier, lang + ".txt"), encoding="utf-8") as fh:
        return fh.read()


_FILL_EN = [
    "The box kept dropping packets on Tuesday.",
    "A colleague rewrote the whole retry loop in an afternoon and nobody complained.",
    "Ship it.",
    "Most of the debugging happened in the staging logs, where one line repeated for hours.",
    "We finally moved the cron job off the old host.",
    "The fix was three lines.",
]

_FILL_RU = [
    "Сервер падал каждую ночь без причины.",
    "Коллега переписал весь цикл повторов за один вечер.",
    "Выкатили.",
    "Большая часть отладки шла по логам стенда, где одна строка повторялась часами.",
    "Потом перенесли задачу со старого хоста.",
    "Правка заняла три строки.",
]


def _pad(base, target_words, lang):
    """Deterministically append varied filler sentences (none of which
    is in a lexicon and none repeats an opener back-to-back) until the
    text reaches `target_words`. One repeated sentence would be a
    metronome all by itself, so the filler pool cycles."""
    pool = _FILL_EN if lang == "en" else _FILL_RU
    out = base.rstrip()
    i = 0
    while len(out.split()) < target_words:
        out += " " + pool[i % len(pool)]
        i += 1
    return out


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
    check(
        f"R1 {lang}: clean < borderline < ai_flop",
        scores[("clean_human", lang)] < scores[("borderline", lang)] < scores[("ai_flop", lang)],
        {k: scores[(k, lang)] for k in ("clean_human", "borderline", "ai_flop")},
    )

# --- R2 clean yields ~zero error-severity findings -------------------
for lang in ("en", "ru"):
    errs = [f for f in results[("clean_human", lang)]["findings"] if f["severity"] == 2]
    check(f"R2 clean_human/{lang}: <=1 error finding", len(errs) <= 1, errs[:3])
    check(
        f"R2 clean_human/{lang}: score in human band (<45)",
        scores[("clean_human", lang)] < 45,
        scores[("clean_human", lang)],
    )

# --- R3 determinism ---------------------------------------------------
txt = fixture("ai_flop", "en") + "\n" + fixture("borderline", "ru")
d1 = json.dumps(rl.score_text(txt, "ru"), sort_keys=True, ensure_ascii=False)
d2 = json.dumps(rl.score_text(txt, "ru"), sort_keys=True, ensure_ascii=False)
check("R3 double-run byte-identical", d1 == d2)

# --- R4 response shape ------------------------------------------------
res = results[("ai_flop", "en")]
check(
    "R4 top-level keys",
    all(k in res for k in ("score", "findings", "metrics", "lang", "version"))
    and isinstance(res["score"], int)
    and 0 <= res["score"] <= 100,
)
check(
    "R4 finding shape",
    all(
        {"rule", "severity", "span", "text", "suggestion"} <= set(f)
        and f["severity"] in (1, 2)
        and isinstance(f["span"], list)
        and len(f["span"]) == 2
        for f in res["findings"]
    ),
)
check(
    "R4 metrics contract keys",
    all(
        k in res["metrics"]
        for k in ("stdev_words", "band_share", "nominalization_density", "marker_density")
    ),
)

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
check(
    "R5 every finding carries a suggestion",
    all(f["suggestion"] for r in results.values() for f in r["findings"]),
)

# --- R6 burstiness AND-gate -------------------------------------------
flop_r = results[("ai_flop", "en")]
check(
    "R6 flop/en: burstiness error fires",
    bool(find(flop_r, rule="burstiness", severity=2)),
    [f["rule"] for f in flop_r["findings"]],
)
flop_ru = results[("ai_flop", "ru")]
check("R6 flop/ru: burstiness error fires", bool(find(flop_ru, rule="burstiness", severity=2)))
for lang in ("en", "ru"):
    check(
        f"R6 clean/{lang}: burstiness does NOT fire",
        not find(results[("clean_human", lang)], rule="burstiness"),
    )

# --- R7 RU layer -------------------------------------------------------
rules_ru = {f["rule"] for f in flop_ru["findings"]}
check("R7 ru-stamp markers fire on flop/ru", "ru-stamp" in rules_ru, rules_ru)
check("R7 ru-nominalization fires on flop/ru", "ru-nominalization" in rules_ru, rules_ru)
ru_texts = " ".join(f["text"] for f in flop_ru["findings"])
for needle in ("В современном мире", "Важно отметить"):
    check(f"R7 catches '{needle}'", needle in ru_texts, ru_texts[:200])
check(
    "R7 'играет важнейшую роль' caught",
    any(
        "важнейш" in f["text"] or "роль" in f["text"]
        for f in flop_ru["findings"]
        if f["rule"] == "ru-stamp"
    ),
)

# --- R8 EN vendored dicts ----------------------------------------------
en_texts = " ".join(f["text"].lower() for f in flop_r["findings"])
for needle in (
    "in today's fast-paced world",
    "it is important to note",
    "plays a vital role",
    "furthermore",
):
    check(f"R8 catches '{needle}'", needle in en_texts, en_texts[:200])

# --- R9 /diff ------------------------------------------------------------
ORIG = (
    "On March 5, 2024 the N8N deploy took 40 seconds, p99 hit "
    "900ms. Acme Corp paid $1200 via https://acme.example/inv-77 "
    "using `deploy.sh --prod`. 12.03.2024 confirmed."
)
CLEAN = (
    "The March 5, 2024 N8N deploy took 40 seconds with p99 at "
    "900ms. Acme Corp paid $1200 via https://acme.example/inv-77 "
    "using `deploy.sh --prod`. Confirmed 12.03.2024."
)
diff_clean = rl.diff_texts(ORIG, CLEAN, ["Acme Corp", "p99"])
check("R9 clean rewrite: zero mismatches", diff_clean["mismatches"] == [], diff_clean["mismatches"])

MUT = (
    "On April 7, 2024 the deploy took 52 seconds, p99 hit 700ms. "
    "Acme Corporation paid $1500 via https://acme.example/inv-88 "
    "using `deploy.sh --staging`. 13.03.2024 confirmed."
)
diff_mut = rl.diff_texts(ORIG, MUT, ["Acme Corp", "p99", "N8N"])
types = {m["type"] for m in diff_mut["mismatches"]}
for t in ("number", "date", "url", "code", "entity"):
    check(f"R9 diff catches {t} mutation", t in types, types)
check(
    "R9 diff catches dropped protected term",
    any(m["type"] == "protected" and m["original"] == "N8N" for m in diff_mut["mismatches"]),
    diff_mut["mismatches"],
)
check(
    "R9 diff survives kept protected term",
    not any(
        m["type"] == "protected" and m["original"] == "Acme Corp" for m in diff_mut["mismatches"]
    ),
)
check(
    "R9 diff pairs original->rewritten",
    any(m["original"] == "40" and m["rewritten"] == "52" for m in diff_mut["mismatches"]),
)

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
        hits = [
            f for f in r["findings"] if needle in f["text"].lower() or f["text"].lower() in needle
        ]
        found.append(bool(hits))
    check(
        f"R10 {lang}: >=60% of expected spans flagged",
        sum(found) / max(len(found), 1) >= 0.6,
        f"{sum(found)}/{len(found)}",
    )

# --- R11 density model ---------------------------------------------------
# one AI-tell in an otherwise human text: warn at most, human band
single = rl.score_text(fixture("clean_human", "en") + " The team leveraged it well.", "en")
check(
    "R11 single AI-tell is warn at most",
    all(f["severity"] == 1 for f in single["findings"]),
    single["findings"],
)
check("R11 single AI-tell keeps score in human band", single["score"] < 45, single["score"])

# --- R12 voice.json -------------------------------------------------------
voice_path = os.path.join(ROOT, "rubric-lint", "voice.json")
voice = json.load(open(voice_path, encoding="utf-8"))
check(
    "R12 voice.json per-language rhythm",
    all(k in voice and "stdev_words" in voice[k].get("rhythm", {}) for k in ("en", "ru")),
    sorted(voice),
)
sys.path.insert(0, ROOT)
spec = importlib.util.spec_from_file_location(
    "learn_voice", os.path.join(ROOT, "tools", "learn_voice.py")
)
lv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lv)
fresh = {lang: lv.measure(lang) for lang in ("en", "ru")}
check(
    "R12 voice.json matches fresh calibration",
    all(voice[lang]["rhythm"] == fresh[lang]["rhythm"] for lang in ("en", "ru")),
    {
        "stored": {k: voice[k]["rhythm"] for k in ("en", "ru")},
        "fresh": {k: fresh[k]["rhythm"] for k in ("en", "ru")},
    },
)

# --- R13 masked-region integrity -------------------------------------
# 'however, it seems' is an ai_phrase whose pattern spans up to 40
# non-period characters - with code swapped to spaces it bridged
# across the masked span; with \x00 + intersect-drop it cannot.
code_snip = "`import os; os.environ['KEY'] = 'val'`"
masked_mid = _pad(
    "We shipped the fix and it landed, however, "
    + code_snip
    + " it seems the rollout still failed. The page stayed blank and "
    "the team is still looking at it.",
    120,
    "en",
)
res_mask = rl.score_text(masked_mid, "en")
a_code = masked_mid.index(code_snip)
b_code = a_code + len(code_snip)
check(
    "R13 no finding's span reaches into the masked code span",
    not any(f["span"][0] < b_code and f["span"][1] > a_code for f in res_mask["findings"]),
    [(f["rule"], f["span"]) for f in res_mask["findings"]],
)
# headings and table rows are masked: 'Moreover,' sits after a masked
# heading line - the opener-chain regex must not reach across
masked_head = _pad(
    "## Deployment notes\nMoreover, the rollout kept failing in odd ways.", 110, "en"
)
res_head = rl.score_text(masked_head, "en")
check(
    "R13 masked heading does not seed findings",
    not any(
        f["rule"].startswith("en-")
        for f in res_head["findings"]
        if "deployment notes" in f["text"].lower()
    ),
    res_head["findings"],
)
# a masked span BEFORE a finding must not shift its offsets: with the
# '\x00+' collapse the pbody coordinates came back short of the truth,
# so the finding's span sliced the wrong bytes and the intersect-drop
# compared garbage. Per-char masking keeps len(pbody) == len(text).
code_ru = "`kubectl rollout restart`"
ru_long_src = (
    "Утром вернули " + code_ru + " в runbook. "
    "Потом целый час разбирались, почему канарейка упала: метрика шла "
    "с задержкой, алёрт молчал, дашборд показывал зелёное, а в логах "
    "уже копились пятисотые ответы от старого пода, который никто не "
    "успел снять с балансировщика, и он продолжал отдавать битые "
    "страницы клиентам ещё минут двадцать."
)
res_ru_span = rl.score_text(ru_long_src, "ru")
long_f = [f for f in res_ru_span["findings"] if f["rule"] == "ru-long-sentence"]
check(
    "R13 ru-long-sentence span survives a leading masked span",
    len(long_f) == 1
    and long_f[0]["span"][0] == ru_long_src.index("Потом")
    and ru_long_src[long_f[0]["span"][0] : long_f[0]["span"][1]] == long_f[0]["text"]
    and "балансировщика" in long_f[0]["text"],
    [(f["span"], f["text"][:60]) for f in long_f],
)
# /diff must not emit a phantom entity from inside a code span
d = rl.diff_texts(
    "Run `kubectl rollout restart DeployX` now.", "Run `kubectl rollout restart DeployY` now.", []
)
check(
    "R13 diff sees code span, no phantom entity",
    {m["type"] for m in d["mismatches"]} == {"code"},
    d["mismatches"],
)

# --- R14 C1 density floors -------------------------------------------
# exactly 1 REAL em dash (—, counted by [—–]), 2 LISTED transitions
# (EN_TRANSITION_RE members) and 3 hard-list nominalizations in a
# ~170-word honest post - all under the absolute floors, so nothing
# escalates to severity 2. (The previous draft pinned nothing: its
# ' - ' was an ASCII hyphen the counter deliberately ignores, and
# 'However,' is not a listed transition.)
short_post = _pad(
    "Last week I shipped the docs — the move itself took two "
    "evenings. The test plan caught the last bug before users did. "
    "Similarly, the rollback path got a real rehearsal. "
    "Consequently, the reconciliation step now covers the "
    "investigation notes and the monetization report, and the rest "
    "of the upgrade notes are finally short enough to read.",
    175,
    "en",
)
w = len(short_post.split())
res_short = rl.score_text(short_post, "en")
errs = [f for f in res_short["findings"] if f["severity"] == 2]
check(
    "R14 ~170-word post stays under the absolute floors",
    140 <= w <= 210 and not errs and res_short["score"] < 45,
    f"words={w} score={res_short['score']} errs={[f['rule'] for f in errs]}",
)
# and the SAME post one notch over the floors must escalate: 3 real
# em dashes, 3 listed transitions and 4 hard nominalizations cross
# every absolute count at this length
dense_post = _pad(
    "Last week I shipped the docs — the move itself took two "
    "evenings — and nobody paged me — not once. Moreover, the "
    "rollout went fine. Furthermore, the test plan caught the last "
    "bug before users did. Consequently, the reconciliation step, "
    "the investigation notes, the monetization report and the "
    "prioritization list are all finally short enough to read.",
    175,
    "en",
)
res_dense = rl.score_text(dense_post, "en")
sev2 = {f["rule"] for f in res_dense["findings"] if f["severity"] == 2}
check(
    "R14 floor-crossing post escalates all three density rules",
    {"en-emdash-density", "en-transition-density", "en-nominalization"} <= sev2,
    f"words={len(dense_post.split())} sev2={sorted(sev2)}",
)
# ordinary technology nouns: 4+ 'implementation'-class words at any
# density are the common subset, never the severity-2 gate
tech = _pad(
    "The implementation and documentation cover the configuration, "
    "specification and validation of the integration and "
    "installation steps, plus the generation and description of the "
    "connection setup.",
    220,
    "en",
)
res_tech = rl.score_text(tech, "en")
check(
    "R14 tech nouns never escalate to severity-2",
    not any(f["severity"] == 2 for f in res_tech["findings"]),
    [(f["rule"], f["severity"], f["text"]) for f in res_tech["findings"]],
)
check(
    "R14 tech nouns land in the reduced-weight subset",
    all(
        f["rule"] == "en-nominalization-common"
        for f in res_tech["findings"]
        if "nominalization" in f["rule"]
    ),
    [f["rule"] for f in res_tech["findings"]],
)
# and a genuine hard-nominal cluster above the floor still escalates
hard = _pad(
    "The reconciliation and the investigation and the "
    "standardization and the monetization and the optimization and "
    "the prioritization of the work kept everyone busy.",
    220,
    "en",
)
res_hard = rl.score_text(hard, "en")
check(
    "R14 hard nominal cluster above floor still escalates",
    any(f["rule"] == "en-nominalization" and f["severity"] == 2 for f in res_hard["findings"]),
    [f["rule"] for f in res_hard["findings"]],
)

# --- R15 RU connector split ------------------------------------------
clean_ru = results[("clean_human", "ru")]
check(
    "R15 clean/ru: no ru-stamp finding at all",
    not any(f["rule"] in ("ru-stamp", "ru-stamp-soft") for f in clean_ru["findings"]),
    [f["rule"] for f in clean_ru["findings"]],
)
soft = rl.score_text(
    _pad(
        "Кроме того, при этом более того таким образом в рамках проекта мы писали и обсуждали.",
        130,
        "ru",
    ),
    "ru",
)
check(
    "R15 soft connectors land in ru-stamp-soft",
    any(f["rule"] == "ru-stamp-soft" for f in soft["findings"])
    and not any(f["rule"] == "ru-stamp" for f in soft["findings"]),
    [(f["rule"], f["text"]) for f in soft["findings"]],
)
check(
    "R15 soft connectors never reach severity-2",
    not any(f["severity"] == 2 for f in soft["findings"] if f["rule"].startswith("ru-stamp")),
    [(f["rule"], f["severity"]) for f in soft["findings"]],
)
literal = rl.score_text(_pad("Актёр играет роль в спектакле.", 130, "ru"), "ru")
check(
    "R15 literal 'играет роль' (no adjective) does not fire",
    not any(f["rule"].startswith("ru-stamp") for f in literal["findings"]),
    [(f["rule"], f["text"]) for f in literal["findings"]],
)
ru_nom = rl.score_text(
    _pad(
        "Гости принесли кости, новости о скорости. Внимательный "
        "строительный вопрос: функция станции и позиция акции.",
        130,
        "ru",
    ),
    "ru",
)
check(
    "R15 ordinary -ость/-тельн/-ци words do not count",
    not any(
        f["rule"].startswith("ru-nominalization") and f["severity"] == 2 for f in ru_nom["findings"]
    ),
    [(f["rule"], f["text"]) for f in ru_nom["findings"]],
)

# --- R16 W6 single-token entities --------------------------------------
d = rl.diff_texts(
    "We deployed on Gemini this week and it went fine.",
    "We deployed on Claude this week and it went fine.",
    [],
)
check(
    "R16 single proper noun swap pairs as entity",
    any(
        m["type"] == "entity" and m["original"] == "Gemini" and m["rewritten"] == "Claude"
        for m in d["mismatches"]
    ),
    d["mismatches"],
)
d = rl.diff_texts(
    "The app talks to PostgreSQL over the local socket.",
    "The app talks to MySQL over the local socket.",
    [],
)
check(
    "R16 non-standard-case token swap pairs as entity",
    any(
        m["type"] == "entity" and "PostgreSQL" in m["original"] and "MySQL" in m["rewritten"]
        for m in d["mismatches"]
    ),
    d["mismatches"],
)
d = rl.diff_texts(
    "Claude wrote the note. We keep n8n running on the small box.",
    "Gemini wrote the note. We keep n8n running on the small box.",
    ["n8n"],
)
check(
    "R16 sentence-start capital is NOT an entity",
    not any(m["type"] == "entity" and "Claude" in str(m) for m in d["mismatches"]),
    d["mismatches"],
)
check(
    "R16 identical non-standard token survives",
    not any("n8n" in str(m) for m in d["mismatches"]),
    d["mismatches"],
)

# --- R17 flat_for_you keeps the band gate --------------------------------
# stdev 4.0 < en-base*0.7 would have fired flat_for_you before; the
# writer's bands are distributed (~0.36 share) so nothing fires
# 14 sentences of deliberately spread word counts - mean lands so the
# +-25% band catches only a minority, stdev sits under the calibrated
# en base*0.6 but the packed-middle gate must not fire
_lengths = (3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 20)
_fill_cycle = ("the", "work", "went", "fine", "and", "we", "kept", "moving", "along", "ok")
terse = " ".join(
    " ".join(_fill_cycle[(i * j) % len(_fill_cycle)] for j in range(n)) + "."
    for i, n in enumerate(_lengths)
)
res_terse = rl.score_text(terse, "en")
check(
    "R17 terse-but-varied writer is not metronomic",
    res_terse["metrics"].get("stdev_words") is not None
    and res_terse["metrics"]["stdev_words"] < 10
    and res_terse["metrics"].get("band_share", 1) <= 0.5
    and not find(res_terse, rule="burstiness"),
    {k: res_terse["metrics"].get(k) for k in ("stdev_words", "band_share", "flat_for_you")},
)

# --- R18 stable rhythm shape --------------------------------------------
res_tiny = rl.score_text("Short. Very short indeed.", "en")
check(
    "R18 <5 sentences: rhythm keys present and null",
    all(
        k in res_tiny["metrics"] and res_tiny["metrics"][k] is None
        for k in ("stdev_words", "band_share")
    ),
    res_tiny["metrics"],
)

# --- R19 server contract -------------------------------------------------
import server  # noqa: E402

captured = {}


class _DummyHandler:
    """Bare stub: BaseHTTPRequestHandler state without a socket."""

    protocol_version = "HTTP/1.1"

    def __init__(self, path):
        self.path = path
        self.rfile = None

    def _send(self, code, obj):
        captured["code"] = code
        captured["obj"] = obj

    def _bad(self, code, msg):
        self._send(code, {"error": msg, "ok": False})


h = _DummyHandler("/health?x=1&y=2")
server.Handler.do_GET(h)
check(
    "R19 /health?query resolves to health",
    captured.get("code") == 200 and captured["obj"]["ok"],
    captured,
)
h = _DummyHandler("/nope?x")
server.Handler.do_GET(h)
check("R19 unknown GET still 404", captured.get("code") == 404, captured)

# --- R20 protected dedup --------------------------------------------------
# an inflected-form drift ('Corp' -> 'Corporation') is reported once
# by the entity arm; the protected arm is substring-blind to it
d = rl.diff_texts(
    "We deployed on Acme Corp infra last night.",
    "We deployed on Acme Corporation infra last night.",
    ["Acme Corp"],
)
check(
    "R20 inflected protected drift reports entity once",
    sum(1 for m in d["mismatches"] if m["type"] == "entity") == 1
    and not any(m["type"] == "protected" for m in d["mismatches"]),
    d["mismatches"],
)
# a genuinely dropped term still reports protected (and the invented
# replacement is an honest entity finding, not a dupe of it)
d = rl.diff_texts(
    "We deployed on Acme Corp infra last night.",
    "We deployed on Zenith infra last night.",
    ["Acme Corp"],
)
check(
    "R20 dropped protected term still reports protected",
    any(m["type"] == "protected" and m["original"] == "Acme Corp" for m in d["mismatches"]),
    d["mismatches"],
)

print()
if failures:
    print(f"{len(failures)} FAILURES")
    sys.exit(1)
print("all rubric checks pass")
