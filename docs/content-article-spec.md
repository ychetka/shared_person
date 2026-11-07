# Content article spec (issue #44)

Posts are ARTICLES now (developer decision 2026-11-07): a generated post
is a structured long-read - logical blocks + build timeline +
structural diagrams - instead of a single-paragraph note. This document
is the canonical spec; the platform writers (`prompts/writer-vk.txt`,
`prompts/writer-linkedin.txt`) carry a compressed operational copy, and
Generate Drafts (sp-content-gen) wires the structured output into the
render pipeline.

## Canonical spec

Agreed with comms-partner; the text below is the contract verbatim.

- 6-block skeleton: B1 Friction Hook (VK 400-600 chars / LI 250-350) |
  B2 Constraints & Rejections (800-1200 / 350-450) | B3 Build Timeline
  arc T0->T1->T2->Now incl. one wrong turn/pivot (1800-2500 / 700-900) |
  B4 System Architecture: nodes, contracts, failure recovery (1500-2200
  / 600-750) | B5 Telemetry & Trade-offs real numbers + what's still
  broken/simulated (600-900 / 300-400) | B6 Peer Prompt CTA - real
  question, never 'follow for more' (200-300 / 150-200).
- Visual mapping (prefer render_viz over image-gen): B3 MANDATORY
  timeline diagram; B4 MANDATORY topology diagram with payload types on
  edges; B2 comparison matrix if >=3 options; B5 metric chart or
  <=20-line code snippet; B1 optional hero only if blueprint-style.
  >=2 rendered visuals per article; [See Fig N] pointers since
  wall.post/ugcPosts attach media as bottom grid not inline.
- Tone: first-person practitioner; concrete nouns (endpoints, fields,
  tools); banned lexicon EN (delve/tapestry/testament/game-changer/
  unleash/harness/ever-evolving/symphony/beacon/seamless/supercharge/
  'in today's fast-paced world'/'let's dive in') + RU equivalents
  (погрузиться/гобелен/симфония/в современном быстро меняющемся мире/
  без лишних слов/уникальный/революционный/поднять на новый уровень/
  не секрет что); honesty constraint - state live vs simulated
  explicitly; no moralizing summaries.
- Platform compression: LinkedIn hard cap 3000 (target <=2800) - merge
  B1+B2 to ~4 lines, B3 timestamped bullets, B4 detail moves into
  diagram; VK full length ~5.3-7.7k chars. Structural markers: VK
  '[NN / Заголовок]' or '=== NN ===' plain-text headers; LI
  '[NN // Title]' compact markers.

## Block reference

- **B1 Friction Hook** - the concrete pain or edge case that forced the
  work. No rhetorical questions, no throat-clearing.
- **B2 Constraints & Rejections** - what was tried and rejected, the
  constraints that killed each option. When >=3 options were compared
  this block feeds the comparison-matrix visual.
- **B3 Build Timeline** - the build arc as dated milestones T0 -> T1 ->
  T2 -> Now, including exactly one wrong turn/pivot told honestly. This
  is the old dev-log "what did > what broke > how fixed" stretched over
  a timeline.
- **B4 System Architecture** - the current system as nodes, contracts
  and failure recovery. Detail that would bloat the text moves into the
  topology diagram (especially on LinkedIn).
- **B5 Telemetry & Trade-offs** - real numbers only (they must exist in
  the brief facts), plus an explicit statement of what is still broken
  or simulated vs live. Alternatively a <=20-line code snippet inline.
- **B6 Peer Prompt** - one genuine question to practitioners working on
  the same class of problem. Never a subscribe/follow CTA.

## Visual mapping and the viz task list

Visuals are produced by the pipeline, not pasted by the writer. The
writer emits a `visuals[]` task list in its JSON output; Generate
Drafts renders each task through the host renderer
(`tools/render_viz.py --serve`) or, for `type:"image"`, through the
llm-gateway `/image` endpoint. Prefer render_viz over image-gen - the
article diagrams are structural, not illustrative.

| Block | Visual | Chart type | Dataset kind | When |
|-------|--------|------------|--------------|------|
| B1 | hero image | `image` (gateway) | - | optional, blueprint-style only |
| B2 | comparison matrix | `matrix` | `matrix` | >=3 rejected/compared options |
| B3 | timeline diagram | `timeline` | `timeline` | MANDATORY |
| B4 | topology diagram | `pipeline` | `topology` | MANDATORY, payload types on edges |
| B5 | metric chart | `stat-cards`/`bar`/`line` | `stats`/`series`/`distribution` | optional (or inline <=20-line snippet) |

Rules:

- >=2 rendered visuals per article; B3+B4 alone satisfy the floor.
- Media attach as a bottom grid on both target platforms
  (VK wall.post, LinkedIn ugcPosts) - nothing is inline. Text points at
  figures with `[See Fig N]` pointers (RU: `[см. Fig N]`).
- Dataset payloads are inline in the writer output (the writer never
  sees `viz_data[]` from the brief); every number and node must trace
  back to brief facts - the facts-only rule covers diagram data too.
- Total attached media per draft is capped at 4 by content-gen; the
  legacy session/image/archive paths only fill slots the article
  visuals leave free.

## Writer JSON output contract

Backward-compatible extension - `text` stays the fully assembled
article so existing consumers (moderation draft, previews, publish
drivers) need no changes:

```json
{
  "platform": "vk|linkedin",
  "lang": "ru|en",
  "text": "<complete article, block markers included>",
  "hashtags": ["..."],
  "comment_link": "<linkedin only, unchanged>",
  "blocks": [
    {"id": "B1", "title": "Friction Hook", "chars": 512}
  ],
  "visuals": [
    {"block": "B3", "type": "timeline", "title": "...",
     "caption": "...", "options": {},
     "dataset": {"kind": "timeline",
                 "data": {"milestones": [{"t": "T0", "label": "...",
                                          "detail": "...", "pivot": false}]}}},
    {"block": "B1", "type": "image", "prompt": "...",
     "caption": "..."}
  ]
}
```

- `text` - REQUIRED, the entire article assembled with block headers
  and `[See Fig N]` pointers in place.
- `blocks` - optional per-block manifest (id, title, char count); an
  aid to moderation and future block-level rewrites.
- `visuals` - optional viz task list; Generate Drafts turns each entry
  into a renderer spec plus a synthetic `viz_data` entry. `dataset`
  uses the same `{kind, data}` shape as brief `viz_data[]` (see
  `brief/schema.json`); `type:"image"` entries instead carry `prompt`.
- A legacy writer response (`{platform, lang, text, hashtags}` with no
  `blocks`/`visuals`) stays valid - the pipeline just gets no article
  media from it.

## Pipeline wiring (sp-content-gen / Generate Drafts)

1. Pass 2 writer output is parsed as before (`parsed.text` -> draft
   text -> humanizer -> critic verify). The critic input also carries
   `visuals` - one flattened claim line per `visuals[]` task
   (`visual k <type>/<block> "title": key=value; ...`) - so dataset
   numbers and labels are fact-checked against `facts` exactly like
   the draft text (issue #52; the key is absent when `visuals[]` is
   empty).
2. After the verify pass, `parsed.visuals[]` is read off the FINAL
   parsed object. Renderable entries (non-`image` type with a
   `dataset.data` payload) become `{type, viz_id, title, caption,
   options}` specs; each `dataset` registers as a synthetic `viz_data`
   entry `{id, kind, title, unit, data}` keyed by a derived `viz_id`.
   `type:"image"` entries become gateway `/image` calls.
3. The renderer returns `paths` which append to `mediaSel.selected` -
   the same field the session viz-spec, image-gen and media-selector
   paths already write - and land on `draft.media` via the
   moderation-draft dispatch, attached as the bottom media grid at
   publish time.
4. Render results are collected per task and attached in requested
   `visuals[]` order (the chart batch still runs before the image
   calls, but attach order follows `visuals[]`), so the attach index
   IS the figure number. After all render attempts the
   `[See Fig N]` / `[см. Fig N]` pointers in `draft.text` are
   rewritten to the final attach order (issue #51); a task that
   produced no attached media loses its pointer entirely - no
   dangling references - and adds a `fig N render failed: ...` entry
   to `draft.warnings`, which lands on the moderation card's
   [WARNINGS] block. `caption_note` lists the RENDERED figures in
   attach order (`Fig N: type/block`), not the requested task list.
   The draft still goes to moderation on any render failure; visual
   tasks are logged under `stage:"viz"` / `stage:"image"` with
   `source:"article-visuals"`.

## Platform notes

- **VK** - full-length article (~5.3-7.7k chars), Russian, dev-log
  register. Block headers as `[NN / Заголовок]` or `=== NN ===`
  plain-text markers.
- **LinkedIn** - separately generated compressed rewrite: hard cap
  3000 chars, target <=2800. Developer decision 2026-11-07:
  per-platform **rewrite-to-fit** - the LinkedIn version is a
  compressed regeneration of the article, NOT a truncation of the VK
  text. B1+B2 merge to ~4 lines, B3 becomes timestamped bullets, B4
  detail moves into the diagram. Markers: `[NN // Title]`.
- **Facebook** - OUT OF SCOPE for the article skeleton. The FB publish
  driver is not shipped in sp-publish (fb drafts park in `skipped/`
  with "no driver for platform fb"), and the FB format stays the short
  discussion post until the driver lands. `prompts/writer-fb.txt`
  carries a pointer here and keeps its current contract.

## Tone and honesty constraints

- First-person practitioner voice; concrete nouns - endpoints, fields,
  tool names, versions.
- Honesty constraint: what runs live vs what is simulated/mocked is
  stated explicitly (B5 is the natural home). No inflated claims.
- No moralizing summaries - the article ends on the peer question, not
  a lesson.
- The banned lexicon from the canonical spec applies on top of the
  existing per-writer hard rules (no em-dash, no emoji bullets,
  facts-only, first person singular, "falsified" wording rule,
  transliterated tech terms for RU).
