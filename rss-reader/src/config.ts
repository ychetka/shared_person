import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.RSS_PORT ?? 8788),
  feedsFile: process.env.FEEDS_FILE ?? path.resolve(here, "..", "feeds.yaml"),
  stateDir: process.env.STATE_DIR ?? path.resolve(here, "..", "state"),
  llmGatewayUrl: process.env.LLM_GATEWAY_URL ?? "", // empty = curation off
  curateRole: process.env.CURATE_ROLE ?? "feed-curator",
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 15_000),
  userAgent: "rss-reader/0.1 (+https://github.com/ychetka/shared_person)",
};
