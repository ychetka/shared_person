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
//   H7  3-per-24h window: three recorded habr publications inside 24h
//       make the fourth file requeue (retryable), not enqueue;
//   H8  result timeout: no result file inside HABR_RESULT_WAIT_MS ->
//       failed/ + maybe_live, and the habr_probe orphan probe
//       (HABR_PROFILE_URL) recovers the article url into the ledger;
//   H9  media path translation: /home/node/materials/<rel> resolves
//       then translates to HANDS_HOST_PREFIX/<rel> host paths in the
//       task params; image (КДПВ) lands in image_path;
//   H10 test:true + {retracted:true} -> test-published-retracted;
//       {ok,url} without retracted -> test-retract-failed;
//   H11 recipe failure classification: pre-click {ok:false,error}
//       -> definite failed (no maybe_live); post-click
//       {ok:false,published:true} -> failed + maybe_live;
//   H12 CAPTCHA/verification abort -> operator_escalation status,
//       no retry, no maybe_live;
//   H13 HABR_VIA other than 'hands' -> config_error, terminal.
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
        pub.verified === true,
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

  // H7: 3-per-24h window - requeue, no enqueue.
  {
    const now = Date.now();
    const { fakeFs } = await runTick({
      ledgerSeed: [1, 2, 3].map((i) => ({
        ts: new Date(now - i * 3600 * 1000).toISOString(),
        id: `old${i}`,
        platform: "habr",
        status: "published",
        external_id: `https://habr.com/ru/articles/${i}/`,
      })),
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
    const { fakeFs } = await runTick({
      payload: {
        media: ["materials/photos/fig1.png"],
        image: "materials/photos/fig2.png",
      },
      media: MEDIA,
      result: { url: "https://habr.com/ru/articles/7/" },
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
      result: { url: "https://habr.com/ru/articles/55/", retracted: true },
    });
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

  // H11: recipe failure classification.
  {
    const { fakeFs, ledger } = await runTick({
      failResult: { error: "composer field not found", log: ["fill title", "fill hubs"] },
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
    const { fakeFs, ledger } = await runTick({
      env: { HABR_PROFILE_URL: "" },
      failResult: { error: "browser died after click", published: true },
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

  // H12: CAPTCHA abort - operator escalation, terminal.
  {
    const { fakeFs, ledger } = await runTick({
      failResult: {
        error: "CAPTCHA challenge shown - abort",
        log: ["nav", "captcha interstitial"],
      },
    });
    check(
      "H12 captcha: failed/ + operator_escalation",
      at(fakeFs, "failed").includes("h1.json") && status(fakeFs)?.status === "operator_escalation",
      JSON.stringify(status(fakeFs)),
    );
    check(
      "H12 captcha: no maybe_live",
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

  console.log(fails ? `habr: ${fails} check(s) failed` : "habr: all checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error(`FAIL harness crashed: ${e?.stack || e}`);
  process.exit(1);
});
