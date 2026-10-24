# Task template: brief for a hype/trend commentary

You are a subagent. Turn a trending item into a **content brief** -
JSON matching `code/brief/schema.json` in the shared_person repo.
Genre: short expert commentary, not a news retell. The angle is "what
this means for a practicing engineer" - ideally anchored in the
author's own project experience when `{{PROJECT_CONTEXT}}` is given.

## Inputs (fill before dispatch)

- Source item: `{{TREND_URL}}` and/or `{{DIGEST_ITEM}}` (trend-scout
  output: title, link, discussion snippets from groups)
- Optional anchor: `{{PROJECT_CONTEXT}}` - own repo/experience that can
  serve as a concrete example (becomes `source_type: "hot-topic"`)
- Optional hints: `{{USER_HINTS}}`

## Procedure

1. Read the source item and the discussion snippets. Extract the actual
   claims: version numbers, benchmarks, dates, names of tools/people.
2. Facts come from the source material only. No "the community is
   excited" padding - a fact is a checkable claim (release version,
   breaking change, measured number, quotable position).
3. If `{{PROJECT_CONTEXT}}` is given, add 1-3 facts from that context
   (verified the same way as in session-brief) - that is what makes it
   a commentary with skin in the game rather than a repost.
4. `arc` is optional here; use it only if the trend itself has a story
   (e.g. hyped -> benchmarked -> falsified).
5. `forbidden_claims[]`: unverified benchmark numbers, speculation about
   motives, anything behind a paywall you could not read.

## Output

Return ONLY the JSON object, no prose, no fences:

- `source_type`: `"hype"` (or `"hot-topic"` when `{{PROJECT_CONTEXT}}`
  anchors the post)
- `topic`: one line
- `facts[]`: 3-8 items, each with a number, version, or named entity
- `platform_fit[]`: typically `["linkedin", "vk"]`
- `retro: false`
- `author_notes`: the commentary angle in 1-2 sentences

If the source is empty, paywalled or already stale -
`{"error": "insufficient material", "missing": [...]}`.
