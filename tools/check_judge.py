#!/usr/bin/env python3
"""check_judge.py - fixture-tier validation harness for the
fluency-judge role (issue #82).

The composite 'rubric+judge' scorer in sp-humanizer-eval blends the
LLM judge's fluency verdict into the deterministic rubric floor, so
the judge must be VALIDATED against the fixture tiers before its
score is trusted: clean_human must rank better than borderline,
borderline better than ai_flop, ai_flop better than broken_fluency -
on the judge's own polarity (0-100, HIGHER = WORSE fluency, same as
ai_score).

  J1  role contract: roles/fluency-judge.yaml parses, points at an
      existing prompts/fluency-judge.txt, and declares the strict
      output schema ({score 0-100, rationale, issues[] with optional
      span / required problem+severity, additionalProperties:false
      at both levels);
  J2  contract validator: accepts a compliant verdict, rejects a
      score out of range, a missing rationale, an extra key, a bad
      severity and an issue with an unexpected property - the same
      shape the gateway's ajv enforces server-side;
  J3  recorded verdicts: the checked-in per-tier responses validate
      and rank clean_human < borderline < ai_flop < broken_fluency
      (worse) on the EN fixtures - the regression floor the live model
      must beat;
  J4  --live only: POSTs the REAL role to $LLM_GATEWAY_URL/run for
      every EN fixture cell, validates each live verdict against the
      contract, hard-fails unless broken_fluency scores strictly worse
      than clean_human (a fluency judge MUST separate genuinely broken
      grammar from fluent text), and warns (not fails) when the slop
      ordering doesn't hold - ai_flop and borderline/en are both
      fluent prose, so live ordering there can legit drift; prints the
      report.

Default mode is mock/recorded - NO network, CI-safe. Live validation
against the real gateway is opt-in:

    python3 tools/check_judge.py           # mock mode (exit 0 = pass)
    python3 tools/check_judge.py --live    # hits LLM_GATEWAY_URL
"""

import json
import os
import sys
import urllib.request

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "fixtures", "humanizer")
ROLE_PATH = os.path.join(ROOT, "roles", "fluency-judge.yaml")
PROMPT_PATH = os.path.join(ROOT, "prompts", "fluency-judge.txt")

LIVE = "--live" in sys.argv[1:]
GATEWAY = os.environ.get("LLM_GATEWAY_URL", "http://127.0.0.1:8787").rstrip("/")
JUDGE_ROLE = os.environ.get("JUDGE_ROLE", "fluency-judge").strip() or "fluency-judge"

TIERS = ("clean_human", "borderline", "ai_flop", "broken_fluency")
SEVERITIES = ("minor", "major", "fatal")

failures = []


def check(name, cond, detail=""):
    if cond:
        print("ok  ", name)
    else:
        print("FAIL", name, ("- " + str(detail)[:200]) if detail else "")
        failures.append(name)


def fixture(tier, lang="en"):
    with open(os.path.join(FIX, tier, lang + ".txt"), encoding="utf-8") as fh:
        return fh.read()


def valid_verdict(obj):
    """The fluency-judge output contract, mirrored from the role
    schema - kept dependency-free (the gateway's ajv copy is the
    enforcement side; this is the harness's read of the same shape).
    Returns None when valid, else the first contract break."""
    if not isinstance(obj, dict):
        return "verdict is not an object"
    extra = set(obj) - {"score", "rationale", "issues"}
    if extra:
        return f"extra keys {sorted(extra)}"
    for k in ("score", "rationale", "issues"):
        if k not in obj:
            return f"missing {k}"
    if not isinstance(obj["score"], (int, float)) or isinstance(obj["score"], bool):
        return "score is not a number"
    if not 0 <= obj["score"] <= 100:
        return f"score {obj['score']} out of 0-100"
    if not isinstance(obj["rationale"], str):
        return "rationale is not a string"
    if not isinstance(obj["issues"], list):
        return "issues is not an array"
    for i, it in enumerate(obj["issues"]):
        if not isinstance(it, dict):
            return f"issues[{i}] is not an object"
        iextra = set(it) - {"span", "problem", "severity"}
        if iextra:
            return f"issues[{i}] extra keys {sorted(iextra)}"
        if "problem" not in it or "severity" not in it:
            return f"issues[{i}] missing problem/severity"
        if "span" in it and it["span"] is not None and not isinstance(it["span"], str):
            return f"issues[{i}] span is neither string nor null"
        if not isinstance(it["problem"], str):
            return f"issues[{i}] problem is not a string"
        if it["severity"] not in SEVERITIES:
            return f"issues[{i}] severity {it['severity']!r} not in {SEVERITIES}"
    return None


# --- J1 role manifest + schema contract --------------------------------
role = yaml.safe_load(open(ROLE_PATH, encoding="utf-8"))
schema = ((role or {}).get("output") or {}).get("schema") or {}
issue_item = ((schema.get("properties") or {}).get("issues") or {}).get("items") or {}
check(
    "J1 role: manifest parses, prompt file exists, name/prompt agree",
    role.get("name") == "fluency-judge"
    and role.get("prompt") == "fluency-judge"
    and os.path.exists(PROMPT_PATH),
    {k: role.get(k) for k in ("name", "prompt", "backend", "model")},
)
check(
    "J1 role schema: strict shape - required keys, no extra props",
    schema.get("type") == "object"
    and schema.get("additionalProperties") is False
    and set(schema.get("required") or []) == {"score", "rationale", "issues"}
    and set(schema.get("properties") or {}) == {"score", "rationale", "issues"}
    and (schema["properties"]["score"] or {}).get("minimum") == 0
    and (schema["properties"]["score"] or {}).get("maximum") == 100
    and issue_item.get("additionalProperties") is False
    and set(issue_item.get("required") or []) == {"problem", "severity"}
    and "span" in (issue_item.get("properties") or {})
    and "span" not in (issue_item.get("required") or []),
    {"required": schema.get("required"), "itemRequired": issue_item.get("required")},
)

# --- J2 contract validator arms -----------------------------------------
good = {"score": 42, "rationale": "r", "issues": [{"problem": "p", "severity": "major"}]}
check("J2 contract: compliant verdict accepted (span omitted)", valid_verdict(good) is None)
good2 = dict(good, issues=[{"span": "it seems", "problem": "p", "severity": "minor"}])
good3 = dict(good, issues=[{"span": None, "problem": "p", "severity": "fatal"}])
check(
    "J2 contract: span + null-span forms accepted",
    valid_verdict(good2) is None and valid_verdict(good3) is None,
)
bad_cases = [
    dict(good, score=120),
    dict(good, score="high"),
    {k: v for k, v in good.items() if k != "rationale"},
    dict(good, note="extra"),
    dict(good, issues=[{"problem": "p", "severity": "terrible"}]),
    dict(good, issues=[{"problem": "p", "severity": "minor", "offset": 3}]),
    dict(good, issues=[{"problem": "p"}]),
]
check(
    "J2 contract: malformed verdicts rejected",
    all(valid_verdict(b) is not None for b in bad_cases),
    [valid_verdict(b) for b in bad_cases],
)


# --- J3 recorded verdicts (mock mode, CI-safe) ---------------------------
# Recorded tier responses in the role's output shape - the harness's
# offline stand-in for the live model. They double as the schema
# fixtures and as the ranking floor: any regression in the role
# prompt/schema that changes the contract breaks J3 before a live
# call is ever made.
RECORDED = {
    "clean_human": {
        "score": 8,
        "rationale": "Fluent native register throughout: uneven sentence "
        "rhythm, concrete detail and no grammar breaks. The terse "
        "fragments are deliberate style, not damage.",
        "issues": [
            {
                "span": None,
                "problem": "occasional abrupt fragment, clearly stylistic",
                "severity": "minor",
            }
        ],
    },
    "borderline": {
        "score": 44,
        "rationale": "Understandable throughout but recurrently stiff: "
        "several translated-sounding collocations and a metronome "
        "rhythm a native reader would notice.",
        "issues": [
            {
                "span": "The estimate is charged optimistically at enqueue",
                "problem": "stiff passive construction reads translated",
                "severity": "major",
            },
            {
                "span": None,
                "problem": "uniform sentence length across the text",
                "severity": "minor",
            },
        ],
    },
    "ai_flop": {
        "score": 78,
        "rationale": "Pervasive unnatural phrasing: formulaic openers, "
        "cliched collocations and an unbroken metronome rhythm give "
        "the whole text a generated feel even where single sentences "
        "parse.",
        "issues": [
            {
                "span": "In today's fast-paced world",
                "problem": "stock machine opener",
                "severity": "major",
            },
            {
                "span": "plays a vital role",
                "problem": "cliched collocation reads translated",
                "severity": "major",
            },
            {
                "span": None,
                "problem": "uniform sentence length across the whole text",
                "severity": "major",
            },
        ],
    },
    "broken_fluency": {
        "score": 90,
        "rationale": "Severe grammatical breakage throughout: "
        "subject-verb disagreement, missing and wrong articles, "
        "garbled word order and tense chaos on nearly every sentence. "
        "The text is understandable in intent but does not parse as "
        "fluent English anywhere.",
        "issues": [
            {
                "span": "The deploy was goes yesterday",
                "problem": "subject-verb disagreement and broken tense",
                "severity": "fatal",
            },
            {
                "span": "there was not no way for forward the requests",
                "problem": "double negation and garbled infinitive phrase",
                "severity": "fatal",
            },
            {
                "span": None,
                "problem": "missing articles across the whole text",
                "severity": "major",
            },
        ],
    },
}


def judge_mock(tier, _text):
    # copy so a caller mutating a verdict can't corrupt the fixture
    return json.loads(json.dumps(RECORDED[tier]))


def judge_live(_tier, text):
    body = json.dumps(
        {
            "role": JUDGE_ROLE,
            "input": json.dumps({"source_text": text, "language": "en"}),
        }
    ).encode()
    req = urllib.request.Request(
        GATEWAY + "/run", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read().decode())
    return out.get("json") if isinstance(out.get("json"), dict) else out


def run_tiers(judge):
    """Score every EN tier through `judge(tier, text)`, validate each
    verdict against the contract, and return {tier: verdict}."""
    verdicts = {}
    for tier in TIERS:
        v = judge(tier, fixture(tier, "en"))
        verdicts[tier] = v
        err = valid_verdict(v)
        check(f"verdict[{tier}]: contract-valid judge output", err is None, err)
    return verdicts


def report(verdicts):
    print("\ntier          score  issues")
    for tier in TIERS:
        v = verdicts[tier]
        print(f"{tier:<13} {v.get('score')!s:>5}  {len(v.get('issues') or [])}")


if LIVE:
    print(f"--live: POST {GATEWAY}/run role={JUDGE_ROLE} per EN fixture tier")
    try:
        verdicts = run_tiers(judge_live)
    except Exception as e:  # noqa: BLE001 - report and fail honestly
        check("live: gateway reachable and role answered", False, str(e))
        verdicts = None
    if verdicts is not None:
        report(verdicts)
        scores = {t: verdicts[t]["score"] for t in TIERS}
        # Hard fail only on the FLUENCY axis the judge exists to catch:
        # broken_fluency is genuinely broken grammar and MUST score
        # strictly worse than clean_human. The slop ordering
        # (clean_human < borderline < ai_flop) is a WARNING, not a
        # fail: slop can be perfectly fluent, so a live model that
        # scores ai_flop at or below clean_human is reporting a legit
        # fluency outcome - treat it as a drift signal only.
        check(
            "J4 live: broken_fluency scores strictly worse than clean_human",
            scores["broken_fluency"] > scores["clean_human"],
            scores,
        )
        if not scores["clean_human"] < scores["borderline"] < scores["ai_flop"]:
            print(
                "warn J4 live: strict order clean < borderline < ai_flop "
                f"not held - slop can be fluent, treat as drift "
                f"signal not failure: {scores}"
            )
else:
    verdicts = run_tiers(judge_mock)
    report(verdicts)
    scores = {t: verdicts[t]["score"] for t in TIERS}
    check(
        "J3 recorded: clean_human < borderline < ai_flop (higher=worse)",
        scores["clean_human"] < scores["borderline"] < scores["ai_flop"],
        scores,
    )
    check(
        "J3 recorded: broken_fluency scores strictly worst (> ai_flop)",
        scores["broken_fluency"] > scores["ai_flop"],
        scores,
    )
    # the composite blend in Eval Tick: max(rubric, round(judge*0.8)) -
    # the judge floor ordering must survive the dampening too, so the
    # recorded verdicts also rank after *0.8
    damped = {t: round(scores[t] * 0.8) for t in TIERS}
    check(
        "J3 recorded: tier order survives the 0.8 blend dampening",
        damped["clean_human"] < damped["borderline"] < damped["ai_flop"],
        damped,
    )
    check(
        "J3 recorded: broken_fluency stays worst after dampening",
        damped["broken_fluency"] > damped["ai_flop"],
        damped,
    )

print()
if failures:
    print(f"{len(failures)} check(s) FAILED")
    sys.exit(1)
print("all checks passed")
