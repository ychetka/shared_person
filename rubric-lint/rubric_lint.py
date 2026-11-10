#!/usr/bin/env python3
"""rubric_lint.py - deterministic anti-slop rubric scorer (issue #80).

Pure-stdlib engine behind the rubric-lint HTTP service (server.py).
Same input -> same output, byte-identical: no clocks, no randomness,
no network. Score polarity matches the pangram ai_score contract the
humanizer eval loop consumes: 0 = human-clean, 100 = worst/AI-ish.

Scoring model (krrkt-shaped): every finding carries severity (1 warn /
2 error) and a per-rule weight; the weighted-hit rate per 1k words goes
through a saturating hyperbola  score = 100 * rate / (rate + HALF).
Single occurrences are warn at most - error severity is reserved for
document-level density violations, per the slopless FP-avoidance audit.

Rule provenance (see NOTICE.md / README.md):
  wsc aiTells dicts + structural regexes   vendored data/en_lexicon.json
  slopless phrase rule dicts               vendored data/en_lexicon.json
  nomisread.py rhythm/structural rules     vendored vendor/nomisread.py
  RU канцелярит/штампы + nominalization    own corpus layer, mined from
                                           fixtures/humanizer/ai_flop
"""

import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import vendor.nomisread as nomisread  # noqa: E402  (MIT, vendored)

VERSION = "0.1.0"
DATA_DIR = os.path.join(_HERE, "data")
VOICE_PATH = os.path.join(_HERE, "voice.json")


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


LEX = _load_json(os.path.join(DATA_DIR, "en_lexicon.json"), {})
VOICE = _load_json(VOICE_PATH, {})

# ---------------------------------------------------------------------------
# offset-preserving masking: same exclusion semantics as vendored
# nomisread.strip_code (code fences, inline code, block quotes, URLs,
# 4-space-indented lines, no-misread off regions, heading text, table
# rows) but replaces the excised bytes with \x00 (newlines kept) so
# every regex offset still addresses the ORIGINAL text - findings'
# spans point into the caller's input, not a rewritten copy.
#
# Why \x00 and not spaces (review W1): a space mask lets multi-token
# patterns bridge a masked run - [\s,;:]+ joins phrase tokens across
# it, [^.!?]{0,40}? walks through it, and the finding's span then
# covers code it never saw (phantom findings whose text != source).
# \x00 is neither \s nor \w, so word/whitespace joins cannot cross it.
# Negated classes like [^.!?] still CAN consume it, so score_text also
# drops any finding whose span intersects a masked span - the two
# layers together cover every rule family.
def _mask(text):
    spans = []

    def blank(m):
        spans.append(m.span())
        return "".join("\x00" if c != "\n" else "\n" for c in m.group(0))

    body = re.sub(
        r"<!--\s*no-misread:\s*off\s*-->.*?<!--\s*no-misread:\s*on\s*-->",
        blank, text, flags=re.S | re.I)
    body = re.sub(r"```.*?```|~~~.*?~~~", blank, body, flags=re.S)
    # \x00 added to the negated classes below so a later pass cannot
    # extend its masked span across a region an earlier pass claimed
    body = re.sub(r"`[^`\n\x00]+`", blank, body)
    body = re.sub(r"^\s*>.*$", blank, body, flags=re.M)
    body = re.sub(r"https?://[^\s\x00]+", blank, body)
    body = re.sub(r"^\s{4,}\S.*$", blank, body, flags=re.M)
    body = re.sub(r"^#{1,6}[ \t]+.*$", blank, body, flags=re.M)
    body = re.sub(r"^\s*\|.*\|\s*$", blank, body, flags=re.M)
    return body, spans


def mask_body(text):
    """NUL-masked scoring body: rule regexes run on this so whitespace
    joins cannot bridge excluded regions."""
    return _mask(text)[0]


def prose_body(text):
    """Space-normalized view of the masked body for the structural
    passes (sentence split, paragraphs, rhythm): byte-identical in
    shape to the original space mask, so vendored nomisread helpers
    see exactly the text they were tuned against."""
    return re.sub(r"\x00+", " ", mask_body(text))


def _sentence_spans(body):
    """Offset-tracking mirror of vendor/nomisread.sentences().

    The vendored splitter rewrites the text (drops table rows/rules,
    heading lines, rewrites list markers to '\\n') before splitting,
    so its sentence strings cannot be mapped back to offsets by
    re-searching. This version performs the SAME rewrites as
    offset-preserving paddings and yields (start, end, normalized
    sentence) triples that slice back into `body`. Kept in sync with
    nomisread.sentences; check_rubric asserts parity on the fixtures.
    """
    def sp_pad(m):
        return " " * len(m.group(0))

    def nl_pad(m):
        return "\n" + " " * (len(m.group(0)) - 1)

    padded = re.sub(r"^\s*\|.*\|\s*$", sp_pad, body, flags=re.M)
    padded = re.sub(r"^\s*[-:| ]{4,}\s*$", sp_pad, padded, flags=re.M)
    padded = re.sub(r"^#{1,6}\s+.*$", sp_pad, padded, flags=re.M)
    padded = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", nl_pad, padded,
                    flags=re.M)

    bounds = []
    pos = 0
    for sep in re.finditer(r"\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)",
                           padded):
        bounds.append((pos, sep.start()))
        pos = sep.end()
    bounds.append((pos, len(padded)))

    out = []
    for a, b in bounds:
        sub = padded[a:b]
        p = 0
        for sm in re.finditer(r"(?<=[.!?])[\s\"')\]]+", sub):
            out.append((a + p, a + sm.start(), sub[p:sm.start()]))
            p = sm.end()
        out.append((a + p, b, sub[p:]))
    return [(a, b, " ".join(raw.split()))
            for a, b, raw in out if len(raw.split()) >= 3]


def _iter_spans(compiled, body):
    for m in compiled.finditer(body):
        if m.group(0).strip():
            yield m


def _finding(rule, severity, m, suggestion, text=None):
    src = text if text is not None else m.string
    return {
        "rule": rule,
        "severity": severity,
        "span": [m.start(), m.end()],
        "text": src[m.start():m.end()],
        "suggestion": suggestion,
    }


def _doc_finding(rule, severity, suggestion):
    return {"rule": rule, "severity": severity, "span": [0, 0],
            "text": "", "suggestion": suggestion}


def _term_regex(terms):
    parts = sorted({re.escape(t) for t in terms if t},
                   key=len, reverse=True)
    if not parts:
        return None
    # \b is ASCII-only under re.I on str? No - on str patterns \b IS
    # unicode-aware; safe for latin terms here regardless.
    return re.compile(r"\b(?:" + "|".join(parts) + r")\b", re.I)


def _phrase_regex(phrases):
    """Literal multi-word phrases, whitespace- and apostrophe-tolerant."""
    parts = []
    for p in sorted({p for p in phrases if p}, key=len, reverse=True):
        toks = [re.escape(t) for t in p.strip().split()]
        if not toks:
            continue
        parts.append(r"[\s,;:]+".join(toks).replace(
            re.escape("'"), r"['\u2019]"))
    if not parts:
        return None
    return re.compile(r"(?<!\w)(?:" + "|".join(parts) + r")(?!\w)",
                      re.I)


# ---------------------------------------------------------------------------
# EN rules. Sources:
#   en_lexicon.json ai_vocab/ai_phrases/ai_patterns/hedges/nominalizations/
#       filler_adverbs        - wsc (MIT), extracted by tools/extract_lexicon.py
#   en_lexicon.json seo_filler/corporate_speak/cliches/prohibited_phrases/
#       weasel_attribution/llm_disclaimer_expansions
#                               - slopless (MIT), vendored rule dicts
#   nomisread regexes         - no-misread (MIT), vendor/nomisread.py
EN_AI_VOCAB_TERMS = []
for _e in LEX.get("ai_vocab", []):
    EN_AI_VOCAB_TERMS.append(_e.get("word", ""))
    EN_AI_VOCAB_TERMS.extend(_e.get("variants") or [])
EN_AI_VOCAB_RE = _term_regex(EN_AI_VOCAB_TERMS)
EN_AI_VOCAB_REASON = {}
for _e in LEX.get("ai_vocab", []):
    r = _e.get("reason", "AI-tell vocabulary")
    EN_AI_VOCAB_REASON[_e.get("word", "")] = r
    for _v in _e.get("variants") or []:
        EN_AI_VOCAB_REASON[_v] = r

EN_AI_PHRASES = {p.get("phrase", ""): p.get("reason", "AI-tell phrase")
                 for p in LEX.get("ai_phrases", [])}
EN_AI_PHRASE_RE = _phrase_regex(EN_AI_PHRASES)


def _phrase_key(t):
    return re.sub(r"\s+", " ", t.lower()).strip(" ,.;:!?-–—")


# per-phrase reasons the lexicon already carries - a matched phrase's
# surface form may differ in case/whitespace, so lookups normalize the
# same way the phrase list does
EN_AI_PHRASE_REASON = {_phrase_key(k): v
                       for k, v in EN_AI_PHRASES.items()}

EN_STRUCT = []
for _p in LEX.get("ai_patterns", []):
    try:
        EN_STRUCT.append((_p["name"],
                          re.compile(_p["pattern"], re.I),
                          _p.get("reason", "AI structural pattern")))
    except (KeyError, re.error):
        continue

EN_SEO_RE = _phrase_regex(LEX.get("seo_filler", []))
EN_CORP_RE = _phrase_regex(LEX.get("corporate_speak", []))
EN_CLICHE_RE = _phrase_regex(LEX.get("cliches", []))
EN_PROHIBITED_RE = _phrase_regex(LEX.get("prohibited_phrases", []))
EN_WEASEL_ATTR_RE = _phrase_regex(LEX.get("weasel_attribution", []))
EN_HEDGE_RE = _phrase_regex(LEX.get("hedges", []))
EN_ADVERB_RE = _term_regex(LEX.get("filler_adverbs", []))
EN_NOMINAL = {n.get("word", ""): n.get("suggestion", "")
              for n in LEX.get("nominalizations", [])}
EN_NOMINAL_RE = _term_regex(EN_NOMINAL)
# C1 audit carve-out: the wsc nominalizations dict treats every -tion
# noun as a tell, but in a dev diary these twenty are ordinary CONCRETE
# nouns - "the migration ran in 40 seconds" names an artifact, not a
# buried verb. They still get a warn finding at half weight (the
# pattern is worth noticing), but they no longer count toward the
# severity-2 density gate, which was tripping on three ordinary tech
# nouns in a 150-word eval cell.
EN_NOMINAL_COMMON = {
    "implementation", "documentation", "configuration", "specification",
    "validation", "integration", "installation", "generation",
    "description", "connection", "deployment", "development",
    "operation", "authentication", "authorization", "distribution",
    "serialization", "registration", "replication", "migration",
}
EN_DISCLAIMER = LEX.get("llm_disclaimer_expansions", {})
EN_DISCLAIMER_RE = _phrase_regex(
    list(EN_DISCLAIMER.get("startsWith", [])) +
    list(EN_DISCLAIMER.get("contains", [])))

EN_TRANSITION_RE = re.compile(
    r"\b(?:furthermore|moreover|additionally|in addition|what's more|"
    r"beyond that|similarly|likewise|conversely|nevertheless|nonetheless|"
    r"consequently|as a result|in essence|in short|firstly|secondly|"
    r"thirdly|lastly|in conclusion|to summarize|overall)\b", re.I)

# ---------------------------------------------------------------------------
# RU rules (own layer - no translation circle; markers mined from
# fixtures/humanizer/ai_flop/ru.txt plus the generic канцелярит set,
# per issue #80 "banned tropes mined from OUR fixtures"). Each entry is
# a regex with the human suggestion the finding carries.

RU_STAMPS = [
    (r"в современном\b[^.!?]{0,40}?\bмире", "framing opener - cut it, state the subject directly"),
    (r"в (?:современном|нынешнем) (?:мире|обществе|информационном обществе)",
     "framing opener - cut it"),
    (r"на сегодняшний день", "write 'сейчас' or drop it"),
    (r"в настоящее время", "write 'сейчас' or drop it"),
    (r"в эпоху (?:цифровизации|быстрых|перемен|информационных)",
     "framing opener - cut it"),
    (r"важно отметить", "meta-announcement - the point carries its own weight"),
    (r"стоит отметить", "meta-announcement - drop the preamble"),
    (r"следует отметить", "meta-announcement - drop the preamble"),
    (r"необходимо отметить", "meta-announcement - drop the preamble"),
    (r"нельзя не отметить", "meta-announcement - drop the preamble"),
    (r"не секрет,?\s*что", "meta-announcement - state the fact"),
    (r"не (?:является|будет) секретом", "meta-announcement - state the fact"),
    (r"как известно", "attribution stamp - name the source or drop it"),
    (r"как (?:уже )?(?:было )?отмечено ранее", "backreference stamp - drop it"),
    (r"в заключени[ие]", "wrap-up formula - let the text end"),
    (r"подводя итог", "wrap-up formula - let the text end"),
    (r"следует подчеркнуть", "meta-announcement - drop the preamble"),
    # the stock "plays a <adj> role" frame requires at least one
    # modifier word: a bare 'актор играет роль' is a literal statement,
    # not a stamp. One or two adjective slots cover 'очень важную роль'
    (r"игра\w*\s+(?:\w+\s+){1,2}рол\w*\b",
     "stock importance phrase - say what it actually does"),
    (r"занима\w*\s+(?:\w+\s+){1,2}мест\w*\b",
     "stock importance phrase - say what it actually does"),
    (r"име\w*\s+(?:\w+\s+){1,2}значени\w*\b",
     "stock importance phrase - say why it matters concretely"),
    (r"созда\w* условия для", "vague benefit - name the concrete outcome"),
    (r"обеспечива\w* \w* ?возможност", "канцелярит - name the concrete effect"),
    (r"оказыва\w* \w* ?влияни", "канцелярит - say how it changes things"),
    (r"вносит \w* ?вклад", "канцелярит - say what it adds concretely"),
    (r"является (?:неотъемлемой|важной|ключевой|необходимой) частью",
     "stock importance phrase - cut or make concrete"),
    (r"представляет собой", "канцелярит copula - write 'это' or a real verb"),
    (r"осуществля\w*", "канцелярит verb - use the direct verb (делает, проводит, строит)"),
    (r"выступает в качестве", "канцелярит - write 'работает как' or 'это'"),
    (r"в условиях", "канцелярит frame - name the concrete condition"),
    (r"широкий спектр", "vague quantity - give the number"),
    (r"большое количество", "vague quantity - give the number"),
    (r"высок(?:ое|ий|ая|ую|им|ую) качество",
     "uncited quality claim - give the metric"),
    (r"комплексн\w* подход", "corporate stamp - say which steps"),
    # declined nouns included: 'ключевым моментом' (instrumental) is the
    # same stamp as 'ключевой момент'
    (r"ключев\w*\s+(?:рол\w*|аспект\w*|фактор\w*|элемент\w*|момент\w*|задач\w*)",
     "stock importance phrase - say what it actually does"),
    (r"важнейш\w*\s+рол\w*\b", "stock importance phrase"),
    (r"прочн\w* фундамент", "stock metaphor - name the concrete thing"),
    (r"глубок\w* погружени\w*", "neuroslop - write 'разбор' or 'анализ'"),
    (r"погрузи\w*ся в", "neuroslop - write 'разберём' or 'посмотрим'"),
    (r"синерги\w*", "corporate stamp - name the interaction"),
    (r"бесшовн\w*", "neuroslop - 'без сбоев' or say what stayed up"),
    (r"инновационн\w*", "uncited novelty claim - show what is new"),
    (r"революционн\w*", "hype adjective - show, don't declare"),
    (r"передов(?:ой|ого|ым|ому|ая|ую|ые)", "uncited claim - name who is ahead"),
    (r"уникальн\w*", "uncited claim - show what is one-off"),
    (r"ценн(?:ое|ый|ая|ую|ого|ым) (?:понимани|вклад|ресурс|опыт|инсайт)",
     "value-inflation - state the insight itself"),
    (r"ценное понимание", "value-inflation - state the insight itself"),
    (r"вывод\w* на новый уровень", "hype phrase - give the metric"),
    (r"новый уровень", "hype phrase - give the metric"),
    (r"меняет правила игры", "cliche - say what changed"),
    (r"отправная точка", "cliche - 'начало' usually works"),
    (r"в динамично развивающемся", "framing opener - cut it"),
    (r"давайте (?:разберёмся|погрузимся|посмотрим|выясним)",
     "chatty opener - just do the thing"),
    (r"представьте себе", "chatty opener - state the scenario"),
    (r"забудьте вс[её], что вы знали", "hype opener - state the correction"),
    (r"вс[её] дело в том, что", "throat-clearing - state the thing"),
    (r"стоит понимать", "meta-announcement - drop it"),
    (r"важно понимать", "meta-announcement - drop it"),
    (r"качественн\w* (?:контент|материал|продукт)", "uncited quality claim"),
    (r"экосистем\w*", "buzzword - name the actual parts"),
    (r"эффективн(?:о|ым|ое|ая|ую) (?:использов|решени|работ|функцион)",
     "uncited efficiency claim - give the number"),
    (r"богатый опыт", "канцелярит - name the experience"),
    (r"многогранн\w*", "hype adjective - say which facets"),
    (r"неоспорим\w*", "unsupported superlative - show it"),
    (r"существенн\w* (?:повыс|улучш|упроща)", "weasel quantity - give the number"),
]
RU_STAMP_RES = [(re.compile(p, re.I), s) for p, s in RU_STAMPS]

# W2 audit split: these are ordinary Russian connectors a human hand
# reaches for constantly - 'кроме того' is not the same evidence class
# as 'важно отметить'. They stay warn findings but at half weight, and
# they never carry the full 2.0 stamp charge the hard tells do.
RU_STAMPS_SOFT = [
    (r"при этом", "connector stamp - often pure padding"),
    (r"кроме того", "connector stamp - 'и' usually works"),
    (r"более того", "connector stamp - 'и' usually works"),
    (r"таким образом", "connector stamp - most uses are padding"),
    (r"вместе с тем", "connector stamp - pick a plainer link"),
    (r"в рамках", "канцелярит preposition - 'в' or 'по' usually works"),
]
RU_STAMP_SOFT_RES = [(re.compile(p, re.I), s) for p, s in RU_STAMPS_SOFT]

# nominalization suffix density (W3 audit): only the endings that are
# reliably отглагольные - -ание/-ение/-ствие count at full weight. The
# old pattern also fired on -ость (гости/новости/скорости),
# -тельн (внимательный/строительный) and -ци (функция/станция/акция,
# all concrete) - those suffixes match far more ordinary lexicon than
# nominalizations, so they were dropped. -ость survives only as a small
# curated list of true abstract канцелярит nouns at half weight.
# Pure-regex RU layer (pymorphy3 optional and deliberately unused - a
# suffix regex is honest about what it sees and keeps the service
# zero-dep).
RU_NOMINAL_RE = re.compile(
    r"\b[а-яё]+(?:ан|ен)и(?:е|я|ем|ей|ю|и|й|ями|ях)\b|"
    r"\b[а-яё]+стви(?:е|я|ем|ей|ю|и|ями|ях)\b",
    re.I)
RU_NOMINAL_SOFT_RE = re.compile(
    r"\b(?:возможност|необходимост|актуальност|вероятност|"
    r"целесообразност)\w*\b", re.I)
# denominator: ALL word tokens - a mixed RU/EN tech post must not see
# its nominalization share inflated because the Latin half went
# uncounted (W3)
RU_WORD_RE = re.compile(r"[0-9a-zа-яё]+", re.I)

# only the strict "это не X — это Y" reframe; the plain "не ..., а ..."
# contrast is ordinary Russian, not a machine tell (FP audit)
RU_NEGATION_REFRAME = re.compile(
    r"\bэто не\b[^.!?\n]{2,60}?[—–-]\s*это\b", re.I)
# typography tell (honest version): straight quotes are what a HUMAN
# keyboard produces - flagging them as AI evidence was backwards, so
# that rule is gone. The machine tell runs the other way: typograph-
# ically perfect «ёлочки» paired with typographic dashes in one casual
# post. Kept at low weight - a phone keyboard with autocorrect can
# produce the same pair, so it is a weak signal, not a verdict.
RU_GUILLEMET = re.compile(r"«[^»\n]{2,80}»")
RU_CYR = re.compile(r"[а-яё]", re.I)

# ---------------------------------------------------------------------------
# thresholds (documented; tuned against fixtures/humanizer tiers)
SAT_HALF = 25.0          # weighted hits/1k where the curve reaches 50
# per-1k rates are unmeasurable on tiny cells - a single hit saturates
# any band (1 em dash in 150 words is 6.7/1k, past the 5/1k gate on a
# perfectly human post). Density ERROR gating therefore requires ALL
# THREE: words >= MIN_DENSE_WORDS, an absolute hit floor that keeps a
# lone occurrence from ever reading as a cluster, and the per-1k rate.
# The score denominator floors at 80 words as before (eval cells are
# >=150 anyway: pangram's floor).
MIN_DENSE_WORDS = 80
EMDASH_PER_1K_ERR = 5.0  # em/en dashes per 1k words -> error finding
EMDASH_MIN_HITS = 3      # absolute floor: 1-2 dashes stay warn
TRANSITION_PER_1K_ERR = 12.0
TRANSITION_MIN_HITS = 3  # 1-2 formal transitions are ordinary prose
NOMINAL_PER_1K_ERR = 18.0    # EN nominalization hits per 1k
NOMINAL_MIN_HITS = 4     # a 3-nominal cell is vocabulary, not density
RU_NOMINAL_SHARE_ERR = 0.14  # suffix-share of ALL word tokens
RU_NOMINAL_MIN_HITS = 4
LONG_SENT_WORDS = 35
LONG_SENT_SHARE_ERR = 0.3
PASSIVE_PER_1K_FLAG = 30.0
# calibration corpus below this many sentences is honestly 'thin' -
# learn_voice.py warns on write, /score echoes the caveat in metrics
THIN_CAL_SENTENCES = 30


def _en_rules(body, pbody, words, sents):
    """Run the EN rule layer. Returns (findings, extra_metrics).

    `body` is the NUL-masked text the rule regexes scan; `pbody` is the
    space-normalized view the vendored structural passes (narrative,
    drumbeats) were tuned against.
    """
    f = []
    per1k = 1000.0 / max(words, 1)
    # density ERROR severity is a document-level judgment; under
    # MIN_DENSE_WORDS the same hits stay warn, and under the absolute
    # hit floors below so does a lone occurrence at any length
    dense = words >= MIN_DENSE_WORDS

    def per_hit(regex, rule, weight_src, cap=None):
        hits = []
        for m in _iter_spans(regex, body):
            hits.append(m)
        if cap is not None:
            hits = hits[:cap]
        for m in hits:
            txt = m.group(0)
            sugg = weight_src(txt) if callable(weight_src) else weight_src
            f.append(_finding(rule, 1, m, sugg))
        return len(hits)

    if EN_AI_VOCAB_RE:
        per_hit(EN_AI_VOCAB_RE, "en-ai-vocab",
                lambda t: EN_AI_VOCAB_REASON.get(
                    t.lower(), "AI-tell vocabulary - prefer plain wording"))
    if EN_AI_PHRASE_RE:
        per_hit(EN_AI_PHRASE_RE, "en-ai-phrase",
                lambda t: EN_AI_PHRASE_REASON.get(
                    _phrase_key(t),
                    "AI-tell phrase - cut the formula, say the thing"))
    for name, cre, reason in EN_STRUCT:
        per_hit(cre, "en-struct-" + name, reason)
    if EN_SEO_RE:
        per_hit(EN_SEO_RE, "en-seo-filler",
                "SEO filler (slopless dict) - cut the padding")
    if EN_CORP_RE:
        per_hit(EN_CORP_RE, "en-corporate-speak",
                "corporate speak (slopless dict) - plainer wording exists")
    if EN_CLICHE_RE:
        per_hit(EN_CLICHE_RE, "en-cliche",
                "cliche (slopless dict) - say it plainly", cap=5)
    if EN_PROHIBITED_RE:
        per_hit(EN_PROHIBITED_RE, "en-prohibited-phrase",
                "prohibited phrase (slopless dict) - never earned")
    if EN_WEASEL_ATTR_RE:
        per_hit(EN_WEASEL_ATTR_RE, "en-weasel-attribution",
                "vague authority attribution - name the source")
    if EN_HEDGE_RE:
        per_hit(EN_HEDGE_RE, "en-hedge",
                "impersonal hedge - state the claim or name the doubter")
    if EN_ADVERB_RE:
        per_hit(EN_ADVERB_RE, "en-filler-adverb",
                "empty intensifier - the verb usually carries it", cap=8)
    if EN_DISCLAIMER_RE:
        for m in _iter_spans(EN_DISCLAIMER_RE, body):
            # chatbot self-disclosure left in pasted output: unambiguous,
            # severity 2 is honest (not a density rule)
            f.append(_finding("en-llm-disclaimer", 2, m,
                              "chatbot artifact left in the text - delete it"))

    # nomisread structural rules (vendored compiled regexes)
    for rule, cre, sugg in (
            ("en-worn-word", nomisread.WORN_WORDS,
             "overworked word (no-misread list) - prefer plain wording"),
            ("en-contrast-frame", nomisread.CONTRAST_FRAME,
             "'not X - it's Y' reveal frame - state the point directly"),
            ("en-throat-clearing", nomisread.THROAT_CLEARING,
             "announced opener - start with the point"),
            ("en-wrap-up", nomisread.WRAP_UP,
             "closing ritual - let the text end"),
            ("en-false-emphasis", nomisread.FALSE_EMPHASIS,
             "emphasis filler - the sentence already made the point"),
            ("en-false-agency", nomisread.FALSE_AGENCY,
             "abstraction doing a human verb - name the actor"),
            ("en-hedge-stack", nomisread.HEDGE_STACK,
             "stacked hedge - pick one qualifier or none"),
            ("en-mirror-contrast", nomisread.MIRROR_CONTRAST,
             "'a, not b' mirrored contrast - precision or padding?"),
            ("en-tricolon", nomisread.TRICOLON,
             "rule-of-three drumbeat - keep one if the beat is chosen")):
        per_hit(cre, rule, sugg)

    # document-level density rules - error severity only over threshold.
    # Only true em/en dash CHARACTERS count: the AI tell is typographic
    # (" — "). A spaced ASCII hyphen is what a human keyboard produces
    # (our clean fixtures use it constantly) - counting it flags the
    # human corpus, the exact FP the density model exists to avoid.
    emdashes = len(re.findall(r"[—–]", body))
    emdash_per_1k = emdashes * per1k
    if dense and emdashes >= EMDASH_MIN_HITS and \
            emdash_per_1k > EMDASH_PER_1K_ERR:
        f.append(_doc_finding("en-emdash-density", 2,
                              f"{emdashes} dashes per {words} words "
                              f"({emdash_per_1k:.1f}/1k) - em-dash density "
                              "is a document-level AI tell"))
    transitions = len(EN_TRANSITION_RE.findall(body))
    transition_per_1k = transitions * per1k
    if dense and transitions >= TRANSITION_MIN_HITS and \
            transition_per_1k > TRANSITION_PER_1K_ERR:
        f.append(_doc_finding("en-transition-density", 2,
                              f"{transitions} formal transitions per {words} "
                              f"words - 'furthermore/moreover' chains read "
                              "as generated structure"))
    nominal_hits = []
    if EN_NOMINAL_RE:
        for m in _iter_spans(EN_NOMINAL_RE, body):
            nominal_hits.append(m)
    # the severity-2 gate counts only the full-weight hits: the
    # EN_NOMINAL_COMMON tech nouns stay warn findings but do not
    # inflate the density rate (C1 - three ordinary -tion words must
    # never read as a nominalization cluster)
    hard_nominal = [m for m in nominal_hits
                    if m.group(0).lower() not in EN_NOMINAL_COMMON]
    nominal_per_1k = len(hard_nominal) * per1k
    sev = 2 if (dense and len(hard_nominal) >= NOMINAL_MIN_HITS and
                nominal_per_1k > NOMINAL_PER_1K_ERR) else 1
    for m in nominal_hits[:8]:
        w = m.group(0).lower()
        if w in EN_NOMINAL_COMMON:
            f.append(_finding("en-nominalization-common", 1, m,
                              f"common tech noun - reads as nominalization "
                              f"only in dense clusters "
                              f"('{EN_NOMINAL.get(w, 'the verb')}')"))
        else:
            f.append(_finding("en-nominalization", sev, m,
                              f"nominalization - write '{EN_NOMINAL.get(w, 'the verb')}'"))
    passive_hits = list(_iter_spans(nomisread.PASSIVE, body))
    passive_per_1k = len(passive_hits) * per1k
    if passive_per_1k > PASSIVE_PER_1K_FLAG:
        for m in passive_hits[:5]:
            f.append(_finding("en-passive-density", 1, m,
                              "passive stack - name the actor"))

    # structural passes run on the space-normalized view - identical to
    # the space mask they were calibrated against
    narr = nomisread.narrative(pbody, sents)
    if narr.get("same_opener_run"):
        f.append(_doc_finding(
            "en-same-opener-run", 2,
            f"{narr['same_opener_run']} sentences in a row open with the "
            "same word - anaphora is a chosen device, this is a habit"))
    if narr.get("uniform_paragraphs"):
        f.append(_doc_finding(
            "en-uniform-paragraphs", 2,
            f"{narr['uniform_paragraphs']} paragraphs cut to the same "
            "sentence count - the paragraph-level metronome"))
    if narr.get("transition_opener_chain"):
        f.append(_doc_finding(
            "en-transition-opener-chain", 1,
            f"{narr['transition_opener_chain']} paragraphs open with a "
            "formal transition adverb"))
    drumbeats = nomisread.count_drumbeats(pbody)
    if drumbeats >= 2:
        f.append(_doc_finding(
            "en-drumbeat-triads", 1,
            f"{drumbeats} closing three-item drumbeats - rhetoric by beat"))

    return f, {
        "emdash_per_1k": round(emdash_per_1k, 1),
        "transition_per_1k": round(transition_per_1k, 1),
        # stable contract: nominalization_density is the hit SHARE of
        # word tokens (0-1) in both languages; nominal_per_1k keeps the
        # gating rate for whoever wants the raw units
        "nominalization_density": round(
            len(nominal_hits) / max(words, 1), 4),
        "nominal_per_1k": round(nominal_per_1k, 1),
        "passive_per_1k": round(passive_per_1k, 1),
        "en_drumbeats": drumbeats,
    }


def _ru_rules(body, pbody, words, sents, span_sents):
    """Own light RU layer - канцелярит/штампы markers (hard + soft
    connector tiers), nominalization suffix density, long sentences,
    typography notes. Regexes scan `body` (NUL-masked); token counts
    and sentence offsets come from the space-normalized `pbody`."""
    f = []

    for cre, sugg in RU_STAMP_RES:
        for m in _iter_spans(cre, body):
            f.append(_finding("ru-stamp", 1, m, sugg))
    for cre, sugg in RU_STAMP_SOFT_RES:
        for m in _iter_spans(cre, body):
            f.append(_finding("ru-stamp-soft", 1, m, sugg))

    tokens = RU_WORD_RE.findall(pbody)
    nominal_hard = list(_iter_spans(RU_NOMINAL_RE, body))
    nominal_soft = list(_iter_spans(RU_NOMINAL_SOFT_RE, body))
    share = (len(nominal_hard) + len(nominal_soft)) / max(len(tokens), 1)
    hard_share = len(nominal_hard) / max(len(tokens), 1)
    sev = 2 if (hard_share > RU_NOMINAL_SHARE_ERR and
                len(tokens) >= MIN_DENSE_WORDS and
                len(nominal_hard) >= RU_NOMINAL_MIN_HITS) else 1
    for m in nominal_hard[:8]:
        f.append(_finding("ru-nominalization", sev, m,
                          "отглагольное существительное - замените живым глаголом"))
    for m in nominal_soft[:8]:
        f.append(_finding("ru-nominalization-soft", 1, m,
                          "канцелярная абстракция - часто хватает глагола"))

    # long sentences: offsets come straight from the sentence splitter
    # (_sentence_spans) - the old re-search of a normalized prefix
    # could land on an earlier lookalike or on nothing at all
    long_sents = [sp for sp in span_sents
                  if len(sp[2].split()) > LONG_SENT_WORDS]
    long_share = len(long_sents) / max(len(sents), 1)
    sev = 2 if long_share > LONG_SENT_SHARE_ERR and len(sents) >= 4 else 1
    for a, b, norm in long_sents[:5]:
        f.append({"rule": "ru-long-sentence", "severity": sev,
                  "span": [a, b],
                  "text": body[a:b],
                  "suggestion":
                      f"{len(norm.split())} слов - разбейте на два"})
    neg = list(_iter_spans(RU_NEGATION_REFRAME, body))
    if neg:
        for m in neg[:3]:
            f.append(_finding("ru-negation-reframe", 1, m,
                              "'это не X - это Y' рамка - скажите сразу"))
    # «ёлочки» + typographic dash: the perfect-typography pair (see the
    # constant's comment - straight quotes are human, not a tell)
    if RU_CYR.search(body) and re.search(r"[—–]", body):
        for m in list(_iter_spans(RU_GUILLEMET, body))[:3]:
            f.append(_finding("ru-typography", 1, m,
                              "«ёлочки» вместе с тире - типографская "
                              "аккуратность, которую редко даёт рука"))

    return f, {
        "nominalization_density": round(share, 4),
        "long_sentence_share": round(long_share, 2),
        "ru_tokens": len(tokens),
    }


def score_text(text, lang):
    """POST /score body. Deterministic: same input -> same output."""
    text = text if isinstance(text, str) else ""
    lang = "ru" if str(lang).lower().startswith("ru") else "en"
    body, masked_spans = _mask(text)
    pbody = re.sub(r"\x00+", " ", body)
    span_sents = _sentence_spans(pbody)
    sents = [t for _, _, t in span_sents]
    words = len(pbody.split())

    findings = []
    metrics = {}
    if lang == "ru":
        f, m = _ru_rules(body, pbody, words, sents, span_sents)
    else:
        f, m = _en_rules(body, pbody, words, sents)
    findings.extend(f)
    metrics.update(m)

    # masked-region bridging (W1): \x00 already stops whitespace/word
    # joins, but negated classes ([^.!?]{0,40}, [^"\n]{2,80}) can still
    # walk through a masked run - a finding whose span touches masked
    # bytes is a phantom built on text the rules never saw
    findings = [x for x in findings
                if x["span"][0] == x["span"][1] or not any(
                    x["span"][0] < mb and x["span"][1] > ma
                    for ma, mb in masked_spans)]

    # burstiness: vendored nomisread rhythm() - stdev_words AND
    # band_share gate (terse human prose is not metronomic), plus the
    # calibrated per-language voice.json flat_for_you comparison.
    rhythm = nomisread.rhythm(sents)
    prof = VOICE.get(lang)
    if prof and rhythm.get("measurable"):
        base = (prof.get("rhythm") or {}).get("stdev_words")
        if base:
            # W7: the calibrated arm keeps the SAME and-gate as the
            # fixed floor - a terse-but-varied writer (low stdev,
            # distributed bands) is not metronomic, just short
            flat_for_you = (
                rhythm["stdev_words"] < base * nomisread.FLAT_FOR_YOU
                and rhythm.get("band_share", 0) > nomisread.BAND_CEILING)
            if flat_for_you:
                rhythm["reads_metronomic"] = True
            rhythm["calibrated_stdev"] = base
            rhythm["flat_for_you"] = flat_for_you
    # stable contract: the rhythm keys are always present, null when
    # the sentence count cannot support a measurement
    for k in ("sentences", "mean_words", "stdev_words", "band_share",
              "shortest", "longest"):
        metrics[k] = rhythm.get(k)
    if prof:
        n_cal = (prof.get("samples") or {}).get("sentences")
        metrics["voice_sentences"] = n_cal
        metrics["thin_calibration"] = bool(
            n_cal is not None and n_cal < THIN_CAL_SENTENCES)
    if rhythm.get("measurable") and rhythm.get("reads_metronomic"):
        why = (f"sentence-length spread {rhythm['stdev_words']} words with "
               f"{int(rhythm['band_share'] * 100)}% of sentences inside a "
               "single band")
        if rhythm.get("flat_for_you"):
            why += (f" - flat against this voice's calibrated "
                    f"{rhythm['calibrated_stdev']}")
        findings.append(_doc_finding(
            "burstiness", 2,
            why + " - vary sentence length; metronome rhythm is the "
                  "strongest structural AI tell"))

    # one span, one flag (wsc's own dedupe discipline): overlapping
    # matches from different rules collapse onto the strongest rule -
    # "seamless" must not double-charge both en-ai-vocab and
    # en-worn-word
    findings.sort(key=lambda x: -(
        WEIGHTS.get(x["rule"], DEFAULT_WEIGHT) * x["severity"]))
    kept_spans = []
    deduped = []
    for x in findings:
        a, b = x["span"]
        if a == b or not any(a < kb and b > ka for ka, kb in kept_spans):
            deduped.append(x)
            kept_spans.append((a, b))
    findings = deduped

    # marker density: total warn hits per 1k words crosses into error
    # evidence on its own. Counted on the DEDUPED list - overlapping
    # pre-dedup hits inflated the rate (a span already claimed by the
    # stronger rule must not charge twice).
    warn_hits = sum(1 for x in findings if x["severity"] == 1)
    metrics["marker_density"] = round(warn_hits * 1000.0 / max(words, 1), 1)
    if metrics["marker_density"] > 40 and warn_hits >= 5:
        findings.append(_doc_finding(
            "marker-density", 2,
            f"{warn_hits} marker hits per {words} words - the density "
            "itself is the tell, not any single phrase"))

    # weighted-hits-per-words -> saturating hyperbola (krrkt-shaped)
    weighted = sum(WEIGHTS.get(x["rule"], DEFAULT_WEIGHT) * x["severity"]
                   for x in findings)
    # same floor as the density gate: a weighted-hits-per-1k rate needs
    # a measurable denominator or tiny cells blow the curve up
    rate = weighted * 1000.0 / max(words, MIN_DENSE_WORDS)
    score = round(100.0 * rate / (rate + SAT_HALF)) if rate > 0 else 0
    score = max(0, min(100, score))

    findings.sort(key=lambda x: (x["span"][0], x["rule"]))
    metrics["weighted_rate_per_1k"] = round(rate, 1)
    metrics["words"] = words
    return {
        "score": score,
        "findings": findings,
        "metrics": metrics,
        "lang": lang,
        "version": VERSION,
    }


# per-rule weights (severity multiplies these)
DEFAULT_WEIGHT = 1.5
WEIGHTS = {
    "en-ai-vocab": 2.0,
    "en-ai-phrase": 2.0,
    "en-prohibited-phrase": 3.0,
    "en-seo-filler": 2.0,
    "en-weasel-attribution": 2.0,
    "en-llm-disclaimer": 6.0,
    "en-corporate-speak": 1.5,
    "en-cliche": 1.0,
    "en-hedge": 1.0,
    "en-filler-adverb": 0.5,
    "en-worn-word": 1.5,
    "en-contrast-frame": 2.0,
    "en-throat-clearing": 2.0,
    "en-wrap-up": 1.5,
    "en-false-emphasis": 2.0,
    "en-false-agency": 1.5,
    "en-hedge-stack": 1.5,
    "en-mirror-contrast": 1.5,
    "en-tricolon": 1.0,
    "en-drumbeat-triads": 1.5,
    "en-nominalization": 1.0,
    "en-nominalization-common": 0.5,
    "en-emdash-density": 4.0,
    "en-transition-density": 4.0,
    "en-transition-opener-chain": 1.5,
    "en-same-opener-run": 3.0,
    "en-uniform-paragraphs": 3.0,
    "en-passive-density": 0.5,
    "en-struct-negative-parallelism": 2.0,
    "en-struct-not-only-but-also": 2.0,
    "en-struct-trailing-participial-analysis": 2.5,
    "en-struct-vague-attribution": 2.0,
    "en-struct-audience-hedge": 2.0,
    "en-struct-despite-challenges": 2.0,
    "en-struct-copula-puffery": 2.0,
    "en-struct-pivotal-role-claim": 2.5,
    "en-struct-false-range": 2.0,
    "en-struct-unfilled-placeholder": 3.0,
    "en-struct-meta-announcement": 2.5,
    "en-struct-dance-metaphor": 2.0,
    "ru-stamp": 2.0,
    "ru-stamp-soft": 0.5,
    "ru-nominalization": 1.0,
    "ru-nominalization-soft": 0.5,
    "ru-long-sentence": 1.5,
    "ru-negation-reframe": 2.0,
    "ru-typography": 0.5,
    "burstiness": 4.0,
    "marker-density": 4.0,
}


# ---------------------------------------------------------------------------
# POST /diff - fact/entity preservation between original and rewrite.
# Numbers, dates, URLs, inline code and protected terms must survive
# VERBATIM; entities are capitalized multi-word proper-noun chunks.
# Extraction is ordered (code -> url -> date -> number) and each pass
# masks the spans it claims so a URL's digits never reach the number
# pass. Pairs align by position; unequal or unmatched items are the
# mismatches.

D_SPAN_RES = [
    ("code", re.compile(r"```.*?```|`[^`\n]+`", re.S)),
    ("url", re.compile(
        r"https?://[^\s)\]>\"'\x00]+|www\.[^\s)\]>\"'\x00]+")),
    ("date", re.compile(
        r"\b\d{4}-\d{2}-\d{2}\b"
        r"|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b"
        r"|\b(?:January|February|March|April|May|June|July|August|"
        r"September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?"
        r"|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|"
        r"August|September|October|November|December)\s*,?\s*\d{4}"
        r"|\b\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|"
        r"августа|сентября|октября|ноября|декабря)(?:\s+\d{4}\s*г?\.?)?",
        re.I)),
    # any word-token containing a digit is a fact: '40', '900ms',
    # 'p99', 'v2.5', '100%' - unit-suffixed and letter-prefixed forms
    # are the tokens a rewrite most often mutates
    ("number", re.compile(r"\b\w*\d[\w%.,]*")),
]
D_ENTITY_RE = re.compile(
    r"\b[A-ZА-ЯЁ][\w'’.-]*(?:\s+[A-ZА-ЯЁ][\w'’.-]*)+\b")

# single-token entities the multi-word pass cannot see (W6): a rewrite
# that swaps 'Gemini' for 'Claude' or 'PostgreSQL' for 'MySQL' used to
# pass silently because neither is a multi-word chunk. Two shapes count:
#   mid-sentence Capitalized words  - 'we deployed on Gemini' names a
#     thing; a sentence-INITIAL capital is grammar, not a name, so it
#     is excluded (the FP cost of catching every opener)
#   non-standard-case tokens        - internal caps or digit-less odd
#     case (PostgreSQL, iOS, PyPI, macOS) are brand-shaped wherever
#     they sit
D_WORD_RE = re.compile(r"\b[A-Za-zА-ЯЁа-яё][\w'’.-]*\b")
# common function/emphasis words that get capitalized (or shouted) in
# ordinary prose - matched lowercase, so 'Not' and 'NOT' both stay out
D_ENTITY_STOP = frozenset({
    "i", "a", "an", "the", "and", "or", "but", "if", "so", "no", "not",
    "yes", "ok", "okay", "do", "does", "did", "is", "are", "was",
    "were", "be", "been", "it", "its", "we", "you", "they", "he", "she",
    "my", "our", "your", "their", "his", "her", "in", "on", "at", "to",
    "by", "of", "for", "from", "with", "as", "vs", "via", "per", "etc",
    "now", "then", "just", "also", "only", "even", "still", "all",
    "any", "each", "every", "both", "how", "what", "why", "who", "when",
    "where", "which", "that", "this", "these", "those", "there", "here",
    "one", "two", "can", "could", "will", "would", "may", "might",
    "must", "shall", "should", "up", "out", "off", "down", "back",
    "over", "under", "after", "before", "between", "into", "about",
    "because", "while", "during", "again", "once", "some", "more",
    "most", "other", "such", "same", "than", "too", "very", "much",
    "many", "few", "dont", "cant", "wont", "didnt", "isnt", "arent",
})


def _is_sent_start(text, pos):
    """Is the token at `pos` the first word of its sentence? Scans back
    over whitespace and open quotes/brackets; a NUL-masked span or
    ordinary text stops the scan (NOT a sentence start)."""
    j = pos - 1
    while j >= 0 and (text[j].isspace() or
                      text[j] in "\"'«»([{‘’“”"):
        j -= 1
    if j < 0:
        return True
    return text[j] in ".!?…"


def _masked_out(text, spans):
    chars = list(text)
    for a, b in spans:
        for i in range(a, min(b, len(chars))):
            if chars[i] != "\n":
                chars[i] = "\x00"
    return "".join(chars)


def _extract(text):
    """Ordered span extraction -> {type: [items in order]}."""
    out = {t: [] for t, _ in D_SPAN_RES}
    out["entity"] = []
    claimed = []
    for typ, cre in D_SPAN_RES:
        cur = _masked_out(text, claimed)
        for m in cre.finditer(cur):
            claimed.append(m.span())
            out[typ].append(m.group(0).strip())
    cur = _masked_out(text, claimed)
    ent_spans = []
    for m in D_ENTITY_RE.finditer(cur):
        ent_spans.append(m.span())
        out["entity"].append(m.group(0))
    # single-token pass runs over the multi-word entities already
    # claimed - 'Acme Corp' must not spawn 'Acme' and 'Corp' on top
    cur = _masked_out(cur, ent_spans)
    for m in D_WORD_RE.finditer(cur):
        tok = m.group(0)
        if len(tok) < 2 or tok.islower():
            continue
        uppers = sum(1 for c in tok if c.isupper())
        if uppers == 1 and tok[0].isupper():
            # plain Title-case: entity only mid-sentence - an opener's
            # capital is grammar, not a name
            if _is_sent_start(cur, m.start()):
                continue
        if tok.lower() in D_ENTITY_STOP:
            continue
        out["entity"].append(tok)
    return out


def _norm_item(typ, s):
    if typ == "number":
        s = s.strip(".,;:)").replace(" ", "")
        # thousands separators only: '1,200' -> '1200' (the old blanket
        # comma->dot made '1,200' read as '1.200'). A comma NOT followed
        # by a 3-digit group is a decimal mark ('1,5' -> '1.5'). Edge
        # case kept knowingly: '0,123' parses as thousands here - an
        # ambiguous token either way, and the digit-shape pairing below
        # still lands it against the same-shape peer.
        s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", s)
        return s.replace(",", ".")
    if typ in ("code", "url"):
        return s.strip().rstrip(".,;)")
    return re.sub(r"\s+", " ", s).strip()


def diff_texts(original, rewritten, protected_terms=None):
    """POST /diff body. {mismatches:[{type, original, rewritten}]}"""
    original = original if isinstance(original, str) else ""
    rewritten = rewritten if isinstance(rewritten, str) else ""
    protected_terms = protected_terms if isinstance(
        protected_terms, list) else []

    a = _extract(original)
    b = _extract(rewritten)
    mismatches = []
    # a term the caller already protects verbatim must not double-report
    # as an entity mismatch - drop EXACT protected terms from the entity
    # bags. An inflected form ('Acme Corporation' next to protected
    # 'Acme Corp') is kept: the protected arm is substring-blind and
    # the entity row is then the only report of the drift.
    prot = {str(t) for t in protected_terms if str(t)}
    if prot:
        a["entity"] = [x for x in a["entity"] if x not in prot]
        b["entity"] = [x for x in b["entity"] if x not in prot]
    # multiset compare: an identical span moved elsewhere is a survive;
    # only count deltas are mismatches. Leftovers pair by position, and
    # numbers pair by digit-masked shape first so '900ms' lands against
    # '700ms' and '40' against '52' - not against whatever happened to
    # sort next in the bag. A leftover with no same-shape peer reports
    # the honest null.
    for typ in ("code", "url", "date", "number", "entity"):
        la = [_norm_item(typ, x) for x in a[typ]]
        lb = [_norm_item(typ, x) for x in b[typ]]
        remaining = list(lb)
        removed = []
        for item in la:
            if item in remaining:
                remaining.remove(item)
            else:
                removed.append(item)
        added = list(remaining)
        for item in removed:
            pair = None
            if typ == "number":
                shape = re.sub(r"\d", "#", item)
                for cand in added:
                    if re.sub(r"\d", "#", cand) == shape:
                        pair = cand
                        added.remove(cand)
                        break
            elif added:
                pair = added.pop(0)
            mismatches.append({"type": typ, "original": item,
                               "rewritten": pair})
        for item in added:
            # additions are mismatches too - the rewrite invented a
            # fact the original never had
            mismatches.append({"type": typ, "original": None,
                               "rewritten": item})

    # protected terms: verbatim survival (case-sensitive contract)
    for term in protected_terms:
        term = str(term)
        if not term:
            continue
        na, nb = original.count(term), rewritten.count(term)
        if nb < na:
            mismatches.append({"type": "protected",
                               "original": term,
                               "rewritten": None if nb == 0 else
                               f"only {nb}/{na} occurrences"})

    return {"mismatches": mismatches, "version": VERSION}
