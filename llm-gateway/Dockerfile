# Base is the locally-flattened image (rootless docker cannot pull
# multi-uid layers; n8n-local ships node v26 + npm).
# Build artifacts are produced on the host: npm install + tsc.
FROM n8n-local:latest
WORKDIR /app
COPY node_modules ./node_modules
COPY dist ./dist
# roles/, prompts/, context/ are mounted read-only at runtime
ENTRYPOINT ["node", "dist/server.js"]
