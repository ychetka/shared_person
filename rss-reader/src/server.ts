import express from "express";
import _ from "lodash";
import { config } from "./config.js";
import { type Feed, fetchFeed, type Item, loadFeeds, saveFeeds } from "./feeds.js";
import { hypeScore } from "./hype.js";
import { attachEngagement } from "./metrics.js";
import { filterUnseen, markSeen } from "./store.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, feeds: loadFeeds().length }));

async function collect(sinceMs: number): Promise<Item[]> {
  const feeds = loadFeeds();
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f)));
  const items: Item[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else console.error(`feed ${feeds[i].name} failed:`, r.reason?.message ?? r.reason);
  });
  const cutoff = Date.now() - sinceMs;
  return items
    .filter((i) => !Number.isNaN(Date.parse(i.published)) && Date.parse(i.published) >= cutoff)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

// GET /digest?since=24h&tags=ai,frontend&fresh=1
app.get("/digest", async (req, res) => {
  const since = parseSince(String(req.query.since ?? "24h"));
  const tags = req.query.tags ? String(req.query.tags).split(",") : null;
  const freshOnly = req.query.fresh === "1";
  try {
    let items = await collect(since);
    if (tags) items = items.filter((i) => _.intersection(i.tags, tags).length > 0);
    if (freshOnly) {
      const fresh = filterUnseen(items.map((i) => i.id));
      items = items.filter((i) => fresh.includes(i.id));
      markSeen(items.map((i) => i.id));
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Attach engagement metrics + hype score, order by hype desc.
async function finish(items: Item[], curated: boolean) {
  await attachEngagement(items);
  for (const i of items) {
    const h = hypeScore(i);
    i.hype = h.hype;
    i.hype_parts = h.parts;
  }
  return { items: _.orderBy(items, ["hype", "score"], ["desc", "desc"]), curated };
}

// POST /curate {items?: Item[]} - LLM scoring via llm-gateway; no body = digest first
app.post("/curate", async (req, res) => {
  try {
    let items: Item[] = req.body?.items;
    if (!items) {
      const since = parseSince(String(req.query.since ?? "24h"));
      items = await collect(since);
    }
    if (!config.llmGatewayUrl) return res.json(await finish(items, false));
    // chunk sequentially to keep LLM output within max_tokens and
    // stay inside provider rate limits (~25 items per call)
    const scoredLists: Partial<Item>[][] = [];
    for (const chunk of _.chunk(items, 25)) {
      const resp = await fetch(`${config.llmGatewayUrl}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: config.curateRole,
          input: JSON.stringify({
            items: chunk.map((i) =>
              _.pick(i, ["id", "source", "title", "summary", "url", "published"]),
            ),
          }),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const data = (await resp.json()) as { json?: { items?: Partial<Item>[] }; error?: string };
      if (!data.json?.items) {
        console.error("curate chunk failed:", data.error ?? "no items in response");
      }
      scoredLists.push(data.json?.items ?? []);
    }
    const byId = _.keyBy(scoredLists.flat(), "id");
    const scored = items.map((i) => ({ ...i, ...byId[i.id] }));
    res.json(await finish(scored, true));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/feeds", (_req, res) => res.json({ feeds: loadFeeds() }));

app.put("/feeds", (req, res) => {
  const feeds = req.body?.feeds as Feed[] | undefined;
  if (!Array.isArray(feeds)) return res.status(400).json({ error: "feeds[] required" });
  saveFeeds(
    feeds.map((f) => ({ name: f.name, url: f.url, tags: f.tags ?? [], weight: f.weight ?? 0.5 })),
  );
  res.json({ ok: true, feeds: loadFeeds().length });
});

function parseSince(s: string): number {
  const m = s.match(/^(\d+)\s*([hdw])$/);
  if (!m) return 24 * 3600_000;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600_000 : m[2] === "d" ? n * 86400_000 : n * 7 * 86400_000;
}

app.listen(config.port, () => {
  console.log(`rss-reader on :${config.port}, feeds: ${loadFeeds().length}`);
});
