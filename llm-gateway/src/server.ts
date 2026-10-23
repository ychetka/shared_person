import express from "express";
import _ from "lodash";
import { createRequire } from "node:module";
import { config } from "./config.js";
import { buildSystemPrompt, listRoles, loadRole } from "./manifest.js";
import { callLlm } from "./backends.js";

const Ajv = createRequire(import.meta.url)("ajv") as typeof import("ajv").default;
const ajv = new Ajv();
const app = express();
app.use(express.json({ limit: "4mb" }));

function stripJsonFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/roles", (_req, res) =>
  res.json(
    listRoles().map((r) =>
      _.pick(r, ["name", "description", "backend", "model", "temperature"]),
    ),
  ),
);

app.post("/run", async (req, res) => {
  try {
    const { role, input, system_extra } = req.body ?? {};
    if (!role || typeof input !== "string") {
      return res.status(400).json({ error: "role and input required" });
    }
    const manifest = loadRole(String(role));
    let system = buildSystemPrompt(manifest);
    if (system_extra) system += `\n\n${system_extra}`;

    const result = await callLlm(manifest, system, input);
    const wantsJson = manifest.output?.type === "json";
    if (!wantsJson) return res.json({ role: manifest.name, ...result });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFences(result.text));
    } catch {
      return res
        .status(422)
        .json({ error: "model returned non-JSON", raw: result.text.slice(0, 500) });
    }
    if (manifest.output?.schema) {
      const valid = ajv.compile(manifest.output.schema)(parsed);
      if (!valid) {
        return res.status(422).json({ error: "schema validation failed", parsed });
      }
    }
    return res.json({ role: manifest.name, model: result.model, backend: result.backend, json: parsed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

app.listen(config.port, () => {
  console.log(`llm-gateway on :${config.port}, roles: ${listRoles().length}`);
});
