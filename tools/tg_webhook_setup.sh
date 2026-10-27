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
curl -sS -X POST "$API/setWebhook" \
  -d "url=$WEBHOOK_URL" \
  -d "secret_token=$TG_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
echo
echo ">> getWebhookInfo (secret is never echoed back; check url/last_error)"
curl -sS "$API/getWebhookInfo"
echo
