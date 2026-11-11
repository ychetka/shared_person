#!/usr/bin/env bash
# repo_merge.sh <pr_number> <expected_head_sha> — gate + squash merge
# Gate: approved review + green required checks + head == expected sha.
set -e
PR="$1"; EXPECTED="$2"
JSON=$(gh pr view "$PR" --json headRefOid,mergeable,mergeStateStatus,reviews,statusCheckRollup,state)
HEAD=$(printf '%s' "$JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["headRefOid"])')
STATE=$(printf '%s' "$JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
APPROVED=$(printf '%s' "$JSON" | python3 -c 'import json,sys;print(any(r["state"]=="APPROVED" for r in json.load(sys.stdin)["reviews"]))')
BAD=$(printf '%s' "$JSON" | python3 -c 'import json,sys;print([c["name"] for c in json.load(sys.stdin)["statusCheckRollup"] if c.get("conclusion") not in ("SUCCESS","NEUTRAL","SKIPPED",None)])')
if [ "$STATE" != "OPEN" ]; then echo "GATE_BLOCK: pr state=$STATE" >&2; exit 4; fi
if [ "$HEAD" != "$EXPECTED" ]; then echo "GATE_BLOCK: head $HEAD != expected $EXPECTED" >&2; exit 4; fi
if [ "$APPROVED" != "True" ]; then echo "GATE_BLOCK: no approving review" >&2; exit 4; fi
if [ -n "$BAD" ] && [ "$BAD" != "[]" ]; then echo "GATE_BLOCK: failing checks $BAD" >&2; exit 4; fi
# release-notes record gate (issue #95): a PR without a .changes
# fragment, a folded CHANGELOG.md change, or the no-changes-entry
# marker does not merge.
ENTRY=$(bash "$(git rev-parse --show-toplevel)/tools/check_changes_entry.sh" --pr "$PR" 2>&1 | tail -n 1)
echo "$ENTRY" | python3 -c 'import json,sys
sys.exit(0 if json.load(sys.stdin).get("status") == "pass" else 1)' 2>/dev/null \
  || { echo "GATE_BLOCK: missing_changes_entry $ENTRY" >&2; exit 4; }
gh pr merge "$PR" --squash
