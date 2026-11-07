#!/usr/bin/env bash
# chrome-audit.sh - canonical launcher for the operator's AUDIT Chrome,
# the dedicated browser profile that every hands-off / CDP consumer on
# this host talks to: vk_token_issue.py + vk_token_service.py
# (VK_CDP_URL), hands-agent/cdp.py (HANDS_CDP), deploy/vk-token.service
# and the manual Facebook/Instagram/LinkedIn session workflows in
# PLATFORM_ACCESS.md. It exposes the Chrome DevTools Protocol on
# http://127.0.0.1:9223 bound to loopback only, on the dedicated
# profile dir ~/.chrome-audit-profile - NEVER the operator's daily
# browser profile, so automation flags and CDP stay isolated.
#
# Why this script exists: the launch recipe was tribal knowledge and
# every manual relaunch hit the same two failures - a stale
# SingletonLock left behind by a killed/crashed instance made chrome
# open a window in a phantom "existing" process and exit without CDP,
# and a launch from a non-desktop context (ssh, systemd, Devin shell)
# missed the Wayland/Xwayland environment (WAYLAND_DISPLAY, the
# per-boot-rotating mutter XAUTHORITY cookie, DISPLAY), so the window
# could not connect to the compositor at all. Both are handled here:
#
#   1. STALE LOCKS: chrome drops SingletonCookie/SingletonLock/
#      SingletonSocket symlinks+files in the profile dir and refuses to
#      take the profile while a peer holds them. They are removed ONLY
#      when no live chrome process runs on this profile dir (pgrep -f
#      on the --user-data-dir flag, regex-escaped and end-anchored so
#      sibling dirs like <profile>-bak cannot match) AND the CDP
#      endpoint is dead - deleting the locks under a live instance
#      would let a second browser hijack the profile and corrupt
#      session state.
#
#   2. WAYLAND/X11 ENV: the desktop session on this host is GNOME/
#      mutter on Wayland (loginctl Type=wayland). Chrome needs
#        - WAYLAND_DISPLAY: discovered from the compositor socket
#          $XDG_RUNTIME_DIR/wayland-* (the inherited value is kept only
#          if its socket is still live - an SSH/systemd context has
#          none, a stale value from a previous boot must not survive);
#        - XAUTHORITY: mutter writes its Xwayland cookie to
#          /run/user/<uid>/.mutter-Xwaylandauth.<SUFFIX> where the
#          suffix embeds a value that ROTATES EVERY BOOT - it MUST be
#          globbed, never hardcoded, and when several cookies exist
#          (Xwayland restart) the NEWEST wins. On pure-X11 sessions the
#          file is absent and the fallback is the classic
#          $HOME/.Xauthority. An inherited XAUTHORITY that still points
#          at a readable file is used only when no mutter cookie
#          exists;
#        - DISPLAY: the Xwayland display; the inherited value wins,
#          default :0.
#
#   3. DETACHED START + HEALTHCHECK: chrome is started via setsid -f
#      (new session, reparented away from this script - survives the
#      launcher exiting and the calling terminal closing), output to
#      $PROFILE_DIR/chrome-audit.log (capped: truncated to the newest
#      512KiB once it passes 1MiB). The script then polls
#      http://127.0.0.1:9223/json/version for up to ~15s and prints the
#      returned JSON (Browser version line included); a timeout or a
#      missing chrome binary is a clear non-zero failure.
#
#   4. IDEMPOTENT: if the CDP endpoint already answers AND its
#      /json/version really is CDP (carries Browser +
#      webSocketDebuggerUrl) AND a chrome process is bound to THIS
#      profile dir, the script prints 'already running' and exits 0 -
#      no relaunch, no lock cleanup, no env probing. A foreign listener
#      on :9223 (non-CDP body, or CDP served by a chrome on a
#      different profile) is a loud non-zero failure - reported,
#      never killed.
#
# Usage:
#   tools/chrome-audit.sh            # launch (or no-op if already up)
#   tools/chrome-audit.sh --dry-run  # report decisions, change nothing
#
# Overrides (env): CHROME_BIN, PROFILE_DIR, CDP_PORT, CDP_ADDR,
# CDP_WAIT_SECONDS.

set -euo pipefail

CHROME_BIN="${CHROME_BIN:-/opt/google/chrome/chrome}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.chrome-audit-profile}"
CDP_ADDR="${CDP_ADDR:-127.0.0.1}"
CDP_PORT="${CDP_PORT:-9223}"
CDP_URL="http://${CDP_ADDR}:${CDP_PORT}"
CDP_WAIT_SECONDS="${CDP_WAIT_SECONDS:-15}"

say()  { printf '%s\n' "$*"; }
fail() { printf '!! %s\n' "$*" >&2; exit 1; }

# Strict args: a mistyped flag ('--dryrun') must fail loudly instead
# of silently performing a REAL launch.
DRY_RUN=0
for _arg in "$@"; do
  case "$_arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      say "usage: $0 [--dry-run]  - launch the audit Chrome on $CDP_URL (idempotent)"
      exit 0 ;;
    *) fail "unrecognized argument '$_arg' - usage: $0 [--dry-run]" ;;
  esac
done

# curl is the only CDP client used here (probe + version fetch) - the
# same hard dependency vk_token_issue.py/service already assume via
# urllib. Fail loud instead of dying mid-run on 'command not found'.
command -v curl >/dev/null 2>&1 \
  || fail "curl is required for the CDP healthcheck - install it and re-run $0"

# 'chrome holding this profile dir' test, shared by the idempotence
# check and the stale-lock guard. PROFILE_DIR is raw text, not a
# regex - escape every non-alphanumeric char so a '.' or '+' in $HOME
# cannot widen the match, and anchor the path with a terminator
# ([[:space:]]=next argv token, $=end of cmdline) so siblings like
# '.chrome-audit-profile-bak' do NOT match.
_ESCAPED_DIR="$(printf '%s' "$PROFILE_DIR" | sed 's/[^[:alnum:]_]/\\&/g')"
_PROFILE_PAT="--user-data-dir[= ]${_ESCAPED_DIR}"'([[:space:]]|$)'
profile_chrome_pid() {
  # argv match alone is not enough: a wrapper whose command line merely
  # MENTIONS the flag (e.g. `bash -c '... --user-data-dir=...'`, an
  # editor with the recipe open, a fake argv[0]) would pass the regex.
  # /proc/<pid>/exe always resolves to the real binary, so require the
  # match to actually BE a chrome/chromium executable.
  local pid
  for pid in $(pgrep -f -- "$_PROFILE_PAT" 2>/dev/null); do
    case "$(readlink "/proc/$pid/exe" 2>/dev/null)" in
      *chrome*|*chromium*) printf '%s\n' "$pid"; return 0 ;;
    esac
  done
  return 1
}

# --- 0. Idempotence: a live CDP endpoint means the audit browser is
# already serving every consumer - nothing else must happen (no
# relaunch, no lock cleanup, no env discovery). 'HTTP 200' alone is
# NOT proof though: any web listener on :9223 returns a body, and a
# chrome started on a DIFFERENT profile would silently hijack every
# CDP consumer (they would drive the wrong sessions). Require BOTH
# markers a real /json/version always carries AND a chrome process
# bound to THIS profile dir. Foreign listeners are reported loudly -
# never killed.
if VERSION_JSON="$(curl -fsS --max-time 2 "$CDP_URL/json/version" 2>/dev/null)" \
     && [ -n "$VERSION_JSON" ]; then
  if ! printf '%s' "$VERSION_JSON" | grep -q '"webSocketDebuggerUrl"' \
    || ! printf '%s' "$VERSION_JSON" | grep -q '"Browser"'; then
    fail "$CDP_URL answers HTTP but is NOT a CDP endpoint - a foreign
   service holds the audit port. Free port $CDP_PORT and re-run $0."
  fi
  PROFILE_PROC="$(profile_chrome_pid || true)"
  if [ -z "$PROFILE_PROC" ]; then
    fail "$CDP_URL serves a CDP endpoint but no chrome runs on
   $PROFILE_DIR - a chrome on a DIFFERENT profile holds the audit port
   and consumers would attach to the wrong sessions. Stop that
   instance (left untouched on purpose) and re-run $0."
  fi
  say ">> audit Chrome already running on $CDP_URL (pid $PROFILE_PROC) - nothing to do"
  # keep it short: the Browser line only (a caller needing the full
  # /json/version can curl it - the endpoint is live by definition).
  printf '%s\n' "$VERSION_JSON" | grep -o '"Browser"[^,}]*' || true
  exit 0
fi

# --- 1. Preflight: a missing chrome binary is a non-zero error BEFORE
# any profile mutation - deleting locks and then failing to launch
# would leave the profile unprotected for a parallel manual start.
if [ ! -x "$CHROME_BIN" ]; then
  # a PATH-resolvable google-chrome is a friendlier diagnosis than a
  # bare 'not found': the binary may just live elsewhere.
  _alt="$(command -v google-chrome 2>/dev/null || true)"
  if [ -n "$_alt" ]; then
    fail "chrome binary not executable at $CHROME_BIN (found $_alt - re-run with CHROME_BIN=$_alt)"
  fi
  fail "chrome binary not found at $CHROME_BIN and no google-chrome on PATH - install Chrome or set CHROME_BIN"
fi

# --- 2. Is a live chrome already holding this profile dir? The
# escaped/anchored pattern above covers both '--user-data-dir=PATH'
# and '--user-data-dir PATH' argv spellings. If one is running but
# CDP is dead, it was started WITHOUT --remote-debugging-port (or is
# mid-crash) - launching again would just open a window in that
# instance and never bring CDP up, and deleting its locks would be
# worse. Give it a short grace for the in-flight-startup case, then
# fail loudly so the operator kills or adopts it.
PROFILE_PROC="$(profile_chrome_pid || true)"

if [ -n "$PROFILE_PROC" ]; then
  say ">> chrome pid $PROFILE_PROC already runs on $PROFILE_DIR but CDP is down -"
  say ">> giving it up to ${CDP_WAIT_SECONDS}s to finish starting..."
  deadline=$((SECONDS + CDP_WAIT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if VERSION_JSON="$(curl -fsS --max-time 2 "$CDP_URL/json/version" 2>/dev/null)" \
         && [ -n "$VERSION_JSON" ]; then
      say ">> CDP came up on $CDP_URL (pid $PROFILE_PROC finished starting)"
      printf '%s\n' "$VERSION_JSON" | grep -o '"Browser"[^,}]*' || true
      exit 0
    fi
    sleep 1
  done
  fail "chrome pid $PROFILE_PROC holds $PROFILE_DIR without a CDP endpoint.
   It was likely started WITHOUT --remote-debugging-port. Kill it
   ('kill $PROFILE_PROC') and re-run $0 - the stale locks are left in
   place on purpose, they belong to that live process."
fi

# --- 3. No live chrome on the profile: the Singleton* leftovers (if
# any) are provably stale - drop them so chrome can take the profile.
_removed=""
for lock in SingletonCookie SingletonLock SingletonSocket; do
  if [ -e "$PROFILE_DIR/$lock" ] || [ -L "$PROFILE_DIR/$lock" ]; then
    _removed="$_removed $lock"
    [ "$DRY_RUN" -eq 0 ] && rm -f "$PROFILE_DIR/$lock"
  fi
done
if [ -n "$_removed" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    say ">> --dry-run: would remove stale profile locks:${_removed}"
  else
    say ">> removed stale profile locks:${_removed} (no live chrome on $PROFILE_DIR)"
  fi
else
  say ">> no stale Singleton* locks under $PROFILE_DIR"
fi

# --- 4. Discover the desktop display environment for a launch coming
# from a context that has none (ssh, systemd unit, agent shell).
_UID="$(id -u)"
XDG_RT="${XDG_RUNTIME_DIR:-/run/user/$_UID}"
# libwayland resolves a BASENAME WAYLAND_DISPLAY ('wayland-0') through
# $XDG_RUNTIME_DIR - so when this script had to derive the dir itself
# (cron/systemd/agent shells carry none), it MUST reach chrome's
# environment too or the socket lookup has no root to resolve
# against. Exporting unconditionally also covers an inherited-but-
# unexported value.
export XDG_RUNTIME_DIR="$XDG_RT"

# WAYLAND_DISPLAY: keep the inherited value only while its socket is
# still live; otherwise glob $XDG_RT/wayland-* (skipping the .lock
# sidecar files) for the real compositor socket name. No socket = pure
# X11 session = the variable stays UNSET so chrome does not chase a
# dead wayland path.
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  case "$WAYLAND_DISPLAY" in
    /*) _wl_sock="$WAYLAND_DISPLAY" ;;          # absolute-path form
    *)  _wl_sock="$XDG_RT/$WAYLAND_DISPLAY" ;;  # name inside XDG_RT
  esac
  [ -S "$_wl_sock" ] || WAYLAND_DISPLAY=""
fi
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for _sock in "$XDG_RT"/wayland-*; do
    case "$_sock" in
      *.lock|*'/*wayland-*') continue ;;  # .lock sidecar / unmatched glob
    esac
    if [ -S "$_sock" ]; then
      WAYLAND_DISPLAY="${_sock##*/}"
      break
    fi
  done
fi
# A stale exported value must not reach chrome either: an
# exported-but-empty/dead WAYLAND_DISPLAY is treated as a REAL socket
# name by ozone and breaks the launch where an absent variable just
# means 'use X11'.
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  export WAYLAND_DISPLAY
else
  unset WAYLAND_DISPLAY
fi

# XAUTHORITY: mutter's Xwayland cookie name carries a boot-rotating
# suffix (.mutter-Xwaylandauth.XXXXXX) - glob, NEVER hardcode. When
# several match (Xwayland restarted mid-session leaves the old cookie
# behind) the NEWEST is the live one - plain glob order is
# alphabetical and would pick a stale suffix, so sort by mtime
# (`ls -t`). The classic $HOME/.Xauthority is the fallback for X11
# sessions where no mutter cookie exists; an inherited readable
# XAUTHORITY is only a last resort when neither file is there.
_XAUTH=""
for _xa in $(ls -t "$XDG_RT"/.mutter-Xwaylandauth.* 2>/dev/null); do
  [ -r "$_xa" ] || continue
  _XAUTH="$_xa"
  break
done
if [ -z "$_XAUTH" ]; then
  if [ -n "${XAUTHORITY:-}" ] && [ -r "$XAUTHORITY" ]; then
    _XAUTH="$XAUTHORITY"
  elif [ -r "$HOME/.Xauthority" ]; then
    _XAUTH="$HOME/.Xauthority"
  fi
fi
# Same stale-export rule as WAYLAND_DISPLAY: an inherited XAUTHORITY
# pointing at a rotated-away cookie must not reach chrome.
if [ -n "$_XAUTH" ]; then
  export XAUTHORITY="$_XAUTH"
else
  unset XAUTHORITY
fi

# DISPLAY: inherited wins, else the Xwayland default.
DISPLAY="${DISPLAY:-:0}"

say ">> display env: DISPLAY=$DISPLAY" \
    "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<unset>}" \
    "XAUTHORITY=${_XAUTH:-<unset>}"

if [ "$DRY_RUN" -eq 1 ]; then
  say ">> --dry-run: would launch $CHROME_BIN on $CDP_URL with profile $PROFILE_DIR - exiting"
  exit 0
fi

# --- 5. Detached launch: `setsid -f` forks chrome into its own
# session so it survives this script (and the terminal that ran it)
# going away - bare `setsid` in a `&` job can itself become the
# process-group leader and setsid(2) would then fail; -f makes the
# detach unconditional and returns immediately. The log lives inside
# the profile dir so a crash after this script exits stays
# diagnosable.
mkdir -p "$PROFILE_DIR"
LOG="$PROFILE_DIR/chrome-audit.log"
# The log is append-only across launches - cap it: past 1MiB keep the
# newest 512KiB. Truncate IN PLACE (temp file + `cat >`, not mv): if
# an older chrome still holds the fd, replacing the inode would split
# its output into an orphaned file. Crash diagnostics live at the
# tail anyway.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  _logtail="$(mktemp)"
  tail -c 524288 "$LOG" > "$_logtail" && cat "$_logtail" > "$LOG"
  rm -f "$_logtail"
fi
export DISPLAY

setsid -f "$CHROME_BIN" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address="$CDP_ADDR" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  >>"$LOG" 2>&1 </dev/null
say ">> launched $CHROME_BIN (detached, log: $LOG)"

# --- 6. Bounded wait for the CDP endpoint. Chrome opens the HTTP
# listener only after the profile is up - a stale lock that survived
# step 3, a crashed profile or a compositor it cannot reach all show
# up here as a timeout, which MUST be a non-zero exit so callers
# (vk-token.service et al.) notice instead of talking to a dead port.
deadline=$((SECONDS + CDP_WAIT_SECONDS))
VERSION_JSON=""
while [ "$SECONDS" -lt "$deadline" ]; do
  if VERSION_JSON="$(curl -fsS --max-time 2 "$CDP_URL/json/version" 2>/dev/null)" \
       && [ -n "$VERSION_JSON" ]; then
    break
  fi
  sleep 1
done

if [ -z "$VERSION_JSON" ]; then
  fail "chrome did not open CDP on $CDP_URL within ${CDP_WAIT_SECONDS}s -
   check $LOG (compositor unreachable? profile still locked?)"
fi

say ">> CDP up on $CDP_URL:"
printf '%s\n' "$VERSION_JSON"
printf '%s\n' "$VERSION_JSON" | grep -o '"Browser"[^,}]*' || true
exit 0
