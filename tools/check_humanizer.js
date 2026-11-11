#!/usr/bin/env node
// check_humanizer.js - harness for the issue #78 humanizer eval
// pipeline. Runs the REAL 'Eval Tick' jsCode from
// n8n/workflows/sp-humanizer-eval.json inside a stubbed n8n
// Code-node sandbox (same contract as check_pangram.js /
// check_habr.js) against the REAL fixture corpus in
// fixtures/humanizer/, and asserts:
//
//   E1  seeding: the first tick creates <chain>__<tier>-<lang>.json
//       run files for every fixture cell x enabled chain; a second
//       tick seeds nothing (idempotent);
//   E2  clean_human: both chains reach done/'pass' with ZERO
//       iterations - the partner is never invoked (no rewrite
//       trace, no http calls, iteration stays 0);
//   E3  ai_flop editor: converges to done/'pass' in <=2 iterations
//       with a visible scoring->decide->rewriting->rescoring trace;
//       the baseline chain scores then escalates 'no_rewrite_stage'
//       without ever rewriting;
//   E4  borderline editor: escalates 'max_iterations' after exactly
//       2 attempts with a recorded best-so-far - the score never
//       dips below threshold on the way (no oscillation);
//   E5  score ledger: state/humanizer_scores.jsonl rows carry
//       {run_id,fixture,chain,stage,score_label,confidence,words,
//       credits_used,at} - one row per scored cell incl. the
//       post-rewrite rescores;
//   E6  pangram scorer: enqueues pangram-<run>-<seq>.json
//       {recipe:'pangram_check', params:{text,snippet}}, charges
//       ceil(words/100) into the shared credits counter, consumes
//       the landed .result.json and scores 'Possibly human' 95% as
//       ai_score 5 -> pass;
//   E7  pangram credit cap: HUMANIZER_DAILY_CREDITS=0 -> the run
//       escalates 'credit_cap' with ZERO inbox writes;
//   E8  pangram queue missing: no hands-queue dirs -> the scorer
//       falls back to stub, stamped scorer_fallback + a trace note;
//   E9  inhouse partner: POST http://127.0.0.1:8787/run
//       {role:'humanizer-partner', input:<json payload>} drives the
//       rewrite (loopback default - all compose services run
//       network_mode:host so 'llm-gateway' is unresolvable); a
//       422-class failure records a failed attempt and escalates
//       'partner_failed';
//   E10 external stage: chain 'writehuman' with no
//       HUMANIZER_EXT_WRITEHUMAN_URL -> 'unavailable' cell +
//       escalate 'stage_unavailable' with ZERO http calls;
//   E11 regression: a rescore worse than best by > margin reverts to
//       best text -> done/'reverted';
//   E12 no external calls in stub mode: httpRequest is never touched
//       across the whole stub-mode run matrix;
//   E13 scorer stale claim: a scorer_pending older than
//       SCORE_STALE_MS gets ONE re-enqueue (score-stale-clear), a
//       second stale escalates 'scorer_failed';
//   E14 charge dedupe: a crash between the inbox rename and the run
//       write re-arms the SAME deterministic task id without
//       spending the credit a second time;
//   E15 crash-after-consume: a landed result renamed to .consumed by
//       a tick that died before its run write is re-read and scored,
//       not re-enqueued;
//   E16 vetoed settle: a rewrite_pending nonce that changed under
//       the in-flight stage call refuses the settle (no apply);
//   E17 role contract: roles/humanizer-partner.yaml manifest+schema
//       compile via ajv and enforce the full output shape
//       (rewritten_text, edits[]{span_original,span_new,reason},
//       confidence, recommendation, unchanged_reason, caveats,
//       additionalProperties:false) incl. the plan-mode pass-through;
//   E18 fixtures: every <tier>/<lang>.txt is >=150 words (Pangram
//       floor) and every <lang>.spans.json parses with a non-empty
//       expected_spans;
//   E19 seed-race guard: a live foreign 'humanizer-seed' lock makes
//       the tick seed 0 and never touches existing run files;
//   E20 cross-backend 'best': a best recorded under 'pangram' is not
//       compared against a 'stub' score - the backend switch resets
//       to a fresh baseline (best-reset-backend trace) instead of a
//       false 'reverted';
//   E21 HUMANIZER_THRESHOLD is clamped to the 0-100 score domain;
//   E22 the workflow spec ships "active": true (activated post-matrix
//       in task 224; deploy propagates the eval schedule);
//   E23 detector_payload contract: the partner input carries
//       {ai_score, marker_spans:[{text,marker_type,reason}]} - never
//       the raw last_score blob (checked inside E9);
//   E24 credits rollover: a stale-dated credits file with a charged[]
//       entry for the SAME tid still charges fresh on re-arm - every
//       loader that rolls the shared counter resets the per-day
//       dedupe ledger (all three copies: Eval Tick + the SYNC'd
//       pangram-gate pair in sp-tg-moderation);
//   E25 partner recommendation honored: escalate_to_human -> the run
//       escalates 'partner_escalate' with confidence/caveats/
//       unchanged_reason recorded and the rewrite NEVER applied;
//   E26 unchanged pass-through: byte-identical rewritten_text +
//       unchanged_reason counts one 'partner_unchanged' attempt and
//       stalls into escalation with ZERO rescore credit burned;
//   E27 scorer_retries is a per-claim-attempt bound: a landed score
//       resets the stale-claim budget;
//   E28 late-result sweep: done|failed pangram-<run>-<seq>.result.json
//       artifacts no run still claims are consumed to .consumed and
//       noted 'consumed-late' - pending claims and warn-gate draft
//       tasks are left alone;
//   E29 chain id fold: '+' folds to '_' in run filenames and a
//       fold collision ('a+b' vs 'a_b') skips+logs instead of
//       silently merging two chains into one run;
//   E30 marker_spans carry the ORIGINAL source casing, not the
//       lowercase canonical needle;
//   E31 plan mode: the role schema accepts a pass-through plan
//       response (rewritten_text === source, edits describe the
//       plan) and the escalate_to_human arm - schema-level, no
//       live model call.
//   E32 rubric scorer backend (issue #80): POST RUBRIC_URL/score
//       maps findings -> marker_spans, via 'rubric' in trace +
//       scorer_backend in the ledger, malformed/unreachable service
//       -> scorer_failed (never a stub fallback), and a stale
//       scorer_claim re-claims once on the same scorer_retries
//       budget the pangram pending path keeps.
//   E33 composite 'rubric+judge' scorer (issue #82): rubric /score
//       AND the fluency-judge role on GATEWAY/run both land; final =
//       max(rubric, round(judge*0.8)), marker_spans = rubric
//       findings + judge span issues (spanless issues stay doc-level
//       in the score record + trace);
//   E34 malformed judge JSON (bad shape despite a healthy rubric)
//       -> scorer_failed, atomic - no rubric-only settle;
//   E35 unreachable judge -> scorer_failed, no fallback;
//   E36 blind A/B labels: runs carry chain_a/chain_b labels and
//       stage_<letter> maps, the tick output records the mapping,
//       and NO scorer/judge/partner payload contains a chain or
//       stage id (baseline/editor/inhouse never leak);
//   E37 roles/fluency-judge.yaml manifest + strict output schema
//       compile via ajv ({score 0-100, rationale, issues[]},
//       additionalProperties:false at both levels).
//
// Run:  node tools/check_humanizer.js    (exit 0 = all pass)

const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const WF = path.join(__dirname, "..", "n8n", "workflows", "sp-humanizer-eval.json");
const FIXTURE_SRC = path.join(__dirname, "..", "fixtures", "humanizer");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const node0 = spec.nodes.find((n) => n.name === "Eval Tick");
if (!node0?.parameters?.jsCode) {
  console.error(`FAIL: Eval Tick jsCode not found in ${WF}`);
  process.exit(1);
}
const factory = new Function(
  "require",
  "$input",
  "$env",
  `return (async function () {\n${node0.parameters.jsCode}\n});`,
);

// ------------------------------------------------------------------
// in-memory fs - same contract as check_pangram.js's mkFs
// ({flag:'wx'} honored for the lock claims).
const norm = (p) => path.posix.normalize(String(p));
const mkFs = () => {
  const nodes = new Map();
  const err = (code) => Object.assign(new Error(code), { code });
  const fileNode = (content) => ({
    dir: false,
    content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content ?? "")),
    mtimeMs: Date.now(),
  });
  const api = {
    __nodes: nodes,
    mkdirSync(p, o) {
      p = norm(p);
      if (nodes.has(p)) {
        if (o?.recursive) return;
        throw err("EEXIST");
      }
      if (o?.recursive) {
        let cur = "";
        for (const part of p.split("/").filter(Boolean)) {
          cur += `/${part}`;
          if (!nodes.has(cur)) nodes.set(cur, { dir: true });
        }
        return;
      }
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      nodes.set(p, { dir: true });
    },
    existsSync(p) {
      return nodes.has(norm(p));
    },
    readdirSync(p) {
      const d = norm(p);
      const n = nodes.get(d);
      if (!n?.dir) throw err("ENOENT");
      const out = [];
      for (const k of nodes.keys()) {
        if (k !== d && norm(path.posix.dirname(k)) === d && !k.slice(d.length + 1).includes("/")) {
          out.push(k.slice(d.length + 1));
        }
      }
      return out;
    },
    readFileSync(p, enc) {
      p = norm(p);
      const n = nodes.get(p);
      if (!n || n.dir) throw err("ENOENT");
      return enc ? n.content.toString(enc) : Buffer.from(n.content);
    },
    writeFileSync(p, data, opts) {
      p = norm(p);
      if (opts && opts.flag === "wx" && nodes.has(p)) throw err("EEXIST");
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      const n = nodes.get(p) || fileNode(data);
      n.dir = false;
      n.content = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data));
      n.mtimeMs = Date.now();
      nodes.set(p, n);
    },
    appendFileSync(p, data) {
      p = norm(p);
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      const n = nodes.get(p) || fileNode("");
      n.content = Buffer.concat([n.content, Buffer.from(String(data))]);
      n.mtimeMs = Date.now();
      nodes.set(p, n);
    },
    statSync(p) {
      const n = nodes.get(norm(p));
      if (!n) throw err("ENOENT");
      return {
        size: n.dir ? 0 : n.content.length,
        mtimeMs: n.mtimeMs,
        ctimeMs: n.mtimeMs,
        isDirectory: () => !!n.dir,
        isFile: () => !n.dir,
      };
    },
    realpathSync(p) {
      p = norm(p);
      if (!nodes.has(p)) throw err("ENOENT");
      return p;
    },
    renameSync(a, b) {
      a = norm(a);
      b = norm(b);
      const n = nodes.get(a);
      if (!n) throw err("ENOENT");
      if (!nodes.has(norm(path.posix.dirname(b)))) throw err("ENOENT");
      nodes.delete(a);
      nodes.set(b, n);
    },
    linkSync(a, b) {
      a = norm(a);
      b = norm(b);
      const n = nodes.get(a);
      if (!n) throw err("ENOENT");
      if (nodes.has(b)) throw err("EEXIST");
      if (!nodes.has(norm(path.posix.dirname(b)))) throw err("ENOENT");
      nodes.set(b, n);
    },
    unlinkSync(p) {
      p = norm(p);
      const n = nodes.get(norm(p));
      if (!n) throw err("ENOENT");
      nodes.delete(p);
    },
    chmodSync() {},
    truncateSync(p, len) {
      const n = nodes.get(norm(p));
      if (!n || n.dir) throw err("ENOENT");
      n.content = n.content.subarray(0, len || 0);
    },
  };
  return api;
};

const STATE = "/home/node/.n8n/state";
const LOGD = "/home/node/.n8n/logs";
const RUNS = `${STATE}/humanizer_runs`;
const SCORES = `${STATE}/humanizer_scores.jsonl`;
const CREDITS = `${STATE}/pangram_credits.json`;
const HANDS = "/home/node/hands-queue";
const FIXTURES = "/home/node/fixtures/humanizer";

const BASE_ENV = {
  HUMANIZER_SCORER: "stub",
  HUMANIZER_PARTNER: "stub",
  HUMANIZER_CHAINS: "baseline,editor",
  HUMANIZER_FIXTURES: FIXTURES,
};

// copy the REAL fixture corpus into the fake volume - the harness
// exercises the deliverable texts end to end, so a fixture edit that
// breaks the tier contract fails here, not in production
const seedFixtures = (fakeFs, tiers) => {
  for (const tier of tiers) {
    for (const lang of ["en", "ru"]) {
      const p = path.join(FIXTURE_SRC, tier, `${lang}.txt`);
      if (!fs.existsSync(p)) continue;
      fakeFs.mkdirSync(`${FIXTURES}/${tier}`, { recursive: true });
      fakeFs.writeFileSync(`${FIXTURES}/${tier}/${lang}.txt`, fs.readFileSync(p, "utf8"));
    }
  }
};
const seedHands = (fakeFs) => {
  fakeFs.mkdirSync(`${HANDS}/inbox`, { recursive: true });
  fakeFs.mkdirSync(`${HANDS}/done`, { recursive: true });
  fakeFs.mkdirSync(`${HANDS}/failed`, { recursive: true });
};
const readJson = (fakeFs, p) => {
  try {
    return JSON.parse(fakeFs.readFileSync(p, "utf8"));
  } catch (_e) {
    return null;
  }
};
const dirOf = (fakeFs, d) => {
  try {
    return fakeFs.readdirSync(d).filter((f) => !f.startsWith("."));
  } catch (_e) {
    return [];
  }
};
const loadRun = (fakeFs, id) => readJson(fakeFs, `${RUNS}/${id}.json`);
const scoreRows = (fakeFs) => {
  try {
    return fakeFs
      .readFileSync(SCORES, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (_e) {
    return [];
  }
};
const logLines = (fakeFs) => {
  try {
    return fakeFs
      .readFileSync(`${LOGD}/humanizer-eval.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (_e) {
    return [];
  }
};
const fixtureText = (tier, lang) =>
  fs.readFileSync(path.join(FIXTURE_SRC, tier, `${lang}.txt`), "utf8");

const mkSc = (extra) => ({
  fakeFs: mkFs(),
  env: {},
  calls: [],
  httpImpl: null,
  ...extra,
});
const execTick = async (sc) => {
  const helpers = {
    httpRequest: async (o) => {
      sc.calls.push(o);
      if (sc.httpImpl) return await sc.httpImpl(o);
      throw new Error(`unstubbed URL ${o.url}`);
    },
  };
  const fn = factory(
    (m) => (m === "fs" ? sc.fakeFs : require(m)),
    { all: () => [{ json: {} }] },
    { ...BASE_ENV, ...(sc.env || {}) },
  );
  return await fn.call({ helpers });
};
const runTicks = async (sc, n) => {
  let out = null;
  for (let i = 0; i < n; i++) out = await execTick(sc);
  return out;
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures++;
  }
};

const main = async () => {
  // --- E1/E2 seeding, idempotency, clean zero-iteration pass -------
  {
    const sc = mkSc();
    seedFixtures(sc.fakeFs, ["clean_human", "ai_flop", "borderline"]);
    const out1 = await execTick(sc);
    check(
      "E1 seeding: 12 run files (3 tiers x 2 langs x 2 chains)",
      dirOf(sc.fakeFs, RUNS).length === 12 && out1?.[0]?.json?.seeded === 12,
      JSON.stringify({ runs: dirOf(sc.fakeFs, RUNS).length, out: out1?.[0]?.json }),
    );
    const out2 = await execTick(sc);
    check(
      "E1 idempotent: second tick seeds nothing",
      out2?.[0]?.json?.seeded === 0 && dirOf(sc.fakeFs, RUNS).length === 12,
      JSON.stringify(out2?.[0]?.json),
    );
    await runTicks(sc, 8);
    for (const chain of ["baseline", "editor"]) {
      for (const lang of ["en", "ru"]) {
        const id = `${chain}__clean_human-${lang}`;
        const r = loadRun(sc.fakeFs, id);
        check(
          `E2 ${id}: done/'pass', partner never invoked`,
          r?.state === "done" &&
            r.outcome === "pass" &&
            Number(r.iteration) === 0 &&
            !(r.trace || []).some((t) => t.action === "rewrite" || t.action === "rewrite-claim"),
          JSON.stringify({ st: r?.state, oc: r?.outcome, it: r?.iteration }),
        );
      }
    }
    check(
      "E12 stub mode: zero httpRequest calls",
      sc.calls.length === 0,
      JSON.stringify(sc.calls.map((c) => c.url)),
    );

    // --- E3 ai_flop: editor converges <=2 iters, baseline escalates -
    for (const lang of ["en", "ru"]) {
      const r = loadRun(sc.fakeFs, `editor__ai_flop-${lang}`);
      check(
        `E3 editor__ai_flop-${lang}: pass in <=2 iterations`,
        r?.state === "done" && r.outcome === "pass" && r.iteration >= 1 && r.iteration <= 2,
        JSON.stringify({ st: r?.state, oc: r?.outcome, it: r?.iteration }),
      );
      const actions = (r?.trace || []).map((t) => t.action);
      check(
        `E3 editor__ai_flop-${lang}: full state path in trace`,
        actions.includes("score") &&
          actions.includes("rewrite-request") &&
          actions.includes("rewrite") &&
          actions.includes("pass"),
        actions.join(","),
      );
      const b = loadRun(sc.fakeFs, `baseline__ai_flop-${lang}`);
      check(
        `E3 baseline__ai_flop-${lang}: escalated 'no_rewrite_stage', iteration 0`,
        b?.state === "escalated" && b.outcome === "no_rewrite_stage" && b.iteration === 0,
        JSON.stringify({ st: b?.state, oc: b?.outcome, it: b?.iteration }),
      );
    }

    // --- E4 borderline: max_iterations escalate, no oscillation -----
    for (const lang of ["en", "ru"]) {
      const r = loadRun(sc.fakeFs, `editor__borderline-${lang}`);
      check(
        `E4 editor__borderline-${lang}: escalated 'max_iterations' at 2 iters`,
        r?.state === "escalated" && r.outcome === "max_iterations" && r.iteration === 2,
        JSON.stringify({ st: r?.state, oc: r?.outcome, it: r?.iteration }),
      );
      const rows = scoreRows(sc.fakeFs).filter((s) => s.run_id === `editor__borderline-${lang}`);
      const minScore = Math.min(...rows.map((s) => Number(s.confidence)));
      check(
        `E4 editor__borderline-${lang}: no oscillation below threshold`,
        rows.length >= 3 && minScore >= 50,
        JSON.stringify({ rows: rows.length, minScore }),
      );
      check(
        `E4 editor__borderline-${lang}: escalation carries best-so-far`,
        !!r?.escalation &&
          typeof r.escalation.best_text === "string" &&
          r.escalation.best_text.length > 0 &&
          Number.isFinite(Number(r.escalation.best_score)),
        JSON.stringify(r?.escalation && { bs: r.escalation.best_score }),
      );
    }

    // --- E5 score ledger rows ---------------------------------------
    const rows = scoreRows(sc.fakeFs);
    const keys = [
      "run_id",
      "fixture",
      "chain",
      "stage",
      "score_label",
      "confidence",
      "words",
      "credits_used",
      "at",
    ];
    check(
      "E5 ledger: rows exist, full key contract",
      rows.length >= 12 && rows.every((r) => keys.every((k) => k in r)),
      JSON.stringify({ rows: rows.length }),
    );
    const flopStages = rows.filter((r) => r.run_id === "editor__ai_flop-en").map((r) => r.stage);
    check(
      "E5 ledger: editor flop cell stages input+editor",
      flopStages.includes("input") && flopStages.includes("editor"),
      flopStages.join(","),
    );
  }

  // --- E6 pangram scorer: enqueue -> result -> pass -----------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    seedHands(sc.fakeFs);
    await execTick(sc);
    const inbox = dirOf(sc.fakeFs, `${HANDS}/inbox`);
    check(
      "E6 pangram: task enqueued per live run",
      inbox.length === 2 && inbox.every((f) => /^pangram-.*-0\.json$/.test(f)),
      inbox.join(","),
    );
    const task = readJson(sc.fakeFs, `${HANDS}/inbox/${inbox[0]}`);
    const srcText = fixtureText("clean_human", "en");
    check(
      "E6 pangram: task shape pangram_check + text/snippet",
      task?.recipe === "pangram_check" &&
        typeof task.params.text === "string" &&
        task.params.snippet.length <= 60 &&
        [
          task.params.text === srcText || task.params.text === fixtureText("clean_human", "ru"),
        ].some(Boolean),
      JSON.stringify(task && { r: task.recipe, snip: task.params.snippet.length }),
    );
    const c = readJson(sc.fakeFs, CREDITS);
    check(
      "E6 pangram: credits charged ceil(words/100) per task",
      c?.date === new Date().toISOString().slice(0, 10) && c.est_spent >= 2,
      JSON.stringify(c),
    );
    // worker lands both results: Possibly human 95% -> ai_score 5
    for (const f of inbox) {
      const tid = f.replace(/\.json$/, "");
      sc.fakeFs.writeFileSync(
        `${HANDS}/done/${tid}.result.json`,
        JSON.stringify({ ok: true, hit_ph: "Possibly human", confidence: "95%" }),
      );
    }
    await runTicks(sc, 3);
    const r = loadRun(sc.fakeFs, "baseline__clean_human-en");
    check(
      "E6 pangram: consumed result -> scored -> pass",
      r?.state === "done" &&
        r.outcome === "pass" &&
        r.last_score?.via === "pangram" &&
        r.last_score.score === 5 &&
        dirOf(sc.fakeFs, `${HANDS}/done`).every((f) => f.endsWith(".consumed")),
      JSON.stringify({ st: r?.state, oc: r?.outcome, ls: r?.last_score }),
    );
    check(
      "E6 pangram: score carries marker_spans:[] (no span data)",
      Array.isArray(r?.last_score?.marker_spans) && r.last_score.marker_spans.length === 0,
      JSON.stringify(r?.last_score?.marker_spans),
    );
    check(
      "E6 pangram: score row credits_used>0 recorded",
      scoreRows(sc.fakeFs).some(
        (s) => s.run_id === "baseline__clean_human-en" && s.credits_used > 0,
      ),
      JSON.stringify(scoreRows(sc.fakeFs)),
    );
    check(
      "E6 pangram: zero httpRequest calls",
      sc.calls.length === 0,
      JSON.stringify(sc.calls.map((x) => x.url)),
    );
  }

  // --- E7 pangram credit cap -----------------------------------------
  {
    const sc = mkSc();
    sc.env = {
      HUMANIZER_SCORER: "pangram",
      HUMANIZER_CHAINS: "baseline",
      HUMANIZER_DAILY_CREDITS: "0",
    };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    seedHands(sc.fakeFs);
    await runTicks(sc, 3);
    const r = loadRun(sc.fakeFs, "baseline__clean_human-en");
    check(
      "E7 credit cap: escalated 'credit_cap', zero inbox writes",
      r?.state === "escalated" &&
        r.outcome === "credit_cap" &&
        dirOf(sc.fakeFs, `${HANDS}/inbox`).length === 0,
      JSON.stringify({ st: r?.state, oc: r?.outcome, inbox: dirOf(sc.fakeFs, `${HANDS}/inbox`) }),
    );
  }

  // --- E8 pangram queue missing -> stub fallback ----------------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    // no hands-queue dirs at all
    await runTicks(sc, 3);
    const r = loadRun(sc.fakeFs, "baseline__clean_human-en");
    check(
      "E8 queue missing: stub fallback stamps scorer_fallback",
      r?.scorer_fallback === true &&
        r.last_score?.via === "stub" &&
        (r.trace || []).some((t) => t.action === "scorer-fallback-stub") &&
        r.state === "done",
      JSON.stringify({ fb: r?.scorer_fallback, via: r?.last_score?.via, st: r?.state }),
    );
  }

  // --- E9 inhouse partner: happy path + 422 escalate -------------------
  // no LLM_GATEWAY_URL anywhere: every compose service runs
  // network_mode:host, so the default endpoint must be the loopback
  // sibling - the 'llm-gateway' container name is unresolvable
  {
    const sc = mkSc();
    sc.env = {
      HUMANIZER_PARTNER: "inhouse",
      HUMANIZER_CHAINS: "editor",
    };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8787/run") {
        const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
        const payload = JSON.parse(body.input);
        return {
          role: "humanizer-partner",
          model: "m",
          backend: "gemini",
          json: {
            rewritten_text: `${payload.source_text}\n\nRewritten by partner.`,
            edits: [{ span_original: "x", span_new: "y", reason: "stub" }],
            confidence: "medium",
            recommendation: "continue",
            unchanged_reason: null,
            caveats: [],
          },
        };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 6);
    const r = loadRun(sc.fakeFs, "editor__ai_flop-en");
    const gwCalls = sc.calls.filter((c0) => c0.url === "http://127.0.0.1:8787/run");
    // 2 runs (en+ru) x <=2 rewrite iterations each: every call must
    // hit /run with the role contract - never another host
    check(
      "E9 inhouse: /run calls bounded, role + payload contract",
      gwCalls.length === 4 &&
        gwCalls.every((c0) => c0.body.role === "humanizer-partner") &&
        (() => {
          const p = JSON.parse(gwCalls[0].body.input);
          return (
            [
              "source_text",
              "language",
              "detector_payload",
              "iteration",
              "previous_attempts",
              "protected_terms",
              "persona_context",
              "mode",
            ].every((k) => k in p) &&
            p.language === "en" &&
            p.iteration === 0
          );
        })(),
      JSON.stringify(gwCalls.map((c0) => c0.url)),
    );
    // E23 detector_payload contract: {ai_score, marker_spans[]} only -
    // the contracted scorer view, never the raw last_score blob
    check(
      "E23 detector_payload: {ai_score,marker_spans} shape, no raw blob",
      gwCalls.every((c0) => {
        const p = JSON.parse(c0.body.input);
        const d = p.detector_payload;
        return (
          d &&
          typeof d === "object" &&
          typeof d.ai_score === "number" &&
          Array.isArray(d.marker_spans) &&
          d.marker_spans.every(
            (s) =>
              s &&
              typeof s.text === "string" &&
              typeof s.marker_type === "string" &&
              typeof s.reason === "string",
          ) &&
          Object.keys(d).every((k) => ["ai_score", "marker_spans"].includes(k))
        );
      }) && JSON.parse(gwCalls[0].body.input).detector_payload.marker_spans.length > 0,
      JSON.stringify(gwCalls[0] && JSON.parse(gwCalls[0].body.input).detector_payload),
    );
    check(
      "E9 inhouse: rewrite applied -> rescoring path",
      !!r && r.iteration >= 1 && String(r.working_text).includes("Rewritten by partner."),
      JSON.stringify({ it: r?.iteration, st: r?.state }),
    );
    check(
      "E9 inhouse: calls only to llm-gateway loopback default",
      sc.calls.every((c0) => c0.url.startsWith("http://127.0.0.1:8787")),
      JSON.stringify(sc.calls.map((c0) => c0.url)),
    );

    const sc2 = mkSc();
    sc2.env = {
      HUMANIZER_PARTNER: "inhouse",
      HUMANIZER_CHAINS: "editor",
      LLM_GATEWAY_URL: "http://127.0.0.1:8787",
    };
    seedFixtures(sc2.fakeFs, ["ai_flop"]);
    sc2.httpImpl = async () => {
      const e = new Error("422 - schema validation failed");
      e.statusCode = 422;
      throw e;
    };
    await runTicks(sc2, 6);
    const r2 = loadRun(sc2.fakeFs, "editor__ai_flop-en");
    check(
      "E9 inhouse 422: failed attempt recorded -> partner_failed",
      r2?.state === "escalated" &&
        r2.outcome === "partner_failed" &&
        (r2.previous_attempts || []).some((a) => a.failed === true),
      JSON.stringify({ st: r2?.state, oc: r2?.outcome, pa: r2?.previous_attempts }),
    );
  }

  // --- E10 external stage declared but unconfigured -------------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_CHAINS: "writehuman" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    await runTicks(sc, 6);
    const r = loadRun(sc.fakeFs, "writehuman__ai_flop-en");
    check(
      "E10 external: unavailable cell + stage_unavailable escalate",
      r?.state === "escalated" &&
        r.outcome === "stage_unavailable" &&
        scoreRows(sc.fakeFs).some(
          (s) => s.run_id === "writehuman__ai_flop-en" && s.score_label === "unavailable",
        ),
      JSON.stringify({ st: r?.state, oc: r?.outcome }),
    );
    check(
      "E10 external: zero httpRequest calls",
      sc.calls.length === 0,
      JSON.stringify(sc.calls.map((c0) => c0.url)),
    );
  }

  // --- E11 regression -> revert to best --------------------------------
  {
    const sc = mkSc();
    seedFixtures(sc.fakeFs, ["clean_human"]);
    sc.fakeFs.mkdirSync(RUNS, { recursive: true });
    const bestText = "Best version so far - short and honest.";
    sc.fakeFs.writeFileSync(
      `${RUNS}/probe__revert-en.json`,
      JSON.stringify({
        run_id: "probe__revert-en",
        fixture: "probe/en",
        tier: "probe",
        lang: "en",
        chain: "editor",
        stages: ["editor"],
        state: "decide",
        iteration: 1,
        cell_stage: "editor",
        text: "Original text.",
        working_text: "Worse rewritten text.",
        best: { text: bestText, score: 40, stage: "input", at: new Date().toISOString() },
        last_score: {
          score: 78,
          label: "AI Generated",
          confidence: 78,
          via: "stub",
          words: 5,
          at: new Date().toISOString(),
        },
        previous_attempts: [{ iteration: 0, stage: "editor", score: 40 }],
        protected_terms: [],
        persona_context: "",
        credits_used: 0,
        score_seq: 0,
        scorer_fallback: false,
        outcome: null,
        escalation: null,
        trace: [],
        seeded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );
    await execTick(sc);
    const r = loadRun(sc.fakeFs, "probe__revert-en");
    check(
      "E11 regression: done/'reverted', best text restored",
      r?.state === "done" &&
        r.outcome === "reverted" &&
        r.working_text === bestText &&
        (r.trace || []).some((t) => t.action === "revert"),
      JSON.stringify({ st: r?.state, oc: r?.outcome, wt: r?.working_text }),
    );
  }

  // --- E13 scorer stale claim: one re-enqueue, then scorer_failed ----
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    seedHands(sc.fakeFs);
    await execTick(sc);
    const id = "baseline__clean_human-en";
    const backdate = () => {
      const cur = loadRun(sc.fakeFs, id);
      cur.scorer_pending.at = new Date(Date.now() - 700000).toISOString();
      sc.fakeFs.writeFileSync(`${RUNS}/${id}.json`, JSON.stringify(cur));
    };
    backdate();
    await execTick(sc);
    let r = loadRun(sc.fakeFs, id);
    check(
      "E13 stale claim: score-stale-clear + ONE re-enqueue",
      r?.state === "scoring" &&
        r.scorer_retries === 1 &&
        r.scorer_pending?.task === `pangram-${id}-1` &&
        (r.trace || []).some((t) => t.action === "score-stale-clear") &&
        dirOf(sc.fakeFs, `${HANDS}/inbox`).includes(`pangram-${id}-1.json`),
      JSON.stringify({
        st: r?.state,
        pend: r?.scorer_pending,
        inbox: dirOf(sc.fakeFs, `${HANDS}/inbox`),
      }),
    );
    backdate();
    await execTick(sc);
    r = loadRun(sc.fakeFs, id);
    check(
      "E13 second stale: escalated 'scorer_failed', pending cleared",
      r?.state === "escalated" && r.outcome === "scorer_failed" && !r.scorer_pending,
      JSON.stringify({ st: r?.state, oc: r?.outcome, pend: r?.scorer_pending }),
    );
  }

  // --- E14 crash-after-charge dedupe (no double credit spend) --------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    seedHands(sc.fakeFs);
    await execTick(sc);
    const spent1 = readJson(sc.fakeFs, CREDITS)?.est_spent;
    const id = "baseline__clean_human-en";
    // simulate the crash window between the inbox rename and the run
    // write: the charge persisted in the credits ledger but the run
    // record lost scorer_pending/score_seq/credits_used
    const cur = loadRun(sc.fakeFs, id);
    cur.scorer_pending = null;
    cur.score_seq = 0;
    cur.credits_used = 0;
    cur.state = "scoring";
    sc.fakeFs.writeFileSync(`${RUNS}/${id}.json`, JSON.stringify(cur));
    await execTick(sc);
    const c2 = readJson(sc.fakeFs, CREDITS);
    const r = loadRun(sc.fakeFs, id);
    check(
      "E14 charge dedupe: same tid re-armed, est_spent unchanged",
      c2?.est_spent === spent1 &&
        Number(c2?.charged?.[`pangram-${id}-0`]) > 0 &&
        r?.scorer_pending?.task === `pangram-${id}-0`,
      JSON.stringify({ spent1, c2, pend: r?.scorer_pending }),
    );
  }

  // --- E15 crash-after-consume: re-read the consumed result ----------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    seedHands(sc.fakeFs);
    await execTick(sc);
    const id = "baseline__clean_human-en";
    const tid = `pangram-${id}-0`;
    // the worker landed the result and a tick consumed it but died
    // before its run write - only the .consumed record survives
    sc.fakeFs.writeFileSync(
      `${HANDS}/done/${tid}.result.json`,
      JSON.stringify({ ok: true, hit_ph: "Possibly human", confidence: "95%" }),
    );
    sc.fakeFs.renameSync(
      `${HANDS}/done/${tid}.result.json`,
      `${HANDS}/done/${tid}.result.json.consumed`,
    );
    await runTicks(sc, 2);
    const r = loadRun(sc.fakeFs, id);
    check(
      "E15 crash-after-consume: re-reads .consumed -> scored -> pass",
      r?.state === "done" &&
        r.outcome === "pass" &&
        r.last_score?.via === "pangram" &&
        (r.trace || []).some((t) => t.action === "score-recovered-consumed"),
      JSON.stringify({ st: r?.state, oc: r?.outcome, ls: r?.last_score }),
    );
  }

  // --- E16 vetoed settle: nonce changed under the in-flight call -----
  {
    const sc = mkSc();
    sc.env = {
      HUMANIZER_PARTNER: "inhouse",
      LLM_GATEWAY_URL: "http://127.0.0.1:8787",
    };
    sc.fakeFs.mkdirSync(RUNS, { recursive: true });
    const id = "probe__veto-en";
    const nowIso = new Date().toISOString();
    sc.fakeFs.writeFileSync(
      `${RUNS}/${id}.json`,
      JSON.stringify({
        run_id: id,
        fixture: "probe/en",
        tier: "probe",
        lang: "en",
        chain: "editor",
        stages: ["editor"],
        state: "rewriting",
        iteration: 0,
        cell_stage: "editor",
        text: "Source text under rewrite.",
        working_text: "Source text under rewrite.",
        best: { text: "b", score: 40, stage: "input", backend: "stub", at: nowIso },
        last_score: {
          score: 80,
          label: "AI Generated",
          confidence: 80,
          via: "stub",
          words: 4,
          marker_spans: [],
          at: nowIso,
        },
        previous_attempts: [],
        protected_terms: [],
        persona_context: "",
        credits_used: 0,
        score_seq: 0,
        scorer_retries: 0,
        scorer_fallback: false,
        outcome: null,
        escalation: null,
        trace: [],
        seeded_at: nowIso,
        updated_at: nowIso,
      }),
    );
    sc.httpImpl = async () => {
      // a competing tick cleared + reclaimed the pending claim while
      // our stage call was in flight: the on-disk nonce is no longer
      // ours, so the settle guard must veto (no apply)
      const cur = loadRun(sc.fakeFs, id);
      cur.rewrite_pending = { nonce: "foreign", stage: "editor", at: nowIso };
      sc.fakeFs.writeFileSync(`${RUNS}/${id}.json`, JSON.stringify(cur));
      return {
        role: "humanizer-partner",
        model: "m",
        backend: "gemini",
        json: {
          rewritten_text: "Rewritten text that must NOT land.",
          edits: [],
          confidence: "medium",
          recommendation: "continue",
          unchanged_reason: null,
          caveats: [],
        },
      };
    };
    const out = await execTick(sc);
    const r = loadRun(sc.fakeFs, id);
    check(
      "E16 vetoed settle: nonce mismatch keeps 'rewriting', no apply",
      out?.[0]?.json?.by_step?.vetoed === 1 &&
        r?.state === "rewriting" &&
        r.rewrite_pending?.nonce === "foreign" &&
        r.working_text === "Source text under rewrite.",
      JSON.stringify({ bs: out?.[0]?.json?.by_step, st: r?.state, wt: r?.working_text }),
    );
  }

  // --- E17 role manifest + output schema contract --------------------
  {
    const rolePath = path.join(__dirname, "..", "roles", "humanizer-partner.yaml");
    const req = createRequire(path.join(__dirname, "..", "llm-gateway", "package.json"));
    const YAML = req("yaml");
    const Ajv = req("ajv");
    const doc = YAML.parse(fs.readFileSync(rolePath, "utf8"));
    const schema = doc?.output?.schema;
    let compiled = null;
    let compErr = null;
    try {
      compiled = new Ajv().compile(schema);
    } catch (e) {
      compErr = e;
    }
    check(
      "E17 role: manifest + output.schema compile via ajv",
      doc?.name === "humanizer-partner" && !!compiled && !compErr,
      String(compErr || ""),
    );
    const editReq = schema?.properties?.edits?.items?.required || [];
    check(
      "E17 role schema: full contract shape, additionalProperties:false",
      schema?.additionalProperties === false &&
        [
          "rewritten_text",
          "edits",
          "confidence",
          "recommendation",
          "unchanged_reason",
          "caveats",
        ].every((k) => schema.required.includes(k) && k in schema.properties) &&
        ["span_original", "span_new", "reason"].every(
          (k) => editReq.includes(k) && k in schema.properties.edits.items.properties,
        ),
      JSON.stringify({ req: schema?.required, editReq }),
    );
    // plan-mode pass-through: an identical rewritten_text with a
    // non-null unchanged_reason and planned edits[] is the plan
    // contract - it must validate under the same schema
    check(
      "E17 role schema: plan-mode output validates (pass-through)",
      !!compiled?.({
        rewritten_text: "Source text.",
        edits: [{ span_original: "a", span_new: "b", reason: "planned change" }],
        confidence: "medium",
        recommendation: "continue",
        unchanged_reason: "plan mode - changes not applied",
        caveats: [],
      }),
    );
    // E31 plan mode end-to-end shape: the schema-level coverage for
    // the mode the eval loop doesn't drive - a plan response is a
    // byte-identical rewritten_text whose edits[] DESCRIBE the plan,
    // plus the escalate_to_human enum arm
    const planSource = "Source text with a marker.";
    check(
      "E31 plan mode: pass-through plan + escalate arm both validate",
      !!compiled?.({
        rewritten_text: planSource,
        edits: [
          {
            span_original: "a marker",
            span_new: "",
            reason: "planned filler strip - applied on the next pass",
          },
        ],
        confidence: "medium",
        recommendation: "continue",
        unchanged_reason: "plan mode - edits described, not applied",
        caveats: ["plan only, text untouched"],
      }) &&
        !!compiled?.({
          rewritten_text: planSource,
          edits: [],
          confidence: "low",
          recommendation: "escalate_to_human",
          unchanged_reason: "a rewrite would degrade the text",
          caveats: [],
        }),
    );
    check(
      "E17 role schema: rejects extra/missing/legacy fields",
      !compiled?.({
        rewritten_text: "x",
        edits: [],
        confidence: "low",
        recommendation: "continue",
        unchanged_reason: null,
        caveats: [],
        note: "n",
      }) &&
        !compiled?.({
          rewritten_text: "x",
          edits: [{ span: "a", action: "strip", reason: "r" }],
          confidence: "low",
          recommendation: "continue",
          unchanged_reason: null,
          caveats: [],
        }) &&
        !compiled?.({
          rewritten_text: "x",
          edits: [],
          recommendation: "continue",
          unchanged_reason: null,
          caveats: [],
        }),
    );
  }

  // --- E18 fixtures: pangram floor + spans.json annotations ----------
  {
    const bad = [];
    for (const tier of fs.readdirSync(FIXTURE_SRC)) {
      for (const lang of ["en", "ru"]) {
        const tp = path.join(FIXTURE_SRC, tier, `${lang}.txt`);
        if (!fs.existsSync(tp)) continue;
        const w = fs.readFileSync(tp, "utf8").split(/\s+/).filter(Boolean).length;
        if (w < 150) bad.push(`${tier}/${lang} ${w}w`);
        const sp = path.join(FIXTURE_SRC, tier, `${lang}.spans.json`);
        if (!fs.existsSync(sp)) continue;
        try {
          const ann = JSON.parse(fs.readFileSync(sp, "utf8"));
          if (!Array.isArray(ann.expected_spans) || ann.expected_spans.length === 0) {
            bad.push(`${tier}/${lang}.spans.json empty expected_spans`);
          }
        } catch (_e) {
          bad.push(`${tier}/${lang}.spans.json unparsable`);
        }
      }
    }
    check(
      "E18 fixtures: every cell >=150 words, spans.json non-empty",
      bad.length === 0,
      bad.join(", "),
    );
  }

  // --- E19 seed-race guard: busy seed lock -> seed nothing -----------
  {
    const sc = mkSc();
    seedFixtures(sc.fakeFs, ["clean_human"]);
    sc.fakeFs.mkdirSync(`${STATE}/locks`, { recursive: true });
    sc.fakeFs.mkdirSync(RUNS, { recursive: true });
    // a live foreign 'humanizer-seed' lock (exp in the future) plus a
    // run file a racing seeder must never wipe
    sc.fakeFs.writeFileSync(
      `${STATE}/locks/humanizer-seed.lock`,
      JSON.stringify({ token: "foreign", exp: Date.now() + 60000 }),
    );
    sc.fakeFs.writeFileSync(
      `${RUNS}/editor__clean_human-en.json`,
      JSON.stringify({ run_id: "editor__clean_human-en", sentinel: "keep" }),
    );
    const out = await execTick(sc);
    const r = readJson(sc.fakeFs, `${RUNS}/editor__clean_human-en.json`);
    check(
      "E19 seed-race: busy seed lock -> seeded 0, run file preserved",
      out?.[0]?.json?.seeded === 0 && r?.sentinel === "keep" && dirOf(sc.fakeFs, RUNS).length === 1,
      JSON.stringify({ out: out?.[0]?.json, r }),
    );
  }

  // --- E20 cross-backend 'best' separation ----------------------------
  {
    const sc = mkSc();
    sc.fakeFs.mkdirSync(RUNS, { recursive: true });
    const id = "probe__backend-en";
    const nowIso = new Date().toISOString();
    sc.fakeFs.writeFileSync(
      `${RUNS}/${id}.json`,
      JSON.stringify({
        run_id: id,
        fixture: "probe/en",
        tier: "probe",
        lang: "en",
        chain: "editor",
        stages: ["editor"],
        state: "decide",
        iteration: 1,
        cell_stage: "editor",
        text: "Original text.",
        working_text: "Rescored text.",
        // a 'pangram' best must never be compared against this 'stub'
        // score - the backend switch resets to a fresh baseline
        best: { text: "b", score: 40, stage: "input", backend: "pangram", at: nowIso },
        last_score: {
          score: 78,
          label: "AI Generated",
          confidence: 78,
          via: "stub",
          words: 5,
          marker_spans: [],
          at: nowIso,
        },
        previous_attempts: [],
        protected_terms: [],
        persona_context: "",
        credits_used: 0,
        score_seq: 0,
        scorer_retries: 0,
        scorer_fallback: true,
        outcome: null,
        escalation: null,
        trace: [],
        seeded_at: nowIso,
        updated_at: nowIso,
      }),
    );
    await execTick(sc);
    const r = loadRun(sc.fakeFs, id);
    check(
      "E20 cross-backend: pangram best dropped, fresh stub baseline",
      r?.state === "rewriting" &&
        r.outcome === null &&
        r.best?.score === 78 &&
        r.best?.backend === "stub" &&
        (r.trace || []).some((t) => t.action === "best-reset-backend"),
      JSON.stringify({ st: r?.state, oc: r?.outcome, best: r?.best }),
    );
  }

  // --- E21 threshold clamp + E22 ships active -------------------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_THRESHOLD: "250" };
    const out = await execTick(sc);
    check(
      "E21 threshold: HUMANIZER_THRESHOLD clamped to 0-100",
      out?.[0]?.json?.threshold === 100,
      JSON.stringify(out?.[0]?.json?.threshold),
    );
    check(
      "E22 deploy: workflow spec ships active:true",
      spec.active === true,
      JSON.stringify(spec.active),
    );
  }

  // --- E24 credits rollover: charged[] resets with the daily date ----
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    seedHands(sc.fakeFs);
    await execTick(sc);
    const id = "baseline__clean_human-en";
    const tid = `pangram-${id}-0`;
    // midnight passed between the original charge and the
    // crash-repair re-arm: the counter file still carries yesterday's
    // date AND yesterday's charged[tid] entry. Every credits loader
    // must roll the dedupe ledger with the date or the same-tid
    // re-arm dedupes against a stale entry and re-enqueues a real
    // task UNCHARGED
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    sc.fakeFs.writeFileSync(
      CREDITS,
      JSON.stringify({
        date: yest,
        est_spent: 5,
        last_seen_left: null,
        charged: { [tid]: 2 },
      }),
    );
    const cur = loadRun(sc.fakeFs, id);
    cur.scorer_pending = null;
    cur.score_seq = 0;
    cur.state = "scoring";
    sc.fakeFs.writeFileSync(`${RUNS}/${id}.json`, JSON.stringify(cur));
    await execTick(sc);
    const cost = Math.ceil(
      fixtureText("clean_human", "en").split(/\s+/).filter(Boolean).length / 100,
    );
    const c = readJson(sc.fakeFs, CREDITS);
    const r = loadRun(sc.fakeFs, id);
    check(
      "E24 rollover: stale charged[] ignored - same-tid re-arm charges fresh",
      c?.date === new Date().toISOString().slice(0, 10) &&
        c.est_spent === cost &&
        Number(c?.charged?.[tid]) === cost &&
        r?.scorer_pending?.task === tid &&
        dirOf(sc.fakeFs, `${HANDS}/inbox`).includes(`${tid}.json`),
      JSON.stringify({ c, pend: r?.scorer_pending, cost }),
    );
    // the reset must hold in EVERY loader that rolls the shared
    // counter file - the warn-gate copies are SYNC'd identical
    // (check_sync.js pangram-gate), but only the text itself proves
    // the charged reset is present in all three
    const modSpec = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "n8n", "workflows", "sp-tg-moderation.json"),
        "utf8",
      ),
    );
    const loaders = modSpec.nodes
      .map((n) => n.parameters?.jsCode || "")
      .filter((code) => code.includes("pangramLoadCredits"));
    check(
      "E24 rollover: every credits loader copy resets charged[]",
      loaders.length === 2 &&
        loaders.every((code) => code.includes("c.charged = {}")) &&
        node0.parameters.jsCode.includes("c.charged = {}"),
      JSON.stringify({ loaders: loaders.length }),
    );
  }

  // --- E25 partner recommendation escalate_to_human -------------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_PARTNER: "inhouse", HUMANIZER_CHAINS: "editor" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      // no LLM_GATEWAY_URL env - the host-mode loopback default must
      // resolve, never the unresolvable container name
      if (o.url === "http://127.0.0.1:8787/run") {
        const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
        const payload = JSON.parse(body.input);
        return {
          role: "humanizer-partner",
          model: "m",
          backend: "gemini",
          json: {
            rewritten_text: `${payload.source_text}\n\nRewrite that must NOT land.`,
            edits: [],
            confidence: "low",
            recommendation: "escalate_to_human",
            unchanged_reason: "source already reads human; a rewrite would inject errors",
            caveats: ["detector flag is likely a false positive"],
          },
        };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 6);
    const r = loadRun(sc.fakeFs, "editor__ai_flop-en");
    check(
      "E25 escalate_to_human: escalated 'partner_escalate', rewrite never applied",
      r?.state === "escalated" &&
        r.outcome === "partner_escalate" &&
        r.working_text === r.text &&
        r.iteration === 0 &&
        r.escalation?.partner_confidence === "low" &&
        String(r.escalation?.unchanged_reason || "").includes("already reads human") &&
        Array.isArray(r.escalation?.partner_caveats) &&
        r.escalation.partner_caveats.length === 1,
      JSON.stringify({ st: r?.state, oc: r?.outcome, esc: r?.escalation }),
    );
    check(
      "E25 escalate_to_human: partner telemetry lands in trace",
      (r?.trace || []).some(
        (t) =>
          t.action === "partner-result" &&
          t.recommendation === "escalate_to_human" &&
          t.confidence === "low" &&
          Array.isArray(t.caveats),
      ),
      JSON.stringify((r?.trace || []).map((t) => t.action)),
    );
    check(
      "E25 gateway default: /run calls hit 127.0.0.1 loopback",
      sc.calls.length === 2 && sc.calls.every((c0) => c0.url === "http://127.0.0.1:8787/run"),
      JSON.stringify(sc.calls.map((c0) => c0.url)),
    );
  }

  // --- E26 partner unchanged pass-through: attempt, no rescore --------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_PARTNER: "inhouse", HUMANIZER_CHAINS: "editor" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8787/run") {
        const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
        const payload = JSON.parse(body.input);
        return {
          role: "humanizer-partner",
          model: "m",
          backend: "gemini",
          json: {
            // byte-identical pass-through WITH a stated reason: an
            // honest no-op attempt, not a rewrite
            rewritten_text: payload.source_text,
            edits: [],
            confidence: "high",
            recommendation: "continue",
            unchanged_reason: "no safe edits - every flagged span is load-bearing",
            caveats: [],
          },
        };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 6);
    const r = loadRun(sc.fakeFs, "editor__ai_flop-en");
    check(
      "E26 partner_unchanged: attempt counts, stalled run escalates",
      r?.state === "escalated" &&
        r.outcome === "partner_unchanged" &&
        r.iteration === 1 &&
        r.working_text === r.text &&
        (r.previous_attempts || []).some(
          (a) =>
            a.note === "partner_unchanged" &&
            String(a.unchanged_reason || "").includes("load-bearing") &&
            a.confidence === "high",
        ) &&
        r.escalation?.partner_confidence === "high" &&
        r.escalation?.unchanged_reason?.includes("load-bearing"),
      JSON.stringify({ st: r?.state, oc: r?.outcome, pa: r?.previous_attempts }),
    );
    check(
      "E26 partner_unchanged: no rescore credit burned",
      scoreRows(sc.fakeFs).filter((s) => s.run_id === "editor__ai_flop-en").length === 1,
      JSON.stringify(scoreRows(sc.fakeFs).filter((s) => s.run_id === "editor__ai_flop-en")),
    );
  }

  // --- E27 scorer_retries: per-claim bound resets on a landed score ---
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedHands(sc.fakeFs);
    sc.fakeFs.mkdirSync(RUNS, { recursive: true });
    const id = "probe__retries-en";
    const tid = `pangram-${id}-0`;
    const nowIso = new Date().toISOString();
    // a run that already burned its one stale-claim retry - a landed
    // result proves the queue end-to-end, so the budget must reset
    // for the NEXT claim instead of accumulating for the run's life
    sc.fakeFs.writeFileSync(
      `${RUNS}/${id}.json`,
      JSON.stringify({
        run_id: id,
        fixture: "probe/en",
        tier: "probe",
        lang: "en",
        chain: "baseline",
        stages: [],
        state: "scoring",
        iteration: 0,
        cell_stage: "input",
        text: "Source text.",
        working_text: "Source text.",
        mode: "rewrite",
        best: null,
        last_score: null,
        last_edits: [],
        scorer_pending: { task: tid, words: 200, cost: 2, at: nowIso },
        rewrite_pending: null,
        previous_attempts: [],
        protected_terms: [],
        persona_context: "",
        credits_used: 2,
        score_seq: 1,
        scorer_retries: 1,
        scorer_fallback: false,
        outcome: null,
        escalation: null,
        trace: [],
        seeded_at: nowIso,
        updated_at: nowIso,
      }),
    );
    sc.fakeFs.writeFileSync(
      `${HANDS}/done/${tid}.result.json`,
      JSON.stringify({ ok: true, hit_ph: "Possibly human", confidence: "92%" }),
    );
    await execTick(sc);
    const r = loadRun(sc.fakeFs, id);
    check(
      "E27 retries reset: a landed score clears the stale-claim budget",
      r?.scorer_retries === 0 && r.state === "decide" && r.last_score?.via === "pangram",
      JSON.stringify({ rt: r?.scorer_retries, st: r?.state, via: r?.last_score?.via }),
    );
  }

  // --- E28 orphaned late results: sweep consumes unclaimed artifacts --
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "pangram", HUMANIZER_CHAINS: "baseline" };
    seedHands(sc.fakeFs);
    sc.fakeFs.mkdirSync(RUNS, { recursive: true });
    sc.fakeFs.mkdirSync(`${STATE}/drafts`, { recursive: true });
    const nowIso = new Date().toISOString();
    const mkRun = (id, extra) => ({
      run_id: id,
      fixture: "probe/en",
      tier: "probe",
      lang: "en",
      chain: "baseline",
      stages: [],
      state: "escalated",
      iteration: 0,
      cell_stage: "input",
      text: "Source text.",
      working_text: "Source text.",
      mode: "rewrite",
      best: null,
      last_score: null,
      last_edits: [],
      scorer_pending: null,
      rewrite_pending: null,
      previous_attempts: [],
      protected_terms: [],
      persona_context: "",
      credits_used: 2,
      score_seq: 1,
      scorer_retries: 0,
      scorer_fallback: false,
      outcome: "scorer_failed",
      escalation: null,
      trace: [],
      seeded_at: nowIso,
      updated_at: nowIso,
      ...(extra || {}),
    });
    // an escalated run - its task landed AFTER the stale retraction
    sc.fakeFs.writeFileSync(`${RUNS}/probe__late-en.json`, JSON.stringify(mkRun("probe__late-en")));
    // a run still claiming its tid - the pending claim wins over the
    // sweep even though the state itself is 'decide'
    sc.fakeFs.writeFileSync(
      `${RUNS}/probe__claim-en.json`,
      JSON.stringify(
        mkRun("probe__claim-en", {
          state: "decide",
          outcome: null,
          last_score: {
            score: 10,
            label: "Possibly human",
            confidence: 90,
            via: "pangram",
            words: 200,
            at: nowIso,
          },
          scorer_pending: {
            task: "pangram-probe__claim-en-0",
            words: 200,
            cost: 2,
            at: nowIso,
          },
        }),
      ),
    );
    // a warn-gate draft whose id ends in -<digits> owns its own task
    sc.fakeFs.writeFileSync(`${STATE}/drafts/wgd-7.json`, JSON.stringify({ draft_id: "wgd-7" }));
    for (const f of [
      "pangram-probe__late-en-0.result.json",
      "pangram-gone-3.result.json",
      "pangram-probe__claim-en-0.result.json",
      "pangram-wgd-7.result.json",
      "pangram-draftx.result.json",
    ]) {
      sc.fakeFs.writeFileSync(`${HANDS}/done/${f}`, JSON.stringify({ ok: true }));
    }
    const out = await execTick(sc);
    const done = dirOf(sc.fakeFs, `${HANDS}/done`);
    const late = logLines(sc.fakeFs).filter((l) => l.action === "consumed-late");
    check(
      "E28 late sweep: unclaimed results consumed, claimed ones kept",
      out?.[0]?.json?.consumed_late === 2 &&
        done.includes("pangram-probe__late-en-0.result.json.consumed") &&
        done.includes("pangram-gone-3.result.json.consumed") &&
        done.includes("pangram-probe__claim-en-0.result.json") &&
        done.includes("pangram-wgd-7.result.json") &&
        done.includes("pangram-draftx.result.json") &&
        late.length === 2 &&
        late.every((l) => typeof l.task === "string" && typeof l.run_state === "string"),
      JSON.stringify({ done, late, cl: out?.[0]?.json?.consumed_late }),
    );
  }

  // --- E29 chain id fold: '+' -> '_' + collision guard -----------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_CHAINS: "writehuman+editor" };
    seedFixtures(sc.fakeFs, ["clean_human"]);
    await execTick(sc);
    const r = loadRun(sc.fakeFs, "writehuman_editor__clean_human-en");
    check(
      "E29 id fold: '+' chain folds to '_' run id, stages preserved",
      r?.chain === "writehuman+editor" && (r.stages || []).join("+") === "writehuman+editor",
      JSON.stringify(r && { chain: r.chain, stages: r.stages }),
    );
    const sc2 = mkSc();
    sc2.env = { HUMANIZER_CHAINS: "a+b,a_b" };
    seedFixtures(sc2.fakeFs, ["clean_human"]);
    await execTick(sc2);
    const kept = loadRun(sc2.fakeFs, "a_b__clean_human-en");
    const coll = logLines(sc2.fakeFs).filter((l) => l.action === "seed-id-collision");
    check(
      "E29 fold collision: distinct folded chain skipped + logged, never merged",
      kept?.chain === "a+b" && coll.some((l) => l.chain === "a_b" && l.held_by === "a+b"),
      JSON.stringify({ chain: kept?.chain, coll }),
    );
  }

  // --- E30 marker_spans: original source casing -------------------------
  {
    const sc = mkSc();
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    await execTick(sc);
    const r = loadRun(sc.fakeFs, "editor__ai_flop-en");
    const texts = (r?.last_score?.marker_spans || []).map((s) => s.text);
    check(
      "E30 marker_spans: source casing emitted, not the lowercase needle",
      texts.includes("In today's fast-paced world") &&
        texts.includes("It is important to note") &&
        texts.includes("Furthermore"),
      JSON.stringify(texts),
    );
  }

  // --- E32 rubric scorer backend (issue #80) -----------------------------
  // the deterministic local HTTP scorer: POST RUBRIC_URL/score with
  // {text,lang}, findings -> marker_spans {span,text,marker_type,
  // reason}, via 'rubric' in trace + scorer_backend in the ledger, and
  // honest scorer_failed on a dead/malformed service - never a stub
  // fallback
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "rubric", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return {
          score: 20,
          findings: [
            {
              rule: "en-hedge",
              severity: 1,
              span: [10, 18],
              text: "it seems",
              suggestion: "cut the hedge",
            },
            {
              rule: "burstiness",
              severity: 2,
              span: [0, 0],
              text: "",
              suggestion: "vary sentence length",
            },
          ],
          metrics: { stdev_words: 3.2, band_share: 0.8 },
          version: "0.1.0",
        };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 4);
    const r = loadRun(sc.fakeFs, "baseline__ai_flop-en");
    check(
      "E32 rubric: baseline run reaches done under the rubric scorer",
      r?.state === "done" && r.last_score?.via === "rubric" && r.last_score?.score === 20,
      JSON.stringify({ st: r?.state, s: r?.last_score }),
    );
    check(
      "E32 rubric: POST {text,lang} to RUBRIC_URL/score",
      sc.calls.length >= 1 &&
        sc.calls.every(
          (c0) =>
            c0.url === "http://127.0.0.1:8790/score" &&
            String(c0.method || "").toUpperCase() === "POST" &&
            typeof (c0.body || {}).text === "string" &&
            ["en", "ru"].includes((c0.body || {}).lang),
        ),
      JSON.stringify(
        sc.calls.map((c0) => ({ u: c0.url, m: c0.method, b: c0.body && Object.keys(c0.body) })),
      ),
    );
    const spans = r?.last_score?.marker_spans || [];
    check(
      "E32 rubric: findings -> marker_spans {span,text,marker_type,reason}",
      spans.length === 1 &&
        spans[0].span?.[0] === 10 &&
        spans[0].span?.[1] === 18 &&
        spans[0].text === "it seems" &&
        spans[0].marker_type === "en-hedge" &&
        spans[0].reason === "cut the hedge",
      JSON.stringify(spans),
    );
    check(
      "E32 rubric: doc-level [0,0] finding never enters marker_spans",
      !spans.some(
        (s) =>
          s.text === "" ||
          (s.span?.[0] === 0 && s.span?.[1] === 0 && s.marker_type === "burstiness"),
      ),
      JSON.stringify(spans),
    );
    check(
      "E32 rubric: via 'rubric' in trace, scorer_backend 'rubric' in ledger",
      (r?.trace || []).some((t) => t.action === "score" && t.via === "rubric") &&
        scoreRows(sc.fakeFs).some((row) => row.scorer_backend === "rubric"),
      JSON.stringify({ tr: (r?.trace || []).map((t) => t.action), rows: scoreRows(sc.fakeFs) }),
    );

    // malformed response: a numeric score with no findings array is
    // as bad as a non-numeric one - scorer_failed, no stub fallback
    const sc2 = mkSc();
    sc2.env = { HUMANIZER_SCORER: "rubric", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc2.fakeFs, ["ai_flop"]);
    sc2.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") return { score: 30 };
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc2, 4);
    const r2 = loadRun(sc2.fakeFs, "baseline__ai_flop-en");
    check(
      "E32 rubric: missing findings array -> scorer_failed",
      r2?.state === "escalated" && r2.outcome === "scorer_failed",
      JSON.stringify({ st: r2?.state, oc: r2?.outcome }),
    );
    check(
      "E32 rubric: malformed response never falls back to stub",
      r2?.last_score?.via !== "stub" && !(r2?.trace || []).some((t) => t.via === "stub"),
      JSON.stringify(r2?.last_score),
    );

    // dead service: transport error -> scorer_failed, and no score
    // row is written in any backend's name
    const sc3 = mkSc();
    sc3.env = { HUMANIZER_SCORER: "rubric", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc3.fakeFs, ["ai_flop"]);
    sc3.httpImpl = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
    };
    await runTicks(sc3, 4);
    const r3 = loadRun(sc3.fakeFs, "baseline__ai_flop-en");
    check(
      "E32 rubric: unreachable service -> scorer_failed, no stub fallback",
      r3?.state === "escalated" &&
        r3.outcome === "scorer_failed" &&
        r3?.last_score?.via !== "stub" &&
        !scoreRows(sc3.fakeFs).some((row) => row.scorer_backend === "stub"),
      JSON.stringify({ st: r3?.state, oc: r3?.outcome, rows: scoreRows(sc3.fakeFs) }),
    );

    // stale-claim parity with pangram's E13 - same tick, both arms:
    // a scorer_claim that outlives SCORE_STALE_MS is a crashed tick.
    // The en run (retries 0) gets ONE re-claim on the scorer_retries
    // budget: rubric-stale-clear, then a fresh claim whose landed
    // score resets the budget to 0 (E27 semantics). The ru run
    // (retries already 1) hits the second-stale bound and escalates
    // 'scorer_failed'. This machinery is the rubric-specific
    // scorer_claim, not the pangram pending task, so E13 never saw it
    const sc4 = mkSc();
    sc4.env = { HUMANIZER_SCORER: "rubric", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc4.fakeFs, ["clean_human"]);
    sc4.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return { score: 10, findings: [], metrics: {}, version: "0.1.0" };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await execTick(sc4); // seeds + first claims land -> decide
    const stale = new Date(Date.now() - 700000).toISOString();
    for (const [id, retries] of [
      ["baseline__clean_human-en", 0],
      ["baseline__clean_human-ru", 1],
    ]) {
      const cur4 = loadRun(sc4.fakeFs, id);
      cur4.state = "scoring";
      cur4.scorer_retries = retries;
      cur4.scorer_claim = { nonce: "stale0", at: stale };
      sc4.fakeFs.writeFileSync(`${RUNS}/${id}.json`, JSON.stringify(cur4));
    }
    const callsBefore = sc4.calls.length;
    await execTick(sc4);
    const r4 = loadRun(sc4.fakeFs, "baseline__clean_human-en");
    const r4ru = loadRun(sc4.fakeFs, "baseline__clean_human-ru");
    const tr4 = (r4?.trace || []).map((t) => t.action);
    check(
      "E32 rubric: stale scorer_claim - one re-claim, then scorer_failed",
      r4?.state === "decide" &&
        r4.scorer_retries === 0 &&
        !r4.scorer_claim &&
        tr4.includes("rubric-stale-clear") &&
        tr4.indexOf("rubric-stale-clear") < tr4.lastIndexOf("rubric-claim") &&
        sc4.calls.length === callsBefore + 1 &&
        r4ru?.state === "escalated" &&
        r4ru.outcome === "scorer_failed" &&
        !r4ru.scorer_claim,
      JSON.stringify({
        en: { st: r4?.state, rt: r4?.scorer_retries, tr: tr4 },
        ru: { st: r4ru?.state, oc: r4ru?.outcome },
      }),
    );
  }

  // --- E33 composite 'rubric+judge' scorer (issue #82) ---------------
  // both legs land: POST RUBRIC_URL/score AND POST GATEWAY/run
  // {role: fluency-judge}. final = max(rubric, round(judge*0.8)),
  // marker_spans = rubric findings + judge span issues, spanless
  // judge issues stay doc-level on the score record + trace
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "rubric+judge", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return {
          score: 20,
          findings: [
            {
              rule: "en-hedge",
              severity: 1,
              span: [10, 18],
              text: "it seems",
              suggestion: "cut the hedge",
            },
          ],
          metrics: { stdev_words: 3.2 },
          version: "0.1.0",
        };
      }
      if (o.url === "http://127.0.0.1:8787/run") {
        const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
        if (body.role === "fluency-judge") {
          return {
            role: "fluency-judge",
            model: "m",
            backend: "gemini",
            json: {
              score: 80,
              rationale: "stiff machine rhythm with grammar breaks",
              issues: [
                {
                  span: "plays a vital role",
                  problem: "cliched collocation reads translated",
                  severity: "major",
                },
                {
                  span: null,
                  problem: "uniform sentence length across the whole text",
                  severity: "minor",
                },
              ],
            },
          };
        }
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 4);
    const r = loadRun(sc.fakeFs, "baseline__ai_flop-en");
    // blend: max(rubric 20, round(80 * 0.8) = 64) = 64 -> >=50 ->
    // baseline escalates no_rewrite_stage carrying the composite score
    check(
      "E33 composite: blend = max(rubric, round(judge*0.8)), via stamped",
      r?.last_score?.via === "rubric+judge" &&
        r.last_score.score === 64 &&
        r.last_score.rubric_score === 20 &&
        r.last_score.judge_score === 80 &&
        r.last_score.judge_weight === 0.8 &&
        r.state === "escalated" &&
        r.outcome === "no_rewrite_stage",
      JSON.stringify({ st: r?.state, oc: r?.outcome, ls: r?.last_score }),
    );
    const judgeCalls = sc.calls.filter(
      (c0) => c0.url === "http://127.0.0.1:8787/run" && c0.body?.role === "fluency-judge",
    );
    check(
      "E33 composite: judge leg POSTs role contract, blind input shape",
      judgeCalls.length >= 1 &&
        judgeCalls.every((c0) => {
          const p = JSON.parse(c0.body.input);
          return (
            Object.keys(p).sort().join(",") === "language,source_text" &&
            typeof p.source_text === "string" &&
            ["en", "ru"].includes(p.language)
          );
        }),
      JSON.stringify(judgeCalls.map((c0) => c0.body)),
    );
    const spans = r?.last_score?.marker_spans || [];
    check(
      "E33 composite: marker_spans = rubric findings + judge spans",
      spans.some((s) => s.text === "it seems" && s.marker_type === "en-hedge") &&
        spans.some((s) => s.text === "plays a vital role" && s.marker_type === "judge-major") &&
        spans.length === 2,
      JSON.stringify(spans),
    );
    check(
      "E33 composite: spanless issue is doc-level - out of marker_spans, kept in record+trace",
      !spans.some((s) => s.text === "" || s.text == null) &&
        (r.last_score.judge_issues || []).some(
          (i) => i.span === null && i.problem.includes("uniform sentence length"),
        ) &&
        (r.trace || []).some(
          (t) => t.action === "score" && t.via === "rubric+judge" && t.judge_doc_issues === 1,
        ),
      JSON.stringify({
        ji: r?.last_score?.judge_issues,
        tr: (r?.trace || []).map((t) => t.action),
      }),
    );
    check(
      "E33 composite: scorer_backend 'rubric+judge' in the ledger",
      scoreRows(sc.fakeFs).some((row) => row.scorer_backend === "rubric+judge"),
      JSON.stringify(scoreRows(sc.fakeFs)),
    );
  }

  // --- E34 malformed judge -> atomic scorer_failed ---------------------
  // a healthy rubric cannot settle alone: a judge verdict with a
  // bad shape (or a gateway 422) fails the whole scorer leg
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "rubric+judge", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return { score: 20, findings: [], metrics: {}, version: "0.1.0" };
      }
      if (o.url === "http://127.0.0.1:8787/run") {
        return {
          role: "fluency-judge",
          model: "m",
          backend: "gemini",
          json: { score: "high", rationale: "no issues array" },
        };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 4);
    const r = loadRun(sc.fakeFs, "baseline__ai_flop-en");
    check(
      "E34 composite: malformed judge verdict -> scorer_failed, no settle",
      r?.state === "escalated" &&
        r.outcome === "scorer_failed" &&
        r.last_score === null &&
        scoreRows(sc.fakeFs).length === 0 &&
        String(r?.escalation?.error || "").includes("judge"),
      JSON.stringify({ st: r?.state, oc: r?.outcome, esc: r?.escalation }),
    );

    const sc2 = mkSc();
    sc2.env = { HUMANIZER_SCORER: "rubric+judge", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc2.fakeFs, ["ai_flop"]);
    sc2.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return { score: 20, findings: [], metrics: {}, version: "0.1.0" };
      }
      const e = new Error("422 - schema validation failed");
      e.statusCode = 422;
      throw e;
    };
    await runTicks(sc2, 4);
    const r2 = loadRun(sc2.fakeFs, "baseline__ai_flop-en");
    check(
      "E34 composite: gateway 422 -> scorer_failed, never rubric-only",
      r2?.state === "escalated" &&
        r2.outcome === "scorer_failed" &&
        r2.last_score === null &&
        !scoreRows(sc2.fakeFs).some((row) => row.scorer_backend === "rubric"),
      JSON.stringify({ st: r2?.state, oc: r2?.outcome, rows: scoreRows(sc2.fakeFs) }),
    );
  }

  // --- E35 unreachable judge -> scorer_failed, no fallback -------------
  {
    const sc = mkSc();
    sc.env = { HUMANIZER_SCORER: "rubric+judge", HUMANIZER_CHAINS: "baseline" };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return { score: 20, findings: [], metrics: {}, version: "0.1.0" };
      }
      throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
    };
    await runTicks(sc, 4);
    const r = loadRun(sc.fakeFs, "baseline__ai_flop-en");
    check(
      "E35 composite: unreachable judge -> scorer_failed, no fallback",
      r?.state === "escalated" &&
        r.outcome === "scorer_failed" &&
        r.last_score === null &&
        !(r.trace || []).some((t) => t.via === "stub") &&
        scoreRows(sc.fakeFs).length === 0,
      JSON.stringify({ st: r?.state, oc: r?.outcome }),
    );
  }

  // --- E36 blind A/B labels: mapping recorded, identity never leaks ----
  // chains baseline+editor under composite scorer + inhouse partner:
  // every outbound body (rubric, judge, partner) is scanned for the
  // real chain/stage ids - 'baseline', 'editor', 'inhouse' must
  // never appear in a payload, while runs/trace/ledger carry the
  // chain_a/chain_b mapping for audit
  {
    const sc = mkSc();
    sc.env = {
      HUMANIZER_SCORER: "rubric+judge",
      HUMANIZER_PARTNER: "inhouse",
      HUMANIZER_CHAINS: "baseline,editor",
    };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://127.0.0.1:8790/score") {
        return { score: 60, findings: [], metrics: {}, version: "0.1.0" };
      }
      if (o.url === "http://127.0.0.1:8787/run") {
        const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
        if (body.role === "fluency-judge") {
          return {
            role: "fluency-judge",
            model: "m",
            backend: "gemini",
            json: {
              score: 70,
              rationale: "stiff but grammatical",
              issues: [{ span: null, problem: "flat rhythm", severity: "minor" }],
            },
          };
        }
        if (body.role === "humanizer-partner") {
          const p = JSON.parse(body.input);
          return {
            role: "humanizer-partner",
            model: "m",
            backend: "gemini",
            json: {
              rewritten_text: `${p.source_text}\n\nRewritten.`,
              edits: [{ span_original: "x", span_new: "y", reason: "s" }],
              confidence: "medium",
              recommendation: "continue",
              unchanged_reason: null,
              caveats: [],
            },
          };
        }
      }
      throw new Error(`unexpected ${o.url}`);
    };
    const out = await runTicks(sc, 10);
    const rb = loadRun(sc.fakeFs, "baseline__ai_flop-en");
    const re = loadRun(sc.fakeFs, "editor__ai_flop-en");
    check(
      "E36 blind labels: chain_a/chain_b on runs, mapping in trace + tick output",
      rb?.label === "chain_a" &&
        re?.label === "chain_b" &&
        (rb.trace || []).some((t) => t.action === "seeded" && t.label === "chain_a") &&
        out?.[0]?.json?.labels?.chain_a === "baseline" &&
        out?.[0]?.json?.labels?.chain_b === "editor",
      JSON.stringify({ rb: rb?.label, re: re?.label, labels: out?.[0]?.json?.labels }),
    );
    check(
      "E36 blind labels: stage map on the editor run",
      re?.stage_labels?.editor === "stage_a",
      JSON.stringify(re?.stage_labels),
    );
    // the leak scan: serialize every outbound request body and hunt
    // the real chain/stage ids - blind labels ('chain_a', 'stage_a')
    // are fine, real ids never are
    const bodies = sc.calls.map((c0) => JSON.stringify(c0.body || {}));
    const leaked = bodies.filter((b) => /baseline|editor|inhouse|writehuman/.test(b));
    check(
      "E36 non-leakage: no chain/stage id in any scorer/judge/partner payload",
      leaked.length === 0 && sc.calls.length > 0,
      JSON.stringify(leaked.slice(0, 3)),
    );
    const partnerCalls = sc.calls.filter(
      (c0) => c0.url === "http://127.0.0.1:8787/run" && c0.body?.role === "humanizer-partner",
    );
    check(
      "E36 non-leakage: partner previous_attempts carry blind stage labels",
      partnerCalls.length >= 1 &&
        partnerCalls.every((c0) => {
          const p = JSON.parse(c0.body.input);
          return (p.previous_attempts || []).every(
            (a) => !a || typeof a !== "object" || !("stage" in a) || /^stage_/.test(a.stage),
          );
        }) &&
        partnerCalls.some((c0) => JSON.parse(c0.body.input).previous_attempts.length > 0),
      JSON.stringify(partnerCalls.map((c0) => JSON.parse(c0.body.input).previous_attempts)),
    );
    check(
      "E36 audit side: run record keeps real chain + stage names",
      re?.chain === "editor" &&
        (re.previous_attempts || []).every((a) => a.stage === "editor" || a.failed),
      JSON.stringify(re?.previous_attempts),
    );
    check(
      "E36 ledger: blind label rides the score rows",
      scoreRows(sc.fakeFs).some((row) => row.label === "chain_b" && row.chain === "editor"),
      JSON.stringify(scoreRows(sc.fakeFs)),
    );
  }

  // --- E37 fluency-judge role manifest + strict schema ----------------
  {
    const rolePath = path.join(__dirname, "..", "roles", "fluency-judge.yaml");
    const promptPath = path.join(__dirname, "..", "prompts", "fluency-judge.txt");
    const req = createRequire(path.join(__dirname, "..", "llm-gateway", "package.json"));
    const YAML = req("yaml");
    const Ajv = req("ajv");
    const doc = YAML.parse(fs.readFileSync(rolePath, "utf8"));
    const schema = doc?.output?.schema;
    let compiled = null;
    let compErr = null;
    try {
      compiled = new Ajv().compile(schema);
    } catch (e) {
      compErr = e;
    }
    check(
      "E37 judge role: manifest + prompt + output.schema compile via ajv",
      doc?.name === "fluency-judge" &&
        doc?.prompt === "fluency-judge" &&
        fs.existsSync(promptPath) &&
        !!compiled &&
        !compErr,
      String(compErr || ""),
    );
    const itemReq = schema?.properties?.issues?.items?.required || [];
    check(
      "E37 judge schema: strict shape, span optional, severity enum",
      schema?.additionalProperties === false &&
        ["score", "rationale", "issues"].every(
          (k) => schema.required.includes(k) && k in schema.properties,
        ) &&
        schema.properties.score.type === "number" &&
        schema.properties.score.minimum === 0 &&
        schema.properties.score.maximum === 100 &&
        schema.properties.issues.items.additionalProperties === false &&
        ["problem", "severity"].every((k) => itemReq.includes(k)) &&
        !itemReq.includes("span") &&
        "span" in (schema.properties.issues.items.properties || {}),
      JSON.stringify({ req: schema?.required, itemReq }),
    );
    check(
      "E37 judge schema: accepts compliant verdicts, rejects malformed",
      !!compiled?.({ score: 42, rationale: "r", issues: [] }) &&
        !!compiled?.({
          score: 80,
          rationale: "stiff",
          issues: [{ span: "it seems", problem: "hedge", severity: "major" }],
        }) &&
        !!compiled?.({
          score: 10,
          rationale: "fine",
          issues: [{ problem: "doc-level", severity: "minor" }],
        }) &&
        !compiled?.({ score: 120, rationale: "r", issues: [] }) &&
        !compiled?.({ score: 5, issues: [] }) &&
        !compiled?.({ score: 5, rationale: "r", issues: [], note: "x" }) &&
        !compiled?.({
          score: 5,
          rationale: "r",
          issues: [{ problem: "p", severity: "terrible" }],
        }),
    );
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
};

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
