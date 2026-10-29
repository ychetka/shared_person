import crypto from "node:crypto";
import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";
import _ from "lodash";
import YAML from "yaml";
import { config } from "./config.js";

export interface Feed {
  name: string;
  url: string;
  tags: string[];
  weight: number;
}

export interface Item {
  id: string;
  source: string;
  title: string;
  summary: string;
  url: string;
  published: string; // ISO
  tags: string[];
  weight?: number; // feed weight from feeds.yaml
  comments?: string; // discussion URL when the feed provides one (e.g. HN)
  metrics?: import("./metrics.js").Engagement;
  score?: number; // LLM curator score 0-10
  angle?: string | null;
  reason?: string;
  hype?: number; // 0-100, see hype.ts for the formula
  hype_parts?: { theme: number; llm: number; weight: number; engagement: number };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: {
    enabled: true,
    maxTotalExpansions: 100_000,
    maxExpandedLength: 4_000_000,
    maxEntityCount: 20_000,
  },
});

export function loadFeeds(): Feed[] {
  const doc = YAML.parse(fs.readFileSync(config.feedsFile, "utf8"));
  return (doc?.feeds ?? []).filter((f: Feed) => f?.url);
}

export function saveFeeds(feeds: Feed[]): void {
  fs.writeFileSync(config.feedsFile, YAML.stringify({ feeds }));
}

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["#text"] ?? o["@_href"] ?? "");
  }
  return String(v);
}

function findLink(link: unknown): string {
  if (Array.isArray(link)) {
    const alt = link.find((l) => (l as Record<string, unknown>)["@_rel"] !== "self");
    return text(alt ?? link[0]);
  }
  return text(link);
}

// --- RSS 2.0 / Atom / RDF parsing ---

function parseRss(
  doc: Record<string, unknown>,
): { title: string; link: string; date: string; summary: string; comments: string }[] {
  const channel = doc?.rss ? (doc.rss as Record<string, unknown>).channel : doc?.["rdf:RDF"];
  const items = ((channel as Record<string, unknown>)?.item ?? []) as unknown[];
  return _.castArray(items).map((it) => {
    const i = it as Record<string, unknown>;
    return {
      title: text(i.title),
      link: text(i.link),
      date: text(i.pubDate ?? i["dc:date"] ?? i.published),
      summary: text(i.description ?? i["content:encoded"]),
      comments: text(i.comments), // HN exposes the thread URL here
    };
  });
}

function parseAtom(
  doc: Record<string, unknown>,
): { title: string; link: string; date: string; summary: string }[] {
  const feed = doc.feed as Record<string, unknown>;
  const entries = _.castArray(feed?.entry ?? []);
  return entries.map((e) => ({
    title: text((e as Record<string, unknown>).title),
    link: findLink((e as Record<string, unknown>).link),
    date: text((e as Record<string, unknown>).published ?? (e as Record<string, unknown>).updated),
    summary: text((e as Record<string, unknown>).summary ?? (e as Record<string, unknown>).content),
  }));
}

export function parseFeed(
  xml: string,
): { title: string; link: string; date: string; summary: string; comments?: string }[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  if (doc.rss || doc["rdf:RDF"]) return parseRss(doc);
  if (doc.feed) return parseAtom(doc);
  return [];
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export async function fetchFeed(feed: Feed): Promise<Item[]> {
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
    headers: {
      "User-Agent": config.userAgent,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });
  if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml)
    .map((p) => ({
      id: crypto
        .createHash("sha1")
        .update(feed.name + p.link + p.title)
        .digest("hex")
        .slice(0, 16),
      source: feed.name,
      title: p.title.trim(),
      summary: stripHtml(p.summary),
      url: p.link.trim(),
      published: new Date(p.date).toISOString(),
      tags: feed.tags,
      weight: feed.weight,
      comments: p.comments || undefined,
    }))
    .filter((i) => i.title && i.url);
}
