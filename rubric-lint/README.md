# rubric-lint

Deterministic anti-slop rubric scorer for the humanizer eval loop
(issue #80). Python3 stdlib only - no pip deps, no network, no clocks.
Same input -> same output, byte-identical. Score polarity matches the
pangram `ai_score` the Eval Tick consumes: **0 = human-clean,
100 = worst/AI-ish**.

## Run

```bash
RUBRIC_PORT=8790 python3 server.py        # host
sh fetch_python.sh && docker build -t shared-person/rubric-lint .  # image
```

## API

- `GET /health` -> `{ok: true, version}`
- `POST /score {text, lang: 'ru'|'en'}` ->
  ```json
  {
    "score": 88,
    "findings": [
      {"rule": "en-ai-phrase", "severity": 1,
       "span": [0, 27], "text": "In today's fast-paced world",
       "suggestion": "..."}
    ],
    "metrics": {"stdev_words": 3.9, "band_share": 0.79,
                "nominalization_density": 0.022, "marker_density": 49.4,
                "emdash_per_1k": 0, "transition_per_1k": 4.1,
                "passive_per_1k": 8.2, "mean_words": 15.7,
                "sentences": 14, "words": 201,
                "weighted_rate_per_1k": 231.3},
    "lang": "en", "version": "0.1.0"
  }
  ```
  `severity`: 1 = warn, 2 = error. `span` offsets address the caller's
  input verbatim (excluded regions - code, quotes, URLs - are masked,
  never re-offset).
- `POST /diff {original, rewritten, protected_terms[]}` ->
  `{mismatches: [{type: 'number'|'date'|'entity'|'protected'|'url'|
  'code', original, rewritten}]}` - fact/entity preservation: numbers
  (any digit-bearing token incl. `900ms`/`p99`/`100%`), dates (ISO,
  dotted, EN + RU month names), URLs, inline/fenced code, capitalized
  multi-word proper-noun chunks and `protected_terms` must survive
  verbatim. Items are multiset-compared; leftovers pair by position
  (numbers additionally by digit-masked shape), so `rewritten` shows
  what the fact changed into or `null` for dropped/invented.

## Scoring model

`score = 100 * rate / (rate + 25)` where `rate` is the
severity*weight-summed hits per 1k words - a saturating hyperbola in
the krrkt shape (weighted-hits-per-words). Single occurrences are
**warn at most**; severity 2 is reserved for document-level density
violations (per the slopless FP-avoidance audit). Per-1k rates floor
at 80 words - a tiny cell cannot establish a density.

Dedupe: one span, one flag - overlapping matches from different rules
collapse onto the strongest-weighted one.

## Rule inventory

### Shared

| rule | sev | what |
|---|---|---|
| `burstiness` | 2 | vendored nomisread `rhythm()`: stdev_words < 5 AND band_share > 0.70, or < 60% of this language's calibrated voice.json stdev (`flat_for_you`). Terse human prose passes the AND-gate. |
| `marker-density` | 2 | warn-hits per 1k words > 40 with >=5 hits - the density itself is the tell. |

### EN (sources: wsc aiTells dicts, slopless phrase dicts, nomisread regexes - see NOTICE.md)

| rule | what |
|---|---|
| `en-ai-vocab` | wsc aiTellsVocabulary (98 entries + inflections; Kobak/Juzek/Liang-cited) |
| `en-ai-phrase` | wsc aiTellsPhrases (83 literal formulas) |
| `en-struct-<name>` | wsc aiTellsPatterns (12 regexes): negative-parallelism, not-only-but-also, trailing-participial-analysis, vague-attribution, audience-hedge, despite-challenges, copula-puffery, pivotal-role-claim, false-range, unfilled-placeholder, meta-announcement, dance-metaphor |
| `en-seo-filler` / `en-corporate-speak` / `en-cliche` / `en-prohibited-phrase` / `en-weasel-attribution` | slopless phrase dicts (32/102/831/10/35 entries) |
| `en-llm-disclaimer` | chatbot self-disclosure left in prose - the one rule that is error-severity per occurrence (unambiguous evidence) |
| `en-hedge` | wsc impersonal hedges subset ("it is worth noting", "one could argue"; personal hedges excluded) |
| `en-filler-adverb` | wsc fillerAdverbs (weight 0.5, capped findings) |
| `en-nominalization` | wsc nominalization pairs w/ verb suggestions; severity 2 when density > 18/1k |
| `en-emdash-density` | em/en dash CHARACTERS per 1k > 5 (spaced ASCII hyphens deliberately not counted - human keyboard habit) |
| `en-transition-density` / `en-transition-opener-chain` | formal transition adverbs per 1k > 12 / >=2 paragraphs opening with one |
| `en-worn-word`, `en-contrast-frame`, `en-throat-clearing`, `en-wrap-up`, `en-false-emphasis`, `en-false-agency`, `en-hedge-stack`, `en-mirror-contrast`, `en-tricolon`, `en-drumbeat-triads`, `en-same-opener-run`, `en-uniform-paragraphs`, `en-passive-density` | vendored nomisread structural/narrative rules |

### RU (own layer - mined from fixtures/humanizer/ai_flop + generic канцелярит, NOT a translation of the EN lists)

| rule | what |
|---|---|
| `ru-stamp` | ~50 канцелярит/штампы/neuroslop marker regexes: в современном мире, важно/стоит/нельзя не отметить, осуществлять, играет ключевую роль (adjective required - a literal "играет роль" is spared), синергия, бесшовн-, глубокое погружение, в заключении, ... each carrying a specific fix suggestion |
| `ru-stamp-soft` | ordinary connectors that are warn-only at half weight: при этом, кроме того, более того, таким образом, вместе с тем, в рамках |
| `ru-nominalization` | suffix-regex share of ALL word tokens: -ание/-ение/-ствие at full weight, plus a small curated -ость list (возможность, необходимость, ...) at half weight; severity 2 when the hard share > 0.14. -тельн-/-ци- were dropped - they match far more ordinary lexicon (функция, станция, внимательный) than nominalizations |
| `ru-long-sentence` | sentences > 35 words; severity 2 when share > 30% |
| `ru-negation-reframe` | strict "это не X — это Y" only (plain "не ..., а ..." is ordinary Russian, excluded after FP audit) |
| `ru-typography` | typographically perfect «ёлочки» paired with a typographic dash in one casual post (weight 0.5 - straight quotes are the human habit, not the tell) |

pymorphy3 was evaluated for RU POS-confirm and deliberately skipped:
the suffix regex is honest about what it sees and keeps the image
zero-dep.

## Calibration (voice.json)

`voice.json` ships generated - do not hand-edit:

```bash
python3 tools/learn_voice.py          # regenerate from clean_human fixtures
python3 tools/learn_voice.py --check  # CI drift check
```

The calibration corpus is exactly
`fixtures/humanizer/clean_human/{en,ru}.txt` - the only committed,
verifiably human-authored sample the repo carries. Repo docs/prompts
are agent-written prose and `context/` is gitignored, so neither may
feed a baseline that has to regenerate byte-identically on a clean
checkout. That leaves ~16 sentences per language - honestly recorded
as `thin_calibration: true` in the profile and echoed in `/score`
metrics. A thin-but-verified profile is a documented small-sample
estimate; a fat-but-corrupted one is a silent wrong baseline.

Each language's `rhythm.stdev_words` feeds the burstiness
`flat_for_you` comparison (`sd < base * 0.6`, with the same
`band_share` gate the fixed floor keeps), per the vendored
nomisread profile convention.

## Eval Tick integration

`HUMANIZER_SCORER=rubric` routes each scoring step through a
synchronous `POST $RUBRIC_URL/score` (default
`http://127.0.0.1:8790`, no queue - the service is local+fast). The
response maps onto the existing score record: `score`, `label`
(stub's bands: >=75 AI Generated / >=45 Possibly AI / else Possibly
human), `via: 'rubric'` -> ledger `scorer_backend: 'rubric'`, and
`findings` -> `marker_spans [{text, span, marker_type: rule,
reason: suggestion}]` for the partner's `detector_payload`. An
unreachable service or a bad response shape escalates
`scorer_failed` - honest, never a silent stub fallback.

`HUMANIZER_SCORER=rubric+judge` (issue #82) is the atomic composite:
the same `/score` call PLUS a blind `fluency-judge` role verdict via
`$LLM_GATEWAY_URL/run` (`JUDGE_ROLE`), blended
`final = max(rubric, round(judge * 0.8))` - this service's score is
the deterministic floor the LLM leg can never under-score. Either
leg down escalates `scorer_failed`; there is no rubric-only settle.
Validate the judge against the fixture tiers with
`tools/check_judge.py --live` before enabling it.

## Docker

`FROM n8n-local` like the siblings, but the flattened base ships node
only - the interpreter is a host-fetched artifact (`edge/caddy`
pattern): `sh fetch_python.sh` reuses a uv-managed python-build-
standalone or downloads one; `python/` is .gitignored. Healthcheck
probes `/health` with the vendored interpreter (no curl/wget in the
base). Compose service `shared-person-rubric` on `RUBRIC_PORT=8790`,
`network_mode: host` like every service in the stack.

## Harness

`python3 tools/check_rubric.py` - imports the engine in-process (no
network): tier ordering per language, clean-corpus FP budget,
determinism, response shape, span integrity, burstiness AND-gate, RU
detectors, /diff mutation classes, spans.json parity, density model,
voice.json drift.
