import express from "express";
import _ from "lodash";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "./config.js";
import { buildSystemPrompt, listRoles, loadRole } from "./manifest.js";
import { callImage, callLlm } from "./backends.js";

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

// POST /image {prompt, name?} - generate a PNG via a Gemini image model
// and write it to config.imageDir (mounted as materials/img). The
// returned `path` is materials/img/<name>.png, the same form media[]
// entries take for the moderation sendPhoto resolution.
app.post("/image", async (req, res) => {
  try {
    const { prompt, name } = req.body ?? {};
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt required" });
    }
    const safe = String(name || "img")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80) || "img";
    const img = await callImage(prompt);
    const ext = img.mime === "image/webp" ? "webp"
      : img.mime === "image/jpeg" ? "jpg" : "png";
    const fname = `${safe}.${ext}`;
    fs.mkdirSync(config.imageDir, { recursive: true });
    const abs = path.join(config.imageDir, fname);
    const buf = Buffer.from(img.base64, "base64");
    fs.writeFileSync(abs, buf);
    return res.json({
      ok: true,
      path: `materials/img/${fname}`,
      file: abs,
      model: img.model,
      backend: img.backend,
      bytes: buf.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

app.listen(config.port, () => {
  console.log(`llm-gateway on :${config.port}, roles: ${listRoles().length}`);
});
