#!/usr/bin/env bash
# env_val.sh - single implementation of the project ENV-file parsing,
# shared by everything that must NOT `set -a; . ENV` (sourcing exports
# every project secret into the environment of each child process,
# where /proc/<pid>/environ exposes them to other processes of the
# same uid).
#
# Semantics match what sourcing a single KEY= line would produce:
#   - leading whitespace before the key is tolerated - an indented
#     '  KEY=value' sources fine in bash;
#   - an optional 'export ' prefix is tolerated;
#   - the LAST KEY= assignment wins;
#   - one pair of surrounding quotes (' or ") is stripped - a quoted
#     value loses everything after the closing quote (comment or not);
#   - an UNTERMINATED quote (KEY='abc) is NOT silently repaired:
#     sourcing the same line is a syntax error, so the raw value is
#     kept verbatim and a warning goes to stderr - a consumer failing
#     on the stray quote char is the visible equivalent;
#   - for a bare value an inline comment (everything from the first
#     ' #') is removed; a '#' mid-word stays literal;
#   - trailing whitespace left by a stripped comment is trimmed -
#     bare values only; the interior of a quoted value (trailing
#     spaces included) is kept verbatim, matching sourcing.
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
    { sub(/^[[:space:]]+/, "") }
    { sub(/^export[[:space:]]+/, "") }
    index($0, k "=") == 1 { print substr($0, length(k) + 2) }
  ' "$ENV_FILE" | tail -n 1)"
  # ENV accepts KEY="value" and KEY='value' - strip one matching pair
  # of surrounding quotes, otherwise the quote chars end up inside the
  # token/secret/url and every consumer fails. Only a MATCHED pair is
  # stripped: an opening quote with no closing one anywhere later in
  # the value (KEY='abc) would be a syntax error under sourcing, so
  # the raw value - quote char included - is kept and a warning is
  # printed instead of silently returning a repaired token. An inline
  # comment (KEY=value # note) is shell syntax, not part of the value:
  # for a quoted value everything after the closing quote goes with
  # the quotes; for a bare value everything from the first ' #' goes
  # (a '#' mid-word is literal, same as sourcing).
  case "$v" in
    # quoted value: everything between the quote pair is verbatim -
    # sourcing KEY="a b " keeps the interior/trailing whitespace, so
    # no trimming may run on this branch
    \"*\"*) v="${v#\"}"; v="${v%%\"*}" ;;
    \'*\'*) v="${v#\'}"; v="${v%%\'*}" ;;
    \"*|\'*)
      printf 'env_val.sh: unterminated quote in %s for key %s\n' \
        "$ENV_FILE" "$1" >&2
      # raw value kept verbatim (quote char included) - same
      # no-trimming rule as the matched-quote branches
      v="${v%% #*}" ;;
    *)
      v="${v%% #*}"
      # whitespace left behind by a stripped comment is not part of a
      # BARE value either - only this branch may trim
      v="${v%"${v##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$v"
}

# executed directly (not sourced): print the parsed value of one var
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -euo pipefail
  env_val "${1:?usage: env_val.sh VAR_NAME}"
fi
