#!/usr/bin/env bash
# env_val.sh - single implementation of the project ENV-file parsing,
# shared by everything that must NOT `set -a; . ENV` (sourcing exports
# every project secret into the environment of each child process,
# where /proc/<pid>/environ exposes them to other processes of the
# same uid).
#
# Semantics match what sourcing a single KEY= line would produce:
#   - an optional 'export ' prefix is tolerated;
#   - the LAST KEY= assignment wins;
#   - one pair of surrounding quotes (' or ") is stripped - a quoted
#     value loses everything after the closing quote (comment or not);
#   - for a bare value an inline comment (everything from the first
#     ' #') is removed; a '#' mid-word stays literal;
#   - trailing whitespace left by a stripped comment is trimmed.
#
# Usage:
#   . tools/env_val.sh            # defines env_val() in the caller
#   tools/env_val.sh KEY          # prints the parsed value of KEY
#
# ENV_FILE (default: ../../ENV relative to this script - the project
# root) selects the file read; callers may preset it before sourcing.

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/ENV}"

env_val() {
  # last KEY= assignment wins - same rule as sourcing would apply.
  # The key is matched as a FIXED string (awk index() on the line,
  # never interpolated into a regex): a KEY containing BRE
  # metacharacters ('.', '[', '*', '^', '$') would otherwise match
  # the wrong lines or none.
  local v
  v="$(awk -v k="$1" '
    { sub(/^export[[:space:]]+/, "") }
    index($0, k "=") == 1 { print substr($0, length(k) + 2) }
  ' "$ENV_FILE" | tail -n 1)"
  # ENV accepts KEY="value" and KEY='value' - strip one matching pair
  # of surrounding quotes, otherwise the quote chars end up inside the
  # token/secret/url and every consumer fails. An inline
  # comment (KEY=value # note) is shell syntax, not part of the value:
  # for a quoted value everything after the closing quote goes with
  # the quotes; for a bare value everything from the first ' #' goes
  # (a '#' mid-word is literal, same as sourcing).
  case "$v" in
    \"*) v="${v#\"}"; v="${v%%\"*}" ;;
    \'*) v="${v#\'}"; v="${v%%\'*}" ;;
    *) v="${v%% #*}" ;;
  esac
  # whitespace left behind by a stripped comment is not part of the
  # value either
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# executed directly (not sourced): print the parsed value of one var
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -euo pipefail
  env_val "${1:?usage: env_val.sh VAR_NAME}"
fi
