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
   GitHub issues if the repo has them.
3. **Verify every fact against the code.** Named libraries must appear
   in manifests/imports. Versions must match package files or actual
   binary versions mentioned in the history. Numbers (ports, limits,
   counts, timings) must come from the history or the repo - not from
   your estimate. If the history claims X but the code shows Y, trust
   the code and note the discrepancy in `author_notes`.
4. Collect the arc: plan > attempt > failure > fix > outcome. Failures
   and falsified approaches are the core of the story - do not sanitize
   them.
5. If the post could use images, list real local paths in `media[]`
   (e.g. under `materials/photos/`). Paths must exist - check with ls.
6. Fill `forbidden_claims[]` with anything that plausibly could sneak
   into a draft but is not confirmed: profit figures, metrics nobody
   measured, employer/internal details.
7. Sanitize: no tokens, API keys, chat_ids, public IPs, home-directory
   paths or employer data anywhere in the output.

## Output

Return ONLY the JSON object - no prose, no markdown fences. It must
validate against `code/brief/schema.json`:

- `source_type`: `"session"`
- `topic`: one line, concrete
- `facts[]`: each string carries a number, version, or named
  library/method. Target 5-12 facts. No generalities
  ("improved performance" is not a fact; "build time dropped from 40s
  to 9s" is).
- `arc`: as above; omit fields that genuinely do not apply
- `media[]`, `platform_fit[]`, `retro: false`
- `forbidden_claims[]`, `author_notes`

If the session is too thin for a post (no arc, <3 verifiable facts),
say so plainly instead of padding - output `{"error": "insufficient
material", "missing": [...]}`.
