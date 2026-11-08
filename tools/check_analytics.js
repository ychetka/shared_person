#!/usr/bin/env node
// check_analytics.js - harness for the issue #64 collector registry in
// 'Analytics Tick' (n8n/workflows/sp-analytics.json). Runs the REAL
// jsCode inside a stubbed n8n Code-node sandbox (in-memory fs seeded
// with registry events, $env, this.helpers.httpRequest routed to VK /
// LinkedIn API fakes - nothing touches disk or the network) and asserts
// the metrics.jsonl rows each collector emits:
//
//   A1  linkedin: GET /v2/socialActions/<urlencoded URN> maps
//       likesSummary.totalLikes / commentsSummary.totalFirstLevelComments
//       onto a 'measured' row - views/reposts stay absent entirely
//       (member shares do not expose them) - and the request carries
//       Bearer + X-Restli-Protocol-Version 2.0.0;
//   A2  linkedin without LINKEDIN_ACCESS_TOKEN -> per-id 'unsupported'
//       'LINKEDIN_ACCESS_TOKEN not set' with ZERO LinkedIn calls;
//   A3  linkedin 401/403 -> 'unsupported' 'linkedin auth/perm' (a
//       w_member_social token may not cover socialActions);
//   A4  linkedin 404 -> 'gone'; 5xx -> 'error'; a transport-level
//       failure (no HTTP status) -> 'error' too;
//   A5  facebook AND the 'fb' alias both get the explicit per-access
//       verdict 'no facebook api creds (meta app pending)' with zero
//       http calls - an honest unsupported, not the missing-collector
//       fallback;
//   A6  regression: the vk collector still measures, the unsupported
//       counter still counts collector-verdict rows, and
//       perf_summary.json is written with the measured posts.
//
// Run:  node tools/check_analytics.js    (exit 0 = all pass)

const fs = require("node:fs");
const path = require("node:path");

const WF = path.join(__dirname, "..", "n8n", "workflows", "sp-analytics.json");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const node0 = spec.nodes.find((n) => n.name === "Analytics Tick");
if (!node0?.parameters?.jsCode) {
  console.error(`FAIL: Analytics Tick jsCode not found in ${WF}`);
  process.exit(1);
}

// the Code node wraps user code in an async function with require /
// $input / $env in scope and `this` carrying .helpers - mirror that
const factory = new Function(
  "require",
  "$input",
  "$env",
  `return (async function () {\n${node0.parameters.jsCode}\n});`,
);

// ------------------------------------------------------------------
// in-memory fs: the Analytics Tick jsCode uses mkdirSync, readFileSync,
// writeFileSync, appendFileSync and renameSync only.
const STATE = "/home/node/.n8n/state";
const AN = `${STATE}/analytics`;
const LOGD = "/home/node/.n8n/logs";

const mkFs = () => {
  const nodes = new Map(); // path -> {dir, content}
  const norm = (p) => path.posix.normalize(String(p));
  const err = (code) => Object.assign(new Error(code), { code });
  const fileNode = (content) => ({
    dir: false,
    content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content ?? "")),
  });
  const dirNode = () => ({ dir: true });
  return {
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
          if (!nodes.has(cur)) nodes.set(cur, dirNode());
        }
        return;
      }
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      nodes.set(p, dirNode());
    },
    readFileSync(p, enc) {
      const n = nodes.get(norm(p));
      if (!n || n.dir) throw err("ENOENT");
      return enc ? n.content.toString(enc) : Buffer.from(n.content);
    },
    writeFileSync(p, data) {
      p = norm(p);
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      nodes.set(p, fileNode(Buffer.isBuffer(data) ? data : String(data)));
    },
    appendFileSync(p, data) {
      p = norm(p);
      let n = nodes.get(p);
      if (!n) {
        if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
        n = fileNode("");
        nodes.set(p, n);
      }
      n.content = Buffer.concat([n.content, Buffer.from(String(data))]);
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
  };
};

const readJsonl = (fakeFs, p) => {
  try {
    return fakeFs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
  } catch {
    return [];
  }
};

const ev = (pid, plat, ext) =>
  JSON.stringify({
    schema_v: 1,
    event_id: `e_${pid}_${plat}`,
    post_id: pid,
    platform: plat,
    stage: "publish",
    status: "published",
    ts: "2026-11-09T10:00:00Z",
    external_ids: [ext],
    published_at: "2026-11-09T10:00:00Z",
  });

const VK_ITEM = {
  owner_id: 29642349,
  id: 101,
  views: { count: 1000 },
  likes: { count: 9 },
  comments: { count: 3 },
  reposts: { count: 2 },
};

// run one analytics tick end-to-end under the stubs; sc drives the
// httpRequest fakes and the env. Returns the captured calls plus the
// metrics/log rows and status.json the tick wrote.
const runTick = async (sc) => {
  const fakeFs = mkFs();
  fakeFs.mkdirSync(`${STATE}/registry`, { recursive: true });
  fakeFs.mkdirSync(AN, { recursive: true });
  fakeFs.mkdirSync(LOGD, { recursive: true });
  fakeFs.writeFileSync(`${STATE}/registry/events.jsonl`, `${sc.events.join("\n")}\n`);
  const calls = [];
  const helpers = {
    httpRequest: async (opts) => {
      calls.push(opts);
      if (opts.method === "POST" && opts.url.startsWith("https://api.vk.com/method/")) {
        if (sc.vkThrow) throw sc.vkThrow;
        return sc.vk || { response: { items: sc.vkItems ?? [VK_ITEM] } };
      }
      if (
        opts.method === "GET" &&
        opts.url.startsWith("https://api.linkedin.com/v2/socialActions/")
      ) {
        if (sc.liThrow) throw sc.liThrow;
        return (
          sc.li || {
            likesSummary: { totalLikes: 7 },
            commentsSummary: { totalFirstLevelComments: 2 },
          }
        );
      }
      throw new Error(`unexpected httpRequest: ${opts.method} ${opts.url}`);
    },
  };
  const env = {
    VK_ACCESS_TOKEN: "vk-token-for-harness",
    LINKEDIN_ACCESS_TOKEN: "li-token-for-harness",
    ...(sc.env || {}),
  };
  const fn = factory((m) => (m === "fs" ? fakeFs : require(m)), { all: () => [] }, env);
  const out = await fn.call({ helpers });
  let status = null;
  try {
    status = JSON.parse(fakeFs.readFileSync(`${AN}/status.json`, "utf8"));
  } catch {}
  let perf = null;
  try {
    perf = JSON.parse(fakeFs.readFileSync(`${AN}/perf_summary.json`, "utf8"));
  } catch {}
  return {
    calls,
    out,
    status,
    perf,
    metrics: readJsonl(fakeFs, `${AN}/metrics.jsonl`),
    logs: readJsonl(fakeFs, `${LOGD}/analytics.jsonl`),
  };
};

const httpErr = (statusCode) =>
  Object.assign(new Error(`Request failed with status code ${statusCode}`), {
    statusCode,
  });

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    fails++;
  }
};
const byPlat = (metrics, plat) => metrics.find((r) => r && r.platform === plat);

const main = async () => {
  // A1: vk + linkedin + facebook candidates in one tick.
  {
    const { calls, metrics, status, perf, out } = await runTick({
      events: [
        ev("p1", "vk", "29642349_101"),
        ev("p2", "linkedin", "urn:li:share:777001"),
        ev("p3", "facebook", "fb_post_1"),
      ],
    });
    const li = byPlat(metrics, "linkedin");
    check(
      "A1 linkedin measured: likes/comments mapped from socialActions",
      li &&
        li.status === "measured" &&
        li.likes === 7 &&
        li.comments === 2 &&
        li.external_id === "urn:li:share:777001",
      JSON.stringify(li),
    );
    check(
      "A1 linkedin row omits views/reposts (not exposed for member shares)",
      li && !("views" in li) && !("reposts" in li),
      JSON.stringify(li),
    );
    const liCall = calls.find((c) => c.url.startsWith("https://api.linkedin.com/"));
    check(
      "A1 request shape: GET /v2/socialActions/<urlencoded urn> + headers",
      liCall &&
        liCall.method === "GET" &&
        liCall.url === "https://api.linkedin.com/v2/socialActions/urn%3Ali%3Ashare%3A777001" &&
        liCall.headers?.Authorization === "Bearer li-token-for-harness" &&
        liCall.headers?.["X-Restli-Protocol-Version"] === "2.0.0" &&
        liCall.timeout === 30000,
      JSON.stringify(liCall),
    );
    const fb = byPlat(metrics, "facebook");
    check(
      "A1 facebook explicit unsupported verdict, zero fb calls",
      fb &&
        fb.status === "unsupported" &&
        fb.error === "no facebook api creds (meta app pending)" &&
        !calls.some((c) => /facebook|graph\.facebook/.test(String(c.url))),
      JSON.stringify(fb),
    );
    const vk = byPlat(metrics, "vk");
    check(
      "A1 vk still measured (regression)",
      vk &&
        vk.status === "measured" &&
        vk.views === 1000 &&
        vk.likes === 9 &&
        vk.comments === 3 &&
        vk.reposts === 2,
      JSON.stringify(vk),
    );
    check(
      "A1 status.json counts: 2 measured, 1 unsupported",
      status && status.measured === 2 && status.unsupported === 1 && status.errors === 0,
      JSON.stringify(status),
    );
    check(
      "A1 perf_summary written with the measured posts",
      perf &&
        Array.isArray(perf.posts) &&
        perf.posts.length === 2 &&
        perf.posts.some((r) => r.platform === "linkedin" && r.engagement === 9),
      JSON.stringify(perf),
    );
    check("A1 tick output not failed", out?.[0]?.json?.ok === true, JSON.stringify(out));
  }

  // A2: no LINKEDIN_ACCESS_TOKEN - every linkedin id is an explicit
  // unsupported row, and no LinkedIn request is ever attempted.
  {
    const { calls, metrics } = await runTick({
      events: [ev("p2", "linkedin", "urn:li:share:777001")],
      env: { LINKEDIN_ACCESS_TOKEN: undefined },
    });
    const li = byPlat(metrics, "linkedin");
    check(
      "A2 missing token -> unsupported 'LINKEDIN_ACCESS_TOKEN not set'",
      li && li.status === "unsupported" && li.error === "LINKEDIN_ACCESS_TOKEN not set",
      JSON.stringify(li),
    );
    check(
      "A2 zero linkedin calls without a token",
      !calls.some((c) => String(c.url).includes("linkedin.com")),
      JSON.stringify(calls.map((c) => c.url)),
    );
  }

  // A3: auth/perm rejection degrades to unsupported - an honest verdict
  // beats fabricated metrics (w_member_social may not cover
  // socialActions).
  for (const statusCode of [401, 403]) {
    const { metrics } = await runTick({
      events: [ev("p2", "linkedin", "urn:li:share:777001")],
      liThrow: httpErr(statusCode),
    });
    const li = byPlat(metrics, "linkedin");
    check(
      `A3 linkedin ${statusCode} -> unsupported 'linkedin auth/perm'`,
      li && li.status === "unsupported" && li.error === "linkedin auth/perm",
      JSON.stringify(li),
    );
  }

  // A4: 404 -> gone, 5xx and transport-level failures -> error rows.
  {
    const { metrics, status } = await runTick({
      events: [ev("p2", "linkedin", "urn:li:share:777001")],
      liThrow: httpErr(404),
    });
    const li = byPlat(metrics, "linkedin");
    check(
      "A4 linkedin 404 -> gone",
      li && li.status === "gone" && status && status.gone === 1,
      JSON.stringify(li),
    );
  }
  {
    const { metrics } = await runTick({
      events: [ev("p2", "linkedin", "urn:li:share:777001")],
      liThrow: httpErr(500),
    });
    const li = byPlat(metrics, "linkedin");
    check(
      "A4 linkedin 5xx -> error row",
      li && li.status === "error" && typeof li.error === "string",
      JSON.stringify(li),
    );
  }
  {
    const { metrics } = await runTick({
      events: [ev("p2", "linkedin", "urn:li:share:777001")],
      liThrow: new Error("socket hang up"),
    });
    const li = byPlat(metrics, "linkedin");
    check(
      "A4 linkedin transport failure -> error row",
      li && li.status === "error" && li.error.includes("socket hang up"),
      JSON.stringify(li),
    );
  }

  // A5: the 'fb' canonical key (what registry events actually carry
  // for writer-fb drafts) shares the facebook collector verdict.
  {
    const { metrics } = await runTick({
      events: [ev("p4", "fb", "fb_post_9")],
    });
    const fb = byPlat(metrics, "fb");
    check(
      "A5 'fb' alias -> same explicit unsupported verdict",
      fb && fb.status === "unsupported" && fb.error === "no facebook api creds (meta app pending)",
      JSON.stringify(fb),
    );
  }

  console.log(fails ? `analytics: ${fails} check(s) failed` : "analytics: all checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error(`FAIL harness crashed: ${e?.stack || e}`);
  process.exit(1);
});
