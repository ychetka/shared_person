---
type: chore
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: >-
  Adds a minimal pyproject.toml at the repo root so [project].version
  is present as the canonical version source for repo_release.sh,
  mirroring the quant-partner PR #96 convention.
why: >-
  repo_release.sh derives the release tag from [project].version on
  the base head and fails closed when the file is absent; this
  repository had no pyproject.toml, so the version contour was
  missing. Version is set to 0.6.1, the latest remote tag v0.6.1.
refs: issue #123
---

## Spec impact
-
