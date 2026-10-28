#!/usr/bin/env bash
# tg_webhook_setup.sh - (re)register the tg-moderation bot webhook with
# a secret_token so Telegram signs every delivery via the
# X-Telegram-Bot-Api-Secret-Token header. sp-tg-moderation's Handle TG
# Update node rejects any update that does not carry it - without this
# registration the gate fails closed and moderation stops.
#
# Repeatable: run again after rotating TG_WEBHOOK_SECRET or changing the
# public webhook URL.
#
# URL env contract: WEBHOOK_URL is the canonical name everywhere else
# (docker-compose.yml -> the n8n container's WEBHOOK_URL env, and the
# sp-tg-setup workflow's ENV('WEBHOOK_URL')) and carries the public
# BASE URL of the n8n instance - the moderation hook path
# (/webhook/tg-moderation) is appended below. TG_WEBHOOK_URL is kept as
# a compat alias for the legacy FULL webhook URL this script used to
# read. There is deliberately NO hardcoded fallback anymore: the old
# default silently registered a baked-in domain, so on a domain change
# setWebhook still answered ok:true while deliveries went nowhere and
# the moderation gate failed closed in silence. Neither var set is a
# loud failure, not a quiet wrong registration.
#
# TG_WEBHOOK_SECRET is REQUIRED - the script refuses to run without it
# (:? guard below), because registering the webhook unsigned would
# leave every delivery unsigned while the moderation gate fails
# closed: a silent outage that still looks "registered". The
# sp-tg-setup workflow aborts the same way when the env is missing.
# Generate one with `openssl rand -hex 32` and add it to ENV.
#
# Usage:
#   tools/tg_webhook_setup.sh            # register + show getWebhookInfo
#   WEBHOOK_URL=https://... tools/tg_webhook_setup.sh
#
# Reads TELEGRAM_BOT_TOKEN, TG_WEBHOOK_SECRET and WEBHOOK_URL from the
# project ENV (../../ENV relative to this script - the project root)
# unless already exported. TG_WEBHOOK_URL (full hook URL) is accepted
# as a compat alias when WEBHOOK_URL is absent.

set -euo pipefail

# python3 builds the setWebhook JSON body below (it keeps the secret
# off every argv/environ vector - see the staging comment). Preflight
# it like the other fail-loud guards: on a host without python3 the
# script would otherwise die mid-run on an opaque
# 'python3: command not found' after the staging files exist.
command -v python3 >/dev/null 2>&1 || {
  echo "!! python3 is required but not on PATH - install python3" >&2
  echo "   (it builds the setWebhook JSON body) and re-run $0" >&2
  exit 1
}

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/../.." && pwd)/ENV}"
# Never `set -a; . "$ENV_FILE"`: sourcing exports every project secret
# (~16 vars) into the environment of each child process this script
# spawns (curl, python3), where /proc/<pid>/environ exposes them to
# other processes of the same uid. Extract only the vars the script
# actually needs, and only when they are not already set in the
# calling environment. env_val() lives in tools/env_val.sh - the
# single implementation the vk-token.service install snippets point
# at too, so every ENV reader parses identically (optional 'export ',
# last assignment wins, one quote pair stripped, ' # comment' tail
# removed).
. "$(dirname "$0")/env_val.sh"
if [ -f "$ENV_FILE" ]; then
  : "${TELEGRAM_BOT_TOKEN:=$(env_val TELEGRAM_BOT_TOKEN)}"
  : "${TG_WEBHOOK_SECRET:=$(env_val TG_WEBHOOK_SECRET)}"
  : "${WEBHOOK_URL:=$(env_val WEBHOOK_URL)}"
  : "${TG_WEBHOOK_URL:=$(env_val TG_WEBHOOK_URL)}"
fi

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN missing - add it to $ENV_FILE}"
: "${TG_WEBHOOK_SECRET:?TG_WEBHOOK_SECRET missing - generate one (openssl rand -hex 32) and add it to $ENV_FILE}"

# Resolve the hook URL: WEBHOOK_URL (the canonical base URL, same env
# the sp-tg-setup workflow reads) wins; the hook path is appended
# unless the value already ends in it. TG_WEBHOOK_URL is the legacy
# FULL hook URL and is used verbatim. Neither set = refuse loudly -
# see the contract note in the header.
HOOK_PATH='/webhook/tg-moderation'
# strip ALL trailing slashes, not just one: ${var%/} removes a single
# '/', so WEBHOOK_URL=https://x// would register
# https://x//webhook/tg-moderation. Same trim the sp-tg-setup workflow
# applies with /\/+$/
strip_trailing_slashes() {
  local v="$1"
  while [ -n "$v" ] && [ "${v: -1}" = '/' ]; do v="${v%/}"; done
  printf '%s' "$v"
}
if [ -n "${WEBHOOK_URL:-}" ]; then
  _base="$(strip_trailing_slashes "$WEBHOOK_URL")"
  case "$_base" in
    *"$HOOK_PATH") HOOK_URL="$_base" ;;
    *)             HOOK_URL="${_base}${HOOK_PATH}" ;;
  esac
elif [ -n "${TG_WEBHOOK_URL:-}" ]; then
  HOOK_URL="$(strip_trailing_slashes "$TG_WEBHOOK_URL")"
else
  echo "!! WEBHOOK_URL is not set - add the public n8n base URL" >&2
  echo "   (e.g. https://<domain>:<port>/) to $ENV_FILE or export it." >&2
  echo "   The moderation webhook registers at \$WEBHOOK_URL$HOOK_PATH;" >&2
  echo "   TG_WEBHOOK_URL (full hook URL) is accepted as a compat alias." >&2
  exit 1
fi
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

echo ">> setWebhook $HOOK_URL (secret_token=<redacted>)"
# No secret may ever reach a child process argv: -d
# "secret_token=$TG_WEBHOOK_SECRET" (and even --data-urlencode
# 'k=$SECRET') puts the value in curl's command line, where `ps`
# exposes it to every local user for the duration of the call - and
# the bot token inside the $API URL is a secret of exactly the same
# rank, so the URL cannot ride argv either.
# Instead: the request body is staged in a mktemp file (0600) passed
# as `-d @file`, and the token-carrying URL is staged in a second
# 0600 file fed to curl via -K (curl's config-file option - argv then
# shows only paths). printf is a bash builtin, so writing the config
# spawns no process whose argv could carry the token.
# The body is JSON: Telegram's Bot API accepts application/json for
# every method, which also removes the form url-encoding question
# entirely (a '&'/'='/'%' in the secret could corrupt -d form fields;
# in JSON it is just a string). The JSON is built by python3 reading
# the secret from a third 0600 file whose PATH rides argv - an
# env-prefix (SECRET=x python3 ...) would copy the value into
# /proc/<python3-pid>/environ, the same exposure vector the argv ban
# removes, and a here-doc interpolation or jq --arg would put it back
# on the command line. printf is a bash builtin, so staging the
# secret spawns no child process at all. The webhook URL carries no
# secret and may ride argv.
BODY_FILE="$(mktemp)"
CFG_FILE="$(mktemp)"
SECRET_FILE="$(mktemp)"
chmod 600 "$BODY_FILE" "$CFG_FILE" "$SECRET_FILE"  # mktemp already creates 0600; belt & suspenders
trap 'rm -f "$BODY_FILE" "$CFG_FILE" "$SECRET_FILE"' EXIT
printf '%s' "$TG_WEBHOOK_SECRET" > "$SECRET_FILE"
python3 - "$BODY_FILE" "$SECRET_FILE" "$HOOK_URL" <<'PYEOF'
import json, sys
with open(sys.argv[2]) as f:
    secret = f.read()
with open(sys.argv[1], "w") as f:
    json.dump({
        "url": sys.argv[3],
        "allowed_updates": ["message", "callback_query"],
        # drop every update Telegram queued while the webhook was unset
        # or unreachable (it keeps them up to 24h): re-registering
        # without this flag replays the whole backlog to
        # /webhook/tg-moderation, and stale ap:/ed:/rj: callbacks or
        # 'post N' messages pass the signature gate and act on current
        # state - a dead Approve can enqueue a real wall.post. The
        # moderation bot never depends on replayed updates.
        "drop_pending_updates": True,
        "secret_token": secret,
    }, f)
PYEOF
printf 'url = "%s/setWebhook"\n' "$API" > "$CFG_FILE"
# no -f on purpose: --fail suppresses the response body entirely, so
# on an HTTP-layer error Telegram's own error JSON (or a proxy's
# error page) would be swallowed and the operator would see only
# 'curl: (22)'. Capture the body unconditionally, echo it, then check
# the ok field - Telegram reports application errors as HTTP 200 with
# {"ok":false,...} anyway, so the body check (not the HTTP status) is
# what decides. A real transport failure still aborts via the
# if-guard, and -S keeps curl's error text on stderr.
# --max-time 30 bounds a hung api.telegram.org connection the same way
# the workflow Code nodes bound their helpers.httpRequest calls (30s) -
# an unbounded curl would stall this script forever.
if ! RESP="$(curl -sS --max-time 30 -K "$CFG_FILE" -X POST \
  -H 'Content-Type: application/json' \
  -d "@$BODY_FILE")"; then
  echo "!! setWebhook request failed (curl transport error)" >&2
  exit 1
fi
echo "$RESP"
echo "$RESP" | grep -q '"ok" *: *true' || {
  echo "!! setWebhook reported ok:false - webhook NOT registered" >&2
  exit 1
}
echo
echo ">> getWebhookInfo (secret is never echoed back; check url/last_error)"
printf 'url = "%s/getWebhookInfo"\n' "$API" > "$CFG_FILE"
if ! RESP="$(curl -sS --max-time 30 -K "$CFG_FILE")"; then
  echo "!! getWebhookInfo request failed (curl transport error)" >&2
  exit 1
fi
echo "$RESP"
echo "$RESP" | grep -q '"ok" *: *true' || {
  echo "!! getWebhookInfo reported ok:false" >&2
  exit 1
}
