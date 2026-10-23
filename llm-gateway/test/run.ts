// Smoke test: hits a running gateway. Usage: GATEWAY=http://localhost:8787 tsx test/run.ts [role]
const base = process.env.GATEWAY ?? "http://localhost:8787";
const role = process.argv[2];

async function main() {
  const roles = (await (await fetch(`${base}/roles`)).json()) as { name: string }[];
  console.log("roles:", roles.map((r) => r.name).join(", "));
  const pick = role ?? "extract-facts";
  const input =
    pick === "extract-facts"
      ? "We built an n8n workflow: TradingView alert (JSON: OB low, VRVP POC, RSI 14, Stoch) -> localtunnel -> n8n -> OpenRouter LLM verdict -> Telegram. Iterations: broken JSON templates in TV plot() quotes, n8n auto-attribution footer removed. Stack: n8n, OpenRouter, Pine v5, Bybit V5."
      : "Say ok.";
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: pick, input }),
  });
  const data = await res.json();
  console.log(res.status, JSON.stringify(data, null, 2).slice(0, 3000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
