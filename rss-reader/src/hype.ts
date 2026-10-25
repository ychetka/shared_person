import type { Item } from "./feeds.js";

// Hype score (0-100) - how likely an item is worth a commentary post.
//
//   hype = 40 * theme + 30 * llm + 10 * weight + 20 * engagement
//
//   theme      pillar keyword fit, by number of pillar groups matched
//              in title+summary: 0/1/2/3+ -> 0/0.6/0.85/1.0.
//              When no group matches the text but the feed tags do,
//              theme = 0.3 (source is on-topic, item may not be).
//   llm        curator score / 10 (0 when LLM curation is off/failed)
//   weight     source weight from feeds.yaml (0-1)
//   engagement log-normalized metrics when fetchable (habr page stats,
//              HN points via Algolia), else 0:
//                0.5 * ln1p(comments) / ln1p(150)
//              + 0.3 * ln1p(views)    / ln1p(50000)
//              + 0.2 * ln1p(votes)    / ln1p(100)
//              (votes = max(votesCount, |rating|) for habr,
//               HN points for Show HN items)

const PILLARS: [string, RegExp[]][] = [
  [
    "ai-agents",
    [
      /\bagent(s|ic)?\b/i, /\bllm(s)?\b/i, /\bgpt[-\s]?\d|claude|gemini|openai|anthropic|deepseek|qwen|llama\b/i,
      /\bmcp\b|model context protocol/i, /\brag\b|retrieval.augmented/i, /prompt(ing)?/i,
      /copilot|cursor|codeium/i, /нейросет|языков(ая|ой|ую) модел|ии-агент/i,
    ],
  ],
  [
    "automation",
    [
      /\bn8n\b/i, /automat(e|ion|ic)/i, /workflow/i, /self-?host/i, /pipeline/i,
      /telegram[-\s]?bot|\bbot\b/i, /автоматизац/i,
    ],
  ],
  [
    "frontend",
    [
      /\breact\b/i, /typescript|\bts\b/i, /front-?end/i, /\bvite\b|next\.?js|nuxt/i,
      /javascript|\bnode\.?js\b/i, /\bcss\b|tailwind/i, /фронтенд|вёрстк|верстк/i,
    ],
  ],
  [
    "algo-trading",
    [
      /\btrad(e|ing|er)s?\b/i, /\bquant(itative)?\b/i, /backtest/i, /algo(-?trad)?/i,
      /fintech|crypto(currency)?|bitcoin|exchange/i, /market[-\s]?data|order[-\s]?book/i,
      /трейдинг|алготрейдинг|бирж|торгов(ый|ая|ые) (робот|стратег|бот)/i,
    ],
  ],
  [
    "devops",
    [
      /\bdocker\b|kubernetes|\bk8s\b/i, /\bci\/?cd\b/i, /devops/i, /deploy/i,
      /\blinux\b|\bserver\b|vps/i, /observability|monitoring/i,
    ],
  ],
];

const THEME_BY_GROUPS = [0, 0.6, 0.85, 1.0];

function themeScore(item: Item): number {
  const text = `${item.title} ${item.summary}`;
  const tagText = item.tags.join(" ");
  let textGroups = 0;
  let tagGroups = 0;
  for (const [, patterns] of PILLARS) {
    if (patterns.some((p) => p.test(text))) textGroups++;
    else if (patterns.some((p) => p.test(tagText))) tagGroups++;
  }
  if (!textGroups) return tagGroups ? 0.3 : 0;
  return THEME_BY_GROUPS[Math.min(textGroups, 3)];
}

const ln = (v: number, cap: number) =>
  v > 0 ? Math.min(1, Math.log1p(v) / Math.log1p(cap)) : 0;

function engagementScore(item: Item): number {
  const m = item.metrics;
  if (!m) return 0;
  const votes = Math.max(m.votes ?? 0, Math.abs(m.rating ?? 0));
  const e =
    0.5 * ln(m.comments ?? 0, 150) +
    0.3 * ln(m.views ?? 0, 50_000) +
    0.2 * ln(votes, 100);
  return Math.min(1, e);
}

export interface HypeResult {
  hype: number;
  parts: { theme: number; llm: number; weight: number; engagement: number };
}

export function hypeScore(item: Item): HypeResult {
  const parts = {
    theme: themeScore(item),
    llm: typeof item.score === "number" ? Math.min(Math.max(item.score, 0), 10) / 10 : 0,
    weight: Math.min(Math.max(item.weight ?? 0.5, 0), 1),
    engagement: engagementScore(item),
  };
  const hype = Math.round(
    100 * (0.4 * parts.theme + 0.3 * parts.llm + 0.1 * parts.weight + 0.2 * parts.engagement),
  );
  return { hype, parts };
}
