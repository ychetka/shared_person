#!/usr/bin/env node
// check_state_lock.js - harness for the issue #70 state-lock pack.
// Runs the REAL 'Handle TG Update' and 'Prepare Draft' jsCode from
// n8n/workflows/sp-tg-moderation.json inside a stubbed n8n Code-node
// sandbox and asserts the withLock() serialization + the bounded
// content-gen dispatch behave as designed:
//
//   L1  uncontended Approve: draft 'pending' -> 'approved' under
//       withLock('draft-<id>'), exactly one queue file lands in the
//       publish queue root, the lock file is released afterwards;
//   L2  interleaved executions on the SAME draft: a live foreign
//       locks/draft-<id>.lock (the parallel execution's held claim)
//       makes the second Approve answerCallbackQuery
//       'Busy - try again in a moment' (show_alert false), leaves
//       the draft 'pending', writes no queue file, and logs
//       'approve-lock-busy' - so across the two executions exactly
//       ONE transition + ONE busy result ever happen;
//   L3  stale-lock steal: the same foreign lock file with an exp in
//       the past is stolen, the Approve completes, and the stolen
//       lock file is released (locks/ holds no draft-<id>.lock);
//   L4  Prepare Draft busy path: a live foreign lock on the target
//       draft_id makes the overwrite answer the in-band
//       {kind:'msg', ok:false} refusal instead of throwing out of
//       the node;
//   D1  dispatch timeout: helpers.httpRequest throwing
//       ECONNABORTED / 'timeout ... exceeded' on the content-gen
//       'post N' call is counted as DISPATCHED - 'post_n-dispatch-
//       async' logged and the operator told 'sent to content-gen' -
//       while ECONNREFUSED stays a real 'post_n-dispatch-failed';
//   D2  the httpRequest for content-gen carries the bounded
//       CONTENT_GEN_DISPATCH_MS timeout, not the old 300000;
//   D3  an unset/empty CONTENT_GEN_DISPATCH_MS env falls back to the
//       15000 default (the || fallback sits INSIDE Math.max - on the
//       clamped value the 1000 floor is already truthy and the
//       fallback could never fire), a configured value reaches the
//       request, and a sub-floor value clamps to 1000;
//   E1  replace-mode busy: a live foreign draft lock makes the edit
//       feedback answer 'busy - resend the corrected text' AND re-arm
//       pending_edit.json (the entry read already consumed it, so
//       without the re-arm the resent text falls through to the
//       generic reply); after the lock clears the resend lands
//       verbatim;
//   E2  comment-mode busy: same re-arm contract on the rewrite arm
//       ('busy - resend the comments'); after the lock clears the
//       resend dispatches mode:'rewrite' to content-gen.
//
// Sandbox contract: same stub style as check_card_ux.js - require
// ('fs') is an in-memory filesystem (the jsCode paths are hardcoded
// to /home/node/...), $input.all() yields crafted update/webhook
// items, $env reads the env map, and this.helpers.httpRequest is
// routed by URL to a recording Telegram fake or a content-gen fake
// that throws on demand. The fs stub implements the flag:'wx'
// exclusive-create semantics the lock claims and update_id dedup
// rely on, plus the fd family publishedIds() reads through.
//
// Run:  node tools/check_state_lock.js    (exit 0 = all pass)

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
  return new Function(
    "require",
    "$input",
    "$env",
    "$",
    `return (async function () {\n${code}\n});`,
  );
};
const htuFactory = factoryOf("Handle TG Update");
const prepFactory = factoryOf("Prepare Draft");

// ------------------------------------------------------------------
// in-memory fs. Unlike check_card_ux's stub this one MUST honor
// {flag:'wx'} - the lock claims and seen_updates markers are
// exclusive creates that silently become plain overwrites if the
// flag is ignored - and expose dev/ino for the queue inode checks.
const norm = (p) => path.posix.normalize(String(p));
const mkFs = () => {
  const nodes = new Map(); // path -> {dir, content:Buffer, ino, mtimeMs}
  let inoSeq = 1000;
  const err = (code) => Object.assign(new Error(code), { code });
  const fileNode = (content) => ({
    dir: false,
    content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content ?? "")),
    ino: inoSeq++,
    mtimeMs: Date.now(),
  });
  const fds = new Map();
  let fdSeq = 10;
  const api = {
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
      if (opts && opts.flag === "wx" && nodes.has(p)) {
        throw err("EEXIST");
      }
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
        dev: 1,
        ino: n.ino,
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
      n.mtimeMs = Date.now();
      nodes.set(b, n);
    },
    linkSync(a, b) {
      a = norm(a);
      b = norm(b);
      const n = nodes.get(a);
      if (!n || n.dir) throw err("ENOENT");
      if (nodes.has(b)) throw err("EEXIST");
      if (!nodes.has(norm(path.posix.dirname(b)))) throw err("ENOENT");
      nodes.set(b, n); // hard link: SAME node, same ino
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
    openSync(p, flags) {
      p = norm(p);
      if (flags === "wx" || flags === "ax") {
        if (nodes.has(p)) throw err("EEXIST");
      } else if ((flags === "r" || flags === "r+") && !nodes.has(p)) {
        throw err("ENOENT");
      }
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      if (!nodes.has(p)) nodes.set(p, fileNode(""));
      const fd = fdSeq++;
      fds.set(fd, { p, pos: 0 });
      return fd;
    },
    readSync(fd, buf, off, len, pos) {
      const h = fds.get(fd);
      if (!h) throw err("EBADF");
      const n = nodes.get(h.p);
      if (!n || n.dir) throw err("ENOENT");
      const src = n.content.subarray(pos == null ? h.pos : pos, (pos == null ? h.pos : pos) + len);
      src.copy(buf, off);
      const read = src.length;
      if (pos == null) h.pos += read;
      return read;
    },
    writeSync(fd, buf, off, len, pos) {
      const h = fds.get(fd);
      if (!h) throw err("EBADF");
      const n = nodes.get(h.p);
      if (!n || n.dir) throw err("ENOENT");
      const chunk = Buffer.isBuffer(buf) ? buf.subarray(off, off + len) : Buffer.from(String(buf));
      const at = pos == null ? n.content.length : pos;
      const grown = Buffer.alloc(Math.max(at + chunk.length, n.content.length));
      n.content.copy(grown);
      chunk.copy(grown, at);
      n.content = grown;
      return chunk.length;
    },
    closeSync(fd) {
      fds.delete(fd);
    },
  };
  return api;
};

const STATE = "/home/node/.n8n/state";
const DRAFTS = `${STATE}/drafts`;
const LOCKS = `${STATE}/locks`;
const PUBLISH = "/home/node/.n8n/queue/publish";
const LOG = "/home/node/.n8n/logs";

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "tg-token-for-harness",
  TELEGRAM_CHAT_ID: "4242",
  TG_WEBHOOK_SECRET: "tg-hook-secret-for-harness",
  DRAFT_WEBHOOK_SECRET: "draft-secret-for-harness",
  CONTENT_GEN_WEBHOOK_SECRET: "cg-secret-for-harness",
  CONTENT_GEN_DISPATCH_MS: "15000",
  PUBLISH_PLATFORMS: "vk",
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
const readJson = (fakeFs, p) => {
  try {
    return JSON.parse(fakeFs.readFileSync(p, "utf8"));
  } catch (_e) {
    return null;
  }
};

const seed = (fakeFs) => {
  fakeFs.mkdirSync(DRAFTS, { recursive: true });
  fakeFs.mkdirSync(`${PUBLISH}/done`, { recursive: true });
  fakeFs.mkdirSync(`${PUBLISH}/failed`, { recursive: true });
  fakeFs.mkdirSync(`${PUBLISH}/skipped`, { recursive: true });
  fakeFs.mkdirSync(`${PUBLISH}/processing`, { recursive: true });
  fakeFs.mkdirSync(LOG, { recursive: true });
  fakeFs.mkdirSync(`${STATE}/seen_updates`, { recursive: true });
  fakeFs.mkdirSync(LOCKS, { recursive: true });
};

// httpRequest stub: Telegram endpoints are recorded and answer a
// generic ok; the content-gen webhook is routed through sc.cg -
// 'throw' makes it raise `sc.cgError`, anything else returns the
// value (default {ok:true, results:[{ok:true}]}).
const mkHelpers = (sc) => ({
  httpRequest: async (o) => {
    sc.calls.push(o);
    if (String(o.url).includes("/webhook/content-gen")) {
      sc.cgCalls.push(o);
      if (sc.cgError) throw sc.cgError;
      return sc.cgResult || { ok: true, results: [{ ok: true }] };
    }
    if (String(o.url).startsWith("https://api.telegram.org/")) {
      sc.tgCalls.push({
        method: String(o.url).split("/").pop(),
        body: o.body || {},
      });
      return { ok: true, result: { message_id: 777 } };
    }
    throw new Error(`unstubbed URL ${o.url}`);
  },
});

const execNode = async (factory, sc) => {
  const fn = factory(
    (m) => (m === "fs" ? sc.fakeFs : require(m)),
    { all: () => sc.items },
    { ...BASE_ENV, ...(sc.env || {}) },
    null,
  );
  const out = await fn.call({ helpers: mkHelpers(sc) });
  return out;
};

const tgItem = (body, updateId) => ({
  json: {
    headers: {
      "x-telegram-bot-api-secret-token": BASE_ENV.TG_WEBHOOK_SECRET,
    },
    body: { update_id: updateId, ...body },
  },
});
const cbItem = (data, updateId) =>
  tgItem(
    {
      callback_query: {
        id: `cbq-${updateId}`,
        data,
        message: {
          chat: { id: Number(BASE_ENV.TELEGRAM_CHAT_ID) },
          message_id: 555,
          text: "[DRAFT d1] preview text",
          reply_markup: { inline_keyboard: [[{ text: "Approve" }]] },
        },
      },
    },
    updateId,
  );

const mkSc = (extra) => ({
  fakeFs: mkFs(),
  items: [],
  env: {},
  calls: [],
  tgCalls: [],
  cgCalls: [],
  cgError: null,
  cgResult: null,
  ...extra,
});

const seedDraft = (fakeFs, id, fields) => {
  fakeFs.writeFileSync(
    `${DRAFTS}/${id}.json`,
    JSON.stringify({
      id,
      platform: "vk",
      topic: "t",
      text: "draft text one",
      image: "",
      media: [],
      caption_note: "",
      scope: "",
      post_id: "p1",
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
const holdLock = (fakeFs, key, liveMs) => {
  fakeFs.writeFileSync(
    `${LOCKS}/${key}.lock`,
    JSON.stringify({
      token: "foreign-exec",
      exp: Date.now() + liveMs,
    }),
  );
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const main = async () => {
  // --- L1 uncontended Approve ------------------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    seedDraft(sc.fakeFs, "d1");
    sc.items = [cbItem("ap:d1:v1", 9001)];
    await execNode(htuFactory, sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/d1.json`);
    check("L1 approve: draft flipped to 'approved'", d && d.status === "approved", d?.status);
    check(
      "L1 approve: queue file landed in publish root",
      sc.fakeFs.existsSync(`${PUBLISH}/d1.json`),
    );
    check("L1 approve: draft lock released", !sc.fakeFs.existsSync(`${LOCKS}/draft-d1.lock`));
    const ans = sc.tgCalls.find((c) => c.method === "answerCallbackQuery");
    check(
      "L1 approve: operator toast sent",
      !!ans && /queued/i.test(String(ans.body.text)),
      ans?.body.text,
    );
  }

  // --- L2 interleaved executions: one transition + one busy -------
  {
    // execution 1 claims the draft and transitions it
    const s1 = mkSc();
    seed(s1.fakeFs);
    seedDraft(s1.fakeFs, "d1");
    s1.items = [cbItem("ap:d1:v1", 9002)];
    await execNode(htuFactory, s1);
    const t1 = readJson(s1.fakeFs, `${DRAFTS}/d1.json`);

    // execution 2 (parallel): same draft, lock already held foreign
    const s2 = mkSc();
    seed(s2.fakeFs);
    seedDraft(s2.fakeFs, "d1");
    holdLock(s2.fakeFs, "draft-d1", 30000);
    s2.items = [cbItem("ap:d1:v1", 9003)];
    await execNode(htuFactory, s2);
    const d2 = readJson(s2.fakeFs, `${DRAFTS}/d1.json`);
    const ans2 = s2.tgCalls.find((c) => c.method === "answerCallbackQuery");
    check(
      "L2 interleave: first exec transitioned once",
      t1 && t1.status === "approved" && s1.fakeFs.existsSync(`${PUBLISH}/d1.json`),
    );
    check(
      "L2 interleave: second exec busy-answers, no transition",
      !!ans2 &&
        /Busy - try again in a moment/.test(String(ans2.body.text)) &&
        ans2.body.show_alert === false &&
        d2 &&
        d2.status === "pending" &&
        !s2.fakeFs.existsSync(`${PUBLISH}/d1.json`),
      JSON.stringify({ ans: ans2?.body, st: d2?.status }),
    );
    check(
      "L2 interleave: 'approve-lock-busy' logged",
      logLines(s2.fakeFs).some((l) => l.action === "approve-lock-busy"),
    );
    check(
      "L2 interleave: foreign lock left untouched",
      s2.fakeFs.existsSync(`${LOCKS}/draft-d1.lock`),
    );
  }

  // --- L3 stale lock steal + release ------------------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    seedDraft(sc.fakeFs, "d1");
    holdLock(sc.fakeFs, "draft-d1", -5000); // expired 5s ago
    sc.items = [cbItem("ap:d1:v1", 9004)];
    await execNode(htuFactory, sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/d1.json`);
    check(
      "L3 steal: expired lock stolen, approve completed",
      d && d.status === "approved" && sc.fakeFs.existsSync(`${PUBLISH}/d1.json`),
      d?.status,
    );
    check(
      "L3 steal: stolen lock released after use",
      !sc.fakeFs.existsSync(`${LOCKS}/draft-d1.lock`),
    );
    const leftovers = sc.fakeFs.readdirSync(LOCKS).filter((f) => f.includes("draft-d1"));
    check("L3 steal: no lock/tmp debris left", leftovers.length === 0, leftovers.join(","));
  }

  // --- L4 Prepare Draft busy -> in-band refusal -------------------
  {
    const sc = mkSc();
    seed(sc.fakeFs);
    holdLock(sc.fakeFs, "draft-d2", 30000);
    sc.items = [
      {
        json: {
          headers: { "x-shared-token": BASE_ENV.DRAFT_WEBHOOK_SECRET },
          body: {
            draft_id: "d2",
            platform: "vk",
            topic: "t",
            text: "fresh draft text",
          },
        },
      },
    ];
    const out = await execNode(prepFactory, sc);
    const msg = (out || []).find((i) => i.json && i.json.kind === "msg");
    check(
      "L4 prepare: live lock -> in-band ok:false refusal",
      !!msg && msg.json.ok === false && /busy/i.test(String(msg.json.error)),
      msg && JSON.stringify(msg.json),
    );
    check(
      "L4 prepare: busy refusal did not write a draft",
      !sc.fakeFs.existsSync(`${DRAFTS}/d2.json`),
    );
  }

  // --- D1 dispatch timeout = DISPATCHED, refused transport = fail -
  const runPostN = async (cgError, env) => {
    const sc = mkSc();
    seed(sc.fakeFs);
    sc.env = env || {};
    sc.fakeFs.writeFileSync(
      `${STATE}/digest.json`,
      JSON.stringify({
        "2025-01-01": {
          1: {
            id: "i1",
            title: "Story",
            source: "src",
            url: "https://example.com/x",
            hype: 88,
          },
        },
      }),
    );
    sc.items = [
      tgItem(
        {
          message: {
            chat: { id: Number(BASE_ENV.TELEGRAM_CHAT_ID) },
            text: "post 1",
          },
        },
        9100 + Math.floor(Math.random() * 1000),
      ),
    ];
    sc.cgError = cgError;
    await execNode(htuFactory, sc);
    return sc;
  };
  {
    const sc = await runPostN(
      Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" }),
    );
    const sent = sc.tgCalls.find(
      (c) => c.method === "sendMessage" && /sent to content-gen/.test(String(c.body.text)),
    );
    check(
      "D1 timeout(ECONNABORTED): async-dispatched toast",
      !!sent && /drafts will arrive as previews/.test(String(sent.body.text)),
      JSON.stringify(sc.tgCalls.map((c) => c.body.text)),
    );
    check(
      "D1 timeout: 'post_n-dispatch-async' logged",
      logLines(sc.fakeFs).some((l) => l.action === "post_n-dispatch-async"),
    );
    check(
      "D1 timeout: no 'dispatch-failed' log",
      !logLines(sc.fakeFs).some((l) => l.action === "post_n-dispatch-failed"),
    );
  }
  {
    const sc = await runPostN(Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }));
    check(
      "D1 timeout(ETIMEDOUT): async-dispatched toast",
      sc.tgCalls.some(
        (c) => c.method === "sendMessage" && /sent to content-gen/.test(String(c.body.text)),
      ),
      JSON.stringify(sc.tgCalls.map((c) => c.body.text)),
    );
  }
  {
    const sc = await runPostN(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5780"), { code: "ECONNREFUSED" }),
    );
    check(
      "D1 refused: 'Generation failed' toast, no async log",
      sc.tgCalls.some(
        (c) => c.method === "sendMessage" && /Generation failed/.test(String(c.body.text)),
      ) && !logLines(sc.fakeFs).some((l) => l.action === "post_n-dispatch-async"),
      JSON.stringify(sc.tgCalls.map((c) => c.body.text)),
    );
    check(
      "D1 refused: 'post_n-dispatch-failed' logged",
      logLines(sc.fakeFs).some((l) => l.action === "post_n-dispatch-failed"),
    );
  }

  // --- D2 bounded dispatch timeout on the request ------------------
  {
    const sc = await runPostN(null);
    const cg = sc.cgCalls[0];
    check(
      "D2 post-N request carries CONTENT_GEN_DISPATCH_MS",
      !!cg && cg.timeout === 15000,
      cg?.timeout,
    );
    const ok = sc.tgCalls.find((c) => c.method === "sendMessage");
    check(
      "D2 accepted dispatch still says 'sent to content-gen'",
      !!ok && /sent to content-gen/.test(String(ok.body.text)),
      ok?.body.text,
    );
  }

  // --- D3 env fallback: unset -> 15000, knob usable, floor clamp --
  {
    // the compose passthrough writes ${VAR:-}, so a missing and an
    // empty CONTENT_GEN_DISPATCH_MS both reach $env as '' - an empty
    // string covers the unset case. The buggy order clamped '' to the
    // 1000 floor first and '|| 15000' on that truthy floor could
    // never fire: the effective timeout silently became 1s
    const sc = await runPostN(null, { CONTENT_GEN_DISPATCH_MS: "" });
    const cg = sc.cgCalls[0];
    check(
      "D3 unset env: dispatch timeout falls back to 15000",
      !!cg && cg.timeout === 15000,
      cg?.timeout,
    );
  }
  {
    const sc = await runPostN(null, { CONTENT_GEN_DISPATCH_MS: "45000" });
    const cg = sc.cgCalls[0];
    check(
      "D3 env knob: a configured value reaches the request",
      !!cg && cg.timeout === 45000,
      cg?.timeout,
    );
  }
  {
    const sc = await runPostN(null, { CONTENT_GEN_DISPATCH_MS: "500" });
    const cg = sc.cgCalls[0];
    check(
      "D3 env floor: a sub-floor value clamps to 1000",
      !!cg && cg.timeout === 1000,
      cg?.timeout,
    );
  }

  // --- E busy edit feedback: marker re-armed, resend lands --------
  // pend.chat_id is a NUMBER in the real marker (the 'ed'/'rw'
  // callbacks arm it from cb.message.chat.id) and ===-compared
  // against m.chat.id - keep the seeded shape identical
  const armPend = (sc, mode) => {
    sc.fakeFs.writeFileSync(
      `${STATE}/pending_edit.json`,
      JSON.stringify({
        chat_id: Number(BASE_ENV.TELEGRAM_CHAT_ID),
        draft_id: "d7",
        message_id: 555,
        mode,
      }),
    );
  };
  const feedbackItem = (text, updateId) =>
    tgItem(
      {
        message: {
          chat: { id: Number(BASE_ENV.TELEGRAM_CHAT_ID) },
          text,
        },
      },
      updateId,
    );
  {
    // replace mode: the busy reply must re-arm the marker it just
    // consumed, or the resent text falls through to the generic reply
    const sc = mkSc();
    seed(sc.fakeFs);
    seedDraft(sc.fakeFs, "d7");
    armPend(sc, "replace");
    holdLock(sc.fakeFs, "draft-d7", 30000);
    sc.items = [feedbackItem("the first corrected text", 9301)];
    await execNode(htuFactory, sc);
    const busy = sc.tgCalls.find(
      (c) =>
        c.method === "sendMessage" &&
        /busy in a parallel update - resend the corrected text/.test(String(c.body.text)),
    );
    check(
      "E1 replace-busy: resend hint sent",
      !!busy,
      JSON.stringify(sc.tgCalls.map((c) => c.body.text)),
    );
    check(
      "E1 replace-busy: 'edit-replace-lock-busy' logged",
      logLines(sc.fakeFs).some((l) => l.action === "edit-replace-lock-busy"),
    );
    const pend = readJson(sc.fakeFs, `${STATE}/pending_edit.json`);
    check(
      "E1 replace-busy: marker re-armed for the resend",
      !!pend && pend.draft_id === "d7" && pend.mode === "replace",
      JSON.stringify(pend),
    );
    // the foreign lock clears; the resend must now reach the replace
    // path instead of the generic reply
    sc.fakeFs.unlinkSync(`${LOCKS}/draft-d7.lock`);
    sc.items = [feedbackItem("the resent corrected text", 9302)];
    await execNode(htuFactory, sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/d7.json`);
    check(
      "E1 replace-resend: text landed verbatim in the draft",
      !!d && d.text === "the resent corrected text",
      d?.text,
    );
    check(
      "E1 replace-resend: marker consumed by the landed edit",
      !sc.fakeFs.existsSync(`${STATE}/pending_edit.json`),
    );
  }
  {
    // comment mode: same re-arm contract on the rewrite arm
    const sc = mkSc();
    seed(sc.fakeFs);
    seedDraft(sc.fakeFs, "d7");
    armPend(sc, "comment");
    holdLock(sc.fakeFs, "draft-d7", 30000);
    sc.items = [feedbackItem("please shorten the intro", 9311)];
    await execNode(htuFactory, sc);
    const busy = sc.tgCalls.find(
      (c) =>
        c.method === "sendMessage" &&
        /busy in a parallel update - resend the comments/.test(String(c.body.text)),
    );
    check(
      "E2 comment-busy: resend hint sent",
      !!busy,
      JSON.stringify(sc.tgCalls.map((c) => c.body.text)),
    );
    check(
      "E2 comment-busy: 'edit-lock-busy' logged",
      logLines(sc.fakeFs).some((l) => l.action === "edit-lock-busy"),
    );
    const pend = readJson(sc.fakeFs, `${STATE}/pending_edit.json`);
    check(
      "E2 comment-busy: marker re-armed for the resend",
      !!pend && pend.draft_id === "d7" && pend.mode === "comment",
      JSON.stringify(pend),
    );
    // resend after the lock clears: the rewrite arm must run and the
    // feedback must reach content-gen as mode:'rewrite'
    sc.fakeFs.unlinkSync(`${LOCKS}/draft-d7.lock`);
    sc.items = [feedbackItem("please shorten the intro", 9312)];
    await execNode(htuFactory, sc);
    const d = readJson(sc.fakeFs, `${DRAFTS}/d7.json`);
    check("E2 comment-resend: draft armed to 'rewrite'", !!d && d.status === "rewrite", d?.status);
    check(
      "E2 comment-resend: feedback dispatched as mode:'rewrite'",
      sc.cgCalls.some(
        (c) =>
          c.body &&
          c.body.mode === "rewrite" &&
          c.body.draft_id === "d7" &&
          c.body.feedback === "please shorten the intro",
      ),
      JSON.stringify(sc.cgCalls.map((c) => c.body)),
    );
  }

  if (failures) {
    console.log(`\n${failures} state-lock check(s) failed`);
    process.exit(1);
  }
  console.log("\nstate-lock: all checks pass");
};

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
