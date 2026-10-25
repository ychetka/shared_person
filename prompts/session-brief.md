# Task template: extract a content brief from a Devin session

You are a subagent. Your job: turn a development session into a
**content brief** - a JSON object matching
`code/brief/schema.json` in the shared_person repo. The brief is the
ONLY material the post writer gets. If a fact is not in the brief, it
does not exist. If a fact is in the brief but not true, the post is a
lie. Verify everything.

## Inputs (fill before dispatch)

- Session history: `{{SESSION_HISTORY_PATH}}`
  (e.g. `~/.local/share/devin/cli/summaries/history_<id>.md` or a local
  copy under `materials/`)
- Repo: `{{REPO_PATH}}`
- Optional hints from the user: `{{USER_HINTS}}`

## Procedure

1. Read the session history file end to end. Note what was planned,
   what was actually built, what broke, what was thrown away.
2. In `{{REPO_PATH}}` read, if present: `AGENTS.md`, `TASKS.md`,
   `README*`, `docs/`. Run `git log --oneline -30` (more if the arc
   needs it) and skim `git show` of the commits that matter. Check
   GitHub issues/PRs if the repo has them (`git remote -v` gives the
   public URL; `gh issue list` or the GitHub API lists tasks).
3. **Verify every fact against the code.** Named libraries must appear
   in manifests/imports. Versions must match package files or actual
   binary versions mentioned in the history. Numbers (ports, limits,
   counts, timings) must come from the history or the repo - not from
   your estimate. If the history claims X but the code shows Y, trust
   the code and note the discrepancy in `author_notes`.
4. Collect the arc: plan > attempt > failure > fix > outcome. Failures
   and falsified approaches are the core of the story - do not sanitize
   them.
5. Fill `links[]`: the public repo URL (type `repo`) plus task/issue/PR
   references the session actually worked on (type `issue`/`pr`) and
   relevant docs (type `doc`). Only links you verified exist - never
   guess URLs.
6. Propose `scope`: one or two sentences bounding the post - what it
   covers and what it deliberately leaves out (e.g. strategy internals,
   P&L). Fill `accents[]` with 1-5 emphasis points the writer must
   foreground.
7. Collect available media: screenshots, diagrams, terminal captures,
   log excerpts produced during the session (e.g. under
   `materials/photos/` or the repo). List real local paths in `media[]` -
   check each with ls. Do not list files that do not exist.
8. Fill `viz_data[]` - the structured datasets a chart renderer can
   draw from. Session posts get GENERATED visualizations, not archive
   photos, so this field is where real numbers become media. For every
   measured quantity in the session (backtest stats, latency figures,
   request counts, per-asset results, component topology) emit one
   `viz_data` entry:

   - `id`: stable slug (`backtest-totals`, `pipeline-topology`)
   - `kind`:
     - `stats` - headline numbers as label/value pairs:
       `data: {"items": [{"label": "trades", "value": 2593}]}`
     - `series` - values over a category/time axis, one or more named
       series: `data: {"x": ["BTC", "ETH"], "series": [{"name":
       "avgR", "data": [-0.89, -1.02]}]}`
     - `distribution` - repeated measurements: `data: {"values":
       [...]}` or pre-binned `{"bins": [...], "counts": [...]}`
     - `topology` - pipeline/architecture: `data: {"nodes": [{"id",
       "label"}], "edges": [{"from", "to", "label"?}]}`
   - `unit` when it applies (`"R"`, `"ms"`, `"%"`)
   - `source`: where each number was verified (issue id, commit, log
     file, transcript line)

   Rules: every number in `viz_data` must appear in the session/repo
   verbatim - no derived estimates unless the arithmetic is trivial
   and noted in `source`. If the session produced nothing measurable
   and no topology worth diagramming, leave `viz_data` empty - the
   viz-spec pass can still decline to chart, but it cannot invent
   data you did not provide.
9. Fill `forbidden_claims[]` with anything that plausibly could sneak
   into a draft but is not confirmed: profit figures, metrics nobody
   measured, employer/internal details.
10. Sanitize: no tokens, API keys, chat_ids, public IPs, home-directory
   paths or employer data anywhere in the output.

## Output

Return ONLY the JSON object - no prose, no markdown fences. It must
validate against `code/brief/schema.json`:

- `source_type`: `"session"`
- `topic`: one line, concrete
- `links[]`: `{type, url, label}` - repo URL plus verified issue/PR/doc
  references
- `scope`: proposed bounds of the post
- `accents[]`: 1-5 emphasis points
- `facts[]`: each string carries a number, version, or named
  library/method. Target 5-12 facts. No generalities
  ("improved performance" is not a fact; "build time dropped from 40s
  to 9s" is).
- `arc`: as above; omit fields that genuinely do not apply
- `media[]`, `viz_data[]`, `platform_fit[]`, `retro: false`
- `forbidden_claims[]`, `author_notes`

If the session is too thin for a post (no arc, <3 verifiable facts),
say so plainly instead of padding - output `{"error": "insufficient
material", "missing": [...]}`.
