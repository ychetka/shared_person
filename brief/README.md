# Brief - the contract between sources and writers

Content model: **source > brief > draft**.

Every post starts as a *source*, gets condensed by an extractor into a
*brief* (a JSON object conforming to `schema.json`), and only then goes
to `sp-content-gen` which writes platform drafts strictly from the
brief. An empty or thin brief is refused by the brief gate in the
workflow - this is the fix for invented stories: if there is no
material, the pipeline says so instead of hallucinating.

## Sources and extractors

| source_type | extractor | genre |
|---|---|---|
| `session` | Devin subagent with `../prompts/session-brief.md` - reads session history + repo (AGENTS.md, git log, TASKS.md/issues) | build story with an arc: plan > done > dropped |
| `hype` | trend-scout output + `../prompts/hype-brief.md` - link + group discussions | short expert commentary |
| `hot-topic` | popular topic + own project context as the example | opinion piece anchored in own experience |
| `retro` | archive picker - photo + frameworks from `archive_content_guide.md` | retrospective / STAR / value post |

Repo convention: pet projects keep `AGENTS.md` + `TASKS.md` (or GitHub
issues) - the session extractor reads them as the arc source.

## Schema fields (`schema.json`)

- `source_type` - enum, see table.
- `topic` - one-line subject.
- `links[]` - `{type: repo|issue|pr|doc, url, label}`. Verifiable public
  links only - the writer may reference exactly these and must never
  invent URLs.
- `scope` - bounds of the article: what the post covers and, implicitly,
  what stays out. The writer must stay inside it.
- `accents[]` - 1-5 emphasis points the writer must foreground.
- `facts[]` - verifiable statements, each carrying a number, version,
  named library/method or a measurable claim. The workflow gate counts
  digit-bearing tokens, so facts without them do not pass.
- `arc` - `{plan, attempt, failure, fix, outcome}`. Honest failures are
  the most valuable part.
- `media[]` - local paths to usable images (screenshots, diagrams, logs
  excerpts); must exist at pipeline time.
- `viz_data[]` - structured datasets for GENERATED charts (session
  posts): `{id, kind: stats|series|distribution|topology, title?, unit?,
  data, source?}`. Session drafts skip archive-photo selection - the
  `viz-spec` role picks 0-2 datasets and `tools/render_viz.py` draws
  them. Every number must come from the source material verbatim.
- `platform_fit[]` - linkedin | facebook | vk | instagram |
  youtube-shorts | tiktok.
- `retro` - archival content flag; retro posts are marked as such in the
  text, never presented as current work.
- `forbidden_claims[]` - claims that must not leak into drafts
  (unverified metrics, private hosts/paths, employer data).
- `author_notes` - free-form hints for the writer.

## Passing a brief to the pipeline

`POST /webhook/content-gen` accepts `context` - put the serialized
brief JSON there (the workflow parses it and picks up `links`, `scope`
and `accents` automatically). `scope` and `accents[]` may also be passed
as top-level payload fields - explicit fields win over the serialized
brief. The gate requires `context` >= 200 chars and >= 2 digit-bearing
tokens, otherwise it answers "no material in brief" in Telegram and
skips generation.

## Example

`example-session-brief.json` - a filled brief from the stone-ellipse
session (rootless n8n + LLM trading pipeline, repo trade-ai-analitic).
Validate any brief with:

```bash
python3 -c "import json; json.load(open('schema.json'))"
node -e "const Ajv=require('ajv'); ..."   # if ajv is available
```
