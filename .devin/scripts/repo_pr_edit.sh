#!/usr/bin/env bash
# repo_pr_edit.sh - update a PR's title/body through the hygiene gate.
# Usage: repo_pr_edit.sh <pr_number> [--title "..."] [--body "..."]
# Output JSON: {pr_number, status}
set -uo pipefail
DEVIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOP=$(git rev-parse --show-toplevel 2>/dev/null || git -C code rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 1; }
cd "$TOP"

PR="${1:?usage: repo_pr_edit.sh <pr_number> [--title ...] [--body ...]}"
shift || true
TITLE=""; BODY=""; HAS_TITLE=0; HAS_BODY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:?--title needs text}"; HAS_TITLE=1; shift 2 ;;
    --body)  BODY="${2:?--body needs text}";  HAS_BODY=1;  shift 2 ;;
    *) echo '{"status":"error","failure_class":"malformed_input","message":"unknown arg"}'; exit 2 ;;
  esac
done
[ $HAS_TITLE -eq 1 ] || [ $HAS_BODY -eq 1 ] || {
  echo '{"status":"error","failure_class":"malformed_input","message":"--title or --body required"}'; exit 2; }

HYGIENE_OUT=$(printf '%s\n%s\n' "$TITLE" "$BODY" | "$DEVIN_DIR/scripts/hygiene_check.sh")
if [ $? -ne 0 ]; then
  HYGIENE_OUT="$HYGIENE_OUT" python3 -c 'import json,os
try: v=json.loads(os.environ["HYGIENE_OUT"])
except Exception: v={"raw": os.environ["HYGIENE_OUT"]}
print(json.dumps({"status":"error","failure_class":"gate_blocked","violations":v.get("violations",v)}))'
  exit 2
fi

# gh api PATCH avoids the deprecated projectCards GraphQL field that
# makes `gh pr edit` fail on gh 2.46.x against current GitHub.
ARGS=()
[ $HAS_TITLE -eq 1 ] && ARGS+=(-f title="$TITLE")
[ $HAS_BODY -eq 1 ]  && ARGS+=(-f body="$BODY")

OUT=$(gh api -X PATCH "repos/{owner}/{repo}/pulls/$PR" "${ARGS[@]}" --jq .html_url 2>&1) || {
  python3 -c 'import json,sys;print(json.dumps({"status":"error","failure_class":"upstream_error","message":sys.argv[1]}))' "$OUT"
  exit 1
}
python3 -c 'import json,sys;print(json.dumps({"pr_number":int(sys.argv[1]),"status":"updated"}))' "$PR"
