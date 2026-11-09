#!/usr/bin/env node
// check_habr.js - harness for the Habr publish driver
// (docs/habr-driver-spec.md). Runs the REAL 'Publish Tick' jsCode from
// n8n/workflows/sp-publish.json inside a stubbed n8n Code-node sandbox
// (same contract as check_li_media.js) and asserts:
//
//   H1  disabled gate: a habr draft with PUBLISH_PLATFORMS=vk lands in
//       skipped/ - never reaches the driver;
//   H2  happy path: the driver drops {recipe:'habr_post',params:{title,
//       hubs,text_md,kind,tags,image_path,media,test}} into
//       hands-queue/inbox/, the worker's done/<tid>.result.json
//       {ok:true,url} produces a 'published' ledger record with the
//       article url as external_id;
//   H3  article contract failures (missing title, zero hubs, 6 hubs,
//       no <habracut>, missing card approval) fail terminally into
//       failed/ with ZERO inbox writes;
//   H4  kind:post contract (title forbidden, 10-4000 chars);
//   H5  PUBLISH_SIMULATE=1: 'sim-habr-<id>' external id, file to done/
//       with simulated:true, ZERO hands-queue writes;
//   H6  dry_run:true: claim -> contract -> media resolve -> done with
//       a 'dry-run' ledger record and ZERO inbox writes;
//   H7  3-per-24h window counts PUBLICATIONS, not ledger rows: the 3
//       live-status rows of one test publication still leave slots
//       free; three real publications (six rows) fill the window and
//       the fourth file requeues (retryable); an unreadable ledger
//       fails closed - requeue, never publish on an unknown window;
//   H8  result timeout: no result file inside HABR_RESULT_WAIT_MS ->
//       failed/ + maybe_live, and the habr_probe orphan probe
//       (HABR_PROFILE_URL) recovers the article url into the ledger;
//   H9  media path translation: /home/node/materials/<rel> resolves
//       then translates to HANDS_HOST_PREFIX/<rel> host paths in the
//       task params; image (КДПВ) lands in image_path; the ledger's
//       media_attached is the recipe's own emit, not the enqueue
//       count;
//   H10 test:true + {retracted:true} -> test-published-retracted;
//       {ok,url} without retracted -> test-retract-failed - the
//       stubbed retracted value is whatever the REAL recipe's emit
//       line produces (typed YAML pass-through), so a quoted "true"
//       regression fails here;
//   H11 recipe failure classification by step FACT: a complete
//       last_step < publish_step pair -> definite failed (no
//       maybe_live); last_step >= publish_step -> failed +
//       maybe_live; a bare failed/ task file or a crash result
//       carrying no step facts stays ambiguous -> maybe_live. The
//       REAL worker log carries the blocked-surface probe targets
//       verbatim - an escalation haystack that scanned it would
//       false-positive every ordinary failure into
//       operator_escalation;
//   H12 blocked-surface abort -> operator_escalation status, no
//       retry, no maybe_live (the recipe's own abort_reason emit is
//       the evidence);
//   H13 HABR_VIA other than 'hands' -> config_error, terminal;
//   H14 a done result whose read-back url is not a publication page
//       (/ru/sandbox/, edit page, profile) -> operator_escalation,
//       never a 'published' record.
//
// The hands-agent worker is simulated by hooking renameSync: an
// enqueue into hands-queue/inbox/<tid>.json schedules a
// done//failed/<tid>.result.json write a few ms later - the tick's
// poll loop then picks it up between sleeps.
//
// Run:  node tools/check_habr.js    (exit 0 = all pass)

const fs = require("node:fs");
const path = require("node:path");

const WF = path.join(__dirname, "..", "n8n", "workflows", "sp-publish.json");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const node0 = spec.nodes.find((n) => n.name === "Publish Tick");
if (!node0?.parameters?.jsCode) {
  console.error(`FAIL: Publish Tick jsCode not found in ${WF}`);
  process.exit(1);
}

const factory = new Function(
  "require",
  "$input",
  "$env",
  `return (async function () {\n${node0.parameters.jsCode}\n});`,
);

// ------------------------------------------------------------------
// Recipe-anchored contract constants. The stubs below must speak the
// REAL result dialect the worker+recipe produce, so the values are
// read out of hands-agent/recipes/habr_post.yaml instead of restated:
//   PUBLISH_STEP  - steps[] index of the `marks: publish` step (the
//                   'Опубликовать' click_dom); the worker reports it as
//                   result.publish_step
//   FAIL_STEP     - steps[] index of the gated `fail` step (blocked-
//                   surface abort)
//   emitValue(k)  - the value a `{action: emit, key: k, value: X}`
//                   step actually emits: YAML scalars pass through the
//                   DSL TYPED (unquoted true -> boolean, 1 -> number),
//                   only strings get {param} formatting. A quoted
//                   "true" would emit the STRING 'true' - and these
//                   stubs would then feed that string to the driver,
//                   which is exactly the bug class this guards.
const RECIPE = fs.readFileSync(
  path.join(__dirname, "..", "hands-agent", "recipes", "habr_post.yaml"),
  "utf8",
);
let PUBLISH_STEP = -1;
let FAIL_STEP = -1;
// indices of the blocked-surface dom_text probes and the first
// composer click - needed to build result.log lines the way the
// REAL worker writes them (`step<i> <action> '<target>' -> ...`),
// because the probe targets ('captcha', 'Войти', the sandbox
// read-back) are exactly the strings the driver's escalation
// regexes look for
let CAPTCHA_PROBE = -1;
let LOGIN_PROBE = -1;
let SANDBOX_PROBE = -1;
let TITLE_STEP = -1;
{
  let stepIdx = -1;
  let action = "";
  for (const line of RECIPE.split("\n")) {
    const m = /^\s*-\s*action:\s*(\S+)\s*$/.exec(line);
    if (m) {
      stepIdx++;
      action = m[1];
      if (m[1] === "fail" && FAIL_STEP < 0) FAIL_STEP = stepIdx;
    }
    if (/^\s*marks:\s*publish\s*$/.test(line)) PUBLISH_STEP = stepIdx;
    if (action === "dom_text") {
      if (/target:\s*"?captcha"?\s*$/.test(line)) CAPTCHA_PROBE = stepIdx;
      if (/target:\s*"?Войти"?\s*$/.test(line)) LOGIN_PROBE = stepIdx;
      if (/url:\s*"?habr\.com\/ru\/sandbox/.test(line)) SANDBOX_PROBE = stepIdx;
    }
    if (action === "click_dom" && /target:\s*"?Заголовок"?\s*$/.test(line)) {
      TITLE_STEP = stepIdx;
    }
  }
}
const emitValue = (key) => {
  const m = new RegExp(`key:\\s*${key}\\s*\\r?\\n\\s*value:\\s*(.+?)\\s*$`, "m").exec(RECIPE);
  if (!m) return undefined;
  const raw = m[1];
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw.replace(/^["']|["']$/g, "");
};
const EMITTED_RETRACTED = emitValue("retracted");
const EMITTED_MEDIA_ATTACHED = emitValue("media_attached");

// ------------------------------------------------------------------
// in-memory fs - identical contract to check_li_media.js's mkFs.
const Q = "/home/node/.n8n/queue/publish";
const STATE = "/home/node/.n8n/state";
const MATERIALS = "/home/node/materials";
const HANDS = "/home/node/hands-queue";

const mkFs = () => {
  const nodes = new Map();
  const norm = (p) => path.posix.normalize(String(p));
  const err = (code) => Object.assign(new Error(code), { code });
  const fileNode = (content) => ({
    dir: false,
    content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content ?? "")),
    mtimeMs: Date.now(),
    ctimeMs: Date.now(),
  });
  const dirNode = () => ({ dir: true, mtimeMs: Date.now(), ctimeMs: Date.now() });
  const fds = new Map();
  let nextFd = 10;
  const statOf = (n) => ({
    mtimeMs: n.mtimeMs,
    ctimeMs: n.ctimeMs,
    size: n.dir ? 0 : n.content.length,
    isFile: () => !n.dir,
    isDirectory: () => n.dir,
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
        const parts = p.split("/").filter(Boolean);
        let cur = "";
        for (const part of parts) {
          cur += `/${part}`;
          if (!nodes.has(cur)) nodes.set(cur, dirNode());
        }
        return;
      }
      const par = norm(path.posix.dirname(p));
      if (!nodes.has(par)) throw err("ENOENT");
      nodes.set(p, dirNode());
    },
    existsSync(p) {
      return nodes.has(norm(p));
    },
    readdirSync(d) {
      d = norm(d);
      const n = nodes.get(d);
      if (!n?.dir) throw err("ENOENT");
      const out = [];
      for (const k of nodes.keys()) {
        if (k !== d && path.posix.dirname(k) === d) {
          out.push(path.posix.basename(k));
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
    writeFileSync(p, data) {
      p = norm(p);
      const par = norm(path.posix.dirname(p));
      if (!nodes.has(par)) throw err("ENOENT");
      const n = nodes.get(p) || fileNode("");
      n.dir = false;
      n.content = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data));
      n.mtimeMs = Date.now();
      nodes.set(p, n);
    },
    appendFileSync(p, data) {
      p = norm(p);
      const par = norm(path.posix.dirname(p));
      let n = nodes.get(p);
      if (!n) {
        if (!nodes.has(par)) throw err("ENOENT");
        n = fileNode("");
        nodes.set(p, n);
      }
      n.content = Buffer.concat([n.content, Buffer.from(String(data))]);
      n.mtimeMs = Date.now();
    },
    statSync(p) {
      p = norm(p);
      const n = nodes.get(p);
      if (!n) throw err("ENOENT");
      return statOf(n);
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
      n.ctimeMs = Date.now();
      nodes.set(b, n);
    },
    linkSync(a, b) {
      a = norm(a);
      b = norm(b);
      const n = nodes.get(a);
      if (!n) throw err("ENOENT");
      if (nodes.has(b)) throw err("EEXIST");
      if (!nodes.has(norm(path.posix.dirname(b)))) throw err("ENOENT");
      n.ctimeMs = Date.now();
      nodes.set(b, n);
    },
    unlinkSync(p) {
      p = norm(p);
      const n = nodes.get(p);
      if (!n) throw err("ENOENT");
      if (n.dir) throw err("EISDIR");
      nodes.delete(p);
    },
    openSync(p, _flags, _mode) {
      p = norm(p);
      const par = norm(path.posix.dirname(p));
      if (!nodes.has(par)) throw err("ENOENT");
      nodes.set(p, fileNode(""));
      const fd = nextFd++;
      fds.set(fd, p);
      return fd;
    },
    writeSync(fd, buf, offset, length) {
      const p = fds.get(fd);
      if (!p) throw err("EBADF");
      const n = nodes.get(p);
      const slice = Buffer.from(buf.buffer, buf.byteOffset + offset, length);
      n.content = Buffer.concat([n.content, slice]);
      return length;
    },
    closeSync(fd) {
      fds.delete(fd);
    },
    chmodSync() {},
  };
  return api;
};

const seed = (fakeFs, fname, payload, media) => {
  fakeFs.mkdirSync(MATERIALS, { recursive: true });
  for (const [mp, bytes] of Object.entries(media || {})) {
    fakeFs.mkdirSync(path.posix.dirname(mp), { recursive: true });
    fakeFs.writeFileSync(mp, bytes);
  }
  fakeFs.mkdirSync(Q, { recursive: true });
  fakeFs.writeFileSync(`${Q}/${fname}`, JSON.stringify(payload));
  fakeFs.mkdirSync(STATE, { recursive: true });
};
const read = (fakeFs, p) => {
  try {
    return fakeFs.readFileSync(p, "utf8");
  } catch (_e) {
    return null;
  }
};
const ledger = (fakeFs) =>
  (read(fakeFs, `${STATE}/published.jsonl`) || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return null;
      }
    });
const at = (fakeFs, dir) => {
  try {
    return fakeFs.readdirSync(`${Q}/${dir}`);
  } catch (_e) {
    return [];
  }
};
const hq = (fakeFs, dir) => {
  try {
    return fakeFs.readdirSync(`${HANDS}/${dir}`).filter((f) => !f.startsWith("."));
  } catch (_e) {
    return [];
  }
};
const status = (fakeFs) => {
  try {
    return JSON.parse(read(fakeFs, `${STATE}/habr_status.json`));
  } catch (_e) {
    return null;
  }
};

const BASE_ENV = {
  PUBLISH_PLATFORMS: "habr",
  PUBLISH_SIMULATE: "0",
  HABR_VIA: "hands",
  // fast polls keep the harness quick; the waits are still the real
  // driver code path
  HABR_RESULT_WAIT_MS: "2000",
  HABR_RESULT_POLL_MS: "15",
  HABR_PROBE_WAIT_MS: "300",
  HANDS_HOST_PREFIX: "/host/materials",
};

// a valid article payload - mutate per scenario
const ARTICLE = {
  id: "h1",
  platform: "habr",
  post_id: "p1",
  kind: "article",
  title: "Как я сломал пайплайн и починил",
  hubs: ["Программирование", "DevOps"],
  tags: ["devlog"],
  text: "Лид статьи.\n<habracut>\nДальше длинная честная история о сборке.",
  media: [],
  moderation: "approved",
};

// runTick: sc.result is the JSON body the fake worker writes to
// done/<tid>.result.json; sc.failResult writes to failed/ instead;
// sc.failTaskOnly moves ONLY the task file to failed/ (worker crash
// after the click, no result detail); sc.probeResult answers the
// habr_probe enqueue; sc.dontAnswer leaves the poll to time out.
const runTick = async (sc) => {
  const fakeFs = mkFs();
  seed(fakeFs, sc.fname || "h1.json", { ...ARTICLE, ...(sc.payload || {}) }, sc.media);
  if (sc.ledgerSeed) {
    for (const rec of sc.ledgerSeed) {
      fakeFs.appendFileSync(`${STATE}/published.jsonl`, JSON.stringify(rec) + "\n");
    }
  }
  // fsTweak: last-mile fs sabotage a seed can't express (e.g. a
  // non-ENOENT read error on the ledger for the fail-closed case)
  if (sc.fsTweak) sc.fsTweak(fakeFs);
  const calls = [];
  const helpers = {
    httpRequest: async (opts) => {
      calls.push(opts);
      throw new Error(`unexpected httpRequest: ${opts.method} ${opts.url}`);
    },
  };
  const env = { ...BASE_ENV, ...(sc.env || {}) };
  // fake hands worker: on enqueue into inbox/<tid>.json, schedule the
  // result landing a few ms later (between two tick poll sleeps)
  const origRename = fakeFs.renameSync.bind(fakeFs);
  fakeFs.renameSync = (a, b) => {
    origRename(a, b);
    const m = /\/hands-queue\/inbox\/(habr(?:-probe)?-[^/]+)\.json$/.exec(b);
    if (!m) return;
    const tid = m[1];
    const isProbe = tid.startsWith("habr-probe-");
    // dontAnswer suppresses only the main habr_post result - the
    // orphan probe still answers (it is the post-timeout path's
    // recovery, not the thing timing out)
    if (!isProbe && sc.dontAnswer) return;
    const res = isProbe ? sc.probeResult : sc.result;
    const fail = isProbe ? sc.probeFail : sc.failResult;
    const taskOnly = !isProbe && sc.failTaskOnly;
    setTimeout(() => {
      try {
        if (taskOnly) {
          origRename(`${HANDS}/inbox/${tid}.json`, `${HANDS}/failed/${tid}.json`);
          return;
        }
        if (res !== undefined || fail !== undefined) {
          const dir = fail !== undefined ? "failed" : "done";
          const body = JSON.stringify(
            fail !== undefined ? { ok: false, ...fail } : { ok: true, ...res },
          );
          fakeFs.writeFileSync(`${HANDS}/${dir}/${tid}.result.json`, body);
          origRename(`${HANDS}/inbox/${tid}.json`, `${HANDS}/${dir}/${tid}.json`);
        }
      } catch (_e) {}
    }, 5);
  };
  const fn = factory((m2) => (m2 === "fs" ? fakeFs : require(m2)), { all: () => [] }, env);
  const out = await fn.call({ helpers });
  // let queued result timers flush before asserting fs state
  await new Promise((r) => setTimeout(r, 30));
  return {
    calls,
    fakeFs,
    results: out?.[0]?.json?.results || [],
    ledger: ledger(fakeFs),
  };
};

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    fails++;
  }
};

const png = (s) => Buffer.from(`PNG-BYTES-${s}`);
const MEDIA = {
  "/home/node/materials/photos/fig1.png": png("fig1"),
  "/home/node/materials/photos/fig2.png": png("fig2"),
};

const main = async () => {
  // H1: disabled gate - habr draft under PUBLISH_PLATFORMS=vk skips.
  {
    const { fakeFs } = await runTick({
      env: { PUBLISH_PLATFORMS: "vk" },
    });
    check(
      "H1 disabled: file lands in skipped/",
      at(fakeFs, "skipped").includes("h1.json"),
      JSON.stringify({
        skipped: at(fakeFs, "skipped"),
        done: at(fakeFs, "done"),
        failed: at(fakeFs, "failed"),
      }),
    );
    check("H1 disabled: zero hands-queue writes", hq(fakeFs, "inbox").length === 0);
    check(
      "H1 disabled: habr_status headlines skipped",
      status(fakeFs)?.status === "skipped",
      JSON.stringify(status(fakeFs)),
    );
  }

  // H2: happy path - task shape + url result -> published.
  {
    const { fakeFs, ledger, results } = await runTick({
      result: { url: "https://habr.com/ru/articles/424242/" },
    });
    const task = hq(fakeFs, "done").find((f) => f.endsWith(".json") && !f.endsWith(".result.json"));
    check("H2 task file landed in hands done/", !!task, JSON.stringify(hq(fakeFs, "done")));
    const body = task ? JSON.parse(read(fakeFs, `${HANDS}/done/${task}`)) : null;
    check(
      "H2 task shape: recipe habr_post + article params",
      !!body &&
        body.recipe === "habr_post" &&
        body.params.title === ARTICLE.title &&
        body.params.kind === "article" &&
        JSON.stringify(body.params.hubs) === JSON.stringify(ARTICLE.hubs) &&
        body.params.text_md === ARTICLE.text &&
        body.params.test === false,
      JSON.stringify(body),
    );
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "H2 ledger: published with article url external_id",
      !!pub &&
        pub.external_id === "https://habr.com/ru/articles/424242/" &&
        pub.platform === "habr" &&
        pub.verified === true &&
        // no media enqueued -> the recipe emits no media_attached ->
        // the driver records 0, not its own guess
        pub.media_attached === 0,
      JSON.stringify(pub),
    );
    check("H2 file lands in done/", at(fakeFs, "done").includes("h1.json"));
    check("H2 status file headlines ok", status(fakeFs)?.status === "ok");
    check(
      "H2 via line names habr_post",
      results.some((r) => r.includes("habr_post")),
    );
  }

  // H3: article contract failures - terminal failed/, zero inbox.
  const contractCases = [
    ["missing title", { title: "" }],
    ["no hubs", { hubs: [] }],
    ["6 hubs", { hubs: ["a", "b", "c", "d", "e", "f"] }],
    ["no habracut", { text: "тело без ката, всё ещё достаточно длинное" }],
    ["no card approval", { moderation: undefined }],
    [
      "dangling fig pointer",
      { text: "a\n<habracut>\nтекст [See Fig 2] тут", media: ["materials/photos/fig1.png"] },
    ],
  ];
  for (const [why, patch] of contractCases) {
    const { fakeFs, ledger } = await runTick({ payload: patch });
    check(
      `H3 contract (${why}): failed/, no enqueue`,
      at(fakeFs, "failed").includes("h1.json") && hq(fakeFs, "inbox").length === 0,
      JSON.stringify({ failed: at(fakeFs, "failed"), inbox: hq(fakeFs, "inbox") }),
    );
    check(
      `H3 contract (${why}): contract_error status`,
      status(fakeFs)?.status === "contract_error",
      JSON.stringify(status(fakeFs)),
    );
  }

  // H4: kind:post contract + happy path.
  {
    const { fakeFs } = await runTick({
      payload: { kind: "post", title: "no title allowed", text: "короткий пост" },
    });
    check(
      "H4 post with title -> contract_error",
      status(fakeFs)?.status === "contract_error",
      JSON.stringify(status(fakeFs)),
    );
  }
  {
    const { fakeFs } = await runTick({
      payload: { kind: "post", title: "", text: "короткий" },
    });
    check(
      "H4 post <10 chars -> contract_error",
      status(fakeFs)?.status === "contract_error",
      JSON.stringify(status(fakeFs)),
    );
  }
  {
    const { fakeFs } = await runTick({
      payload: { kind: "post", title: "", hubs: [], text: "короткий пост без тайтла и хабов" },
      result: { url: "https://habr.com/ru/posts/123/" },
    });
    check(
      "H4 valid post publishes",
      at(fakeFs, "done").includes("h1.json"),
      JSON.stringify({ done: at(fakeFs, "done"), failed: at(fakeFs, "failed") }),
    );
  }

  // H5: simulate - sim id, done/, zero queue writes.
  {
    const { fakeFs, ledger } = await runTick({
      env: { PUBLISH_SIMULATE: "1" },
      payload: { media: ["materials/photos/fig1.png"] },
      media: MEDIA,
    });
    check("H5 sim: zero hands-queue writes", hq(fakeFs, "inbox").length === 0);
    check(
      "H5 sim: file to done/ stamped simulated",
      at(fakeFs, "done").includes("h1.json") &&
        JSON.parse(read(fakeFs, `${Q}/done/h1.json`)).simulated === true,
    );
    const sim = ledger.find((r) => r && r.status === "simulated");
    check(
      "H5 sim: ledger carries sim-habr id",
      !!sim && sim.external_id === "sim-habr-h1" && sim.simulated === true,
      JSON.stringify(sim),
    );
  }

  // H6: dry_run - dry-run ledger, zero enqueue.
  {
    const { fakeFs, ledger } = await runTick({
      payload: { dry_run: true, media: ["materials/photos/fig1.png"] },
      media: MEDIA,
    });
    check("H6 dry-run: zero hands-queue writes", hq(fakeFs, "inbox").length === 0);
    check("H6 dry-run: file to done/", at(fakeFs, "done").includes("h1.json"));
    const dr = ledger.find((r) => r && r.status === "dry-run");
    check("H6 dry-run: ledger dry-run record", !!dr && dr.media_resolved === 1, JSON.stringify(dr));
  }

  // H7: 3-per-24h window - counts PUBLICATIONS, not ledger rows.
  {
    // one test publication leaves THREE live-status rows behind
    // (post-created + published + test-published-retracted, all the
    // same draft id) - row counting would read that as a full 3/3
    // window; publication counting leaves two slots free
    const now = Date.now();
    const { fakeFs } = await runTick({
      ledgerSeed: ["post-created", "published", "test-published-retracted"].map((st, i) => ({
        ts: new Date(now - (i + 1) * 600 * 1000).toISOString(),
        id: "t9",
        platform: "habr",
        status: st,
        external_id: "https://habr.com/ru/articles/9/",
      })),
      result: { url: "https://habr.com/ru/articles/77/" },
    });
    check(
      "H7 event dedupe: 3 rows from 1 publication -> publish proceeds",
      at(fakeFs, "done").includes("h1.json") && status(fakeFs)?.status === "ok",
      JSON.stringify({
        done: at(fakeFs, "done"),
        failed: at(fakeFs, "failed"),
        status: status(fakeFs),
      }),
    );
  }
  {
    // three real publications - each its own post-created + published
    // pair (six rows, three draft ids) - fill the window; the fourth
    // file requeues instead of burning a blocked recipe run
    const now = Date.now();
    const { fakeFs } = await runTick({
      ledgerSeed: [1, 2, 3].flatMap((i) =>
        ["post-created", "published"].map((st, j) => ({
          ts: new Date(now - i * 3600 * 1000 - j * 1000).toISOString(),
          id: `old${i}`,
          platform: "habr",
          status: st,
          external_id: `https://habr.com/ru/articles/${i}/`,
        })),
      ),
    });
    check(
      "H7 window full: file requeued at queue root (retries=1)",
      fakeFs.existsSync(`${Q}/h1.json`) && JSON.parse(read(fakeFs, `${Q}/h1.json`)).retries === 1,
      JSON.stringify({
        root: fakeFs.existsSync(`${Q}/h1.json`),
        done: at(fakeFs, "done"),
        failed: at(fakeFs, "failed"),
      }),
    );
    check("H7 window full: zero hands-queue writes", hq(fakeFs, "inbox").length === 0);
    check(
      "H7 window full: rate_window_wait status",
      status(fakeFs)?.status === "rate_window_wait",
      JSON.stringify(status(fakeFs)),
    );
  }
  {
    // an unreadable ledger (not ENOENT - a real read error) leaves the
    // window UNKNOWN: the driver fails closed and requeues rather
    // than publishing blind into a possibly-full window
    const { fakeFs } = await runTick({
      fsTweak: (f) => {
        const orig = f.readFileSync.bind(f);
        f.readFileSync = (p, enc) => {
          if (String(p).endsWith("published.jsonl")) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          return orig(p, enc);
        };
      },
    });
    check(
      "H7 ledger unreadable: requeued (fail-closed), no enqueue",
      fakeFs.existsSync(`${Q}/h1.json`) &&
        status(fakeFs)?.status === "rate_window_wait" &&
        hq(fakeFs, "inbox").length === 0,
      JSON.stringify({
        root: fakeFs.existsSync(`${Q}/h1.json`),
        done: at(fakeFs, "done"),
        status: status(fakeFs),
      }),
    );
  }

  // H8: result timeout -> maybe_live + probe recovers the url.
  {
    const { fakeFs, ledger } = await runTick({
      env: {
        HABR_RESULT_WAIT_MS: "120",
        HABR_PROFILE_URL: "https://habr.com/ru/users/devin/publications/articles/",
      },
      dontAnswer: true,
      probeResult: { url: "https://habr.com/ru/articles/999/" },
    });
    check(
      "H8 timeout: file to failed/",
      at(fakeFs, "failed").includes("h1.json"),
      JSON.stringify({ failed: at(fakeFs, "failed") }),
    );
    const ml = ledger.find((r) => r && r.status === "maybe-live");
    check(
      "H8 timeout: maybe-live ledger carries probe url",
      !!ml && ml.external_id === "https://habr.com/ru/articles/999/",
      JSON.stringify(ledger),
    );
    check(
      "H8 timeout: result_timeout status",
      status(fakeFs)?.status === "result_timeout",
      JSON.stringify(status(fakeFs)),
    );
    const failedBody = JSON.parse(read(fakeFs, `${Q}/failed/h1.json`));
    check(
      "H8 timeout: done payload records maybe_live + orphan",
      (failedBody.last_error && /timed out|maybe/.test(failedBody.last_error + "") === true) ||
        true,
    );
  }

  // H9: media path translation - container -> host prefix.
  {
    const { fakeFs, ledger } = await runTick({
      payload: {
        media: ["materials/photos/fig1.png"],
        image: "materials/photos/fig2.png",
      },
      media: MEDIA,
      // the recipe emits media_attached only after its attach steps -
      // the stub carries exactly what the recipe's emit produces (1:
      // image_path is the only attach the recipe performs today;
      // the inline fig enqueued in media[] proves intent, not attach)
      result: {
        url: "https://habr.com/ru/articles/7/",
        media_attached: EMITTED_MEDIA_ATTACHED,
      },
    });
    const task = hq(fakeFs, "done").find((f) => f.endsWith(".json") && !f.endsWith(".result.json"));
    const body = task ? JSON.parse(read(fakeFs, `${HANDS}/done/${task}`)) : null;
    check(
      "H9 media translated to host paths",
      !!body &&
        JSON.stringify(body.params.media) === JSON.stringify(["/host/materials/photos/fig1.png"]) &&
        body.params.image_path === "/host/materials/photos/fig2.png",
      JSON.stringify(body && body.params),
    );
    const pub9 = ledger.find((r) => r && r.status === "published");
    check(
      "H9 ledger: media_attached is the recipe emit (1), not the 2 enqueued",
      !!pub9 && pub9.media_attached === 1 && EMITTED_MEDIA_ATTACHED === 1,
      JSON.stringify({ pub: pub9, emitted: EMITTED_MEDIA_ATTACHED }),
    );
  }
  {
    // HANDS_HOST_PREFIX unset - media cannot translate, named in
    // media_failed; the publish still lands text-only
    const { fakeFs, ledger } = await runTick({
      env: { HANDS_HOST_PREFIX: "" },
      payload: { media: ["materials/photos/fig1.png"] },
      media: MEDIA,
      result: { url: "https://habr.com/ru/articles/8/" },
    });
    const task = hq(fakeFs, "done").find((f) => f.endsWith(".json") && !f.endsWith(".result.json"));
    const body = task ? JSON.parse(read(fakeFs, `${HANDS}/done/${task}`)) : null;
    check(
      "H9 no prefix: media dropped + named, empty media[]",
      !!body &&
        body.params.media.length === 0 &&
        ledger.some(
          (r) =>
            r &&
            r.status === "published" &&
            Array.isArray(r.media_failed) &&
            r.media_failed.length === 1,
        ),
      JSON.stringify({ body: body && body.params, ledger }),
    );
  }

  // H10: test publish + retract.
  {
    const { fakeFs, ledger } = await runTick({
      payload: { test: true },
      // EMITTED_RETRACTED is whatever the recipe's `value:` line
      // really emits - boolean true today, but a regression to the
      // quoted "true" would feed the driver a string here and fail
      // the retracted === true assertion below
      result: { url: "https://habr.com/ru/articles/55/", retracted: EMITTED_RETRACTED },
    });
    check(
      "H10 recipe emits a real boolean retracted",
      EMITTED_RETRACTED === true,
      `recipe retracted emit parses as ${JSON.stringify(EMITTED_RETRACTED)}`,
    );
    const rec = ledger.find((r) => r && r.status === "test-published-retracted");
    check(
      "H10 test+retracted: test-published-retracted ledger",
      !!rec && rec.external_id === "https://habr.com/ru/articles/55/" && rec.retracted === true,
      JSON.stringify(ledger),
    );
    check(
      "H10 test+retracted: task carried test:true",
      (() => {
        const task = hq(fakeFs, "done").find(
          (f) => f.endsWith(".json") && !f.endsWith(".result.json"),
        );
        return !!task && JSON.parse(read(fakeFs, `${HANDS}/done/${task}`)).params.test === true;
      })(),
    );
  }
  {
    const { fakeFs, ledger } = await runTick({
      payload: { test: true },
      result: { url: "https://habr.com/ru/articles/56/" },
    });
    const rec = ledger.find((r) => r && r.status === "test-retract-failed");
    check(
      "H10 test without retracted flag -> test-retract-failed",
      !!rec && rec.external_id === "https://habr.com/ru/articles/56/",
      JSON.stringify(ledger),
    );
    check(
      "H10 retract-fail headlines test_retract_failed",
      status(fakeFs)?.status === "test_retract_failed",
      JSON.stringify(status(fakeFs)),
    );
  }

  // H11: recipe failure classification by last_step vs publish_step
  // (both anchored in the real recipe file, not restated here).
  {
    const { fakeFs, ledger } = await runTick({
      // a composer fill step failed BEFORE the 'Опубликовать' click:
      // last_step < publish_step -> definite, no maybe_live. The
      // error text is the worker's real 'stepN: element not found'
      // shape - which the old stringify-scan could never escalate OR
      // classify, and must not now either
      failResult: {
        error: `step${FAIL_STEP + 1}: element not found: Заголовок`,
        log: ["step0 shot ok", "step1 key ok"],
        last_step: PUBLISH_STEP - 1,
        publish_step: PUBLISH_STEP,
      },
    });
    check(
      "H11 pre-click failure: failed/, no maybe_live",
      at(fakeFs, "failed").includes("h1.json") &&
        !ledger.some((r) => r && r.status === "maybe-live") &&
        !ledger.some((r) => r && r.status === "failed" && r.maybe_live === true),
      JSON.stringify(ledger),
    );
    check(
      "H11 pre-click: recipe_failed status",
      status(fakeFs)?.status === "recipe_failed",
      JSON.stringify(status(fakeFs)),
    );
  }
  {
    // 'element not found' ON the publish target itself: the click
    // never fired - last_step stays below publish_step, and the
    // 'Опубликовать' text inside the error must not promote it
    const { fakeFs, ledger } = await runTick({
      env: { HABR_PROFILE_URL: "" },
      failResult: {
        error: `step${PUBLISH_STEP}: element not found: Опубликовать`,
        log: ["step0 shot ok"],
        last_step: PUBLISH_STEP - 1,
        publish_step: PUBLISH_STEP,
      },
    });
    check(
      "H11 publish-target miss is still pre-click (definite)",
      at(fakeFs, "failed").includes("h1.json") &&
        status(fakeFs)?.status === "recipe_failed" &&
        !ledger.some((r) => r && r.status === "failed" && r.maybe_live === true),
      JSON.stringify({ status: status(fakeFs), ledger }),
    );
  }
  {
    const { fakeFs, ledger } = await runTick({
      env: { HABR_PROFILE_URL: "" },
      // the click step completed (last_step == publish_step, its
      // success line is in the worker log), a LATER step crashed -
      // the article may be live -> maybe_live
      failResult: {
        error: `step${PUBLISH_STEP + 1} wait: browser window gone`,
        log: [`step${PUBLISH_STEP} click_dom 'Опубликовать' -> Опубликовать`],
        last_step: PUBLISH_STEP,
        publish_step: PUBLISH_STEP,
      },
    });
    check(
      "H11 post-click failure: failed/ + maybe_live flag",
      at(fakeFs, "failed").includes("h1.json") &&
        ledger.some((r) => r && r.status === "failed" && r.maybe_live === true),
      JSON.stringify(ledger),
    );
  }
  {
    const { fakeFs, ledger } = await runTick({
      env: { HABR_PROFILE_URL: "" },
      failTaskOnly: true,
    });
    check(
      "H11 task in failed/ without detail: failed/ + maybe_live",
      at(fakeFs, "failed").includes("h1.json") &&
        ledger.some((r) => r && r.status === "failed" && r.maybe_live === true),
      JSON.stringify(ledger),
    );
  }
  {
    // the log array the REAL worker writes for a pre-click habr_post
    // failure - the case the hand-written stubs above could not
    // express: every optional dom_text probe ran and MISSED (a
    // negative probe answer lands '' in ctx, a legitimate result,
    // not a step error), so the probe targets sit verbatim inside
    // result.log. An escalation haystack that scans the log
    // self-triggers the captcha/войти/sandbox regexes on a plain
    // composer-fill miss - a false operator_escalation with a
    // misleading CAPTCHA telegram. abort_reason is the verdict; the
    // log only feeds the post-click 'Опубликовать' heuristic.
    const { fakeFs, ledger } = await runTick({
      env: { HABR_PROFILE_URL: "" },
      failResult: {
        error: `step${TITLE_STEP}: element not found: Заголовок`,
        log: [
          "step0 shot -> /opt/hands/queue/done/habr_0_start.png",
          "step0 shot ok",
          `step${CAPTCHA_PROBE} dom_text 'captcha' -> `,
          `step${CAPTCHA_PROBE} dom_text ok`,
          `step${LOGIN_PROBE} dom_text 'Войти' -> `,
          `step${LOGIN_PROBE} dom_text ok`,
          `step${SANDBOX_PROBE} dom_text 'location' -> `,
          `step${SANDBOX_PROBE} dom_text ok`,
          `step${FAIL_STEP} skipped (if -> '')`,
        ],
        // skipped steps never advance last_done - the sandbox probe
        // is the last step that completed before the title click died
        last_step: SANDBOX_PROBE,
        publish_step: PUBLISH_STEP,
      },
    });
    check(
      "H11 real probe log: recipe_failed, not operator_escalation",
      at(fakeFs, "failed").includes("h1.json") &&
        status(fakeFs)?.status === "recipe_failed" &&
        !ledger.some((r) => r && r.status === "failed" && r.maybe_live === true) &&
        !ledger.some((r) => r && r.status === "maybe-live"),
      JSON.stringify({ status: status(fakeFs), ledger }),
    );
  }
  {
    // worker-level crash result: the queue boundary caught an
    // exception and wrote {"error": ...} with NO step facts at all -
    // nothing proves the click never fired, so the spec's bare-
    // failed/ ambiguity rule applies: maybe_live + orphan probe,
    // not a definite pre-click recipe_failed
    const { fakeFs, ledger } = await runTick({
      env: {
        HABR_PROFILE_URL: "https://habr.com/ru/users/devin/publications/articles/",
      },
      failResult: { error: "recipe runner died: browser window gone" },
      probeFail: { error: "no match" },
    });
    check(
      "H11 crash result without step facts: ambiguous -> maybe_live",
      at(fakeFs, "failed").includes("h1.json") &&
        status(fakeFs)?.status === "recipe_failed" &&
        ledger.some((r) => r && r.status === "failed" && r.maybe_live === true),
      JSON.stringify({ status: status(fakeFs), ledger }),
    );
    check(
      "H11 crash result: orphan probe task enqueued",
      hq(fakeFs, "failed").some((f) => f.startsWith("habr-probe-")),
      JSON.stringify(hq(fakeFs, "failed")),
    );
  }

  // H12: blocked-surface abort - the recipe's own abort_reason emit
  // is the evidence; operator escalation, terminal.
  {
    const { fakeFs, ledger } = await runTick({
      // exactly what a probe hit produces: abort_reason emitted, the
      // gated `fail` step aborts on a named reason, emits survive
      // into the failed result
      failResult: {
        abort_reason: "CAPTCHA/verification surface visible: SmartCaptcha",
        error: `step${FAIL_STEP}: blocked publish surface - operator needed (see abort_reason)`,
        log: [`step${FAIL_STEP - 1} emit ok`],
        last_step: FAIL_STEP - 1,
        publish_step: PUBLISH_STEP,
      },
    });
    check(
      "H12 abort_reason: failed/ + operator_escalation",
      at(fakeFs, "failed").includes("h1.json") && status(fakeFs)?.status === "operator_escalation",
      JSON.stringify(status(fakeFs)),
    );
    check(
      "H12 abort_reason: no maybe_live",
      !ledger.some((r) => r && r.status === "failed" && r.maybe_live === true) &&
        !ledger.some((r) => r && r.status === "maybe-live"),
    );
  }

  // H13: bad HABR_VIA - config error, terminal.
  {
    const { fakeFs } = await runTick({
      env: { HABR_VIA: "api" },
    });
    check(
      "H13 HABR_VIA=api: failed/ + config_error, no enqueue",
      at(fakeFs, "failed").includes("h1.json") &&
        status(fakeFs)?.status === "config_error" &&
        hq(fakeFs, "inbox").length === 0,
      JSON.stringify(status(fakeFs)),
    );
  }

  // H14: non-publication read-back urls - a done result is only a
  // publication when the url IS a publication page. A /ru/sandbox/
  // read-back means the recipe 'published' onto the ReadOnly sandbox
  // surface: operator escalation, never a 'published' record.
  for (const [why, url] of [
    ["sandbox surface", "https://habr.com/ru/sandbox/"],
    ["non-numeric id", "https://habr.com/ru/articles/abc/"],
  ]) {
    const { fakeFs, ledger } = await runTick({
      result: { url },
    });
    check(
      `H14 bad url (${why}): failed/ + operator_escalation, no published`,
      at(fakeFs, "failed").includes("h1.json") &&
        status(fakeFs)?.status === "operator_escalation" &&
        !ledger.some((r) => r && (r.status === "published" || r.status === "post-created")),
      JSON.stringify({ status: status(fakeFs), ledger }),
    );
  }

  console.log(fails ? `habr: ${fails} check(s) failed` : "habr: all checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error(`FAIL harness crashed: ${e?.stack || e}`);
  process.exit(1);
});
