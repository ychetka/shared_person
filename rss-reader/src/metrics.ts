import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Item } from "./feeds.js";

// Engagement signals for sources whose RSS does not carry them:
//  - habr.com article pages embed a `statistics` JSON block with
//    commentsCount / votesCount / score / reach (page views)
//  - news.ycombinator.com item ids are resolved through the Algolia
//    HN API (points + num_comments), keyed by the RSS <comments> link
// Other sources return {} - hype scoring treats missing data as zero.
// Results are cached on disk (STATE_DIR/metrics.json, 48h TTL) so
// repeated /curate runs on the same window do not re-fetch pages.

export interface Engagement {
  views?: number; // page views (habr reach)
  comments?: number; // comment count
  votes?: number; // total votes / HN points
  rating?: number; // signed article score (habr)
}

const TTL = 48 * 3600_000;
const CONCURRENCY = 4;
const REQ_TIMEOUT = 10_000;
const UA_HTML =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const cacheFile = () => path.join(config.stateDir, "metrics.json");

type Cache = Record<string, { ts: number; eng: Engagement }>;
let cache: Cache | null = null;

function loadCache(): Cache {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as Cache;
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache(): void {
  if (!cache) return;
  fs.mkdirSync(config.stateDir, { recursive: true });
  const cutoff = Date.now() - TTL;
  const pruned = Object.fromEntries(Object.entries(cache).filter(([, v]) => v.ts > cutoff));
  fs.writeFileSync(cacheFile(), JSON.stringify(pruned));
}

const isHabr = (i: Item) => /habr\.com\//.test(i.url);

// HN item id from the <comments> discussion link or an item?id= url
const hnId = (i: Item): string | null => {
  const m = (i.comments || i.url).match(/item\?id=(\d+)/);
  return m ? m[1] : null;
};

const isHn = (i: Item) =>
  /news\.ycombinator\.com/.test(i.comments || "") || /news\.ycombinator\.com/.test(i.url);

async function habrMetrics(url: string): Promise<Engagement | null> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQ_TIMEOUT),
    headers: { "User-Agent": UA_HTML },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/"statistics":\{[^}]*"commentsCount":\d+[^}]*\}/);
  if (!m) return null;
  const block = m[0];
  const num = (k: string) => {
    const x = block.match(new RegExp(`"${k}":(\\d+)`));
    return x ? Number(x[1]) : undefined;
  };
  return {
    views: num("reach"),
    comments: num("commentsCount"),
    votes: num("votesCount"),
    rating: num("score"),
  };
}

async function hnMetrics(id: string): Promise<Engagement | null> {
  const res = await fetch(`https://hn.algolia.com/api/v1/search?tags=story_${id}`, {
    signal: AbortSignal.timeout(REQ_TIMEOUT),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    hits?: { points?: number; num_comments?: number }[];
  };
  const h = data.hits?.[0];
  if (!h) return null;
  return { votes: h.points ?? 0, comments: h.num_comments ?? 0 };
}

async function fetchOne(i: Item): Promise<Engagement | null> {
  if (isHabr(i)) return habrMetrics(i.url);
  const id = hnId(i);
  if (id) return hnMetrics(id);
  return null;
}

// Enrich items with metrics where the source exposes them.
export async function attachEngagement(items: Item[]): Promise<void> {
  const c = loadCache();
  const targets = items.filter((i) => isHabr(i) || isHn(i));
  const now = Date.now();
  const todo = targets.filter((i) => !c[i.id] || now - c[i.id].ts > TTL);
  for (let k = 0; k < todo.length; k += CONCURRENCY) {
    await Promise.allSettled(
      todo.slice(k, k + CONCURRENCY).map(async (i) => {
        try {
          const eng = await fetchOne(i);
          c[i.id] = { ts: now, eng: eng ?? {} };
        } catch {
          c[i.id] = { ts: now, eng: {} };
        }
      }),
    );
  }
  if (todo.length) saveCache();
  for (const i of targets) {
    const eng = c[i.id]?.eng;
    if (eng && Object.keys(eng).length) i.metrics = eng;
  }
}
