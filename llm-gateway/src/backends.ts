import { config } from "./config.js";
import type { RoleManifest } from "./manifest.js";

export interface LlmResult {
  text: string;
  model: string;
  backend: string;
}

async function callOpenRouter(
  role: RoleManifest,
  system: string,
  input: string,
): Promise<LlmResult> {
  if (!config.openrouterKey) throw new Error("OPENROUTER_API_KEY not set");
  const wantsJson = role.output?.type === "json";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      Authorization: `Bearer ${config.openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: role.model,
      temperature: role.temperature,
      max_tokens: role.max_tokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      ...(wantsJson ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return { text: data.choices[0]?.message?.content ?? "", model: role.model, backend: "openrouter" };
}

async function callGemini(
  role: RoleManifest,
  system: string,
  input: string,
): Promise<LlmResult> {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY not set");
  const wantsJson = role.output?.type === "json";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${role.model}` +
    `:generateContent?key=${config.geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: {
        temperature: role.temperature,
        maxOutputTokens: role.max_tokens,
        ...(wantsJson ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text, model: role.model, backend: "gemini" };
}

export async function callLlm(
  role: RoleManifest,
  system: string,
  input: string,
): Promise<LlmResult> {
  const models = [role.model, ...(role.fallback_models ?? [])];
  let lastErr: unknown = new Error("no models configured");
  for (const model of models) {
    const attempt = { ...role, model };
    try {
      return role.backend === "gemini"
        ? await callGemini(attempt, system, input)
        : await callOpenRouter(attempt, system, input);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
