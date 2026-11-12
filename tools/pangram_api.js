#!/usr/bin/env node
// pangram_api.js - standalone Pangram REST API client + CLI for the
// AI-check warn-gate (issue #125, task 309). Implements the
// documented async task contract (docs.pangram.com/api-reference):
//
//   POST https://text.external-api.pangram.com/task
//     headers: x-api-key, Content-Type: application/json
//     body: { text, model: "pangram-4" }
//     -> { task_id }
//   GET https://text.external-api.pangram.com/task/{task_id}
//     -> { stage: STAGE_PREPROCESSING|STAGE_SUCCESS|STAGE_FAILED,
//          headline, prediction_short, fraction_ai, ... }
//
// pangramCheck(text, opts?) -> {
//   ok, label, short, score, words, task_id?, error?, error_class?
// }
//   label  - the result headline (e.g. "AI Generated",
//            "AI Assisted", "Human Written")
//   short  - prediction_short ("AI" | "Human" | "Mixed")
//   score  - fraction_ai 0..1 (null when absent)
//   error_class - config | http_<status> | transient_exhausted
//            | timeout | task_failed | protocol
//   Note: 'timeout' covers ONLY the async-task polling budget; a hung
//   socket / per-request timeout that survives the retry budget lands
//   in 'transient_exhausted' like every other exhausted transient.
//
// Key resolution order: opts.apiKey -> PANGRAM_API_KEY env ->
// ENV_FILE / PANGRAM_ENV_FILE path (default ../ENV next to this
// repo's tools/). The key is only ever sent as the x-api-key
// header - never logged, never embedded in a URL.
//
// CLI:  node tools/pangram_api.js "text to check"
//       echo "text" | node tools/pangram_api.js
// Prints the verdict as one JSON line.

const fs = require("node:fs");
const path = require("node:path");

const API_BASE = process.env.PANGRAM_API_BASE || "https://text.external-api.pangram.com";
const MODEL = process.env.PANGRAM_API_MODEL || "pangram-4";
const TIMEOUT_MS = Math.max(1000, Number(process.env.PANGRAM_API_TIMEOUT_MS) || 15000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.PANGRAM_API_MAX_ATTEMPTS) || 3);
// total wall-clock budget for the async task to reach a terminal
// stage once created (POST + polls stay inside per-request timeout)
const TASK_BUDGET_MS = Math.max(5000, Number(process.env.PANGRAM_API_TASK_BUDGET_MS) || 60000);
const POLL_MS = Math.max(200, Number(process.env.PANGRAM_API_POLL_MS) || 1500);

const words = (text) =>
  String(text || "")
    .split(/\s+/)
    .filter(Boolean).length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resolveKey = (explicit) => {
  if (explicit) return String(explicit).trim();
  const env = String(process.env.PANGRAM_API_KEY || "").trim();
  if (env) return env;
  const file =
    process.env.ENV_FILE || process.env.PANGRAM_ENV_FILE || path.join(__dirname, "..", "..", "ENV");
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*PANGRAM_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch (_e) {}
  return "";
};

const statusOf = (e) => {
  const s = Number(e && (e.statusCode || e.status || e.response?.status));
  return Number.isFinite(s) && s > 0 ? s : null;
};

// Retry-After header (429 responses): seconds or an HTTP date, capped
// so a hostile/buggy value cannot park the caller.
const RETRY_AFTER_CAP_MS = 30000;
const retryAfterMs = (e) => {
  const raw = e?.retryAfter;
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const t = Date.parse(String(raw));
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
};
// one HTTP request with bounded retry: transient faults (network
// errors, timeouts, 5xx, 429) back off exponentially with jitter
// (half-to-full of the base delay, decorrelating concurrent callers);
// a 429 carrying Retry-After waits that long instead (capped). Every
// other failure (4xx, protocol) fails fast. The API key only ever
// travels in the x-api-key header.
const request = async (key, opts) => {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_BASE + opts.path, {
        method: opts.method,
        headers: {
          "x-api-key": key,
          "Content-Type": "application/json",
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const e = new Error(`HTTP ${res.status}`);
        e.statusCode = res.status;
        if (res.status === 429) e.retryAfter = res.headers.get("retry-after");
        throw e;
      }
      if (res.status >= 400) {
        const e = new Error(`HTTP ${res.status}`);
        e.statusCode = res.status;
        e.pangramFatal = true; // 4xx: no retry, fail fast
        throw e;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e?.pangramFatal) throw e;
      if (attempt < MAX_ATTEMPTS) {
        const ra = retryAfterMs(e);
        // a server-provided Retry-After is slept VERBATIM (capped) -
        // jittering it can under-sleep the wait the server asked for;
        // jitter applies only to the computed exponential backoff
        await sleep(
          ra !== null
            ? Math.min(ra, RETRY_AFTER_CAP_MS)
            : 500 * 2 ** (attempt - 1) * (0.5 + Math.random()),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
};

const pangramCheck = async (text, opts = {}) => {
  const w = words(text);
  const key = resolveKey(opts.apiKey);
  if (!key) {
    return {
      ok: false,
      error_class: "config",
      error: "PANGRAM_API_KEY not configured",
      words: w,
    };
  }
  let created;
  try {
    created = await request(key, {
      method: "POST",
      path: "/task",
      body: { text: String(text), model: MODEL },
    });
  } catch (e) {
    const s = statusOf(e);
    return {
      ok: false,
      error_class: s ? `http_${s}` : "transient_exhausted",
      error: String(e?.message || e).slice(0, 200),
      words: w,
    };
  }
  const taskId = created?.task_id;
  if (!taskId) {
    return {
      ok: false,
      error_class: "protocol",
      error: "no task_id in POST /task response",
      words: w,
    };
  }
  const deadline = Date.now() + TASK_BUDGET_MS;
  for (;;) {
    // check the budget BEFORE each poll, not only between bursts: a
    // slow retry chain inside request() can overshoot the deadline,
    // so re-checking here aborts on expiry instead of firing one
    // more GET past the budget
    if (Date.now() > deadline) {
      return {
        ok: false,
        error_class: "timeout",
        error: "task polling budget exceeded",
        words: w,
        task_id: taskId,
      };
    }
    let r;
    try {
      r = await request(key, {
        method: "GET",
        path: `/task/${encodeURIComponent(taskId)}`,
      });
    } catch (e) {
      const s = statusOf(e);
      return {
        ok: false,
        error_class: s ? `http_${s}` : "transient_exhausted",
        error: String(e?.message || e).slice(0, 200),
        words: w,
        task_id: taskId,
      };
    }
    if (r && r.stage === "STAGE_SUCCESS") {
      const score = Number(r.fraction_ai);
      return {
        ok: true,
        label: String(r.headline || r.prediction_short || ""),
        short: String(r.prediction_short || ""),
        score: Number.isFinite(score) ? score : null,
        words: w,
        task_id: taskId,
        version: r.version || null,
      };
    }
    if (r && r.stage === "STAGE_FAILED") {
      return {
        ok: false,
        error_class: "task_failed",
        error: String(r.headline || "task failed").slice(0, 200),
        words: w,
        task_id: taskId,
      };
    }
    if (Date.now() > deadline) {
      return {
        ok: false,
        error_class: "timeout",
        error: "task polling budget exceeded",
        words: w,
        task_id: taskId,
      };
    }
    await sleep(POLL_MS);
  }
};

module.exports = { pangramCheck, resolveKey, words };

if (require.main === module) {
  (async () => {
    let text = process.argv.slice(2).join(" ");
    if (!text && !process.stdin.isTTY) {
      text = fs.readFileSync(0, "utf8");
    }
    if (!text.trim()) {
      console.error('usage: node tools/pangram_api.js "text to check"');
      process.exit(2);
    }
    const r = await pangramCheck(text);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => {
    console.error("pangram_api error:", String(e?.message || e));
    process.exit(1);
  });
}
