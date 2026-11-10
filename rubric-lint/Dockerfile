# Flattened local base (rootless docker). n8n-local ships node ONLY -
# no python3 - so the interpreter is a host-fetched artifact like
# edge/caddy: run ./fetch_python.sh on the host first (reuses a
# uv-managed standalone build or downloads python-build-standalone).
# The base image's glibc loader runs the gnu build fine.
FROM n8n-local:latest
WORKDIR /app
COPY python ./python
COPY rubric_lint.py server.py voice.json ./
COPY vendor ./vendor
COPY data ./data
ENTRYPOINT ["/app/python/bin/python3", "server.py"]
