import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { config } from "./config.js";

export interface RoleManifest {
  name: string;
  description?: string;
  backend: "openrouter" | "gemini";
  model: string;
  fallback_models?: string[]; // tried in order when primary fails
  temperature?: number;
  max_tokens?: number;
  prompt: string; // file stem in promptsDir
  context_slots?: string[]; // file stems in contextDir
  output?: { type?: "json" | "text"; schema?: Record<string, unknown> };
}

const cache = new Map<string, RoleManifest>();

export function loadRole(name: string): RoleManifest {
  const cached = cache.get(name);
  if (cached) return cached;
  const file = path.join(config.rolesDir, `${name}.yaml`);
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) as RoleManifest;
  if (!doc?.name || !doc.backend || !doc.model || !doc.prompt) {
    throw new Error(`invalid manifest ${file}: name/backend/model/prompt required`);
  }
  cache.set(name, doc);
  return doc;
}

export function listRoles(): RoleManifest[] {
  return fs
    .readdirSync(config.rolesDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadRole(f.replace(/\.yaml$/, "")));
}

function readStem(dir: string, stem: string): string {
  try {
    return fs.readFileSync(path.join(dir, `${stem}.txt`), "utf8");
  } catch {
    try {
      return fs.readFileSync(path.join(dir, `${stem}.md`), "utf8");
    } catch {
      return "";
    }
  }
}

export function buildSystemPrompt(role: RoleManifest): string {
  const parts: string[] = [];
  for (const slot of role.context_slots ?? []) {
    const body = readStem(config.contextDir, slot);
    if (body) parts.push(`<context name="${slot}">\n${body}\n</context>`);
  }
  const prompt = readStem(config.promptsDir, role.prompt);
  if (!prompt) throw new Error(`prompt file missing for role ${role.name}`);
  parts.push(prompt);
  return parts.join("\n\n");
}
