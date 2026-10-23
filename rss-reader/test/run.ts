// Smoke test for rss-reader. Usage: RSS=http://localhost:8788 tsx test/run.ts
const base = process.env.RSS ?? "http://localhost:8788";

async function main() {
  const h = await (await fetch(`${base}/health`)).json();
  console.log("health:", JSON.stringify(h));
  const d = (await (await fetch(`${base}/digest?since=48h`)).json()) as { items: unknown[] };
  console.log("digest items:", d.items?.length ?? 0);
  const sample = (d.items as { source: string; title: string }[]).slice(0, 5);
  for (const i of sample) console.log(` - [${i.source}] ${i.title}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
