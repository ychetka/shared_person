#!/usr/bin/env bash
# env_val.sh - single implementation of the project ENV-file parsing,
# shared by everything that must NOT `set -a; . ENV` (sourcing exports
# every project secret into the environment of each child process,
# where /proc/<pid>/environ exposes them to other processes of the
# same uid).
#
# Semantics track what sourcing a single KEY= line would produce (two
# known divergences, called out below: a quoted value TRUNCATES at the
# closing quote, where sourcing would concatenate - KEY="a"b yields a
# here but ab under . / source; and shell EXPANSIONS inside a
# double-quoted value - $VAR, $(...) and `backticks` - stay LITERAL
# here where sourcing would expand or execute them. The second
# divergence is deliberate: an env file must never run code or pull
# sibling variables into a secret, so consumers get the text as
# written - a KEY="$(rm -rf x)" line is inert text for us but a
# command under . / source):
#   - leading whitespace before the key is tolerated - an indented
#     '  KEY=value' sources fine in bash;
#   - an optional 'export ' prefix is tolerated;
#   - the LAST KEY= assignment wins;
#   - one pair of surrounding quotes (' or ") is stripped - a quoted
#     value loses everything after the closing quote (comment or not);
#     inside a double-quoted value the shell's escape rules apply
#     (\" \\ \$ \` fold to the escaped char, the closing quote is the
#     first UNESCAPED one - KEY="a\"b" parses as a"b, matching
#     sourcing) but $VAR/$(...)/backticks stay LITERAL where sourcing
#     would expand or execute them - deliberate, see the header;
#     single quotes take no escapes, same as sourcing;
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
    \"*\"*)
      # keep the raw post-= text for the not-really-closed case below:
      # a value like KEY="a\"b matches this branch (it contains a later
      # '"') but its last quote is ESCAPED, so the scan folds it and
      # reaches the end with no unescaped closing quote - an
      # unterminated quote under sourcing, handled like the \"*|\'*
      # branch (warn + raw kept), not silently returned folded.
      local raw="$v"
      v="${v#\"}"
      # the closing quote is the first UNESCAPED one, and the shell's
      # double-quote escapes fold: sourcing KEY="a\"b" yields a"b,
      # while truncating at the first '"' would return a\ - a wrong
      # value with no warning. Scan char by char and fold \" \\ \$
      # \` to the escaped char; any other backslash stays literal,
      # matching double-quote sourcing semantics.
      local inner="" n=${#v} i c nx closed=
      for (( i=0; i<n; i++ )); do
        c="${v:i:1}"
        if [ "$c" = '\' ] && [ $((i+1)) -lt "$n" ]; then
          nx="${v:i+1:1}"
          case "$nx" in
            '"'|'\'|'$'|'`')
              inner+="$nx"; i=$((i+1)) ;;
            *) inner+="$c" ;;
          esac
        elif [ "$c" = '"' ]; then
          closed=1
          break
        else
          inner+="$c"
        fi
      done
      if [ -n "$closed" ]; then
        v="$inner"
      else
        printf 'env_val.sh: unterminated quote in %s for key %s\n' \
          "$ENV_FILE" "$1" >&2
        # raw value kept verbatim (quote char and escapes included) -
        # same no-trimming rule as the matched-quote branches, same
        # warn-and-keep-raw contract as the plainly-unterminated one
        v="${raw%% #*}"
      fi ;;
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
