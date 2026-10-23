#!/usr/bin/env bash
# Bridge host ports into the rootless-docker inner netns.
# The shared dockerd (trade-ai-analitic/docker-static) runs containers in a
# child network namespace; a host-network container port is NOT reachable
# from the real host without this relay.
#
# Usage: port_fwd.sh          - spawn forwarders for all stack ports
#        port_fwd.sh stop     - kill them
#
# Re-run after the rootless-docker stack restarts (inner pid changes).

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
INNER_PID_FILE="/home/alexandr/projects/trade-ai-analitic/docker-static/inner.pid"
PORTS="5780 8787 8788"   # n8n UI/webhooks, llm-gateway, rss-reader
MARK="shared-person port_fwd"

if [ "${1:-}" = "stop" ]; then
  pkill -f "port_fwd.py .*$" 2>/dev/null
  echo "stopped"
  exit 0
fi

[ -f "$INNER_PID_FILE" ] || { echo "inner.pid not found - is rootless-docker up?"; exit 1; }
INNER=$(cat "$INNER_PID_FILE")
[ -e "/proc/$INNER/ns/net" ] || { echo "inner netns pid $INNER gone - restart rootless-docker"; exit 1; }

for p in $PORTS; do
  if pgrep -f "port_fwd.py $p $p" >/dev/null; then
    echo "$p already forwarded"
    continue
  fi
  nohup sudo -n python3 "$HERE/port_fwd.py" "$p" "$p" "$INNER" \
    >> /tmp/shared-person-fwd.log 2>&1 &
  echo "fwd $p -> inner $INNER (pid $!)"
done
