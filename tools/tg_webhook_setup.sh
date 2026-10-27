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
# TG_WEBHOOK_SECRET is REQUIRED - the script refuses to run without it
# (:? guard below), because registering the webhook unsigned would
# leave every delivery unsigned while the moderation gate fails
# closed: a silent outage that still looks "registered". The
# sp-tg-setup workflow aborts the same way when the env is missing.
# Generate one with `openssl rand -hex 32` and add it to ENV.
#
# Usage:
#   tools/tg_webhook_setup.sh            # register + show getWebhookInfo
#   TG_WEBHOOK_URL=https://... tools/tg_webhook_setup.sh
#
# Reads TELEGRAM_BOT_TOKEN and TG_WEBHOOK_SECRET from the project ENV
# (../ENV relative to this script) unless already exported.

set -euo pipefail

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/../.." && pwd)/ENV}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN missing - add it to $ENV_FILE}"
: "${TG_WEBHOOK_SECRET:?TG_WEBHOOK_SECRET missing - generate one (openssl rand -hex 32) and add it to $ENV_FILE}"

WEBHOOK_URL="${TG_WEBHOOK_URL:-https://shared-person.opticode.su:8443/webhook/tg-moderation}"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

echo ">> setWebhook $WEBHOOK_URL (secret_token=<redacted>)"
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
# the secret from its ENVIRONMENT - a here-doc interpolation or jq
# --arg would put the value back into an argv line.
BODY_FILE="$(mktemp)"
CFG_FILE="$(mktemp)"
chmod 600 "$BODY_FILE" "$CFG_FILE"  # mktemp already creates 0600; belt & suspenders
trap 'rm -f "$BODY_FILE" "$CFG_FILE"' EXIT
TG_WEBHOOK_SECRET="$TG_WEBHOOK_SECRET" WEBHOOK_URL="$WEBHOOK_URL" \
  python3 - "$BODY_FILE" <<'PYEOF'
import json, os, sys
with open(sys.argv[1], "w") as f:
    json.dump({
        "url": os.environ["WEBHOOK_URL"],
        "allowed_updates": ["message", "callback_query"],
        "secret_token": os.environ["TG_WEBHOOK_SECRET"],
    }, f)
PYEOF
printf 'url = "%s/setWebhook"\n' "$API" > "$CFG_FILE"
curl -sS -K "$CFG_FILE" -X POST \
  -H 'Content-Type: application/json' \
  -d "@$BODY_FILE"
echo
echo ">> getWebhookInfo (secret is never echoed back; check url/last_error)"
printf 'url = "%s/getWebhookInfo"\n' "$API" > "$CFG_FILE"
curl -sS -K "$CFG_FILE"
echo
