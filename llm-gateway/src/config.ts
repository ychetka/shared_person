import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", ".."); // code/

export const config = {
  port: Number(process.env.LLM_GATEWAY_PORT ?? 8787),
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  rolesDir: process.env.ROLES_DIR ?? path.join(ROOT, "roles"),
  promptsDir: process.env.PROMPTS_DIR ?? path.join(ROOT, "prompts"),
  contextDir: process.env.CONTEXT_DIR ?? path.join(ROOT, "context"),
  requestTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000),
  // POST /image - Gemini image generation (generateContent with
  // responseModalities ["IMAGE"]). PNGs are written to imageDir so
  // moderation can sendPhoto them via the shared materials mount.
  imageDir: process.env.IMAGE_DIR ?? path.join(ROOT, "..", "materials", "img"),
  // Overall budget for /image across ALL fallback attempts. Each attempt
  // still gets requestTimeoutMs, but the loop stops at this deadline so
  // total latency cannot exceed the caller's patience (n8n waits 290s).
  imageTotalTimeoutMs: Number(process.env.IMAGE_TOTAL_TIMEOUT_MS ?? 250_000),
  imageModels: (process.env.IMAGE_MODELS ??
    "gemini-3.1-flash-image-preview,gemini-2.5-flash-image")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
};
