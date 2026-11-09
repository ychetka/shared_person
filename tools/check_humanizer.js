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
//   E9  inhouse partner: POST http://llm-gateway:8787/run
//       {role:'humanizer-partner', input:<json payload>} drives the
//       rewrite; a 422-class failure records a failed attempt and
//       escalates 'partner_failed';
//   E10 external stage: chain 'writehuman' with no
//       HUMANIZER_EXT_WRITEHUMAN_URL -> 'unavailable' cell +
//       escalate 'stage_unavailable' with ZERO http calls;
//   E11 regression: a rescore worse than best by > margin reverts to
//       best text -> done/'reverted';
//   E12 no external calls in stub mode: httpRequest is never touched
//       across the whole stub-mode run matrix.
//
// Run:  node tools/check_humanizer.js    (exit 0 = all pass)

const fs = require("node:fs");
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
  {
    const sc = mkSc();
    sc.env = {
      HUMANIZER_PARTNER: "inhouse",
      HUMANIZER_CHAINS: "editor",
      LLM_GATEWAY_URL: "http://llm-gateway:8787",
    };
    seedFixtures(sc.fakeFs, ["ai_flop"]);
    sc.httpImpl = async (o) => {
      if (o.url === "http://llm-gateway:8787/run") {
        const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
        const payload = JSON.parse(body.input);
        return {
          role: "humanizer-partner",
          model: "m",
          backend: "gemini",
          json: {
            rewritten_text: `${payload.source_text}\n\nRewritten by partner.`,
            edits: [{ span: "x", action: "rephrase", reason: "stub" }],
          },
        };
      }
      throw new Error(`unexpected ${o.url}`);
    };
    await runTicks(sc, 6);
    const r = loadRun(sc.fakeFs, "editor__ai_flop-en");
    const gwCalls = sc.calls.filter((c0) => c0.url === "http://llm-gateway:8787/run");
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
    check(
      "E9 inhouse: rewrite applied -> rescoring path",
      !!r && r.iteration >= 1 && String(r.working_text).includes("Rewritten by partner."),
      JSON.stringify({ it: r?.iteration, st: r?.state }),
    );
    check(
      "E9 inhouse: calls only to llm-gateway",
      sc.calls.every((c0) => c0.url.startsWith("http://llm-gateway:8787")),
      JSON.stringify(sc.calls.map((c0) => c0.url)),
    );

    const sc2 = mkSc();
    sc2.env = {
      HUMANIZER_PARTNER: "inhouse",
      HUMANIZER_CHAINS: "editor",
      LLM_GATEWAY_URL: "http://llm-gateway:8787",
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

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
};

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
