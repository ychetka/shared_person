#!/usr/bin/env python3
"""no-misread: find and remove the marks that make English read as machine-written.

Two jobs, two modes.

  --strip   Rewrite the text with the machine marks taken out: invisible
            characters, and the typography no one types by hand. Safe to run
            on anything. It changes characters, never words.

  --check   Score the text. Reports the tells it can count, plus a rhythm
            measurement that no vocabulary list can catch: human sentence
            length swings, machine sentence length does not.

Ceiling, stated up front: this is a regex pass, not a parser. It cannot see
part of speech, so "that lead" and "to lead" look alike to it. It flags
passive voice only in its common forms. A zero score means the text is clean
of the things this file knows about, not that a person wrote it. Read the
prose yourself before you believe any number here.

Usage:
  python3 nomisread.py --check  draft.md
  python3 nomisread.py --strip  draft.md > clean.md
  cat draft.md | python3 nomisread.py --check -
  python3 nomisread.py --self-test

Exit codes for --check: 0 clean, 1 tells found.
"""

import datetime
import json
import os
import re
import statistics
import sys
import unicodedata

# ── Layer 1: characters a keyboard does not produce ────────────────────────
# A person typing in any normal editor emits none of these. Their presence is
# the single most reliable machine signal in a text, and the easiest to erase.

INVISIBLE = {
    "​": "zero-width space",
    "‌": "zero-width non-joiner",
    "‍": "zero-width joiner",
    "⁠": "word joiner",
    "﻿": "zero-width no-break space (BOM)",
    "­": "soft hyphen",
    "‎": "left-to-right mark",
    "‏": "right-to-left mark",
    "⁡": "function application",
    "⁢": "invisible times",
    "⁣": "invisible separator",
    "⁤": "invisible plus",
}

# Spaces that are not the space bar. Legitimate in typesetting, never in a
# draft someone typed, and a favourite carrier for encoded marks.
ODD_SPACE = {
    " ": "no-break space",
    " ": "narrow no-break space",
    " ": "figure space",
    " ": "thin space",
    " ": "hair space",
    " ": "punctuation space",
    " ": "medium mathematical space",
    "　": "ideographic space",
}

# ── Layer 2: typography that arrives with generated text ───────────────────
TYPOGRAPHY = {
    "—": ("em dash", " - "),
    "–": ("en dash", "-"),
    "‘": ("curly open single quote", "'"),
    "’": ("curly close single quote", "'"),
    "“": ("curly open double quote", '"'),
    "”": ("curly close double quote", '"'),
    "…": ("ellipsis character", "..."),
    "→": ("right arrow", "->"),
    "≥": ("greater-or-equal sign", ">="),
    "≤": ("less-or-equal sign", "<="),
}

# ── Layer 3: vocabulary ────────────────────────────────────────────────────
# Words that were ordinary English until generated text wore them out. The
# test for this list is frequency, not taste: each one appears in machine
# prose at many times its rate in human prose.

WORN_WORDS = re.compile(
    r"\b("
    r"delve|tapestry|testament|realm|landscape|intricate|meticulous|"
    r"nuanced|multifaceted|holistic|myriad|plethora|paramount|pivotal|"
    r"crucial|vital|robust|seamless|seamlessly|comprehensive|innovative|"
    r"cutting-edge|state-of-the-art|game-chang\w+|transformative|"
    r"leverag\w+|utiliz\w+|unlock\w*|elevat\w+|empower\w*|"
    # "harness the power of" is the cliche. A test harness is a thing that
    # exists, and flagging it would fire on half the docs in any repository.
    r"(?<![\w ]the )(?<![\w ]a )(?<![\w ]this )(?<![\w ]test )harness(?=\s+(?:the|its|their|our)\b)|"
    r"foster\w*|underscor\w+|showcas\w+|navigat\w+|streamlin\w+|"
    r"facilitat\w+|optimiz\w+|bolster\w*|spearhead\w*|"
    r"boasts|nestled|bustling|vibrant|breathtaking|stunning|"
    r"ever-evolving|fast-paced|rapidly-changing|"
    r"resonat\w+|embark\w*|journey|beacon|treasure trove|"
    r"deep dive|dive into|double down|circle back|lean into|unpack"
    r")\b",
    re.I,
)

# Adverbs doing no work. Generated prose reaches for these to sound certain.
EMPTY_ADVERB = re.compile(
    r"\b("
    # "rather than" is a conjunction, not an intensifier, so it is excluded.
    r"really|very|just|quite|rather(?!\s+than)|simply|actually|basically|literally|"
    r"genuinely|honestly|truly|deeply|fundamentally|inherently|inevitably|"
    r"undoubtedly|certainly|clearly|obviously|notably|importantly|"
    r"crucially|significantly|effectively|essentially|ultimately|"
    r"arguably|remarkably|incredibly|extremely|highly|particularly"
    r")\b",
    re.I,
)

# ── Layer 4: sentence shapes ───────────────────────────────────────────────

# The reveal-by-negation frame. The most recognisable machine sentence there
# is: set up a wrong answer, knock it down, deliver the right one.
CONTRAST_FRAME = re.compile(
    r"\b("
    r"(?:it|this|that|the \w+)(?:'s| is| was)\s+not\s+(?:just\s+)?[^.!?]{2,60}?[,;:—–-]\s*(?:it|this|that)(?:'s| is| was)\b"
    r"|not\s+just\s+[^.!?]{2,60}?\bbut\s+(?:also\s+)?"
    r"|not\s+only\s+[^.!?]{2,60}?\bbut\s+(?:also\s+)?"
    r"|isn't\s+(?:just\s+)?(?:about\s+)?[^.!?]{2,60}?[,;:—–-]\s*it's\b"
    r"|the\s+(?:question|answer|problem|point|issue)\s+is(?:n't| not)\b"
    r"|stops?\s+being\s+[^.;!?]{2,40}?\band\s+starts?\s+being\b"
    r")",
    re.I,
)

# Announcing that a point is coming, instead of making it.
THROAT_CLEARING = re.compile(
    r"(?:^|[.!?]\s+|\n)\s*("
    r"here's (?:the thing|what|why|how|the (?:problem|catch|kicker|truth))"
    r"|let's (?:be clear|dive|talk|explore|unpack|break)"
    r"|it's (?:worth noting|important to note|no secret|no accident)"
    r"|it (?:turns out|is important to note)"
    r"|the (?:truth|reality|fact) is"
    r"|make no mistake"
    r"|at the end of the day"
    r"|in today's [\w\s-]{3,30}(?:world|landscape|era|market|environment)"
    r"|in (?:an|the) (?:ever-evolving|increasingly|rapidly)"
    r"|when it comes to"
    r"|in a world where"
    r"|think about it"
    r"|what if (?:i told you|we|you)"
    r")",
    re.I,
)

# Closing rituals. Human writing usually just stops.
WRAP_UP = re.compile(
    r"(?:^|[.!?]\s+|\n)\s*("
    r"in conclusion|to sum up|to summarize|in summary|all in all|"
    r"overall,|ultimately,|in essence,|at its core,|"
    r"the (?:bottom line|takeaway) is|"
    r"remember(?:,| that)|hope this helps|let me know if"
    r")",
    re.I,
)

# Emphasis that adds nothing after the sentence already made the point.
FALSE_EMPHASIS = re.compile(
    r"\b(let that sink in|full stop\.|period\.|and that's okay|"
    r"that's it\. that's|full circle|no more, no less)\b",
    re.I,
)

# Abstractions given human verbs, which hides who acted. A complaint does not
# become a fix. Someone fixed it.
FALSE_AGENCY = re.compile(
    r"\b("
    r"(?:the\s+)?(?:data|research|evidence|numbers?|results?)\s+(?:tells?|suggests?|reveals?|shows? us)\b"
    r"|(?:the\s+)?(?:culture|conversation|narrative|market|industry|landscape)\s+"
    r"(?:shifts?|moves?|evolves?|rewards?|demands?|shapes?)\b"
    r"|(?:the\s+)?(?:decision|consensus|pattern|truth|answer)\s+(?:emerges?|reveals? itself|becomes clear)\b"
    r"|\w+\s+becomes?\s+(?:a|an|the)\s+\w+\s+(?:overnight|instantly|immediately)\b"
    r")",
    re.I,
)

# Both passive shapes. The get-passive ("prompts get checked") reads casual
# and walked straight past the be-only version of this rule for a full day,
# until a competitor skill running as a critic flagged it in our own README.
PASSIVE = re.compile(
    r"\b(?:is|are|was|were|be|been|being|get|gets|got)\s+(\w+ed|made|done|given|taken|seen|"
    r"known|held|built|written|shown|found|left|kept|sent|told)\b(?!\s+by\s+\w)",
    re.I,
)

# ── Narrative shape ────────────────────────────────────────────────────────
# Word lists catch vocabulary. These catch the essay SKELETON a model falls
# back on: paragraphs chained with transition adverbs, the balanced
# both-sides frame, three sentences in a row marching behind the same
# opening word, and paragraphs cut to equal lengths. Each is countable, so
# each belongs to the linter rather than to taste.

TRANSITION_OPENER = re.compile(
    r"^(?:furthermore|moreover|additionally|in addition|what's more|"
    r"beyond that|similarly|likewise|conversely|nevertheless|nonetheless|"
    r"consequently|as a result|in essence|in short|first(?:ly)?,|"
    r"second(?:ly)?,|third(?:ly)?,|finally,|lastly,)\b",
    re.I,
)

BOTH_SIDES = re.compile(
    r"on (?:the )?one hand\b.{10,400}?\bon the other(?: hand)?\b",
    re.I | re.S,
)


def paragraphs(text):
    body = re.sub(r"```.*?```", " ", text, flags=re.S)
    body = re.sub(r"^#{1,6}\s+.*$", "", body, flags=re.M)
    return [p.strip() for p in re.split(r"\n\s*\n", body) if len(p.split()) >= 8]


def narrative(text, sents):
    """Count the skeleton tells. Prose only: a procedure is supposed to march."""
    paras = paragraphs(text)
    counts = {}

    openers = sum(1 for p in paras if TRANSITION_OPENER.match(p))
    if openers >= 2:
        counts["transition_opener_chain"] = openers

    if BOTH_SIDES.search(text):
        counts["both_sides_frame"] = len(BOTH_SIDES.findall(text))

    # Three consecutive sentences behind the same first word. "The" and its
    # kin open half of technical English, so they are exempt; the tell is
    # "It provides... It ensures... It enables..."
    run, prev, worst = 1, None, 1
    for s in sents:
        first = s.split()[0].lower().strip('"\'(')
        if first == prev and first not in ("the", "a", "an"):
            run += 1
            worst = max(worst, run)
        else:
            run = 1
        prev = first
    if worst >= 3:
        counts["same_opener_run"] = worst

    # Paragraphs cut to the same number of sentences, four or more in a row.
    # The sentence-level metronome, one storey up.
    if len(paras) >= 4:
        sizes = [len(sentences(p)) for p in paras]
        sizes = [n for n in sizes if n >= 2]
        if len(sizes) >= 4 and max(sizes) - min(sizes) <= 1:
            counts["uniform_paragraphs"] = len(sizes)

    return counts


# ── Technical mode only ────────────────────────────────────────────────────
# Text a machine or a non-native reader parses without anyone to ask has the
# opposite problem to an essay. There, uniform sentences are correct: a reader
# scanning a procedure under pressure is helped by every line having the same
# shape, and a stylistic flourish costs them time. The aerospace controlled
# English standard bans contractions and vague modals for the same reason.
#
# So these two run in technical mode and nowhere else, and the rhythm rule
# switches off there. This is not a compromise between the two goals. It is
# the recognition that one text has one goal, and you know which.
CONTRACTION = re.compile(
    r"\b\w+(?:n't|'ll|'re|'ve|'d)\b|\b(?:it's|that's|there's|here's|let's|you're|we're|i'm)\b",
    re.I,
)
VAGUE_MODAL = re.compile(r"\b(should|would|may|might|could)\b", re.I)
LONG_SENTENCE = 25

# ── Chinese ────────────────────────────────────────────────────────────────
# The same thesis, in a language where the tells are different. Chinese written
# by a machine, or by someone thinking in English, gives itself away in
# punctuation width long before it gives itself away in word choice. A person
# typing Chinese has a full-width comma under their fingers; a machine
# assembling a sentence in English and swapping the characters does not.

CJK = r"一-鿿㐀-䶿"

# Half-width punctuation sitting against a Chinese character. The single
# loudest tell there is, and the one no reader has to think about.
HALF_WIDTH = re.compile(rf"[{CJK}]\s*[,.;:!?]|[,.;:!?]\s*[{CJK}]")
HALF_PAREN = re.compile(rf"[{CJK}]\s*[()]|[()]\s*[{CJK}]")
# Space wedged between two Chinese characters. Nobody types that.
CJK_SPACE = re.compile(rf"[{CJK}] +[{CJK}]")
CJK_DASH = re.compile(r"——")

# Translation-ese: English sentence shapes wearing Chinese characters.
TRANSLATIONESE = re.compile(
    r"進行[一-鿿]{1,4}的?(?:動作|工作|處理)"
    r"|做出[一-鿿]{1,4}的?決定"
    r"|被[一-鿿]{1,6}所"
    r"|基於[一-鿿]{1,6}的考量"
    r"|透過[一-鿿]{1,8}來"
    r"|對[一-鿿]{1,6}進行"
    r"|具有[一-鿿]{1,4}性"
    r"|的話[,，]"
)

# Vocabulary that generated Chinese reaches for far past any human rate.
ZH_WORN = re.compile(
    r"賦能|抓手|顆粒度|閉環|對齊顆粒|生態位|方法論|底層邏輯|"
    r"極大地|有效地|顯著地|全面提升|深度賦能|深耕|聚焦於|"
    r"值得注意的是|需要指出的是|不難發現|由此可見|綜上所述|總而言之|"
    r"在當今[一-鿿]{0,6}的時代|隨著[一-鿿]{2,8}的發展|"
    r"扮演[一-鿿]{0,4}重要的?角色|起到了?[一-鿿]{0,4}作用"
)

# The rule-of-three list, which reads as chosen for its beat rather than its
# content, exactly as it does in English.
# Three parallel items reads as a beat the writer chose. Four is a list, and a
# regex that matches the first three of a longer list is reporting a tic that
# is not there, so every item has to end where the pattern says it ends.
ZH_TRICOLON = re.compile(
    rf"(?<![、，,{CJK}])[{CJK}]{{2,4}}、[{CJK}]{{2,4}}、[{CJK}]{{2,4}}(?![{CJK}、])")


def is_chinese(text):
    cjk = len(re.findall(rf"[{CJK}]", text))
    return cjk >= 50 and cjk / max(1, len(text)) > 0.15


def zh_sentences(text):
    body = re.sub(
        r"<!--\s*no-misread:\s*off\s*-->.*?<!--\s*no-misread:\s*on\s*-->",
        " ", text, flags=re.S | re.I)
    body = re.sub(r"```.*?```", " ", body, flags=re.S)
    body = re.sub(r"`[^`\n]+`", " ", body)
    body = re.sub(r"<[^>]+>", " ", body)
    body = re.sub(r"^#{1,6}\s+.*$", "", body, flags=re.M)
    body = re.sub(rf"^\s*\|.*\|\s*$", "", body, flags=re.M)
    parts = re.split(r"[。！？!?\n]+", body)
    # Chinese rhythm is counted in characters, because a "word" is not a unit
    # the writer feels. The shape of the signal is the same as in English.
    out = []
    for p in parts:
        n = len(re.findall(rf"[{CJK}]", p))
        if n >= 4:
            out.append(n)
    return out


def zh_strip(raw):
    body = re.sub(
        r"<!--\s*no-misread:\s*off\s*-->.*?<!--\s*no-misread:\s*on\s*-->",
        " ", raw, flags=re.S | re.I)
    body = re.sub(r"```.*?```", " ", body, flags=re.S)
    # A bare space here would sit between two Chinese characters and read as a
    # spacing error the author never made.
    body = re.sub(r"`[^`\n]+`", "_CODE_", body)
    body = re.sub(r"<[^>]+>", " ", body)
    body = re.sub(r"\[[^\]]*\]\([^)]*\)", " ", body)
    body = re.sub(r"^\s*>.*$", " ", body, flags=re.M)
    # Ordered-list markers: "1." against a Chinese item is markdown, not a
    # half-width period the author typed into prose.
    body = re.sub(r"^\s*\d+[.)]\s+", "", body, flags=re.M)
    return body


def check_zh(raw):
    """Report the Chinese tells. Same shape of answer as the English pass."""
    body = zh_strip(raw)

    counts = {
        "半形標點": len(HALF_WIDTH.findall(body)),
        "半形括號": len(HALF_PAREN.findall(body)),
        "中文之間有空格": len(CJK_SPACE.findall(body)),
        "破折號": len(CJK_DASH.findall(body)),
        "譯文腔": len(TRANSLATIONESE.findall(body)),
        "AI 常用詞": len(ZH_WORN.findall(body)),
        "三連排比": len(ZH_TRICOLON.findall(body)),
    }
    counts = {k: v for k, v in counts.items() if v}

    lens = zh_sentences(raw)
    r = {"句數": len(lens)}
    if len(lens) >= 5:
        mean = statistics.mean(lens)
        sd = statistics.pstdev(lens)
        lo, hi = mean * (1 - BAND), mean * (1 + BAND)
        share = sum(1 for n in lens if lo <= n <= hi) / len(lens)
        r.update({"平均字數": round(mean, 1), "字數標準差": round(sd, 1),
                  "集中率": round(share, 2), "最短": min(lens), "最長": max(lens),
                  "節奏死板": sd < 8.0 and share > BAND_CEILING})

    marks = {}
    marks.update(find_chars(raw, INVISIBLE))
    total = sum(counts.values()) + sum(marks.values())
    if marks:
        verdict = "有隱形字元,先跑 --strip"
    elif counts.get("半形標點"):
        verdict = "中文裡混了半形標點,這是最明顯的一個破綻"
    elif r.get("節奏死板"):
        verdict = "每句長度太接近,先改節奏"
    elif total == 0:
        verdict = "這支工具看得到的部分都乾淨"
    else:
        verdict = "讀起來像機器寫的"

    return {"語言": "中文", "隱形字元": marks, "問題": counts,
            "節奏": r, "問題總數": total, "結論": verdict}


# ── Which direction is this text going? ────────────────────────────────────
# Nobody should have to pick a mode. A text already carries the evidence of
# who reads it, so read that instead of asking.
#
# Going out means somebody executes it: a prompt, a tool description, a
# procedure, an error message. Those are built from imperatives, and the
# imperative is countable.
#
# Coming back means somebody reads it: an answer, a draft, a post. Those
# carry narration, first person, and past tense.

IMPERATIVE_OPENER = re.compile(
    r"^\s*(?:\d+[.)]\s*|[-*]\s*)?(?:please\s+)?"
    r"(do|don't|use|return|write|set|never|always|call|pass|check|run|add|"
    r"remove|include|avoid|ensure|make|keep|apply|read|send|create|delete|"
    r"start|stop|open|close|select|enter|click|install|configure|specify|"
    r"provide|list|report|reply|answer|output|format|follow|treat|assume)\b",
    re.I,
)
NARRATION = re.compile(r"\b(i|we|my|our|us)\b", re.I)
TOOL_FRONTMATTER = re.compile(r"^---\s*\n(?:.*\n)*?\s*description\s*:", re.M)
IMPERATIVE_SHARE = 0.25


def detect_direction(raw, _unused=None):
    """Return (mode, one-line reason). Countable evidence only.

    Reads the whole text, not the graded subset. Skip regions and block
    quotes control what gets *scored*; they say nothing about who the text
    is for, and a document that hides its own examples would otherwise lose
    the evidence of what it is.
    """
    if TOOL_FRONTMATTER.search(raw):
        return "technical", "frontmatter with a description field: this is a spec someone loads"

    visible = re.sub(r"```.*?```", " ", raw, flags=re.S)
    visible = re.sub(r"`[^`\n]+`", " CODE ", visible)
    visible = re.sub(r"^#{1,6}\s+.*$", "", visible, flags=re.M)
    sents = sentences(visible)
    if len(sents) < 3:
        return "prose", "too little text to tell, defaulting to the reading direction"

    imperative = sum(1 for s in sents if IMPERATIVE_OPENER.match(s))
    share = imperative / len(sents)
    first_person = len(NARRATION.findall(" ".join(sents)))

    if share >= IMPERATIVE_SHARE and first_person <= len(sents) * 0.5:
        return "technical", (f"{imperative} of {len(sents)} sentences open with an "
                             "imperative: somebody executes this")
    return "prose", (f"only {imperative} of {len(sents)} sentences give an order: "
                     "somebody reads this")

HEDGE_STACK = re.compile(
    r"\b(may|might|could|can)\s+(?:potentially|possibly|perhaps|sometimes|often|likely)\b"
    r"|\b(?:it is|it's)\s+(?:possible|likely)\s+that\s+\w+\s+(?:may|might|could)\b"
    r"|\bhelps?\s+to\s+(?:potentially|better)\b",
    re.I,
)

EMOJI_MARKER = re.compile(
    r"^\s*#{1,6}\s*[\U0001F300-\U0001FAFF☀-➿]"
    r"|^\s*[-*]\s*[\U0001F300-\U0001FAFF☀-➿]\s",
    re.M,
)

# Three parallel items. One tricolon is rhetoric; a page of them is a machine.
TRICOLON = re.compile(
    r"(?<!, )\b(\w+),\s+(\w+),\s+and\s+(\w+)\b(?!\s*[,:])",
    re.I,
)

# The and-less drumbeat that closes a short sentence: "Fork it, sell it, keep
# the notice." Regex alone cannot tell it from a plain four-item list, an
# appositive, or a number series, so candidates go through count_drumbeats,
# which is the judgment in code form.
DRUMBEAT = re.compile(
    r"((?:\w+[ '-]){0,2}\w+), ((?:\w+[ '-]){0,2}\w+), ((?:\w+[ '-]){0,2}\w+)(?=[.!?])")


def count_drumbeats(body):
    n = 0
    for m in DRUMBEAT.finditer(body):
        before = body[max(0, m.start() - 12):m.start()]
        if "," in before:
            continue                       # tail of a longer list
        items = [g for g in m.groups()]
        if any(re.search(r"\d", g) for g in items):
            continue                       # number series, "4, then 31, then 9"
        firsts = [g.split()[0].lower() for g in items]
        if len(set(firsts)) < 3:
            continue                       # deliberate anaphora, "then X, then Y"
        line_start = body.rfind("\n", 0, m.start()) + 1
        if body[line_start:line_start + 2].strip().startswith("#"):
            continue                       # headings name things, they do not chant
        sent_start = max(body.rfind(ch, 0, m.start()) for ch in ".!?\n")
        sentence = body[sent_start + 1:m.end()]
        if len(sentence.split()) > 12:
            continue                       # a long sentence listing three facts
        n += 1
    return n


# The mirrored contrast, "a symptom report, not a target." In a spec the shape
# is precision ("Hyphens, not dashes"), so it counts in prose only.
MIRROR_CONTRAST = re.compile(r", not (?:a |an |the |your |its )?[\w' -]{2,28}[.!?]")

BOLD_LEAD_BULLET = re.compile(r"^\s*[-*]\s+\*\*[^*]{2,40}\*\*\s*[:—-]", re.M)


# ── Text handling ──────────────────────────────────────────────────────────

def strip_code(text):
    """Remove the spans this file has no business judging.

    Four kinds, and each one is a real class of false positive rather than a
    convenience:

      code           machine typography is correct inside it
      block quotes   someone else's words, which you did not write
      off regions    `<!-- no-misread: off -->` ... `<!-- no-misread: on -->`,
                     for the passage where you quote a tell in order to name it
      links          a URL is not prose

    A document *about* these patterns necessarily contains them. Without the
    off marker this linter scores its own reference files as the worst prose
    it has ever seen, which is true only in the most literal sense.
    """
    text = re.sub(
        r"<!--\s*no-misread:\s*off\s*-->.*?<!--\s*no-misread:\s*on\s*-->",
        " ", text, flags=re.S | re.I)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"~~~.*?~~~", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]+`", " CODE ", text)
    text = re.sub(r"^\s*>.*$", " ", text, flags=re.M)
    text = re.sub(r"https?://\S+", " URL ", text)
    text = re.sub(r"^\s{4,}\S.*$", " ", text, flags=re.M)
    return text


def sentences(text):
    """Split prose into sentences, and refuse to invent any.

    Markdown tables and tight bullet lists have no sentence-ending punctuation
    between rows, so a naive split glues a whole table into one 68-word
    monster. That inflates the length check and wrecks the rhythm measurement,
    which is the one number this tool exists to report. A table is not prose:
    drop it. A list item is its own unit: break on the line, not the full stop.
    """
    body = re.sub(r"^\s*\|.*\|\s*$", "", text, flags=re.M)      # table rows
    body = re.sub(r"^\s*[-:| ]{4,}\s*$", "", body, flags=re.M)  # table rules
    body = re.sub(r"^#{1,6}\s+.*$", "", body, flags=re.M)       # headings
    body = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "\n", body, flags=re.M)

    parts = []
    for line in re.split(r"\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)", body):
        parts.extend(re.split(r"(?<=[.!?])[\s\"')\]]+", line))
    return [" ".join(p.split()) for p in parts if len(p.split()) >= 3]


def find_chars(raw, table):
    hits = {}
    for ch, name in table.items():
        n = raw.count(ch)
        if n:
            hits[name] = n
    return hits


# Detection research calls this burstiness. Measured heads-up, generated prose
# packs most of its sentences into one narrow band while human prose spreads
# from a few words to fifty and past it, with no centre. Two numbers describe
# that, and the second one matters more:
#
#   stdev_words   the spread. One long outlier can carry it, so it is not
#                 sufficient on its own.
#   band_share    the share of sentences sitting within 25% of the mean. This
#                 is the shape the research actually describes, and a single
#                 outlier cannot hide a packed middle from it.
#
# A text is called metronomic when the spread is small AND the middle is
# packed. Requiring both keeps a deliberately terse passage from being
# reported as machine-written for the crime of being short.
BAND = 0.25
STDEV_FLOOR = 5.0
BAND_CEILING = 0.70


def rhythm(sents, profile=None):
    lengths = [len(s.split()) for s in sents]
    if len(lengths) < 5:
        return {"sentences": len(lengths), "measurable": False}
    mean = statistics.mean(lengths)
    sd = statistics.pstdev(lengths)
    lo, hi = mean * (1 - BAND), mean * (1 + BAND)
    inside = sum(1 for n in lengths if lo <= n <= hi)
    share = inside / len(lengths)
    out = {
        "sentences": len(lengths),
        "measurable": True,
        "mean_words": round(mean, 1),
        "stdev_words": round(sd, 1),
        "band_share": round(share, 2),
        "shortest": min(lengths),
        "longest": max(lengths),
        "reads_metronomic": sd < STDEV_FLOOR and share > BAND_CEILING,
    }
    # With a calibrated profile the comparison stops being against a constant
    # and starts being against this author. Somebody whose own writing runs at
    # a spread of 14 has a problem at 7 that the fixed floor never sees.
    if profile:
        base = profile.get("rhythm", {}).get("stdev_words")
        if base:
            out["your_usual_stdev"] = base
            out["flat_for_you"] = sd < base * FLAT_FOR_YOU
            if out["flat_for_you"]:
                out["reads_metronomic"] = True
    return out


# ── The profile: what this author actually does ────────────────────────────
# Every entry has to come from a measurement of writing the author produced
# without a model. A guess in here is worse than no profile, because it gets
# applied silently on every run afterwards.
#
# Two halves, and both are required. profile/voice.json is machine-readable
# and read on every check, so the next run uses it without thinking.
# profile/learnings.md is the human-readable why, so a person can judge six
# weeks later whether it still holds. Data with no explanation is
# unauditable; an explanation with no data change never fires.

FLAT_FOR_YOU = 0.6      # a draft under 60% of your usual spread reads flat FOR YOU
KEEP_MIN_HITS = 2       # a word is yours only if it recurs
KEEP_MIN_RATE = 1000    # ...at least once per this many words


def profile_path():
    """Where the profile lives, in the order a person would expect.

    A writing voice belongs to a person, not to whatever directory they
    happened to run the command from. An earlier version defaulted to
    ./profile/voice.json, which wrote a personal profile into whichever
    project was open and then failed to find it from anywhere else.

      NOMISREAD_PROFILE   an explicit path wins
      ./profile/voice.json  a repository with a house voice, checked in
      ~/.no-misread/voice.json  otherwise: yours, across every project
    """
    env = os.environ.get("NOMISREAD_PROFILE")
    if env:
        return env
    local = os.path.join("profile", "voice.json")
    if os.path.exists(local):
        return local
    return os.path.join(os.path.expanduser("~"), ".no-misread", "voice.json")


PROFILE_PATH = profile_path()


def load_profile(path=None):
    try:
        with open(path or profile_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def learn(paths, path=None):
    """Measure samples the author wrote WITHOUT a model, and record what they do.

    Appends. An earlier observation is never silently dropped: when a fresh
    sample contradicts an old entry the newer one wins and the old reason
    stays in the record with its date, so the change can be argued with.
    """
    texts, files = [], []
    for p in paths:
        try:
            texts.append(open(p, encoding="utf-8").read())
            files.append(p)
        except OSError:
            continue
    if not texts:
        raise SystemExit("no readable samples")

    joined = "\n\n".join(strip_code(t) for t in texts)
    words = len(joined.split())
    sents = sentences(joined)
    if len(sents) < 20:
        raise SystemExit(
            f"only {len(sents)} sentences across {len(files)} file(s). "
            "Calibration needs more: aim for 2,000+ words of your own writing, "
            "or the profile records noise and then applies it to everything.")

    measured = rhythm(sents)

    # Which "worn" words does this author genuinely use? Frequency in their
    # own unassisted prose is the evidence. A finance writer who says
    # leverage six times means it; the list was never about them.
    hits = {}
    for m in WORN_WORDS.finditer(joined):
        w = m.group(0).lower()
        hits[w] = hits.get(w, 0) + 1
    floor = max(KEEP_MIN_HITS, words // KEEP_MIN_RATE)
    keep = {w: n for w, n in hits.items() if n >= floor}

    path = path or profile_path()
    prof = load_profile(path) or {"allow": [], "history": []}
    today = datetime.date.today().isoformat()
    known = {e["term"] for e in prof.get("allow", [])}
    for w, n in sorted(keep.items()):
        if w not in known:
            prof.setdefault("allow", []).append({
                "term": w,
                "why": f"appears {n} times in {words} words of your own writing",
                "added": today,
            })

    prof["rhythm"] = {k: measured[k] for k in
                      ("mean_words", "stdev_words", "band_share", "shortest", "longest")
                      if k in measured}
    prof["samples"] = {"files": len(files), "words": words, "sentences": len(sents)}
    prof["calibrated"] = today
    prof.setdefault("history", []).append({
        "date": today, "files": len(files), "words": words,
        "stdev_words": prof["rhythm"].get("stdev_words"),
    })
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(prof, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return prof


PATTERN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patterns")


def model_phrases():
    """Phrases mined from a specific model's own generations.

    Ships empty until a corpus earns entries: tools/mine_patterns.py measures,
    a person curates, and only phrases that recur across unrelated tasks get
    a line. Nothing goes in this folder by feel.
    """
    out = []
    try:
        for f in sorted(os.listdir(PATTERN_DIR)):
            if not f.endswith(".txt"):
                continue
            for line in open(os.path.join(PATTERN_DIR, f), encoding="utf-8"):
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    out.append(line)
    except OSError:
        pass
    return out


def check(raw, profile=None, mode="auto"):
    """mode = "auto" (read the text and decide), or force "prose" / "technical".

    Auto is the interface. Nobody should have to classify their own text
    before a tool will look at it, and the text already says which way it is
    going.
    """
    body = strip_code(raw)
    sents = sentences(body)
    words = max(1, len(body.split()))
    allowed = {e["term"].lower() for e in (profile or {}).get("allow", [])}

    if mode == "auto":
        mode, why = detect_direction(raw)
        chose = "detected"
    else:
        why = "you asked for it"
        chose = "forced"

    marks = {}
    marks.update(find_chars(raw, INVISIBLE))
    marks.update(find_chars(raw, ODD_SPACE))
    typo = {}
    for ch, (name, _) in TYPOGRAPHY.items():
        n = strip_code(raw).count(ch)
        if n:
            typo[name] = n

    # A word the author demonstrably uses in their own unassisted writing is
    # their word, not a tell. The generic list was never about them.
    worn = [m.group(0) for m in WORN_WORDS.finditer(body)]
    kept = [w for w in worn if w.lower() in allowed]
    worn = [w for w in worn if w.lower() not in allowed]

    counts = {
        # A semicolon splices two sentences that wanted to be two sentences.
        # Generated prose leans on it; so does prose translated from an
        # outline. Code spans are already stripped, so this counts prose only.
        "semicolon": body.count(";"),
        "worn_word": len(worn),
        "empty_adverb": len(EMPTY_ADVERB.findall(body)),
        "contrast_frame": len(CONTRAST_FRAME.findall(body)),
        "throat_clearing": len(THROAT_CLEARING.findall(body)),
        "wrap_up": len(WRAP_UP.findall(body)),
        "false_emphasis": len(FALSE_EMPHASIS.findall(body)),
        "false_agency": len(FALSE_AGENCY.findall(body)),
        "passive": len(PASSIVE.findall(body)),
        "hedge_stack": len(HEDGE_STACK.findall(body)),
        "tricolon": len(TRICOLON.findall(body)),
        "emoji_marker": len(EMOJI_MARKER.findall(body)),
        "bold_lead_bullet": len(BOLD_LEAD_BULLET.findall(body)),
    }

    if mode == "technical":
        counts["contraction"] = len(CONTRACTION.findall(body))
        counts["vague_modal"] = len(VAGUE_MODAL.findall(body))
        counts["over_25_words"] = sum(1 for s in sents if len(s.split()) > LONG_SENTENCE)
    else:
        counts.update(narrative(body, sents))
        drum = count_drumbeats(body)
        if drum:
            counts["tricolon"] = counts.get("tricolon", 0) + drum
        mirror = len(MIRROR_CONTRAST.findall(body))
        if mirror:
            counts["contrast_frame"] = counts.get("contrast_frame", 0) + mirror

    phrases = model_phrases()
    if phrases:
        low = body.lower()
        hits = sum(low.count(ph) for ph in phrases)
        if hits:
            counts["model_phrase"] = hits

    counts = {k: v for k, v in counts.items() if v}

    # Uniform sentences are correct when a reader scans under pressure, so the
    # rhythm rule is reported in technical mode and never enforced there.
    r = rhythm(sents, profile if mode == "prose" else None)
    if mode == "technical":
        r["reads_metronomic"] = False
        r["note"] = "even lengths are correct here: a scanning reader wants one shape"

    total = sum(counts.values()) + sum(marks.values()) + sum(typo.values())

    out = {
        "words": words,
        "direction": ("going out to a machine" if mode == "technical"
                      else "coming back to a person"),
        "direction_why": f"{chose}: {why}",
        "profile": "applied" if profile else "none (generic thresholds)",
        "invisible_marks": marks,
        "machine_typography": typo,
        "tells": counts,
        "rhythm": r,
        "tells_total": total,
        "tells_per_100w": round(100.0 * total / words, 2),
        "verdict": verdict(total, marks, r),
    }
    if kept:
        out["yours_not_flagged"] = sorted({w.lower() for w in kept})
    return out


def verdict(total, marks, r):
    if marks:
        return "carries invisible characters: run --strip first"
    if r.get("flat_for_you"):
        return (f"flatter than you usually write: spread {r['stdev_words']} "
                f"against your {r['your_usual_stdev']}")
    if r.get("reads_metronomic"):
        return "sentence lengths sit too close together: vary them before anything else"
    if total == 0:
        return "clean of everything this file can see"
    if total <= 3:
        return "close: fix the listed tells"
    return "reads as machine-written"


def strip(raw):
    """Erase the machine marks. Characters change, words do not."""
    out = raw
    for ch in INVISIBLE:
        out = out.replace(ch, "")
    for ch in ODD_SPACE:
        out = out.replace(ch, " ")
    for ch, (_, repl) in TYPOGRAPHY.items():
        out = out.replace(ch, repl)
    out = unicodedata.normalize("NFC", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r" +([,.;:!?])", r"\1", out)
    out = re.sub(r"[ \t]+$", "", out, flags=re.M)
    return out


# ── Self-test ──────────────────────────────────────────────────────────────

DIRTY = (
    "Here's the thing: in today's fast-paced landscape, teams must leverage "
    "robust, comprehensive, and innovative tooling to unlock value.​ It's "
    "not just about speed, it's about culture. The data tells us that adoption "
    "is significantly delayed. Results were seen across the board. This may "
    "potentially help teams navigate the journey — and that's okay. "
    "In conclusion, let that sink in."
)

CLEAN = (
    "We shipped the parser on Tuesday.\n\n"
    "It broke twice that week. Both times the input had a byte-order mark at "
    "the front of the file, which our reader treated as part of the first "
    "field name, so every lookup missed by one character and returned nothing "
    "at all. Ravi found it. He added four lines to the reader and a test that "
    "feeds it a marked file.\n\n"
    "Nobody has reported it since."
)


ZH_DIRTY = (
    "在當今快速變化的時代,我們需要透過系統性的方法來進行深度賦能。"
    "這不只是一個工具,更是一種方法論——它能夠有效地提升團隊的協作顆粒度。"
    "值得注意的是,底層邏輯的對齊會起到關鍵作用。"
    "我們聚焦於效率、品質、成本這三個面向,並且全面提升整體產出。"
    "綜上所述,這個方案具有極大的可行性。"
)

ZH_CLEAN = (
    "我們星期二上線。它那週壞了兩次。\n"
    "兩次都是因為檔案開頭多了一個看不見的字元，讀檔的程式把它當成欄位名稱的一部分，"
    "所以每一次查詢都差了一個字，回傳的結果永遠是空的。\n"
    "後來 Ravi 找到了。他在讀檔那邊加了四行，順手補了一個測試。\n"
    "從那之後沒有人再回報過。\n"
    "我到現在還是覺得那四行應該早一點寫。"
)


def self_test():
    d = check(DIRTY)
    assert d["invisible_marks"], d
    assert d["machine_typography"], d
    assert d["tells"]["worn_word"] >= 4, d["tells"]
    assert d["tells"]["throat_clearing"] >= 1, d["tells"]
    assert d["tells"]["contrast_frame"] >= 1, d["tells"]
    assert d["tells"]["false_agency"] >= 1, d["tells"]
    assert d["tells"]["hedge_stack"] >= 1, d["tells"]
    assert d["tells"]["tricolon"] >= 1, d["tells"]
    assert d["tells"]["wrap_up"] >= 1, d["tells"]
    assert d["tells"]["false_emphasis"] >= 1, d["tells"]
    assert d["tells"]["passive"] >= 1, d["tells"]

    stripped = strip(DIRTY)
    assert not check(stripped)["invisible_marks"], "strip left invisible characters"
    assert not check(stripped)["machine_typography"], "strip left machine typography"

    c = check(CLEAN)
    assert not c["invisible_marks"], c
    assert c["tells_total"] == 0, c["tells"]
    assert not c["rhythm"]["reads_metronomic"], c["rhythm"]

    # A profile has to change what the checker does, or it is a note nobody
    # acts on. Same text, two answers.
    prof = {"allow": [{"term": "leverage", "why": "test", "added": "2026-01-01"}],
            "rhythm": {"stdev_words": 20.0}}
    generic = check("We leverage the pipeline. We leverage the queue too.")
    tuned = check("We leverage the pipeline. We leverage the queue too.", prof)
    assert generic["tells"].get("worn_word") == 2, generic["tells"]
    assert "worn_word" not in tuned["tells"], tuned["tells"]
    assert tuned["yours_not_flagged"] == ["leverage"], tuned
    flat = check(CLEAN, prof)
    assert flat["rhythm"]["flat_for_you"], flat["rhythm"]

    # The two modes disagree about exactly three things, and agree elsewhere.
    tech_text = ("It's possible the upload could fail. You shouldn't retry it "
                 "more than three times because the server may throttle you and "
                 "then the whole batch has to start over from the first record.")
    p_rep = check(tech_text, None, "prose")
    t_rep = check(tech_text, None, "technical")
    assert "contraction" not in p_rep["tells"], p_rep["tells"]
    assert t_rep["tells"]["contraction"] >= 2, t_rep["tells"]
    assert t_rep["tells"]["vague_modal"] >= 2, t_rep["tells"]
    assert t_rep["tells"]["over_25_words"] >= 1, t_rep["tells"]
    flatlines = "\n".join(["The parser reads a row and writes it to the queue."] * 6)
    assert check(flatlines, None, "prose")["rhythm"]["reads_metronomic"]
    assert not check(flatlines, None, "technical")["rhythm"]["reads_metronomic"]

    # Auto is the interface: the text says which way it is going.
    orders = ("Return only the rewritten text. Do not add a preamble. "
              "Use the shortest wording that keeps the meaning. "
              "Never invent a fact the source did not state. "
              "Check the output before you send it.")
    story = ("We shipped the parser on Tuesday and it broke twice that week. "
             "Ravi found the byte-order mark on Thursday afternoon. "
             "I had spent two days looking at the wrong file. "
             "Nobody has reported it since we added the test.")
    assert check(orders)["direction"].startswith("going out"), check(orders)["direction_why"]
    assert check(story)["direction"].startswith("coming back"), check(story)["direction_why"]
    assert "detected" in check(orders)["direction_why"]
    assert "forced" in check(orders, None, "prose")["direction_why"]
    frontmatter = "---\nname: x\ndescription: does a thing\n---\n\nA short body here."
    assert check(frontmatter)["direction"].startswith("going out")

    # Chinese: the loudest tell is punctuation width, not word choice. A
    # person typing Chinese has a full-width comma under their fingers.
    assert is_chinese(ZH_DIRTY), "language detection missed Chinese"
    zd = check_zh(ZH_DIRTY)
    assert zd["問題"].get("半形標點"), zd
    assert zd["問題"].get("破折號"), zd
    assert zd["問題"].get("AI 常用詞"), zd
    zc = check_zh(ZH_CLEAN)
    assert not zc["問題"], zc

    skeleton = (
        "The tool has a purpose. It reads the queue. It writes the log. "
        "It sends the report.\n\n"
        "Furthermore, the design has other merits that deserve a mention "
        "here as well. On the one hand the queue is fast, while on the other "
        "hand the log is durable and complete.\n\n"
        "Moreover, the rollout went well according to the team that ran it. "
        "Every region reported a clean upgrade within the first hour there.\n\n"
        "Additionally, costs fell during the quarter after the change landed. "
        "Nobody has asked for a rollback of the change since it shipped.")
    sk = check(skeleton, None, "prose")["tells"]
    assert sk.get("same_opener_run", 0) >= 3, sk
    assert sk.get("transition_opener_chain", 0) >= 2, sk
    assert sk.get("both_sides_frame"), sk
    assert "same_opener_run" not in check(CLEAN, None, "prose")["tells"]
    assert "transition_opener_chain" not in check(CLEAN, None, "prose")["tells"]

    print("self-test OK")
    print("  dirty:", d["tells_total"], "tells,", d["tells_per_100w"], "per 100w")
    print("  clean:", c["tells_total"], "tells, rhythm stdev", c["rhythm"]["stdev_words"])
    print("  profile: suppresses a word you own, and flags prose flat for you")


def main():
    args = sys.argv[1:]
    if not args or "--help" in args or "-h" in args:
        print(__doc__)
        return 0
    if "--self-test" in args:
        self_test()
        return 0

    if "--learn" in args:
        samples = [a for a in args[args.index("--learn") + 1:] if not a.startswith("-")]
        if not samples:
            raise SystemExit("usage: --learn <files you wrote without a model>")
        prof = learn(samples)
        r = prof["rhythm"]
        print(f"calibrated from {prof['samples']['files']} file(s), "
              f"{prof['samples']['words']} words")
        print(f"  your spread: stdev {r['stdev_words']} words "
              f"(mean {r['mean_words']}, {r['shortest']} to {r['longest']})")
        allow = [e["term"] for e in prof.get("allow", [])]
        print(f"  words kept as yours: {', '.join(allow) if allow else 'none'}")
        print(f"  written to {profile_path()}")
        print("Now record WHY in profile/learnings.md. A number with no reason "
              "cannot be argued with in six weeks.")
        return 0

    action = "--strip" if "--strip" in args else "--check"
    mode = "auto"
    if "--type" in args:
        mode = args[args.index("--type") + 1]
        if mode not in ("prose", "technical", "auto"):
            raise SystemExit("--type takes auto, prose or technical")
    src = args[-1]
    raw = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()

    if action == "--strip":
        sys.stdout.write(strip(raw))
        return 0

    # Language is detected the same way direction is: read the text.
    if "--lang" in args:
        lang = args[args.index("--lang") + 1]
    else:
        lang = "zh" if is_chinese(raw) else "en"

    if lang == "zh":
        report = check_zh(raw)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 1 if report["問題總數"] else 0

    report = check(raw, load_profile(), mode)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if report["tells_total"] else 0


if __name__ == "__main__":
    sys.exit(main())
