#!/usr/bin/env node
// text_metrics.js - cheap eval metrics for the humanizer pipeline
// (HumanizerBench proposal P1, task 342). Three signals the
// single-detector Pangram gate misses - meaning drift, length
// inflation/deflation, readability regression - at zero paid API
// cost:
//
//   meaningCosine(inputText, outputText) -> 0..1
//       word-level TF-IDF cosine similarity over the two documents
//       only (the idf corpus IS the pair). Language-agnostic:
//       lowercases and splits on non-letter/non-number chars, so
//       RU and EN both tokenize. A stand-in for the benchmark's
//       embedding cosine - good enough for relative comparison,
//       not calibrated against text-embedding-3-large.
//
//   lengthRatio(inputText, outputText) -> {ratio, flag}
//       whitespace word-count ratio output/input; flag is true
//       when the ratio leaves the HumanizerBench penalty band
//       [0.6, 1.4] (deflation <0.6, inflation >1.4).
//
//   readability(text, opts?) -> {score, error?}
//       LLM-as-judge through the inhouse gateway:
//       POST <LLM_GATEWAY_URL default http://127.0.0.1:8787>/run
//       {role:'fluency-judge', input:'{"source_text":...,"language":...}'}
//       - the same blind payload the eval workflow's judge leg sends
//       (n8n/workflows/sp-humanizer-eval.json, roles/fluency-judge.yaml).
//       The judge contract is {score:0-100 HIGHER=WORSE, rationale,
//       issues[]} so the reply is inverted into the metrics polarity:
//       readability = 1 - score/100 (0..1, higher=better).
//       5s timeout; a down gateway, a non-2xx, or an unparseable
//       score returns {score:null, error:'gateway_unavailable'} -
//       readability NEVER throws, an eval signal must not kill a run.
//
// CLI:  node tools/text_metrics.js <inputFile> [outputFile]
// Prints one JSON line
//   {meaning, length_ratio, length_flag, readability,
//    readability_error?}
// With one file argument the text is compared against itself
// (meaning=1, ratio=1) and readability still scores it.

const fs = require("node:fs");

const GATEWAY = String(process.env.LLM_GATEWAY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(500, Number(process.env.TEXT_METRICS_TIMEOUT_MS) || 5000);
// HumanizerBench methodology 1.3.0 penalty thresholds
const LEN_MIN = 0.6;
const LEN_MAX = 1.4;

const tokens = (text) =>
  String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const words = (text) =>
  String(text || "")
    .split(/\s+/)
    .filter(Boolean).length;

// TF-IDF vector over a document: tf * idf where idf is the smoothed
// (N+1)/(df+1) + 1 form - terms shared by both docs keep weight 1
// instead of collapsing to zero, so identical texts still score ~1.
const tfidfVectors = (docs) => {
  const df = new Map();
  const tfs = docs.map((d) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });
  const n = docs.length;
  return tfs.map((tf) => {
    const v = new Map();
    for (const [t, c] of tf) v.set(t, c * (Math.log((n + 1) / (df.get(t) + 1)) + 1));
    return v;
  });
};

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (!na || !nb) return 0;
  // iterate the smaller vector for the dot product
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, v] of small) {
    const w = big.get(t);
    if (w) dot += v * w;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const meaningCosine = (inputText, outputText) => {
  const a = tokens(inputText);
  const b = tokens(outputText);
  if (!a.length || !b.length) return 0;
  const [va, vb] = tfidfVectors([a, b]);
  return Math.min(1, Math.max(0, cosine(va, vb)));
};

const lengthRatio = (inputText, outputText) => {
  const wi = words(inputText);
  const wo = words(outputText);
  const ratio = wi > 0 ? wo / wi : wo > 0 ? Number.POSITIVE_INFINITY : 1;
  return { ratio, flag: !(ratio >= LEN_MIN && ratio <= LEN_MAX) };
};

// pull the judge's 0-100 damage score out of whatever shape the
// reply takes: the gateway wraps the role output as
// {role,model,backend,json:{score,rationale,issues}} but a bare
// contract object or a text/raw blob naming the score is accepted
// too (stubs differ)
const scoreOf = (reply) => {
  const cand = [reply?.json?.score, reply?.score];
  for (const c of cand) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  const raw = typeof reply?.json === "string" ? reply.json : reply?.text || reply?.raw || "";
  // an explicit 'score: 42' label wins; a bare digit run must be an
  // isolated 1-3 digit number clear of word chars AND date/time
  // separators so '01' or '30' inside '2026-01-15T10:30:00Z' never
  // reads as a score
  const m =
    /\b(?:score|readability)\b[^\d]{0,10}(\d{1,3}(?:\.\d+)?)/i.exec(String(raw)) ||
    /(?<![\w.:/-])(\d{1,3}(?:\.\d+)?)(?![\w.:/-])/.exec(String(raw));
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return null;
};

// the blind-judge contract wants a declared language: a
// cyrillic-majority text is 'ru', everything else 'en' (the judge
// is EN-calibrated and scores other languages shallowly by design)
const langOf = (text) => {
  const s = String(text || "");
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (s.match(/[a-zA-Z]/g) || []).length;
  return cyr > lat ? "ru" : "en";
};

const readability = async (text, opts = {}) => {
  const gateway = String(opts.gateway || GATEWAY).replace(/\/+$/, "");
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${gateway}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "fluency-judge",
        input: JSON.stringify({ source_text: String(text || ""), language: langOf(text) }),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { score: null, error: "gateway_unavailable" };
    const reply = await res.json();
    const damage = scoreOf(reply);
    if (damage === null) return { score: null, error: "gateway_unavailable" };
    // judge polarity is 0-100 HIGHER=WORSE fluency damage; the
    // metrics contract is 0..1 higher=better, so invert
    return { score: Math.round((1 - damage / 100) * 10000) / 10000 };
  } catch (_e) {
    // unreachable, refused, timed out, unparseable body - all the
    // same degraded answer; the caller gets a signal gap, not a crash
    return { score: null, error: "gateway_unavailable" };
  } finally {
    clearTimeout(timer);
  }
};

const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);

module.exports = {
  meaningCosine,
  lengthRatio,
  readability,
  tokens,
  words,
  langOf,
  LEN_MIN,
  LEN_MAX,
};

if (require.main === module) {
  (async () => {
    const [inFile, outFile] = process.argv.slice(2);
    if (!inFile) {
      console.error("usage: node tools/text_metrics.js <inputFile> [outputFile]");
      process.exit(2);
    }
    let input;
    let output;
    try {
      input = fs.readFileSync(inFile, "utf8");
      output = fs.readFileSync(outFile || inFile, "utf8");
    } catch (e) {
      console.error(`text_metrics: ${String(e?.message || e)}`);
      process.exit(2);
    }
    const len = lengthRatio(input, output);
    const r = await readability(output);
    const out = {
      meaning: round4(meaningCosine(input, output)),
      length_ratio: round4(len.ratio),
      length_flag: len.flag,
      readability: r.score,
    };
    if (r.error) out.readability_error = r.error;
    console.log(JSON.stringify(out));
  })().catch((e) => {
    console.error(`text_metrics error: ${String(e?.message || e)}`);
    process.exit(1);
  });
}
