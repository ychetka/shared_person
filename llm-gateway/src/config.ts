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
};
