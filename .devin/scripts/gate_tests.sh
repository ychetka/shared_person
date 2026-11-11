#!/usr/bin/env bash
# gate_tests.sh - negative tests for the commit-wrapper gates.
# Proves each gate blocks its bypass path in an isolated scratch repo:
#   T1 scope gate: file outside whitelist is rejected (exit 2)
#   T2 scope gate: dir-prefix whitelist entry allows the file
#   T3 migration gate: staged migration without stamp is rejected (exit 3)
#   T4 migration gate: rollback-covered migration gets stamped, commit ok
#   T5 migration stamp invalidates when the migration file changes
#   T8 rename+modify of a stamped migration is blocked
#   T9 staged up+down pair verifies via paired-rollback coverage
#   T6 re-grounding output is emitted on every call
#   T7 hygiene gate still rejects (cyrillic on en-language repo)
# Exits non-zero if any expectation fails. Run from anywhere:
#   .devin/scripts/gate_tests.sh
set -uo pipefail
DEVIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/repo" "$SCRATCH/devin/scripts"
cd "$SCRATCH/repo" && git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init
cp "$DEVIN_DIR/scripts/ship_commit.sh" "$DEVIN_DIR/scripts/migration_gate.sh" \
   "$DEVIN_DIR/scripts/hygiene_check.sh" "$SCRATCH/devin/scripts/"
echo '{"text_language":"en"}' > "$SCRATCH/devin/project.json"

pass=0; fail=0
expect() { # name expected_rc actual_rc [pattern_in_output]
  local name="$1" want="$2" got="$3" pat="${4:-}"
  if [ "$got" != "$want" ]; then
    echo "FAIL $name: expected exit $want, got $got"; fail=$((fail+1)); return
  fi
  if [ -n "$pat" ] && ! grep -q "$pat" "$SCRATCH/out"; then
    echo "FAIL $name: output missing '$pat'"; fail=$((fail+1)); return
  fi
  echo "PASS $name"; pass=$((pass+1))
}

SHIP="$SCRATCH/devin/scripts/ship_commit.sh"
GATE="$SCRATCH/devin/scripts/migration_gate.sh"

# --- T1: scope gate blocks out-of-whitelist staged file
echo 'docs/x.md' > "$SCRATCH/devin/scope_whitelist.txt"
mkdir -p src && echo x > src/evil.py && git add src/evil.py
"$SHIP" "test msg" >"$SCRATCH/out" 2>&1; expect T1-scope-block 2 $? "SCOPE_GATE"
git reset -q

# --- T2: dir-prefix entry allows the file
printf 'src/\ndocs/x.md\n' > "$SCRATCH/devin/scope_whitelist.txt"
git add src/evil.py
"$SHIP" "test msg" >"$SCRATCH/out" 2>&1; expect T2-scope-prefix 0 $?

# --- T3: migration gate blocks unstamped migration
rm "$SCRATCH/devin/scope_whitelist.txt"
mkdir -p db/migrations && printf 'CREATE TABLE t(id int);\n-- rollback: DROP TABLE t;\n' > db/migrations/001_up.sql
git add db/migrations/001_up.sql
"$SHIP" "add migration" >"$SCRATCH/out" 2>&1; expect T3-migration-block 3 $? "MIGRATION_GATE"
git reset -q

# --- T4: rollback-covered migration stamps and commits
git add db/migrations/001_up.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T4a-gate-verifies 0 $? "embedded rollback"
"$SHIP" "add migration" >"$SCRATCH/out" 2>&1; expect T4b-commit-ok 0 $?

# --- T5: stamp invalidates on changed migration file
printf 'ALTER TABLE t ADD COLUMN c int;\n' >> db/migrations/001_up.sql
git add db/migrations/001_up.sql
"$SHIP" "change migration" >"$SCRATCH/out" 2>&1; expect T5-stale-stamp 3 $? "MIGRATION_GATE"
git reset -q --hard HEAD 2>/dev/null || git reset -q

# --- T8: rename+modify cannot smuggle a changed migration under an
# old stamp (pure rename of verified content keeps the stamp - the
# stamp binds staged blob content, not the filename)
git mv db/migrations/001_up.sql db/migrations/002_up.sql
printf 'ALTER TABLE t ADD COLUMN c2 int;\n' >> db/migrations/002_up.sql
git add db/migrations/002_up.sql
"$SHIP" "rename+modify migration" >"$SCRATCH/out" 2>&1; expect T8-rename-modify-block 3 $? "MIGRATION_GATE"
git reset -q --hard HEAD 2>/dev/null || git reset -q

# --- T9: staged up+down pair verifies via paired-rollback coverage
printf 'CREATE TABLE u(id int);\n' > db/migrations/003_up.sql
printf 'DROP TABLE u;\n' > db/migrations/003_down.sql
git add db/migrations/003_up.sql db/migrations/003_down.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T9a-paired-verify 0 $? "paired rollback"
"$SHIP" "migration pair" >"$SCRATCH/out" 2>&1; expect T9b-commit-ok 0 $?

# --- T6: re-grounding emitted on every call (even on gate failures)
echo y > docs_x.md && mkdir -p docs && mv docs_x.md docs/x.md && git add docs/x.md
"$SHIP" "test" >"$SCRATCH/out" 2>&1
grep -q "RE-GROUNDING" "$SCRATCH/out" && { echo "PASS T6-regrounding"; pass=$((pass+1)); } \
  || { echo "FAIL T6-regrounding"; fail=$((fail+1)); }
echo z2 > docs/z.md && git add docs/z.md
"$SHIP" "test" >"$SCRATCH/out" 2>&1; expect T6b-commit-ok 0 $?

# --- T7: hygiene still rejects non-English commit message
# Cyrillic built from escapes: this file itself stays pure ASCII.
CYR_MSG=$'\u0442\u0435\u0441\u0442\u043e\u0432\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435'
echo z > docs/y.md && git add docs/y.md
"$SHIP" "$CYR_MSG" >"$SCRATCH/out" 2>&1; expect T7-hygiene 2 $? "HYGIENE_GATE"
git reset -q

# --- T10: a negated/prose rollback mention is NOT a marker.
# '-- no rollback needed' is prose after the comment marker, and a
# column literally named 'countdown' only contains the 'down'
# substring - neither anchors a rollback section.
printf 'CREATE TABLE c(countdown int);\n-- no rollback needed\n' > db/migrations/004_prose.sql
git add db/migrations/004_prose.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T10a-gate-rejects-prose 1 $? "MIGRATION GATE FAIL"
"$SHIP" "prose migration" >"$SCRATCH/out" 2>&1; expect T10b-ship-block 3 $? "MIGRATION_GATE"
git reset -q

# --- T11: a roll-forward note that does NOT name the staged file
# covers nothing - the note must enumerate the file it authorizes.
mkdir -p "$SCRATCH/devin"
printf 'roll-forward approved: db/migrations/other.sql\n' > "$SCRATCH/devin/migration_rollforward.md"
printf 'CREATE TABLE r(id int);\n' > db/migrations/004_up.sql
git add db/migrations/004_up.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T11a-note-mismatched 1 $? "MIGRATION GATE FAIL"
"$SHIP" "rollforward migration" >"$SCRATCH/out" 2>&1; expect T11b-ship-block 3 $? "MIGRATION_GATE"
git reset -q

# --- T12: the note covering the file's exact repo-relative path
# authorizes the roll-forward - gate verifies, ship commits.
printf 'roll-forward approved: db/migrations/004_up.sql\n' > "$SCRATCH/devin/migration_rollforward.md"
git add db/migrations/004_up.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T12a-note-covers 0 $? "roll-forward"
"$SHIP" "rollforward migration" >"$SCRATCH/out" 2>&1; expect T12b-commit-ok 0 $?
rm -f "$SCRATCH/devin/migration_rollforward.md"

# --- T13: scope gate inspects the OLD path of a rename too -
# renaming 'outside/secret.md' to 'docs/ok.md' cannot smuggle
# out-of-whitelist content into an allowed path.
echo 'docs/' > "$SCRATCH/devin/scope_whitelist.txt"
mkdir -p outside && echo secret > outside/secret.md
git add outside/secret.md && git -c user.email=t@t -c user.name=t commit -qm "seed outside file"
git mv outside/secret.md docs/ok.md
"$SHIP" "rename smuggle" >"$SCRATCH/out" 2>&1; expect T13-rename-scope 2 $? "SCOPE_GATE"
git reset -q --hard HEAD 2>/dev/null || git reset -q
rm -f "$SCRATCH/devin/scope_whitelist.txt"

echo "---"
echo "gate_tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
