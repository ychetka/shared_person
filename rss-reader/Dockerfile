# Flattened local base (rootless docker). Build artifacts from host.
FROM n8n-local:latest
WORKDIR /app
COPY node_modules ./node_modules
COPY dist ./dist
# feeds.yaml and state/ are mounted at runtime
ENTRYPOINT ["node", "dist/server.js"]
