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
  # last KEY= assignment wins - same rule as sourcing would apply
  local v
  v="$(sed -n -e 's/^export[[:space:]]\{1,\}//' -e "s/^$1=//p" "$ENV_FILE" | tail -n 1)"
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
