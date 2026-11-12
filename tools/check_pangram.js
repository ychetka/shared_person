#!/usr/bin/env node
// check_pangram.js - harness for the issue #76 Pangram AI-check
// warn-gate. Runs the REAL 'Prepare Draft' and 'Handle Pangram
// Results' jsCode from n8n/workflows/sp-tg-moderation.json inside a
// stubbed n8n Code-node sandbox (same contract as check_state_lock.js
// / check_habr.js) and asserts:
//
//   G1  gate off: PANGRAM_GATE=off -> NO hands-queue enqueue and no
//       ai_check stamp on the draft; the poller answers 'gate off'
//       and consumes/sends nothing;
//   G2  short text: <150 whitespace-split words -> ai_check
//       {status:'inconclusive', reason:'short_text'}, ZERO enqueue;
//   G3  happy path: >=150 words -> inbox/pangram-<id>.json carrying
//       {recipe:'pangram_check', params:{text,snippet}}, the draft
//       stamped ai_check_pending and the credit counter charged the
//       ceil(words/100) optimistic estimate;
//   G4  credit cap: est_spent already at PANGRAM_DAILY_CREDITS ->
//       no enqueue, ai_check 'skipped'/'credit_cap' stamp and a
//       'ai-check-credit-cap' moderation.jsonl note;
//   G5  pending -> done result -> WARN reply via sendMessage under
//       the card's message_id ('AI-check (Pangram): AI Generated 92%
//       - WARN'), draft stamped ai_check done, result file consumed
//       (renamed .consumed), re-poll sends NO second reply;
//   G6  failed result -> warn-classified reply, draft ai_check
//       'failed', draft.status untouched (never blocks);
//   G7  bare failed/<tid>.json (no result record) -> same failed
//       warn classification;
//   G8  text-hash re-check: a settled ai_check whose text_fnv no
//       longer matches the draft text gets ONE re-enqueue
//       (rechecks 0 -> 1, pending stamped); a second change finds
//       rechecks already spent -> nothing;
//   G9  counter date rollover: a stale-dated est_spent resets on the
//       new date, so the enqueue goes through;
//   G10 inconclusive notify sweep: an inconclusive draft with a card
//       message_id gets ONE 'inconclusive - text under 150 words'
//       WARN reply, stamped notified so the next poll stays silent;
//   G11 stale result: a result whose pending stamp no longer matches
//       is consumed WITHOUT a reply;
//   G12 missing hands-queue dirs: Prepare Draft stamps 'skipped' /
//       'queue_unavailable' and the poll exits quietly - no throws;
//   G13 double-poll race: two overlapping poll executions sharing the
//       state fs both see the pending draft + landed result - exactly
//       ONE sendMessage lands (the lock claim precedes sendWarn);
//   G14 inconclusive double-poll: same race on the notify sweep -
//       exactly one 'inconclusive' reply across both polls;
//   G15 transient re-arm: a 'skipped'/'credit_cap' stamp with a stale
//       counter date re-arms after the daily reset (rechecks budget
//       untouched); a still-capped counter stamps rearmed_on and the
//       next same-day poll stays quiet;
//   G16 queue_unavailable re-arm: the same 'skipped' stamp re-arms
//       once the hands-queue bind mount reappears;
//   G17 gate typo: PANGRAM_GATE='wran' fails CLOSED - no enqueue, no
//       stamp, no sends, a 'ai-check-gate-disabled' ledger note and
//       pangram_gate 'disabled' on the poll answer;
//   G18 PANGRAM_DAILY_CREDITS='0' means ZERO: the first enqueue is
//       credit-capped, never silently defaulted back to 20.
//   G19 failed result carrying abort_reason ('wrong_scan_panel' -
//       the recipe's post-click identity probe refused a foreign
//       panel) -> the warn reply AND the ai_check stamp quote it next
//       to the step error;
//   G20 transient re-arm covers 'enqueue_failed' (prep-time lock/io
//       fault): a 'skipped'/'enqueue_failed' stamp re-enqueues once
//       the blocker clears; a settled 'failed' stamp (error, no
//       reason) NEVER re-arms - the dead-branch guard.
//
// Run:  node tools/check_pangram.js    (exit 0 = all pass)

const fs = require("node:fs");
const path = require("node:path");

const WF = path.join(__dirname, "..", "n8n", "workflows", "sp-tg-moderation.json");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const nodeOf = (name) => spec.nodes.find((n) => n.name === name);
const factoryOf = (name) => {
  const code = nodeOf(name)?.parameters?.jsCode;
  if (!code) {
    console.error(`FAIL: ${name} jsCode not found in ${WF}`);
    process.exit(1);
  }
  return new Function("require", "$input", "$env", `return (async function () {\n${code}\n});`);
};
const prepFactory = factoryOf("Prepare Draft");
const pollFactory = factoryOf("Handle Pangram Results");

// ------------------------------------------------------------------
// in-memory fs - the check_state_lock flavor: {flag:'wx'} honored
// (the lock claims are exclusive creates that silently become plain
// overwrites if the flag is ignored).
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
      const n = nodes.get(p);
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
const DRAFTS = `${STATE}/drafts`;
const LOG = "/home/node/.n8n/logs";
const HANDS = "/home/node/hands-queue";
const CREDITS = `${STATE}/pangram_credits.json`;

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "tg-token-for-harness",
  TELEGRAM_CHAT_ID: "4242",
  TG_WEBHOOK_SECRET: "tg-hook-secret-for-harness",
  DRAFT_WEBHOOK_SECRET: "draft-secret-for-harness",
  CONTENT_GEN_WEBHOOK_SECRET: "cg-secret-for-harness",
  PUBLISH_PLATFORMS: "vk",
  PANGRAM_GATE: "warn",
};

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
// same FNV-1a the jsCode applies - lets the harness build matching
// ai_check records instead of restating magic strings
const fnv = (s) => {
  let h = 0x811c9dc5;
  s = String(s || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
};

const seed = (fakeFs, { hands = true } = {}) => {
  fakeFs.mkdirSync(DRAFTS, { recursive: true });
  fakeFs.mkdirSync(LOG, { recursive: true });
  fakeFs.mkdirSync(`${STATE}/locks`, { recursive: true });
  if (hands) {
    fakeFs.mkdirSync(`${HANDS}/inbox`, { recursive: true });
    fakeFs.mkdirSync(`${HANDS}/done`, { recursive: true });
    fakeFs.mkdirSync(`${HANDS}/failed`, { recursive: true });
  }
};
const readJson = (fakeFs, p) => {
  try {
    return JSON.parse(fakeFs.readFileSync(p, "utf8"));
  } catch (_e) {
    return null;
  }
};
const logLines = (fakeFs) => {
  try {
    return fakeFs
      .readFileSync(`${LOG}/moderation.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (_e) {
    return [];
  }
};
const dirOf = (fakeFs, d) => {
  try {
    return fakeFs.readdirSync(d).filter((f) => !f.startsWith("."));
  } catch (_e) {
    return [];
  }
};

const mkHelpers = (sc) => ({
  httpRequest: async (o) => {
    sc.calls.push(o);
    if (String(o.url).startsWith("https://api.telegram.org/")) {
      sc.tgCalls.push({ method: String(o.url).split("/").pop(), body: o.body || {} });
      return { ok: true, result: { message_id: 777 } };
    }
    throw new Error(`unstubbed URL ${o.url}`);
  },
});

const mkSc = (extra) => ({
  fakeFs: mkFs(),
  items: [],
  env: {},
  calls: [],
  tgCalls: [],
  ...extra,
});
const execNode = async (factory, sc) => {
  const fn = factory(
    (m) => (m === "fs" ? sc.fakeFs : require(m)),
    { all: () => sc.items },
    { ...BASE_ENV, ...(sc.env || {}) },
    null,
  );
  return await fn.call({ helpers: mkHelpers(sc) });
};
// a moderation-draft webhook item the way Draft In delivers it
const draftItem = (body) => ({
  json: {
    headers: { "x-shared-token": BASE_ENV.DRAFT_WEBHOOK_SECRET },
    body,
  },
});
const runPrepare = (sc) => execNode(prepFactory, sc);
const runPoll = (sc) => {
  sc.items = [{ json: {} }];
  return execNode(pollFactory, sc);
};
const seedDraft = (fakeFs, id, fields) => {
  fakeFs.writeFileSync(
    `${DRAFTS}/${id}.json`,
    JSON.stringify({
      id,
      platform: "vk",
      topic: "t",
      text: words(160),
      image: "",
      media: [],
      caption_note: "",
      scope: "",
      post_id: "",
      test: false,
      warnings: [],
      status: "pending",
      message_id: 555,
      preview_v: "v1",
      created_at: new Date().toISOString(),
      ...fields,
    }),
  );
};
const today = () => new Date().toISOString().slice(0, 10);

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
  // --- G1 gate off: no enqueue, no stamp, quiet poller --------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.env = { PANGRAM_GATE: "off" };
    sc.items = [draftItem({ draft_id: "g1", platform: "vk", text: words(160) })];
    await runPrepare(sc);
    check(
      "G1 gate off: zero hands-queue writes",
      dirOf(sc.fakeFs, `${HANDS}/inbox`).length === 0,
      dirOf(sc.fakeFs, `${HANDS}/inbox`).join(","),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g1.json`);
    check(
      "G1 gate off: no ai_check stamp",
      !!d && !d.ai_check && !d.ai_check_pending && d.status === "delivering",
      JSON.stringify({ ai: d?.ai_check, st: d?.status }),
    );
    const out = await runPoll(sc);
    check(
      "G1 gate off: poller answers 'gate off', sends nothing",
      out?.[0]?.json?.pangram_gate === "off" && sc.tgCalls.length === 0,
      JSON.stringify(out?.[0]?.json),
    );
  }

  // --- G2 short text -> inconclusive stamp, zero enqueue ------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.items = [draftItem({ draft_id: "g2", platform: "vk", text: words(50) })];
    await runPrepare(sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/g2.json`);
    check(
      "G2 short text: inconclusive/short_text stamp",
      d?.ai_check?.status === "inconclusive" &&
        d.ai_check.reason === "short_text" &&
        d.ai_check.words === 50 &&
        !d.ai_check_pending,
      JSON.stringify(d?.ai_check),
    );
    check("G2 short text: zero enqueue", dirOf(sc.fakeFs, `${HANDS}/inbox`).length === 0);
  }

  // --- G3 happy path: enqueue + pending + credit charge -------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    sc.items = [draftItem({ draft_id: "g3", platform: "vk", text })];
    await runPrepare(sc);
    const inbox = dirOf(sc.fakeFs, `${HANDS}/inbox`);
    check(
      "G3 enqueue: pangram-g3.json in inbox",
      inbox.includes("pangram-g3.json"),
      inbox.join(","),
    );
    const task = readJson(sc.fakeFs, `${HANDS}/inbox/pangram-g3.json`);
    // the driver sends the first ~60 chars of the collapsed text as
    // the history-row match snippet (issue #77 review: lengthened
    // from ~30 to shrink the substring-match click surface)
    const snippet60 = Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 60).join("").trim();
    check(
      "G3 task shape: pangram_check + text/snippet params",
      task?.recipe === "pangram_check" &&
        task.params.text === text &&
        task.params.snippet === snippet60 &&
        task.params.snippet.length === 60,
      JSON.stringify(task),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g3.json`);
    check(
      "G3 pending stamp armed",
      d?.ai_check_pending?.task === "pangram-g3" &&
        d.ai_check_pending.words === 160 &&
        d.ai_check_pending.text_fnv === fnv(text),
      JSON.stringify(d?.ai_check_pending),
    );
    const c = readJson(sc.fakeFs, CREDITS);
    check(
      "G3 credits: optimistic est_spent ceil(160/100)=2",
      c?.date === today() && c.est_spent === 2,
      JSON.stringify(c),
    );
  }

  // --- G4 credit cap: skip + ledger note ----------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.fakeFs.writeFileSync(
      CREDITS,
      JSON.stringify({ date: today(), est_spent: 20, last_seen_left: 0 }),
    );
    sc.items = [draftItem({ draft_id: "g4", platform: "vk", text: words(160) })];
    await runPrepare(sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/g4.json`);
    check(
      "G4 credit cap: skipped/credit_cap stamp, no enqueue",
      d?.ai_check?.status === "skipped" &&
        d.ai_check.reason === "credit_cap" &&
        dirOf(sc.fakeFs, `${HANDS}/inbox`).length === 0,
      JSON.stringify({ ai: d?.ai_check, inbox: dirOf(sc.fakeFs, `${HANDS}/inbox`) }),
    );
    check(
      "G4 credit cap: ledger note",
      logLines(sc.fakeFs).some((l) => l.action === "ai-check-credit-cap"),
    );
  }

  // --- G5 pending -> done result -> WARN reply, once ----------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g5", {
      text,
      ai_check_pending: {
        task: "pangram-g5",
        text_fnv: fnv(text),
        words: 160,
        cost: 2,
        at: new Date().toISOString(),
      },
    });
    sc.fakeFs.writeFileSync(
      `${HANDS}/done/pangram-g5.result.json`,
      JSON.stringify({
        ok: true,
        hit_aig: "AI Generated",
        confidence: "92%",
        credits_raw: "11 left",
      }),
    );
    await runPoll(sc);
    const sent = sc.tgCalls.filter((c) => c.method === "sendMessage");
    check(
      "G5 done: exactly one WARN reply under the card",
      sent.length === 1 &&
        sent[0].body.reply_to_message_id === 555 &&
        sent[0].body.chat_id === "4242" &&
        /AI-check \(Pangram\): AI Generated 92%.*WARN/.test(String(sent[0].body.text)),
      JSON.stringify(sent.map((c) => c.body)),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g5.json`);
    check(
      "G5 done: ai_check stamped, pending cleared",
      d?.ai_check?.status === "done" &&
        d.ai_check.label === "AI Generated" &&
        d.ai_check.confidence === 92 &&
        d.ai_check.text_fnv === fnv(text) &&
        !d.ai_check_pending,
      JSON.stringify(d?.ai_check),
    );
    check(
      "G5 done: result file consumed",
      sc.fakeFs.existsSync(`${HANDS}/done/pangram-g5.result.json.consumed`) &&
        !sc.fakeFs.existsSync(`${HANDS}/done/pangram-g5.result.json`),
    );
    const c = readJson(sc.fakeFs, CREDITS);
    check(
      "G5 done: last_seen_left re-synced from credits_raw",
      c?.last_seen_left === 11,
      JSON.stringify(c),
    );
    // re-poll: nothing may answer twice
    await runPoll(sc);
    check(
      "G5 re-poll: no double reply",
      sc.tgCalls.filter((t) => t.method === "sendMessage").length === 1,
    );
  }

  // --- G6 failed result -> warn reply, never a block ----------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g6", {
      text,
      ai_check_pending: {
        task: "pangram-g6",
        text_fnv: fnv(text),
        words: 160,
        cost: 2,
        at: new Date().toISOString(),
      },
    });
    sc.fakeFs.writeFileSync(
      `${HANDS}/failed/pangram-g6.result.json`,
      JSON.stringify({ ok: false, error: "step8: element not found: Check for AI" }),
    );
    await runPoll(sc);
    const sent = sc.tgCalls.filter((c) => c.method === "sendMessage");
    check(
      "G6 failed: warn-classified reply",
      sent.length === 1 &&
        /AI-check \(Pangram\): check failed.*WARN/.test(String(sent[0].body.text)),
      JSON.stringify(sent.map((c) => c.body)),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g6.json`);
    check(
      "G6 failed: ai_check 'failed', draft status untouched",
      d?.ai_check?.status === "failed" && d.status === "pending" && !d.ai_check_pending,
      JSON.stringify({ ai: d?.ai_check, st: d?.status }),
    );
  }

  // --- G7 bare failed task file (no result record) ------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g7", {
      text,
      ai_check_pending: {
        task: "pangram-g7",
        text_fnv: fnv(text),
        words: 160,
        cost: 2,
        at: new Date().toISOString(),
      },
    });
    sc.fakeFs.writeFileSync(
      `${HANDS}/failed/pangram-g7.json`,
      JSON.stringify({ recipe: "pangram_check", params: {} }),
    );
    await runPoll(sc);
    const sent = sc.tgCalls.filter((c) => c.method === "sendMessage");
    const d = readJson(sc.fakeFs, `${DRAFTS}/g7.json`);
    check(
      "G7 task-only failure: warn reply + 'failed' stamp",
      sent.length === 1 &&
        /check failed.*WARN/.test(String(sent[0].body.text)) &&
        d?.ai_check?.status === "failed",
      JSON.stringify({ sent: sent.map((c) => c.body.text), ai: d?.ai_check }),
    );
  }

  // --- G8 text-hash re-check: one re-enqueue, then spent ------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    // settled check on the OLD text; the draft now carries new text
    seedDraft(sc.fakeFs, "g8", {
      text: words(160),
      ai_check: {
        status: "done",
        label: "Possibly human",
        text_fnv: "oldtextfnv",
        words: 160,
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    await runPoll(sc);
    check(
      "G8 re-check: pangram-g8.json re-enqueued",
      dirOf(sc.fakeFs, `${HANDS}/inbox`).includes("pangram-g8.json"),
      dirOf(sc.fakeFs, `${HANDS}/inbox`).join(","),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g8.json`);
    check(
      "G8 re-check: pending armed + budget spent",
      d?.ai_check_pending?.task === "pangram-g8" && d.ai_check.rechecks === 1,
      JSON.stringify({ ai: d?.ai_check, pend: d?.ai_check_pending }),
    );
    // budget spent: a second text change re-enqueues nothing
    const sc2 = mkSc();
    seed(sc2.fakeFs);
    seedDraft(sc2.fakeFs, "g8b", {
      text: words(160),
      ai_check: {
        status: "done",
        label: "Possibly human",
        text_fnv: "oldtextfnv",
        words: 160,
        rechecks: 1,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    await runPoll(sc2);
    check(
      "G8 re-check budget: spent budget -> no enqueue",
      dirOf(sc2.fakeFs, `${HANDS}/inbox`).length === 0,
      dirOf(sc2.fakeFs, `${HANDS}/inbox`).join(","),
    );
  }

  // --- G9 counter date rollover -------------------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.fakeFs.writeFileSync(
      CREDITS,
      JSON.stringify({ date: "2020-01-01", est_spent: 20, last_seen_left: 0 }),
    );
    sc.items = [draftItem({ draft_id: "g9", platform: "vk", text: words(160) })];
    await runPrepare(sc);
    const c = readJson(sc.fakeFs, CREDITS);
    check(
      "G9 date rollover: est_spent reset then charged",
      c?.date === today() &&
        c.est_spent === 2 &&
        dirOf(sc.fakeFs, `${HANDS}/inbox`).includes("pangram-g9.json"),
      JSON.stringify({ c, inbox: dirOf(sc.fakeFs, `${HANDS}/inbox`) }),
    );
  }

  // --- G10 inconclusive notify sweep --------------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(50);
    seedDraft(sc.fakeFs, "g10", {
      text,
      ai_check: {
        status: "inconclusive",
        reason: "short_text",
        words: 50,
        text_fnv: fnv(text),
        rechecks: 0,
        notified: false,
        at: new Date().toISOString(),
      },
    });
    await runPoll(sc);
    const sent = sc.tgCalls.filter((c) => c.method === "sendMessage");
    check(
      "G10 inconclusive: one WARN reply",
      sent.length === 1 &&
        /AI-check \(Pangram\): inconclusive.*WARN/.test(String(sent[0].body.text)) &&
        sent[0].body.reply_to_message_id === 555,
      JSON.stringify(sent.map((c) => c.body)),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g10.json`);
    check(
      "G10 inconclusive: notified stamped once",
      d?.ai_check?.notified === true,
      JSON.stringify(d?.ai_check),
    );
    await runPoll(sc);
    check(
      "G10 inconclusive: no second reply",
      sc.tgCalls.filter((t) => t.method === "sendMessage").length === 1,
    );
  }

  // --- G11 stale result: consumed, no reply --------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    // draft rewritten - pending dropped, so the result is stale
    seedDraft(sc.fakeFs, "g11", { text: words(160) });
    sc.fakeFs.writeFileSync(
      `${HANDS}/done/pangram-g11.result.json`,
      JSON.stringify({ ok: true, hit_aig: "AI Generated", confidence: "97%" }),
    );
    await runPoll(sc);
    check(
      "G11 stale result: consumed without reply",
      sc.tgCalls.filter((c) => c.method === "sendMessage").length === 0 &&
        sc.fakeFs.existsSync(`${HANDS}/done/pangram-g11.result.json.consumed`),
    );
    check(
      "G11 stale result: ledger note",
      logLines(sc.fakeFs).some((l) => l.action === "ai-check-stale-result"),
    );
  }

  // --- G12 missing hands-queue dirs ----------------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs, { hands: false });
    sc.items = [draftItem({ draft_id: "g12", platform: "vk", text: words(160) })];
    await runPrepare(sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/g12.json`);
    check(
      "G12 queue missing: draft still written, skipped stamp",
      d?.status === "delivering" && d.ai_check?.reason === "queue_unavailable",
      JSON.stringify({ st: d?.status, ai: d?.ai_check }),
    );
    // poller with no dirs at all must exit quietly
    const out = await runPoll(sc);
    check(
      "G12 queue missing: poll exits quietly",
      out?.[0]?.json?.ok === true && sc.tgCalls.length === 0,
      JSON.stringify(out?.[0]?.json),
    );
  }

  // --- G13 double-poll race: exactly one reply ----------------------
  // two poll executions overlapping on the SAME fs: the first claims
  // the pending stamp under the draft lock and only then awaits the
  // TG send - the second sees the stamp already transitioned and must
  // consume the artifact as stale, never reply again.
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g13", {
      text,
      ai_check_pending: {
        task: "pangram-g13",
        text_fnv: fnv(text),
        words: 160,
        cost: 2,
        at: new Date().toISOString(),
      },
    });
    sc.fakeFs.writeFileSync(
      `${HANDS}/done/pangram-g13.result.json`,
      JSON.stringify({ ok: true, hit_aig: "AI Generated", confidence: "88%" }),
    );
    const scA = sc;
    scA.items = [{ json: {} }];
    const scB = mkSc();
    scB.fakeFs = scA.fakeFs; // sibling poll on the same state volume
    scB.items = [{ json: {} }];
    await Promise.all([execNode(pollFactory, scA), execNode(pollFactory, scB)]);
    const sent = [...scA.tgCalls, ...scB.tgCalls].filter((c) => c.method === "sendMessage");
    check(
      "G13 double-poll: exactly one reply across both polls",
      sent.length === 1,
      JSON.stringify(sent.map((c) => c.body.text)),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g13.json`);
    check(
      "G13 double-poll: settled stamp, pending consumed",
      d?.ai_check?.status === "done" && d.ai_check.reply_sent === true && !d.ai_check_pending,
      JSON.stringify(d?.ai_check),
    );
    check(
      "G13 double-poll: loser's stale-consume note in ledger",
      logLines(sc.fakeFs).some(
        (l) => l.action === "ai-check-stale-result" || l.action === "ai-check-stamp-vetoed",
      ),
    );
  }

  // --- G14 inconclusive double-poll: same single-answer rule --------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(50);
    seedDraft(sc.fakeFs, "g14", {
      text,
      ai_check: {
        status: "inconclusive",
        reason: "short_text",
        words: 50,
        text_fnv: fnv(text),
        rechecks: 0,
        notified: false,
        at: new Date().toISOString(),
      },
    });
    const scA = sc;
    scA.items = [{ json: {} }];
    const scB = mkSc();
    scB.fakeFs = scA.fakeFs;
    scB.items = [{ json: {} }];
    await Promise.all([execNode(pollFactory, scA), execNode(pollFactory, scB)]);
    const sent = [...scA.tgCalls, ...scB.tgCalls].filter((c) => c.method === "sendMessage");
    const d = readJson(sc.fakeFs, `${DRAFTS}/g14.json`);
    check(
      "G14 inconclusive double-poll: exactly one reply",
      sent.length === 1 && d?.ai_check?.notified === true,
      JSON.stringify(sent.map((c) => c.body.text)),
    );
  }

  // --- G15 transient re-arm: credit_cap skip wakes after reset ------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g15", {
      text,
      ai_check: {
        status: "skipped",
        reason: "credit_cap",
        words: 160,
        text_fnv: fnv(text),
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    // yesterday's exhausted counter: the rollover in the credit lock
    // resets est_spent, so the re-arm enqueue goes through today
    sc.fakeFs.writeFileSync(
      CREDITS,
      JSON.stringify({ date: "2020-01-01", est_spent: 20, last_seen_left: 0 }),
    );
    await runPoll(sc);
    check(
      "G15 re-arm: credit_cap skip re-enqueues after daily reset",
      dirOf(sc.fakeFs, `${HANDS}/inbox`).includes("pangram-g15.json"),
      dirOf(sc.fakeFs, `${HANDS}/inbox`).join(","),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g15.json`);
    check(
      "G15 re-arm: pending armed, recheck budget untouched",
      d?.ai_check_pending?.task === "pangram-g15" &&
        Number(d.ai_check.rechecks || 0) === 0 &&
        d.ai_check.rearmed_on === today(),
      JSON.stringify({ ai: d?.ai_check, pend: d?.ai_check_pending }),
    );
    // still-capped same day: ONE bound attempt, then quiet
    const sc2 = mkSc();
    seed(sc2.fakeFs);
    seedDraft(sc2.fakeFs, "g15b", {
      text,
      ai_check: {
        status: "skipped",
        reason: "credit_cap",
        words: 160,
        text_fnv: fnv(text),
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    sc2.fakeFs.writeFileSync(
      CREDITS,
      JSON.stringify({ date: today(), est_spent: 20, last_seen_left: 0 }),
    );
    await runPoll(sc2);
    const d2 = readJson(sc2.fakeFs, `${DRAFTS}/g15b.json`);
    check(
      "G15 re-arm bound: capped counter refuses + stamps rearmed_on",
      dirOf(sc2.fakeFs, `${HANDS}/inbox`).length === 0 &&
        d2?.ai_check?.rearmed_on === today() &&
        logLines(sc2.fakeFs).filter((l) => l.action === "ai-check-rearm-credit-cap").length === 1,
      JSON.stringify({
        inbox: dirOf(sc2.fakeFs, `${HANDS}/inbox`),
        ai: d2?.ai_check,
      }),
    );
    await runPoll(sc2);
    check(
      "G15 re-arm bound: same-day repoll stays quiet",
      dirOf(sc2.fakeFs, `${HANDS}/inbox`).length === 0 &&
        logLines(sc2.fakeFs).filter((l) => l.action === "ai-check-rearm-credit-cap").length === 1,
    );
  }

  // --- G16 queue_unavailable re-arm once the mount returns ----------
  {
    const sc = mkSc();
    seed(sc.fakeFs); // hands dirs present again
    const text = words(160);
    seedDraft(sc.fakeFs, "g16", {
      text,
      ai_check: {
        status: "skipped",
        reason: "queue_unavailable",
        words: 160,
        text_fnv: fnv(text),
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    await runPoll(sc);
    check(
      "G16 re-arm: queue_unavailable skip re-enqueues when mounted",
      dirOf(sc.fakeFs, `${HANDS}/inbox`).includes("pangram-g16.json"),
      dirOf(sc.fakeFs, `${HANDS}/inbox`).join(","),
    );
    // mount still absent: quiet skip, no rearm stamp churn
    const sc2 = mkSc();
    seed(sc2.fakeFs, { hands: false });
    seedDraft(sc2.fakeFs, "g16b", {
      text,
      ai_check: {
        status: "skipped",
        reason: "queue_unavailable",
        words: 160,
        text_fnv: fnv(text),
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    const out = await runPoll(sc2);
    const d2 = readJson(sc2.fakeFs, `${DRAFTS}/g16b.json`);
    check(
      "G16 re-arm: mount still absent -> quiet, un-stamped",
      out?.[0]?.json?.ok === true && !d2?.ai_check?.rearmed_on && sc2.tgCalls.length === 0,
      JSON.stringify({ out: out?.[0]?.json, ai: d2?.ai_check }),
    );
  }

  // --- G17 gate typo: fail CLOSED, not silent 'warn' ----------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.env = { PANGRAM_GATE: "wran" };
    sc.items = [draftItem({ draft_id: "g17", platform: "vk", text: words(160) })];
    await runPrepare(sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/g17.json`);
    check(
      "G17 gate typo: no enqueue, no stamp",
      dirOf(sc.fakeFs, `${HANDS}/inbox`).length === 0 && !!d && !d.ai_check && !d.ai_check_pending,
      JSON.stringify({ ai: d?.ai_check, inbox: dirOf(sc.fakeFs, `${HANDS}/inbox`) }),
    );
    const out = await runPoll(sc);
    check(
      "G17 gate typo: poll answers 'disabled', sends nothing",
      out?.[0]?.json?.pangram_gate === "disabled" && sc.tgCalls.length === 0,
      JSON.stringify(out?.[0]?.json),
    );
    check(
      "G17 gate typo: disabled note in ledger",
      logLines(sc.fakeFs).some((l) => l.action === "ai-check-gate-disabled" && l.value === "wran"),
    );
    // 'block' is reserved: same fail-closed treatment
    const sc2 = mkSc();
    seed(sc2.fakeFs);
    sc2.env = { PANGRAM_GATE: "block" };
    const out2 = await runPoll(sc2);
    check(
      "G17 gate 'block': reserved value also disabled",
      out2?.[0]?.json?.pangram_gate === "disabled",
      JSON.stringify(out2?.[0]?.json),
    );
  }

  // --- G18 PANGRAM_DAILY_CREDITS='0' means zero ----------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.env = { PANGRAM_DAILY_CREDITS: "0" };
    sc.items = [draftItem({ draft_id: "g18", platform: "vk", text: words(160) })];
    await runPrepare(sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/g18.json`);
    check(
      "G18 credits=0: first enqueue credit-capped",
      d?.ai_check?.status === "skipped" &&
        d.ai_check.reason === "credit_cap" &&
        dirOf(sc.fakeFs, `${HANDS}/inbox`).length === 0,
      JSON.stringify({ ai: d?.ai_check, inbox: dirOf(sc.fakeFs, `${HANDS}/inbox`) }),
    );
  }

  // --- G19 abort_reason quoted in the warn reply + stamp -----------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g19", {
      text,
      ai_check_pending: {
        task: "pangram-g19",
        text_fnv: fnv(text),
        words: 160,
        cost: 2,
        at: new Date().toISOString(),
      },
    });
    sc.fakeFs.writeFileSync(
      `${HANDS}/failed/pangram-g19.result.json`,
      JSON.stringify({
        ok: false,
        error: "step14: element not found: w0 w1 w2",
        abort_reason: "wrong_scan_panel",
      }),
    );
    await runPoll(sc);
    const sent = sc.tgCalls.filter((c) => c.method === "sendMessage");
    check(
      "G19 abort_reason: warn reply quotes it",
      sent.length === 1 &&
        /check failed.*WARN/.test(String(sent[0].body.text)) &&
        sent[0].body.text.includes("wrong_scan_panel"),
      JSON.stringify(sent.map((c) => c.body.text)),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g19.json`);
    check(
      "G19 abort_reason: ai_check.error carries it too",
      d?.ai_check?.status === "failed" &&
        String(d.ai_check.error || "").includes("wrong_scan_panel"),
      JSON.stringify(d?.ai_check),
    );
  }

  // --- G20 enqueue_failed re-arm; 'failed' stamp stays terminal ----
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    const text = words(160);
    seedDraft(sc.fakeFs, "g20", {
      text,
      ai_check: {
        status: "skipped",
        reason: "enqueue_failed",
        words: 160,
        text_fnv: fnv(text),
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    await runPoll(sc);
    check(
      "G20 re-arm: enqueue_failed skip re-enqueues",
      dirOf(sc.fakeFs, `${HANDS}/inbox`).includes("pangram-g20.json"),
      dirOf(sc.fakeFs, `${HANDS}/inbox`).join(","),
    );
    const d = readJson(sc.fakeFs, `${DRAFTS}/g20.json`);
    check(
      "G20 re-arm: pending armed, rearmed_on stamped",
      d?.ai_check_pending?.task === "pangram-g20" && d.ai_check.rearmed_on === today(),
      JSON.stringify({ ai: d?.ai_check, pend: d?.ai_check_pending }),
    );
    // dead-branch guard: a settled 'failed' stamp carries 'error',
    // not 'reason' - TRANSIENT_SKIP has nothing to match, so the
    // record stays terminal even with a same-day poll
    const sc2 = mkSc();
    seed(sc2.fakeFs);
    seedDraft(sc2.fakeFs, "g20b", {
      text,
      ai_check: {
        status: "failed",
        error: "step8: element not found: Check for AI",
        words: 160,
        text_fnv: fnv(text),
        rechecks: 0,
        at: "2025-01-01T00:00:00.000Z",
      },
    });
    await runPoll(sc2);
    const d2 = readJson(sc2.fakeFs, `${DRAFTS}/g20b.json`);
    check(
      "G20 terminal: a 'failed' stamp never re-arms",
      dirOf(sc2.fakeFs, `${HANDS}/inbox`).length === 0 &&
        !d2?.ai_check_pending &&
        d2?.ai_check?.status === "failed",
      JSON.stringify({
        inbox: dirOf(sc2.fakeFs, `${HANDS}/inbox`),
        ai: d2?.ai_check,
      }),
    );
  }

  // --- WARN invariant: delivery outcome unaffected by pangram fields -
  // the 'msg' marker Prepare Draft emits for a normal draft still
  // carries exactly the moderation contract fields
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.items = [draftItem({ draft_id: "g13", platform: "vk", text: words(160) })];
    const out = await runPrepare(sc);
    const marker = (out || []).find((i) => i.json && i.json.kind === "msg");
    check(
      "WARN invariant: msg marker ok/draft_id/chat_id intact",
      !!marker &&
        marker.json.draft_id === "g13" &&
        marker.json.chat_id === "4242" &&
        marker.json.ok !== false,
      JSON.stringify(marker?.json),
    );
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
};

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
