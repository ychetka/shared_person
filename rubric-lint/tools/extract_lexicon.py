#!/usr/bin/env python3
"""extract_lexicon.py - build rubric-lint/data/en_lexicon.json from the
vendored-source downloads.

Sources (all MIT, see rubric-lint/NOTICE.md):

  wsc (theserverlessdev/wsc, master) src/core/words.ts
    - aiTellsVocabulary  -> "ai_vocab"      [{term, variants, reason}]
    - aiTellsPhrases     -> "ai_phrases"    [{phrase, reason}]
    - aiTellsPatterns    -> "ai_patterns"   [{name, pattern, reason}]
    - hedgingPhrases     -> "hedges"        impersonal subset only
    - nominalizations    -> "nominalizations" [{word, suggestion}]
    - fillerAdverbs      -> "filler_adverbs"  [word]

  slopless (berelevant-ai/slopless, main) src/rules/phrases/data/*.json
    - seo-filler.json, corporate-speak.json, cliches.json,
      prohibited-phrases.json, weasel-attribution.json,
      llm-disclaimer-expansions.json  -> same-named sections

Usage:
  python3 extract_lexicon.py WORDS_TS SLOPLESS_DIR OUT_JSON

The hedging list is filtered to impersonal frames ("it is worth noting",
"one could argue") - the personal hedge entries ("I think", "I believe")
fire on every honest first-person draft and are excluded for false-
positive avoidance, matching the slopless density-audit discipline.
"""

import json
import re
import sys


def unquote_js(s):
    """Decode a JS single/double-quoted string literal body."""
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            out.append({"n": "\n", "t": "\t", "r": "\r"}.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def parse_obj_list(src, array_name):
    """Pull {word: '...', variants: [...], reason: '...'} shaped object
    literals out of `export const <array_name> = [...]`."""
    m = re.search(
        r"export const " + re.escape(array_name) + r"\s*:[^=]*=\s*\[",
        src)
    if not m:
        m = re.search(
            r"export const " + re.escape(array_name) + r"\s*=\s*\[", src)
    if not m:
        return []
    start = m.end()
    depth = 1
    i = start
    # bracket walk must skip over '...'/"..." literals - patterns like
    # "\[(?:your name...)" carry unbalanced brackets inside strings
    while depth and i < len(src):
        c = src[i]
        if c in "'\"":
            j = i + 1
            while j < len(src) and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            i = j + 1
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
        i += 1
    body = src[start:i - 1]
    # objects may contain {n,m} regex quantifiers - walk brace depth
    # instead of a [^{}] character-class match
    objs = []
    depth = 0
    obj_start = None
    j = 0
    while j < len(body):
        c = body[j]
        if c in "'\"":
            k = j + 1
            while k < len(body) and body[k] != c:
                k += 2 if body[k] == "\\" else 1
            j = k + 1
            continue
        if c == "{":
            if depth == 0:
                obj_start = j
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and obj_start is not None:
                objs.append(body[obj_start:j + 1])
                obj_start = None
        j += 1
    out = []
    for o in objs:
        ent = {}
        for key in ("word", "phrase", "name", "reason", "suggestion",
                    "pattern"):
            km = re.search(
                key + r"\s*:\s*'((?:[^'\\]|\\.)*)'", o) or re.search(
                key + r'\s*:\s*"((?:[^"\\]|\\.)*)"', o)
            if km:
                ent[key] = unquote_js(km.group(1))
        vm = re.search(r"variants\s*:\s*\[([^\]]*)\]", o)
        if vm:
            ent["variants"] = [
                unquote_js(x) for x in
                re.findall(r"'((?:[^'\\]|\\.)*)'", vm.group(1))]
        if ent:
            out.append(ent)
    return out


def parse_string_list(src, array_name):
    m = re.search(
        r"export const " + re.escape(array_name) +
        r"[^=]*=\s*\[([^\]]*)\]", src, re.S)
    if not m:
        return []
    return [unquote_js(x) for x in
            re.findall(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"",
                       m.group(1)) for x in x if x]


# impersonal hedge frames only - personal hedges ("I think") are a voice
# feature, not an AI tell
def is_impersonal_hedge(p):
    return bool(re.match(
        r"(it |one |needless|there |this |the evidence|remains|time )"
        r"|(in my opinion|in my view)", p))


def main():
    words_ts, slopless_dir, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    src = open(words_ts, encoding="utf-8").read()

    hedges = [p for p in parse_string_list(src, "hedgingPhrases")
              if is_impersonal_hedge(p.lower())]

    lex = {
        "ai_vocab": parse_obj_list(src, "aiTellsVocabulary"),
        "ai_phrases": parse_obj_list(src, "aiTellsPhrases"),
        "ai_patterns": parse_obj_list(src, "aiTellsPatterns"),
        "hedges": hedges,
        "nominalizations": parse_obj_list(src, "nominalizations"),
        "filler_adverbs": parse_string_list(src, "fillerAdverbs"),
    }
    for name in ("seo-filler", "corporate-speak", "cliches",
                 "prohibited-phrases", "weasel-attribution",
                 "llm-disclaimer-expansions"):
        with open(f"{slopless_dir}/{name}.json", encoding="utf-8") as fh:
            lex[name.replace("-", "_")] = json.load(fh)

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(lex, fh, indent=1, ensure_ascii=False, sort_keys=True)
        fh.write("\n")
    counts = {k: len(v) for k, v in lex.items()}
    print(json.dumps(counts, indent=1))


if __name__ == "__main__":
    main()
