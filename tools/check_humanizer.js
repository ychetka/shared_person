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
//   E22 the workflow spec ships "active": false (deploy never
//       activates the eval schedule on its own);
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

  // --- E21 threshold clamp + E22 ships inactive -----------------------
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
      "E22 deploy: workflow spec ships active:false",
      spec.active === false,
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

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
};

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
