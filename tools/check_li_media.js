#!/usr/bin/env node
// check_li_media.js - harness for the LinkedIn driver media upload
// (issue #50). Runs the REAL 'Publish Tick' jsCode from
// n8n/workflows/sp-publish.json inside a stubbed n8n Code-node
// sandbox and asserts on the publishLinkedin driver behavior:
//
//   S1  PUBLISH_SIMULATE=1 produces a 'sim-urn:li:share:' post id and
//       'sim-asset-<n>' urns for every resolvable media file with
//       ZERO httpRequest calls - no registerUpload, no PUT, no
//       ugcPosts, same contract the pre-#50 sim path kept;
//   S2  the real upload path builds the official flow: POST
//       /v2/assets?action=registerUpload per resolved file (recipes
//       feedshare-image, owner LINKEDIN_PERSON_URN,
//       serviceRelationships OWNER/urn:li:userGeneratedContent), a
//       binary PUT of the file bytes to the returned uploadUrl with
//       'Authorization: Bearer', a bounded GET poll on the asset URN
//       until it reports READY (issue #58), then ugcPosts carries
//       shareMediaCategory IMAGE and media[] = {status:READY,
//       media:<asset urn verbatim>, title:{text:<filename>}};
//   S3  a per-file upload failure is NON-FATAL like the VK driver:
//       the post still publishes with the surviving assets and the
//       dropped file is named in the ledger media_failed list and the
//       via line;
//   S4  media is capped at 4 (MEDIA_MAX): the 5th file never reaches
//       registerUpload and is reported dropped;
//   S5  a transient upload failure (transport error with no HTTP
//       status) rethrows retryable BEFORE ugcPosts, so the claim
//       returns to the queue root with retries=1 - same requeue
//       semantics as the VK photo-upload transient path;
//   S6  a media-only post (no text) publishes with IMAGE category;
//   S7  all media failed + no text fails the file instead of posting
//       an empty share;
//   S8  dry_run:true runs claim -> media resolve -> param build with
//       zero LinkedIn calls and reports media_resolved counts;
//   S9  a malformed registerUpload answer (no uploadUrl) is a LOCAL
//       classification error -> per-file terminal, no requeue
//       (issue #58);
//   S10 an asset that stays PROCESSING through 5 availability polls
//       is a per-file terminal drop, not a requeue (issue #58);
//   S11 a status-less asset GET answer is inconclusive - two in a
//       row end the poll and the file proceeds to attach.
//   S12 secret scrub: a registerUpload failure whose error text echoes
//       the bearer token lands in ledger.media_failed with the token
//       masked ('***') - the raw LINKEDIN_ACCESS_TOKEN value appears
//       NOWHERE in the persisted ledger or the result lines.
//
// Sandbox contract: the Code node sees require('fs'), $env.NAME and
// this.helpers.httpRequest - all stubbed here. fs is a small
// in-memory filesystem (the jsCode paths are hardcoded to
// /home/node/...), seeded with the queue payload plus media files
// under /home/node/materials. httpRequest is routed by URL to the
// LinkedIn API fakes; any unlisted URL throws.
//
// Run:  node tools/check_li_media.js    (exit 0 = all pass)

const fs = require("node:fs");
const path = require("node:path");

const WF = path.join(__dirname, "..", "n8n", "workflows", "sp-publish.json");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const node0 = spec.nodes.find((n) => n.name === "Publish Tick");
if (!node0?.parameters?.jsCode) {
  console.error(`FAIL: Publish Tick jsCode not found in ${WF}`);
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
// in-memory fs: the Publish Tick jsCode uses mkdirSync, readdirSync,
// readFileSync, writeFileSync, appendFileSync, existsSync, statSync,
// realpathSync, renameSync, linkSync, unlinkSync and the openSync/
// writeSync/closeSync/chmodSync quartet inside writeJsonAtomic.
// linkSync shares the node object, like a real hardlink.
const Q = "/home/node/.n8n/queue/publish";
const STATE = "/home/node/.n8n/state";
const MATERIALS = "/home/node/materials";

const mkFs = () => {
  const nodes = new Map(); // path -> {dir, content, mtimeMs, ctimeMs}
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

// seed a payload file plus the shared dirs the jsCode expects
const seed = (fakeFs, fname, payload, media) => {
  fakeFs.mkdirSync(MATERIALS, { recursive: true });
  for (const [mp, bytes] of Object.entries(media || {})) {
    fakeFs.mkdirSync(path.posix.dirname(mp), { recursive: true });
    fakeFs.writeFileSync(mp, bytes);
  }
  fakeFs.mkdirSync(Q, { recursive: true });
  fakeFs.writeFileSync(`${Q}/${fname}`, JSON.stringify(payload));
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

const BASE_ENV = {
  LINKEDIN_ACCESS_TOKEN: "li-token-for-harness",
  LINKEDIN_PERSON_URN: "urn:li:person:wXA3nkEhNW",
  PUBLISH_PLATFORMS: "linkedin",
};

// run one tick end-to-end under the stubs; sc drives the httpRequest
// fake. Returns the node output plus every captured call and the fs.
const runTick = async (sc) => {
  const fakeFs = mkFs();
  seed(fakeFs, sc.fname || "d1.json", sc.payload, sc.media);
  const calls = [];
  let regN = 0;
  const helpers = {
    httpRequest: async (opts) => {
      calls.push(opts);
      const key = `${opts.method} ${opts.url}`;
      if (key === "POST https://api.linkedin.com/v2/assets?action=registerUpload") {
        regN++;
        if (sc.regFail?.(regN, opts)) throw sc.regFail(regN, opts);
        if (sc.regAnswer) return sc.regAnswer(regN, opts);
        return {
          value: {
            asset: `urn:li:digitalmediaAsset:TST${regN}`,
            uploadMechanism: {
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
                uploadUrl: `https://uploads.li.test/put/${regN}`,
              },
            },
          },
        };
      }
      if (opts.method === "PUT" && String(opts.url).startsWith("https://uploads.li.test/")) {
        if (sc.putFail?.(opts)) throw sc.putFail(opts);
        return "";
      }
      // asset availability poll (issue #58): the driver GETs the
      // asset URN after the PUT until it reports a READY-ish status.
      // sc.assetGet(opts, n) overrides the answer per call - return a
      // body or throw an error.
      if (opts.method === "GET" && opts.url.startsWith("https://api.linkedin.com/v2/assets/")) {
        const assetGetN = calls.filter((c) => c.method === "GET" && c.url === opts.url).length;
        if (sc.assetGet) {
          const r = sc.assetGet(opts, assetGetN);
          if (r instanceof Error) throw r;
          return r;
        }
        return { status: "READY" };
      }
      if (key === "POST https://api.linkedin.com/v2/ugcPosts") {
        if (sc.ugcFail) throw sc.ugcFail(opts);
        return { id: "urn:li:share:777001" };
      }
      if (opts.method === "GET" && opts.url.startsWith("https://api.linkedin.com/v2/ugcPosts")) {
        return { id: "urn:li:share:777001" };
      }
      throw new Error(`unexpected httpRequest: ${key}`);
    },
  };
  const env = { ...BASE_ENV, ...(sc.env || {}) };
  const fn = factory((m) => (m === "fs" ? fakeFs : require(m)), { all: () => [] }, env);
  const out = await fn.call({ helpers });
  return {
    calls,
    fakeFs,
    results: out?.[0]?.json?.results || [],
    ledger: ledger(fakeFs),
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const png = (s) => Buffer.from(`PNG-BYTES-${s}`);
const MEDIA = {
  "/home/node/materials/photos/fig1.png": png("fig1"),
  "/home/node/materials/photos/fig2.png": png("fig2"),
  "/home/node/materials/photos/fig3.png": png("fig3"),
  "/home/node/materials/photos/fig4.png": png("fig4"),
  "/home/node/materials/photos/fig5.png": png("fig5"),
};

const main = async () => {
  // S1: PUBLISH_SIMULATE=1 - synthetic ids, zero network.
  {
    const { calls, ledger, fakeFs, results } = await runTick({
      env: { PUBLISH_SIMULATE: "1" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "sim article [See Fig 1] body",
        media: ["materials/photos/fig1.png", "materials/photos/fig2.png"],
      },
      media: MEDIA,
    });
    check("S1 sim: zero httpRequest calls", calls.length === 0, String(calls.length));
    check("S1 sim: file lands in done/", at(fakeFs, "done").includes("d1.json"));
    const sim = ledger.find((r) => r && r.status === "simulated");
    check(
      "S1 sim: ledger carries sim post id + sim asset urns",
      !!sim &&
        sim.external_id === "sim-urn:li:share:d1" &&
        sim.simulated === true &&
        sim.media_attached === 2 &&
        eq(sim.media_assets, ["sim-asset-1", "sim-asset-2"]),
      JSON.stringify(sim),
    );
    check(
      "S1 sim: via line reports sim assets",
      results.some((r) => r.includes("SIMULATED publish") && r.includes("sim assets")),
      JSON.stringify(results),
    );
  }

  // S2: real publish with two media - full official upload flow.
  {
    const { calls, ledger, fakeFs } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "article body [See Fig 1] and [See Fig 2]",
        media: ["materials/photos/fig1.png", "materials/photos/fig2.png"],
      },
      media: MEDIA,
    });
    const kinds = calls.map(
      (c) => c.method + " " + (c.url.startsWith("https://uploads.li.test") ? "<uploadUrl>" : c.url),
    );
    check(
      "S2 call order: register,PUT,assetGET x2 -> ugcPosts -> verify GET",
      eq(kinds, [
        "POST https://api.linkedin.com/v2/assets?action=registerUpload",
        "PUT <uploadUrl>",
        "GET https://api.linkedin.com/v2/assets/urn%3Ali%3AdigitalmediaAsset%3ATST1",
        "POST https://api.linkedin.com/v2/assets?action=registerUpload",
        "PUT <uploadUrl>",
        "GET https://api.linkedin.com/v2/assets/urn%3Ali%3AdigitalmediaAsset%3ATST2",
        "POST https://api.linkedin.com/v2/ugcPosts",
        "GET https://api.linkedin.com/v2/ugcPosts/urn%3Ali%3Ashare%3A777001",
      ]),
      JSON.stringify(kinds),
    );
    const reg = calls[0];
    const req = reg.body?.registerUploadRequest;
    check(
      "S2 registerUpload body: feedshare-image recipe + member owner",
      !!req &&
        eq(req.recipes, ["urn:li:digitalmediaRecipe:feedshare-image"]) &&
        req.owner === "urn:li:person:wXA3nkEhNW" &&
        eq(req.serviceRelationships, [
          { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
        ]) &&
        reg.headers.Authorization === "Bearer li-token-for-harness",
      JSON.stringify(reg.body),
    );
    const put = calls[1];
    check(
      "S2 PUT: file bytes + Bearer auth + image content-type",
      put.method === "PUT" &&
        put.url === "https://uploads.li.test/put/1" &&
        Buffer.isBuffer(put.body) &&
        put.body.equals(png("fig1")) &&
        put.headers.Authorization === "Bearer li-token-for-harness" &&
        put.headers["Content-Type"] === "image/png",
      JSON.stringify({ url: put.url, headers: put.headers, body: String(put.body) }),
    );
    const ugc = calls.find((c) => c.url.endsWith("/v2/ugcPosts") && c.method === "POST");
    const sc2 = ugc?.body?.specificContent["com.linkedin.ugc.ShareContent"];
    check(
      "S2 ugcPosts: shareMediaCategory IMAGE + READY media urns",
      !!sc2 &&
        sc2.shareMediaCategory === "IMAGE" &&
        Array.isArray(sc2.media) &&
        sc2.media.length === 2 &&
        eq(sc2.media[0], {
          status: "READY",
          media: "urn:li:digitalmediaAsset:TST1",
          title: { text: "fig1.png" },
        }) &&
        eq(sc2.media[1], {
          status: "READY",
          media: "urn:li:digitalmediaAsset:TST2",
          title: { text: "fig2.png" },
        }) &&
        sc2.shareCommentary.text === "article body [See Fig 1] and [See Fig 2]",
      JSON.stringify(sc2),
    );
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "S2 ledger: published with media_attached 2, verified",
      !!pub &&
        pub.external_id === "urn:li:share:777001" &&
        pub.media_attached === 2 &&
        pub.verified === true &&
        pub.media_failed === undefined,
      JSON.stringify(pub),
    );
    check(
      "S2 status file headlines ok",
      JSON.parse(read(fakeFs, `${STATE}/linkedin_status.json`)).status === "ok",
    );
    check("S2 file lands in done/", at(fakeFs, "done").includes("d1.json"));
  }

  // S3: partial upload failure -> publish with what attached (VK
  // semantics): media[1] registerUpload rejected 400, media[2]
  // unresolvable; the post still lands with the surviving asset and
  // every drop is named.
  {
    const { calls, ledger } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "article with a dropped fig [See Fig 2]",
        media: [
          "materials/photos/fig1.png",
          "materials/photos/fig2.png",
          "materials/photos/missing.png",
        ],
      },
      media: MEDIA,
      regFail: (n) => (n === 2 ? httpErr(400) : null),
    });
    const ugc = calls.find((c) => c.url.endsWith("/v2/ugcPosts") && c.method === "POST");
    const sc3 = ugc.body.specificContent["com.linkedin.ugc.ShareContent"];
    check(
      "S3 partial: post publishes with the surviving asset only",
      sc3.shareMediaCategory === "IMAGE" &&
        sc3.media.length === 1 &&
        sc3.media[0].media === "urn:li:digitalmediaAsset:TST1",
      JSON.stringify(sc3.media),
    );
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "S3 partial: ledger names both dropped files",
      !!pub &&
        pub.media_attached === 1 &&
        Array.isArray(pub.media_failed) &&
        pub.media_failed.length === 2 &&
        pub.media_failed.some((m) => m.startsWith("materials/photos/fig2.png (")) &&
        pub.media_failed.some((m) => m.includes("missing.png")),
      JSON.stringify(pub),
    );
  }

  // S4: MEDIA_MAX cap - 5 files, only 4 registerUpload calls, the 5th
  // is reported dropped without ever reaching the API.
  {
    const { calls, ledger } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "five figures",
        media: [
          "materials/photos/fig1.png",
          "materials/photos/fig2.png",
          "materials/photos/fig3.png",
          "materials/photos/fig4.png",
          "materials/photos/fig5.png",
        ],
      },
      media: MEDIA,
    });
    const regs = calls.filter((c) => c.url.includes("registerUpload"));
    const ugc = calls.find((c) => c.url.endsWith("/v2/ugcPosts") && c.method === "POST");
    const sc4 = ugc.body.specificContent["com.linkedin.ugc.ShareContent"];
    check(
      "S4 cap: 4 registerUpload calls, 4 attached, 5th dropped",
      regs.length === 4 &&
        sc4.media.length === 4 &&
        ledger.some(
          (r) =>
            r &&
            r.status === "published" &&
            r.media_attached === 4 &&
            Array.isArray(r.media_failed) &&
            r.media_failed.some((m) => m.includes("fig5.png") && m.includes("cap")),
        ),
      JSON.stringify({ regs: regs.length, media: sc4.media.length }),
    );
  }

  // S5: transient PUT failure (transport, no HTTP status) -> the
  // whole file requeues before ugcPosts, retries counter persisted.
  {
    const { calls, fakeFs, results } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "transient upload failure",
        media: ["materials/photos/fig1.png"],
      },
      media: MEDIA,
      putFail: () => new Error("socket hangup"),
    });
    check(
      "S5 transient: ugcPosts never called, file requeued to root",
      !calls.some((c) => c.url.endsWith("/v2/ugcPosts")) &&
        at(fakeFs, ".").includes("d1.json") &&
        !at(fakeFs, "done").includes("d1.json") &&
        !at(fakeFs, "failed").includes("d1.json"),
      JSON.stringify({
        root: at(fakeFs, "."),
        done: at(fakeFs, "done"),
        failed: at(fakeFs, "failed"),
      }),
    );
    const requeued = JSON.parse(read(fakeFs, `${Q}/d1.json`) || "{}");
    check(
      "S5 transient: retries counter persisted on the claim inode",
      requeued.retries === 1,
      JSON.stringify(requeued),
    );
    check(
      "S5 transient: tick reports a RETRY line",
      results.some((r) => r.includes("RETRY 1/5")),
      JSON.stringify(results),
    );
  }

  // S6: media-only post (empty text) still publishes with IMAGE
  // category - the nothing-to-publish gate only fires when BOTH are
  // absent.
  {
    const { calls } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "",
        media: ["materials/photos/fig1.png"],
      },
      media: MEDIA,
    });
    const ugc = calls.find((c) => c.url.endsWith("/v2/ugcPosts") && c.method === "POST");
    const sc6 = ugc.body.specificContent["com.linkedin.ugc.ShareContent"];
    check(
      "S6 media-only: publishes IMAGE with empty commentary",
      sc6.shareMediaCategory === "IMAGE" &&
        sc6.media.length === 1 &&
        sc6.shareCommentary.text === "",
      JSON.stringify(sc6),
    );
  }

  // S7: every upload failed + no text -> terminal failure, no
  // ugcPosts, file to failed/.
  {
    const { calls, fakeFs } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "",
        media: ["materials/photos/fig1.png"],
      },
      media: MEDIA,
      regFail: () => httpErr(400),
    });
    check(
      "S7 all-failed+no-text: file to failed/, no ugcPosts",
      at(fakeFs, "failed").includes("d1.json") &&
        !calls.some((c) => c.url.endsWith("/v2/ugcPosts")),
      JSON.stringify({ failed: at(fakeFs, "failed") }),
    );
  }

  // S8: dry_run - zero LinkedIn calls, media resolved for the report.
  {
    const { calls, ledger, fakeFs } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "dry run body",
        dry_run: true,
        media: ["materials/photos/fig1.png", "materials/photos/nope.png"],
      },
      media: MEDIA,
    });
    check("S8 dry-run: zero httpRequest calls", calls.length === 0, String(calls.length));
    const dr = ledger.find((r) => r && r.status === "dry-run");
    check(
      "S8 dry-run: ledger records media_resolved/media_failed",
      !!dr && dr.media_resolved === 1 && dr.media_failed === 1,
      JSON.stringify(dr),
    );
    check("S8 dry-run: file lands in done/", at(fakeFs, "done").includes("d1.json"));
  }

  // S9: a malformed registerUpload answer (asset urn but no
  // uploadMechanism/uploadUrl) is a LOCAL classification error, not
  // transport loss (issue #58): per-file terminal, the file does NOT
  // requeue, and the post publishes text-only with the drop named.
  {
    const { calls, fakeFs, ledger } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "body surviving a malformed register answer",
        media: ["materials/photos/fig1.png"],
      },
      media: MEDIA,
      regAnswer: (n) => ({ value: { asset: `urn:li:digitalmediaAsset:TST${n}` } }),
    });
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "S9 malformed answer: per-file terminal, post still publishes",
      !!pub &&
        pub.media_attached === 0 &&
        Array.isArray(pub.media_failed) &&
        pub.media_failed.some((m) => m.includes("malformed registerUpload")) &&
        at(fakeFs, "done").includes("d1.json") &&
        !at(fakeFs, ".").includes("d1.json") &&
        calls.some((c) => c.url.endsWith("/v2/ugcPosts") && c.method === "POST"),
      JSON.stringify(pub),
    );
  }

  // S10: an asset that never reports READY is a per-file terminal
  // drop, not a requeue (issue #58): 5 polls of a definite
  // PROCESSING status exhaust the budget and the drop is named.
  {
    const { calls, ledger, results } = await runTick({
      env: { PUBLISH_SIMULATE: "0", LI_ASSET_POLL_MS: "100" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "body surviving a stuck asset",
        media: ["materials/photos/fig1.png"],
      },
      media: MEDIA,
      assetGet: () => ({ status: "PROCESSING" }),
    });
    const assetPolls = calls.filter((c) => c.method === "GET" && c.url.includes("/v2/assets/urn"));
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "S10 stuck asset: 5 polls then per-file terminal, post publishes",
      assetPolls.length === 5 &&
        !!pub &&
        pub.media_attached === 0 &&
        Array.isArray(pub.media_failed) &&
        pub.media_failed.some((m) => m.includes("never reported READY")) &&
        calls.some((c) => c.url.endsWith("/v2/ugcPosts") && c.method === "POST"),
      JSON.stringify({ polls: assetPolls.length, pub }),
    );
    check(
      "S10 stuck asset: no requeue - claim consumed, not re-queued",
      !results.some((r) => r.includes("RETRY")),
      JSON.stringify(results),
    );
  }

  // S11: a status-less asset GET answer is inconclusive - two in a
  // row stop the poll and the file proceeds to attach (issue #58's
  // tolerance arm for id-only asset reads).
  {
    const { calls, ledger } = await runTick({
      env: { PUBLISH_SIMULATE: "0", LI_ASSET_POLL_MS: "100" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "id-only asset shape",
        media: ["materials/photos/fig1.png"],
      },
      media: MEDIA,
      assetGet: () => ({ id: "urn:li:digitalmediaAsset:TST1" }),
    });
    const assetPolls = calls.filter((c) => c.method === "GET" && c.url.includes("/v2/assets/urn"));
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "S11 status-less asset: proceeds after 2 inconclusive polls",
      assetPolls.length === 2 &&
        !!pub &&
        pub.media_attached === 1 &&
        pub.media_failed === undefined,
      JSON.stringify({ polls: assetPolls.length, pub }),
    );
  }

  // S12: token scrub - a failed registerUpload whose error text echoes
  // the bearer token is recorded with the token masked. n8n's
  // httpRequest errors can carry the request config (Authorization
  // header included) into the message, so the KNOWN_TOKENS mask in
  // scrub() is the only thing keeping the secret out of the ledger.
  {
    const { ledger, results } = await runTick({
      env: { PUBLISH_SIMULATE: "0" },
      payload: {
        id: "d1",
        platform: "linkedin",
        post_id: "p1",
        text: "scrub check [See Fig 2]",
        media: ["materials/photos/fig1.png", "materials/photos/fig2.png"],
      },
      media: MEDIA,
      regFail: (n) =>
        n === 2
          ? Object.assign(
              new Error(`400 rejected, echoed Bearer ${BASE_ENV.LINKEDIN_ACCESS_TOKEN}`),
              { statusCode: 400 },
            )
          : null,
    });
    const pub = ledger.find((r) => r && r.status === "published");
    check(
      "S12 scrub: dropped file recorded with token masked",
      !!pub &&
        Array.isArray(pub.media_failed) &&
        pub.media_failed.some((m) => m.includes("fig2.png") && m.includes("***")),
      JSON.stringify(pub && pub.media_failed),
    );
    check(
      "S12 scrub: raw bearer token leaks nowhere observable",
      !JSON.stringify(ledger).includes(BASE_ENV.LINKEDIN_ACCESS_TOKEN) &&
        !JSON.stringify(results).includes(BASE_ENV.LINKEDIN_ACCESS_TOKEN),
      JSON.stringify(pub && pub.media_failed),
    );
  }

  console.log(fails ? `li-media: ${fails} check(s) failed` : "li-media: all checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error(`FAIL harness crashed: ${e?.stack || e}`);
  process.exit(1);
});
