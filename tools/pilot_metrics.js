#!/usr/bin/env node
// pilot_metrics.js - rescan the Pangram pilot artifacts
// (.devin/pilot_pangram/) so every scored artifact row gains the
// cheap P1 eval signals from tools/text_metrics.js: LLM-judge
// readability for every .txt artifact, plus meaning cosine and the
// length-ratio guardrail where a natural input->output pair exists:
//
//   mp_draft -> mp_v1   (manual polish of the machine draft)
//   vm_v1    -> vm_v2   (voice-mimic deeper humanization)
//   hc_b0    -> hc_v1   -> hc_v2   (human-core polish -> rewrite)
//
// For each artifact one row is appended to ledger.jsonl in the
// existing schema {ts,variant,words,label,score,note} with
// label:'metrics' and the signals carried in a new `metrics` field
// (score stays null - existing rows and the numeric score slot are
// untouched):
//
//   {ts, variant, words, label:'metrics', score:null,
//    metrics:{readability, readability_error?, meaning?, vs?,
//             length_ratio?, length_flag?}, note}
//
// Idempotent: a variant is skipped only when a metrics row already
// seals it with a REAL readability score. A row whose readability
// is null (judge unreachable) does NOT seal - the next run appends
// a fresh metrics row for the variant, so a transient gateway
// outage never freezes a variant out of readability data (the
// duplicate row is the honest retry trail; the ledger is
// append-only, never rewritten). --force re-appends every variant
// regardless.
//
// Offline only: no Pangram calls, no paid APIs. When the llm-gateway
// is unreachable readability lands as null with
// readability_error:'gateway_unavailable' and the note flags it.
//
// Env: PILOT_DIR overrides the artifact dir (tests); LLM_GATEWAY_URL
// and TEXT_METRICS_TIMEOUT_MS reach through to text_metrics.
//
// Run:  node tools/pilot_metrics.js [--force]

const fs = require("node:fs");
const path = require("node:path");
const { meaningCosine, lengthRatio, readability, words } = require("./text_metrics.js");

const PILOT_DIR =
  process.env.PILOT_DIR || path.join(__dirname, "..", "..", ".devin", "pilot_pangram");
const LEDGER = path.join(PILOT_DIR, "ledger.jsonl");

// variant -> the artifact that fed it (input->output chains only)
const CHAIN_PREV = {
  mp_v1: "mp_draft",
  vm_v2: "vm_v1",
  hc_v1: "hc_b0",
  hc_v2: "hc_v1",
};

const ledgerRows = () => {
  try {
    return fs
      .readFileSync(LEDGER, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_e) {
          return null; // malformed historical lines pass through untouched
        }
      })
      .filter(Boolean);
  } catch (_e) {
    return [];
  }
};

const appendRow = (row) => {
  fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
};

const main = async () => {
  const force = process.argv.includes("--force");
  if (!fs.existsSync(PILOT_DIR)) {
    console.error(`pilot_metrics: ${PILOT_DIR} not found`);
    process.exit(2);
  }
  // a variant is sealed only by a metrics row that landed a real
  // readability score; readability:null rows (judge unreachable)
  // leave it open for the next run
  const done = new Set(
    ledgerRows()
      .filter((r) => r.label === "metrics" && r.variant && r.metrics?.readability != null)
      .map((r) => r.variant),
  );
  const files = fs
    .readdirSync(PILOT_DIR)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  let appended = 0;
  for (const f of files) {
    const variant = f.replace(/\.txt$/, "");
    if (!force && done.has(variant)) continue;
    const text = fs.readFileSync(path.join(PILOT_DIR, f), "utf8");
    const r = await readability(text);
    const metrics = { readability: r.score };
    if (r.error) metrics.readability_error = r.error;
    const prev = CHAIN_PREV[variant];
    if (prev && fs.existsSync(path.join(PILOT_DIR, `${prev}.txt`))) {
      const input = fs.readFileSync(path.join(PILOT_DIR, `${prev}.txt`), "utf8");
      const len = lengthRatio(input, text);
      metrics.vs = prev;
      metrics.meaning = Math.round(meaningCosine(input, text) * 10000) / 10000;
      metrics.length_ratio = Number.isFinite(len.ratio)
        ? Math.round(len.ratio * 10000) / 10000
        : null;
      metrics.length_flag = len.flag;
    }
    appendRow({
      ts: new Date().toISOString(),
      variant,
      words: words(text),
      label: "metrics",
      score: null,
      metrics,
      note: "task342 P1 eval metrics rescan" + (r.error ? "; readability judge unreachable" : ""),
    });
    appended++;
    console.log(`metrics ${variant}: ${JSON.stringify(metrics)}`);
  }
  console.log(`pilot_metrics: ${appended} row(s) appended to ${LEDGER}`);
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`pilot_metrics error: ${String(e?.message || e)}`);
    process.exit(1);
  });
}

module.exports = { main };
