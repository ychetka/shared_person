import { config } from "./config.js";
import type { RoleManifest } from "./manifest.js";

export interface LlmResult {
  text: string;
  model: string;
  backend: string;
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

export interface ImageResult {
  base64: string;
  mime: string;
  model: string;
  backend: string;
}

async function callGeminiImage(
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<ImageResult> {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY not set");
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
    `:generateContent?key=${config.geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    candidates?: {
      content?: {
        parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[];
      };
    }[];
  };
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("gemini image: no inlineData in response");
  return {
    base64: part.inlineData.data,
    mime: part.inlineData.mimeType ?? "image/png",
    model,
    backend: "gemini",
  };
}

export async function callImage(prompt: string): Promise<ImageResult> {
  // Per-attempt timeout is requestTimeoutMs, but the fallback loop has
  // an overall deadline so N models x timeout cannot overshoot the
  // caller's own HTTP timeout (n8n /image wait is 290s).
  const deadline = Date.now() + config.imageTotalTimeoutMs;
  let lastErr: unknown = new Error("no image models configured");
  for (const model of config.imageModels) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastErr = new Error(
        `image deadline exceeded (${config.imageTotalTimeoutMs}ms total); ` +
        `last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
      break;
    }
    try {
      return await callGeminiImage(
        model, prompt, Math.min(config.requestTimeoutMs, remaining),
      );
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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
      return await callGemini(attempt, system, input);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
