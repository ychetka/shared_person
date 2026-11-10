#!/bin/sh
# fetch_python.sh - materialize rubric-lint/python/ on the HOST.
#
# The n8n-local flattened base ships node only - no python3, no apk,
# and rootless docker builds run without network, so the interpreter
# must arrive as a prebuilt artifact like llm-gateway/node_modules or
# the edge/caddy binary. This script provides it:
#
#   1. a uv-managed python-build-standalone copy already on the host
#      (~/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu) is
#      reused when present - zero download;
#   2. otherwise the matching python-build-standalone release tarball
#      is fetched from GitHub and unpacked.
#
# python/ is .gitignored (build artifact). The n8n-local base carries
# a glibc loader alongside musl, so the gnu build runs inside it
# (verified: python3 3.12 + stdlib http.server in-container).
set -eu
cd "$(dirname "$0")"

# reuse any uv-managed 3.12 install (point release does not matter -
# the container check below verifies the interpreter end to end)
UV_PY=""
for d in "$HOME"/.local/share/uv/python/cpython-3.12.*-*-gnu; do
  if [ -x "$d/bin/python3" ]; then UV_PY="$d"; break; fi
done

PBS_TAG="20250612"
PBS_REL="cpython-3.12.11+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only_stripped"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_REL}.tar.gz"
# expected sha256 of the release tarball (from the release's
# SHA256SUMS manifest) - a tampered or truncated download must never
# be unpacked into python/
PBS_SHA256="15a3c9964e485f04d3c92739aca190616e09b2c4fac29b263432f6f29f00c6cf"

if [ -d python ] && [ -x python/bin/python3 ]; then
  echo "python/ already present: $(python/bin/python3 --version 2>&1)"
  exit 0
fi

rm -rf python .python-tmp
mkdir -p .python-tmp

if [ -n "$UV_PY" ] && [ -x "$UV_PY/bin/python3" ]; then
  echo "reusing uv-managed $UV_PY"
  cp -a "$UV_PY/." .python-tmp/
else
  echo "fetching $PBS_URL"
  curl -fsSL --retry 2 -o .python-tmp/pbs.tar.gz "$PBS_URL"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$PBS_SHA256  .python-tmp/pbs.tar.gz" | sha256sum -c -
  else
    echo "$PBS_SHA256  .python-tmp/pbs.tar.gz" | shasum -a 256 -c -
  fi
  tar -xzf .python-tmp/pbs.tar.gz -C .python-tmp
  mv .python-tmp/python/* .python-tmp/ 2>/dev/null || true
  rmdir .python-tmp/python 2>/dev/null || true
fi

mv .python-tmp python
./python/bin/python3 --version
./python/bin/python3 -c "import http.server, json, re, statistics; print('stdlib check ok')"
