import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const seenFile = () => path.join(config.stateDir, "seen.json");

function load(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenFile(), "utf8")));
  } catch {
    return new Set();
  }
}

export function filterUnseen(ids: string[]): string[] {
  const seen = load();
  return ids.filter((id) => !seen.has(id));
}

export function markSeen(ids: string[]): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  const seen = load();
  for (const id of ids) seen.add(id);
  // keep last ~50k ids
  const arr = [...seen].slice(-50_000);
  fs.writeFileSync(seenFile(), JSON.stringify(arr));
}
