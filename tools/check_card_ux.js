#!/usr/bin/env node
// check_card_ux.js - harness for the issue #60 moderation card UX
// pack. Runs the REAL 'Prepare Draft', 'Fan Out Album' and 'Compose
// Message' jsCode from n8n/workflows/sp-tg-moderation.json inside a
// stubbed n8n Code-node sandbox and asserts on the emitted items /
// TG calls. The media subgraph itself is replayed with the REAL
// wiring (runGraph below): only the three Telegram HTTP nodes are
// faked, so a stream shape the graph cannot produce can never go
// green here again.
//
//   Wiring (the real connections, not assumed ones):
//   W1  TG MediaGroup runs onError=continueRegularOutput and its
//       single output feeds BOTH Merge Media input 1 AND Fan Out
//       Album;
//   W2  the fallback chain Fan Out Album -> TG SendPhoto FB -> Merge
//       Media input 2;
//   W3  the Merge Media append partition itself: sendPhoto results
//       in0, album results in1, fallback photos in2, markers in3,
//       merge -> Compose Message;
//   W4  Is Photo / Is Album routing: photo -> TG SendPhoto, album ->
//       TG MediaGroup, non-media -> Merge in3;
//
//   Fan Out Album side (the bare-{error} pairing contract):
//   F1  a bare {error} result pairs back via pairedItem to the
//       pre-send album item in Is Album's true output -> per-photo
//       items REUSING the vetted f0..f{n} binaries;
//   F2  an n8n build that merges the input json back ({kind:'album',
//       paths, error}) works without pairedItem - re-read fallback;
//   F3  an unpairable bare {error} still emits ONE binary-less
//       marker item - the failure stays observable, never silent;
//   F4  success results emit nothing on this branch;
//
//   Prepare Draft side:
//   P1  0 media -> no media item, marker media_mode 'none';
//   P2  exactly 1 media -> one 'photo' item (binary.file), marker
//       media_mode 'photo';
//   P3  2-10 media -> ONE 'album' item carrying binary f0..f{N-1} and
//       the resolved paths list, marker media_mode 'album';
//   P4  >10 media -> album capped at 10 binaries + paths, and the
//       saved draft file carries the
//       '[WARN] media truncated to 10 (requested N)' warning;
//   P5  the TG MediaGroup node's bodyParameters expression builds a
//       single sendMediaGroup request: 'media' JSON of captionless
//       InputMediaPhoto attach:// entries plus one formBinaryData
//       slot per file - the dynamic-count trick the static keypair
//       UI cannot express;
//
//   Compose Message side (merged-stream pools):
//   C1  album result -> card sendMessage replies to
//       result[0].message_id, parse_mode 'HTML', media_sent counts
//       the result entries;
//   C2  single-photo result -> reply under the photo's message_id;
//   C3  0 media -> card with no reply_to_message_id;
//   C4  sendMediaGroup error through the REAL chain -> the {error}
//       item occupies the album slot, the fallback sendPhoto results
//       are consumed, the card anchors on the first delivered
//       fallback photo, 'mediaGroup-fallback' lands in
//       moderation.jsonl; plus an unpairable-error variant (the
//       failure must stay observable) and a mixed-outcome
//       multi-album batch (every draft's media path stays exactly
//       attributable);
//   C5  a failed reply_to card send retries WITHOUT the anchor and
//       logs 'preview-reply-stale-anchor';
//   C6  mode banner + Approve label: PUBLISH_PLATFORMS-enabled and
//       non-simulated -> '=== [LIVE PUBLISH] ===' + 'Approve (LIVE)';
//       PUBLISH_SIMULATE=1 or a disabled platform ->
//       '--- [SIMULATED PUBLISH] ---' + 'Approve (SIM)';
//   C7  the metadata footer is a single <blockquote expandable> at
//       the END of the card text (after the post text, immediately
//       above the buttons) and every dynamic line inside is
//       entity-escaped;
//   C8  structural checksum: a 6-block article with matching fig
//       pointers lands 'Structure: 6/6 blocks | Figs referenced:
//       [1,2] (attached: 2)' and no warning; a ragged draft lands the
//       line AND a '[WARN] structure mismatch' [WARNINGS] entry;
//   C9  HTML escaping: '<'/'&' in the post text is escaped, the
//       blockquote tags themselves stay literal.
//
// Sandbox contract: the Code nodes see require('fs'), $input.all(),
// $env.NAME, $('Node').all(branch) and this.helpers.httpRequest -
// all stubbed here. fs is a small in-memory filesystem (the jsCode
// paths are hardcoded to /home/node/...), seeded with the draft
// file plus media files under /home/node/materials. httpRequest is
// routed by URL to Telegram / telegra.ph fakes; any unlisted URL
// throws.
//
// Run:  node tools/check_card_ux.js    (exit 0 = all pass)

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
const prepFactory = factoryOf("Prepare Draft");
const compFactory = factoryOf("Compose Message");
const fanoutFactory = factoryOf("Fan Out Album");

// ------------------------------------------------------------------
// in-memory fs: mkdirSync, existsSync, readdirSync, readFileSync,
// writeFileSync, appendFileSync, statSync, realpathSync, renameSync -
// the union both nodes touch.
const norm = (p) => path.posix.normalize(String(p));
const mkFs = () => {
  const nodes = new Map(); // path -> {dir, content(Buffer)}
  const err = (code) => Object.assign(new Error(code), { code });
  const fileNode = (content) => ({
    dir: false,
    content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content ?? "")),
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
    readFileSync(p, enc) {
      p = norm(p);
      const n = nodes.get(p);
      if (!n || n.dir) throw err("ENOENT");
      return enc ? n.content.toString(enc) : Buffer.from(n.content);
    },
    writeFileSync(p, data) {
      p = norm(p);
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      nodes.set(p, fileNode(data));
    },
    appendFileSync(p, data) {
      p = norm(p);
      if (!nodes.has(norm(path.posix.dirname(p)))) throw err("ENOENT");
      const n = nodes.get(p) || fileNode("");
      n.content = Buffer.concat([n.content, Buffer.from(String(data))]);
      nodes.set(p, n);
    },
    statSync(p) {
      const n = nodes.get(norm(p));
      if (!n) throw err("ENOENT");
      return { size: n.dir ? 0 : n.content.length };
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
    unlinkSync(p) {
      p = norm(p);
      const n = nodes.get(p);
      if (!n) throw err("ENOENT");
      nodes.delete(p);
    },
  };
  return api;
};

const DRAFTS = "/home/node/.n8n/state/drafts";
const LOG = "/home/node/.n8n/logs";
const MATERIALS = "/home/node/materials";

const readJson = (fakeFs, p) => {
  try {
    return JSON.parse(fakeFs.readFileSync(p, "utf8"));
  } catch (_e) {
    return null;
  }
};
const logLines = (fakeFs) =>
  (() => {
    try {
      return fakeFs
        .readFileSync(`${LOG}/moderation.jsonl`, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (_e) {
      return [];
    }
  })();

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "tg-token-for-harness",
  TELEGRAM_CHAT_ID: "4242",
  DRAFT_WEBHOOK_SECRET: "draft-secret-for-harness",
  PUBLISH_PLATFORMS: "vk",
};

// --- generic Code-node runner -------------------------------------
// invokes one node's real jsCode in the sandbox: require('fs') is the
// in-memory fs, $input.all() yields `items`, $env reads `env` and $
// is the $('Node').all(branch) stub Fan Out Album uses for pairing.
const execNode = async (factory, sc) => {
  const fakeFs = sc.fakeFs || mkFs();
  const env = { ...BASE_ENV, ...(sc.env || {}) };
  const items = sc.items || [];
  const dollar = sc.dollar;
  const fn = factory((m) => (m === "fs" ? fakeFs : require(m)), { all: () => items }, env, dollar);
  const out = await fn.call({ helpers: sc.helpers || {} });
  return { out, fakeFs, env };
};

const seedMedia = (fakeFs, mediaFiles) => {
  fakeFs.mkdirSync(MATERIALS, { recursive: true });
  for (const [mp, bytes] of Object.entries(mediaFiles || {})) {
    fakeFs.mkdirSync(path.posix.dirname(mp), { recursive: true });
    fakeFs.writeFileSync(mp, bytes);
  }
};

// --- Prepare Draft runner -----------------------------------------
const runPrepare = async (bodies, mediaFiles, fakeFs) => {
  const ffs = fakeFs || mkFs();
  seedMedia(ffs, mediaFiles);
  ffs.mkdirSync(DRAFTS, { recursive: true });
  const list = Array.isArray(bodies) ? bodies : [bodies];
  const items = list.map((body) => ({
    json: {
      headers: { "x-shared-token": BASE_ENV.DRAFT_WEBHOOK_SECRET },
      body,
    },
  }));
  const { out } = await execNode(prepFactory, { fakeFs: ffs, items });
  return { items: out.map((i) => i), fakeFs: ffs };
};

// --- Compose Message runner ---------------------------------------
// media results arrive exactly the way Merge Media concatenates them:
// single-photo results, then album results (one per album, success or
// {error}), then fallback results, then the msg markers.
const runCompose = async (sc) => {
  const fakeFs = sc.fakeFs || mkFs();
  fakeFs.mkdirSync(DRAFTS, { recursive: true });
  fakeFs.mkdirSync(LOG, { recursive: true });
  const base = {
    id: "d1",
    platform: "vk",
    topic: "t",
    text: "post text body",
    image: "",
    media: [],
    caption_note: "",
    scope: "",
    post_id: "",
    test: false,
    warnings: [],
    status: "delivering",
    created_at: new Date().toISOString(),
  };
  const drafts = sc.drafts || (sc.draft ? [{ ...base, ...sc.draft }] : []);
  for (const d of drafts) {
    fakeFs.writeFileSync(`${DRAFTS}/${d.id}.json`, JSON.stringify(d));
  }
  const calls = [];
  const helpers = {
    httpRequest: async (opts) => {
      calls.push(opts);
      const url = String(opts.url);
      if (url.endsWith("/sendMessage")) {
        if (sc.staleAnchor && opts.body.reply_to_message_id !== undefined) {
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: replied message not found",
          };
        }
        return { ok: true, result: { message_id: 9000 + calls.length } };
      }
      if (url.endsWith("/editMessageReplyMarkup") || url.endsWith("/editMessageText")) {
        return { ok: true, result: true };
      }
      if (url.startsWith("https://api.telegra.ph/")) {
        if (url.endsWith("/createAccount"))
          return { ok: true, result: { access_token: "tgph-tok" } };
        if (url.endsWith("/createPage"))
          return { ok: true, result: { url: "https://telegra.ph/test-01" } };
        return { ok: true, result: {} };
      }
      throw new Error(`unexpected httpRequest: ${opts.method} ${url}`);
    },
  };
  const env = { ...BASE_ENV, ...(sc.env || {}) };
  // rawItems = full item objects ({json, pairedItem, ...}); items =
  // plain json payloads wrapped here
  const items = sc.rawItems || (sc.items || []).map((j) => ({ json: j }));
  const { out } = await execNode(compFactory, { fakeFs, items, env, helpers });
  const sends = calls.filter((c) => String(c.url).endsWith("/sendMessage")).map((c) => c.body);
  return {
    out: out.map((i) => i.json),
    sends,
    calls,
    fakeFs,
    logs: logLines(fakeFs),
    draftFile: readJson(fakeFs, `${DRAFTS}/d1.json`),
    draftFileOf: (id) => readJson(fakeFs, `${DRAFTS}/${id}.json`),
    sendOf: (id) => sends.find((s) => String(s.text).includes(`[DRAFT ${id}`)),
  };
};

// --- Telegram HTTP-node sims --------------------------------------
// the ONLY faked nodes in the media subgraph. Each answers a
// per-item result the way the node does under its onError setting:
// continueRegularOutput (TG SendPhoto / TG SendPhoto FB / TG
// MediaGroup) puts {error} items on the SAME regular output, in
// input order, one item per input item.
const simSendPhoto = (item, sc, sent) => {
  const j = item.json || {};
  const fail = sc.photoFail?.(item) || !item.binary?.file?.data;
  const rec = {
    draft_id: j.draft_id,
    album_fallback: j.album_fallback === true,
    ok: !fail,
  };
  sent.push(rec);
  if (fail) {
    return { json: { error: "Request failed with status code 400" } };
  }
  rec.mid = sc.nextMid();
  return { json: { ok: true, result: { message_id: rec.mid } } };
};

// TG MediaGroup under continueRegularOutput: one output-0 item per
// input item - a sendMediaGroup body or a bare {error}, each with
// pairedItem pointing at its input index. mergeErrorJson models an
// n8n build that merges the input json into the error item (the
// repackaged shape the pre-fix code ASSUMED); dropPairedItem models
// the pairing metadata being unavailable - the two failure shapes
// the [UNCERTAIN] review finding worried about.
const simMediaGroup = (item, idx, sc, sent) => {
  const j = item.json || {};
  const paired = sc.dropPairedItem ? {} : { pairedItem: { item: idx } };
  if (sc.albumFail?.(item, idx)) {
    sent.push({ draft_id: j.draft_id, album: true, ok: false });
    const errJson = sc.mergeErrorJson
      ? { ...j, error: "Request failed with status code 400" }
      : { error: "Request failed with status code 400" };
    return { json: errJson, ...paired };
  }
  const n = (j.paths || []).length;
  const mids = Array.from({ length: n }, () => sc.nextMid());
  sent.push({ draft_id: j.draft_id, album: true, ok: true, mids });
  return {
    json: { ok: true, result: mids.map((m) => ({ message_id: m })) },
    ...paired,
  };
};

// --- Fan Out Album runner (unit level) -----------------------------
// items = TG MediaGroup output items; albumItems = Is Album's true
// output (TG MediaGroup's input list) - the pairing table the real
// code reaches through $('Is Album').all(0)
const runFanOut = async (sc) => {
  const fakeFs = sc.fakeFs || mkFs();
  seedMedia(fakeFs, sc.mediaFiles);
  const albumItems = sc.albumItems || [];
  const dollar = (name) => ({
    all: (branch) =>
      name === "Is Album" && (branch === 0 || branch === undefined) ? albumItems : [],
  });
  const { out } = await execNode(fanoutFactory, {
    fakeFs,
    items: sc.items || [],
    dollar,
  });
  return { out, fakeFs };
};

// --- the REAL media subgraph, replayed -----------------------------
// Prepare Draft -> Is Photo / Is Album (kind routing) -> TG SendPhoto
// / TG MediaGroup (faked) -> Fan Out Album (REAL code) -> TG
// SendPhoto FB (faked) -> Merge Media append (in0 photos, in1 album
// results, in2 fallback photos, in3 markers) -> Compose Message
// (REAL code). Only the three TG HTTP nodes are simulated - the
// merged stream Compose sees is exactly what the wiring produces.
const runGraph = async (sc) => {
  const fakeFs = mkFs();
  const { items: prepOut } = await runPrepare(sc.bodies, sc.mediaFiles, fakeFs);
  fakeFs.mkdirSync(LOG, { recursive: true });
  let mid = 6000;
  const nextMid = () => ++mid;
  const sent = [];
  const in0 = [];
  const in1 = [];
  const in2 = [];
  const in3 = [];
  const albumItems = []; // Is Album true output == TG MediaGroup input
  const mgc = { ...sc, nextMid };
  for (const it of prepOut) {
    const k = it.json?.kind;
    if (k === "photo") {
      in0.push(simSendPhoto(it, mgc, sent));
    } else if (k === "album") {
      albumItems.push(it);
    } else {
      in3.push(it); // the msg markers pass Is Album's false output
    }
  }
  // continueRegularOutput: every input item leaves exactly one
  // output-0 item - a sendMediaGroup result OR a bare {error} - and
  // the SAME array feeds Merge input 1 AND Fan Out Album
  const mgOut = albumItems.map((it, i) => simMediaGroup(it, i, mgc, sent));
  in1.push(...mgOut);
  const { out: fanOut } = await runFanOut({
    fakeFs,
    items: mgOut,
    albumItems,
  });
  for (const it of fanOut) in2.push(simSendPhoto(it, mgc, sent));
  const merged = [...in0, ...in1, ...in2, ...in3];
  const r = await runCompose({
    fakeFs,
    rawItems: merged,
    staleAnchor: sc.staleAnchor,
    env: sc.env,
  });
  return { ...r, merged, sent, fanOut };
};

const msg = (draftId, mode, okPaths, failed = []) => ({
  kind: "msg",
  draft_id: draftId,
  chat_id: "4242",
  media_mode: mode,
  media_ok: okPaths,
  media_failed: failed,
});
const photoOk = (mid) => ({ ok: true, result: { message_id: mid } });
const albumOk = (mids) => ({ ok: true, result: mids.map((m) => ({ message_id: m })) });

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
const mediaFiles = (n) => {
  const m = {};
  for (let i = 1; i <= n; i++) m[`${MATERIALS}/photos/f${i}.png`] = png(`f${i}`);
  return m;
};
const mediaList = (n) => Array.from({ length: n }, (_, i) => `materials/photos/f${i + 1}.png`);

const main = async () => {
  // ---------------- Wiring (the real graph shape) ---------------
  const conns = spec.connections;
  const hasConn = (from, outIdx, to, inIdx) =>
    (conns[from]?.main?.[outIdx] || []).some((c) => c.node === to && c.index === inIdx);
  check(
    "W1 TG MediaGroup: continueRegularOutput, one output -> Merge in1 + Fan Out Album",
    nodeOf("TG MediaGroup").onError === "continueRegularOutput" &&
      (conns["TG MediaGroup"]?.main || []).length === 1 &&
      hasConn("TG MediaGroup", 0, "Merge Media", 1) &&
      hasConn("TG MediaGroup", 0, "Fan Out Album", 0),
    JSON.stringify({
      onError: nodeOf("TG MediaGroup").onError,
      main: conns["TG MediaGroup"]?.main,
    }),
  );
  check(
    "W2 fallback chain: Fan Out Album -> TG SendPhoto FB -> Merge in2",
    hasConn("Fan Out Album", 0, "TG SendPhoto FB", 0) &&
      hasConn("TG SendPhoto FB", 0, "Merge Media", 2) &&
      nodeOf("TG SendPhoto FB").onError === "continueRegularOutput",
    JSON.stringify(conns["Fan Out Album"]),
  );
  check(
    "W3 merge partition: photo->in0, markers->in3, append x4 -> Compose Message",
    hasConn("TG SendPhoto", 0, "Merge Media", 0) &&
      hasConn("Is Album", 1, "Merge Media", 3) &&
      nodeOf("Merge Media").parameters.mode === "append" &&
      nodeOf("Merge Media").parameters.numberInputs === 4 &&
      hasConn("Merge Media", 0, "Compose Message", 0),
    JSON.stringify(conns["Merge Media"]),
  );
  check(
    "W4 routing: Is Photo true->SendPhoto, false->Is Album; Is Album true->MediaGroup",
    hasConn("Is Photo", 0, "TG SendPhoto", 0) &&
      hasConn("Is Photo", 1, "Is Album", 0) &&
      hasConn("Is Album", 0, "TG MediaGroup", 0),
    JSON.stringify(conns["Is Photo"]),
  );

  // ---------------- Fan Out Album (pairing contract) --------------
  {
    // F1: a bare {error} + pairedItem -> per-photo items reusing the
    // paired album item's vetted binaries (no disk re-read needed)
    const albumItem = {
      json: {
        kind: "album",
        draft_id: "d9",
        chat_id: "4242",
        paths: [`${MATERIALS}/photos/f1.png`, `${MATERIALS}/photos/f2.png`],
      },
      binary: {
        f0: { data: png("f1").toString("base64"), mimeType: "image/png", fileName: "f1.png" },
        f1: { data: png("f2").toString("base64"), mimeType: "image/png", fileName: "f2.png" },
      },
    };
    const { out } = await runFanOut({
      items: [{ json: { error: "Request failed with status code 400" }, pairedItem: { item: 0 } }],
      albumItems: [albumItem],
      mediaFiles: {}, // deliberately empty: binaries must come from the paired item
    });
    check(
      "F1 bare {error}: paired back to album spec, binaries reused",
      out.length === 2 &&
        out.every(
          (o, i) =>
            o.json.kind === "photo" &&
            o.json.draft_id === "d9" &&
            o.json.chat_id === "4242" &&
            o.json.album_fallback === true &&
            o.binary?.file?.data === png(`f${i + 1}`).toString("base64") &&
            o.binary.file.fileName === `f${i + 1}.png`,
        ),
      JSON.stringify(out),
    );
  }
  {
    // F2: an n8n build that merges the input json back - j.paths
    // present, no pairedItem needed; binaries absent so the disk
    // re-read fallback fills them
    const paths = [`${MATERIALS}/photos/f1.png`, `${MATERIALS}/photos/f2.png`];
    const { out } = await runFanOut({
      items: [
        {
          json: {
            kind: "album",
            draft_id: "d9",
            chat_id: "4242",
            paths,
            error: "Request failed with status code 400",
          },
        },
      ],
      albumItems: [],
      mediaFiles: mediaFiles(2),
    });
    check(
      "F2 merged-json {kind:'album',paths,error}: re-read fallback emits binaries",
      out.length === 2 &&
        out.every(
          (o, i) =>
            o.json.draft_id === "d9" &&
            o.binary?.file?.data === png(`f${i + 1}`).toString("base64"),
        ),
      JSON.stringify(out),
    );
  }
  {
    // F3: unpairable bare {error} - ONE binary-less marker item, not
    // a silent zero-item emit
    const { out } = await runFanOut({
      items: [{ json: { error: "Request failed with status code 400" } }],
      albumItems: [],
    });
    check(
      "F3 unpairable {error}: one observable marker item, no binary",
      out.length === 1 &&
        out[0].json.album_fallback === true &&
        out[0].json.album_spec_lost === true &&
        !out[0].binary,
      JSON.stringify(out),
    );
  }
  {
    // F4: a success result emits nothing on the fallback branch
    const { out } = await runFanOut({
      items: [
        {
          json: { ok: true, result: [{ message_id: 1 }, { message_id: 2 }] },
          pairedItem: { item: 0 },
        },
      ],
      albumItems: [{ json: { kind: "album", draft_id: "d9", chat_id: "4242", paths: ["x", "y"] } }],
    });
    check("F4 success result: zero fallback items", out.length === 0, JSON.stringify(out));
  }

  // ---------------- Prepare Draft -------------------------------
  {
    const { items } = await runPrepare(
      { draft_id: "d0", platform: "vk", text: "no media", media: [] },
      {},
    );
    const kinds = items.map((i) => i.json.kind);
    check("P1 0 media: only the msg marker", kinds.join(",") === "msg", JSON.stringify(kinds));
    const mk = items.find((i) => i.json.kind === "msg").json;
    check(
      "P1 0 media: media_mode none + empty media_ok",
      mk.media_mode === "none" && mk.media_ok.length === 0,
      JSON.stringify(mk),
    );
  }
  {
    const { items } = await runPrepare(
      { draft_id: "d1", platform: "vk", text: "one", media: mediaList(1) },
      mediaFiles(1),
    );
    const kinds = items.map((i) => i.json.kind);
    const ph = items.find((i) => i.json.kind === "photo");
    const mk = items.find((i) => i.json.kind === "msg").json;
    check(
      "P2 1 media: photo item + marker",
      kinds.join(",") === "photo,msg" &&
        mk.media_mode === "photo" &&
        mk.media_ok.length === 1 &&
        !!ph.binary?.file?.data,
      JSON.stringify(kinds),
    );
  }
  {
    const { items } = await runPrepare(
      { draft_id: "d3", platform: "vk", text: "three", media: mediaList(3) },
      mediaFiles(3),
    );
    const al = items.find((i) => i.json.kind === "album");
    const mk = items.find((i) => i.json.kind === "msg").json;
    check(
      "P3 3 media: ONE album item with f0..f2 binaries + paths",
      !!al &&
        Object.keys(al.binary || {})
          .sort()
          .join(",") === "f0,f1,f2" &&
        (al.json.paths || []).length === 3 &&
        items.filter((i) => i.json.kind !== "msg").length === 1 &&
        mk.media_mode === "album" &&
        mk.media_ok.length === 3,
      JSON.stringify(items.map((i) => i.json.kind)),
    );
    check(
      "P3 album binaries carry base64 + mime + filename",
      !!al &&
        al.binary.f0.data === png("f1").toString("base64") &&
        al.binary.f0.mimeType === "image/png" &&
        al.binary.f0.fileName === "f1.png",
      JSON.stringify(al?.binary?.f0),
    );
  }
  {
    const { items, fakeFs } = await runPrepare(
      { draft_id: "d12", platform: "vk", text: "twelve", media: mediaList(12) },
      mediaFiles(12),
    );
    const al = items.find((i) => i.json.kind === "album");
    const mk = items.find((i) => i.json.kind === "msg").json;
    const saved = readJson(fakeFs, `${DRAFTS}/d12.json`);
    check(
      "P4 >10 media: album capped at 10 binaries + paths",
      !!al &&
        Object.keys(al.binary || {}).length === 10 &&
        (al.json.paths || []).length === 10 &&
        mk.media_ok.length === 10 &&
        mk.media_mode === "album",
      JSON.stringify(al && Object.keys(al.binary || {})),
    );
    check(
      "P4 >10 media: [WARN] media truncated to 10 (requested 12) in draft warnings",
      !!saved &&
        Array.isArray(saved.warnings) &&
        saved.warnings.includes("[WARN] media truncated to 10 (requested 12)"),
      JSON.stringify(saved?.warnings),
    );
  }
  {
    // the mediaGroup request body: evaluate the node's bodyParameters
    // expression against an album item, with $json bound like n8n does
    const rawExpr = nodeOf("TG MediaGroup").parameters.bodyParameters.parameters;
    check(
      "P5 bodyParameters is an expression",
      typeof rawExpr === "string" && rawExpr.startsWith("={{"),
      String(rawExpr).slice(0, 60),
    );
    const expr = rawExpr.replace(/^=\{\{/, "").replace(/\}\}$/, "");
    const $json = { chat_id: "4242", paths: ["a.png", "b.png", "c.png"], kind: "album" };
    const params = new Function("$json", `return (${expr});`)($json);
    const mediaParam = params.find((p) => p.name === "media");
    const media = mediaParam && JSON.parse(mediaParam.value);
    const bins = params.filter((p) => p.parameterType === "formBinaryData");
    check(
      "P5 mediaGroup body: captionless InputMediaPhoto attach:// array",
      !!media &&
        media.length === 3 &&
        media.every((m) => m.type === "photo" && m.caption === undefined) &&
        media.every((m, i) => m.media === `attach://f${i}`) &&
        bins.length === 3 &&
        bins.every((b, i) => b.name === `f${i}` && b.inputDataFieldName === `f${i}`) &&
        params.find((p) => p.name === "disable_notification")?.value === "true" &&
        params.find((p) => p.name === "chat_id")?.value === "4242",
      JSON.stringify(params),
    );
  }

  // ---------------- Compose Message -----------------------------
  {
    // C1 album path: one album result + album marker
    const r = await runCompose({
      draft: { id: "d1", media: mediaList(3) },
      items: [
        albumOk([501, 502, 503]),
        msg(
          "d1",
          "album",
          mediaList(3).map((p) => `${MATERIALS}/${p.split("/").pop()}`),
        ),
      ],
    });
    const send = r.sends[0];
    check(
      "C1 album: card replies to result[0].message_id",
      !!send && send.reply_to_message_id === 501 && send.parse_mode === "HTML",
      JSON.stringify(send && { rt: send.reply_to_message_id, pm: send.parse_mode }),
    );
    check(
      "C1 album: media_sent 3 + anchor persisted on draft file",
      !!r.draftFile &&
        r.draftFile.media_sent === 3 &&
        r.draftFile.media_message_id === 501 &&
        r.draftFile.status === "pending",
      JSON.stringify(
        r.draftFile && { ms: r.draftFile.media_sent, mm: r.draftFile.media_message_id },
      ),
    );
    check(
      "C1 album: result carries media_delivery sendMediaGroup",
      r.out[0] && r.out[0].media_delivery === "sendMediaGroup" && r.out[0].ok === true,
      JSON.stringify(r.out[0]),
    );
  }
  {
    // C2 single photo
    const r = await runCompose({
      draft: { id: "d1", media: mediaList(1) },
      items: [photoOk(601), msg("d1", "photo", ["f1.png"])],
    });
    check(
      "C2 single photo: card replies to photo message_id",
      r.sends[0] && r.sends[0].reply_to_message_id === 601,
      JSON.stringify(r.sends[0]?.reply_to_message_id),
    );
    check(
      "C2 single photo: media_sent 1, delivery sendPhoto",
      r.draftFile && r.draftFile.media_sent === 1 && r.out[0].media_delivery === "sendPhoto",
      JSON.stringify(r.out[0]),
    );
  }
  {
    // C3 no media
    const r = await runCompose({
      draft: { id: "d1", media: [] },
      items: [msg("d1", "none", [])],
    });
    check(
      "C3 0 media: card without reply_to_message_id",
      r.sends[0] && r.sends[0].reply_to_message_id === undefined,
      JSON.stringify(r.sends[0]),
    );
  }
  {
    // C4 mediaGroup fallback through the REAL chain: Prepare Draft ->
    // TG MediaGroup (forced error) -> Fan Out Album -> TG SendPhoto
    // FB (second photo forced to fail) -> Merge -> Compose
    const r = await runGraph({
      bodies: { draft_id: "d1", platform: "vk", text: "album post", media: mediaList(3) },
      mediaFiles: mediaFiles(3),
      albumFail: () => true,
      photoFail: (item) =>
        item.json?.album_fallback === true && item.binary?.file?.fileName === "f2.png",
    });
    const fbMids = r.sent.filter((s) => s.draft_id === "d1" && s.album_fallback && s.ok);
    const send = r.sends[0];
    check(
      "C4 fallback: card anchors on first delivered fallback photo",
      !!send && send.reply_to_message_id === fbMids[0]?.mid && fbMids.length === 2,
      JSON.stringify({ rt: send?.reply_to_message_id, sent: r.sent }),
    );
    check(
      "C4 fallback: media_sent counts delivered fallback photos",
      r.draftFile?.media_sent === 2 && r.out[0]?.media_delivery === "sendPhoto-fallback",
      JSON.stringify(r.out[0]),
    );
    check(
      "C4 fallback: 'mediaGroup-fallback' logged",
      r.logs.some((l) => l.action === "mediaGroup-fallback" && l.draft === "d1"),
      JSON.stringify(r.logs),
    );
    check(
      "C4 fallback: the failed file lands in attach failed tail",
      !!send && send.text.includes("attach failed:") && send.text.includes("f2.png"),
      send?.text.slice(-400),
    );
  }
  {
    // C4b: the [UNCERTAIN] shape - bare {error} AND no pairedItem.
    // Fan Out emits one binary-less marker, sendPhoto FB answers an
    // error item, and the failure is OBSERVABLE: the fallback path
    // runs, every path lands in 'attach failed', the log fires -
    // instead of a silent zero-item emit reporting phantom success.
    const r = await runGraph({
      bodies: { draft_id: "d1", platform: "vk", text: "album post", media: mediaList(3) },
      mediaFiles: mediaFiles(3),
      albumFail: () => true,
      dropPairedItem: true,
    });
    const send = r.sends[0];
    check(
      "C4b unpairable error: marker item reaches the fb pool, all paths flagged",
      r.out[0]?.media_delivery === "sendPhoto-fallback" &&
        r.draftFile?.media_sent === 0 &&
        !!send &&
        send.text.includes("attach failed:") &&
        send.text.includes("f1.png") &&
        send.text.includes("f3.png") &&
        r.logs.some((l) => l.action === "mediaGroup-fallback"),
      JSON.stringify({ out: r.out[0], tail: send?.text.slice(-300) }),
    );
  }
  {
    // C4c: mixed-outcome multi-album batch - d1 fails over to the
    // fallback chain while d2's mediaGroup succeeds, in ONE batch.
    // Pre-fix this misattributed the pools across drafts (d1 shifted
    // d2's album result and anchored on d2's photo). Every draft's
    // media path must stay exactly attributable.
    const r = await runGraph({
      bodies: [
        { draft_id: "d1", platform: "vk", text: "first album", media: mediaList(3) },
        {
          draft_id: "d2",
          platform: "vk",
          text: "second album",
          media: ["materials/photos/g1.png", "materials/photos/g2.png"],
        },
      ],
      mediaFiles: {
        ...mediaFiles(3),
        [`${MATERIALS}/photos/g1.png`]: png("g1"),
        [`${MATERIALS}/photos/g2.png`]: png("g2"),
      },
      albumFail: (item) => item.json.draft_id === "d1",
    });
    const send1 = r.sendOf("d1");
    const send2 = r.sendOf("d2");
    const d1fb = r.sent.filter((s) => s.draft_id === "d1" && s.album_fallback && s.ok);
    const d2mg = r.sent.find((s) => s.draft_id === "d2" && s.album);
    check(
      "C4c mixed batch: failed d1 anchors on ITS OWN first fallback photo",
      !!send1 &&
        send1.reply_to_message_id === d1fb[0]?.mid &&
        d1fb.length === 3 &&
        r.draftFileOf("d1")?.media_sent === 3 &&
        r.out.find((o) => o.draft_id === "d1")?.media_delivery === "sendPhoto-fallback",
      JSON.stringify({ send1: send1?.reply_to_message_id, d1fb, out: r.out }),
    );
    check(
      "C4c mixed batch: d2 anchors on ITS OWN mediaGroup result[0]",
      !!send2 &&
        send2.reply_to_message_id === d2mg?.mids?.[0] &&
        r.draftFileOf("d2")?.media_sent === 2 &&
        r.out.find((o) => o.draft_id === "d2")?.media_delivery === "sendMediaGroup",
      JSON.stringify({ send2: send2?.reply_to_message_id, d2mg, out: r.out }),
    );
  }
  {
    // C4d: repackaged-shape resilience - an n8n build that DOES merge
    // the input json into the error item (paths survive on it) runs
    // the same fallback without needing the paired-item lookup
    const r = await runGraph({
      bodies: { draft_id: "d1", platform: "vk", text: "album post", media: mediaList(2) },
      mediaFiles: mediaFiles(2),
      albumFail: () => true,
      mergeErrorJson: true,
      dropPairedItem: true, // json alone must suffice
    });
    const fbMids = r.sent.filter((s) => s.draft_id === "d1" && s.album_fallback && s.ok);
    check(
      "C4d merged-json error: fallback delivers, anchors on first photo",
      fbMids.length === 2 &&
        r.sends[0]?.reply_to_message_id === fbMids[0]?.mid &&
        r.draftFile?.media_sent === 2 &&
        r.out[0]?.media_delivery === "sendPhoto-fallback",
      JSON.stringify(r.out[0]),
    );
  }
  {
    // C5 stale-anchor retry
    const r = await runCompose({
      draft: { id: "d1", media: mediaList(1) },
      staleAnchor: true,
      items: [photoOk(601), msg("d1", "photo", ["f1.png"])],
    });
    check(
      "C5 stale anchor: first send carries reply_to, retry drops it",
      r.sends.length === 2 &&
        r.sends[0].reply_to_message_id === 601 &&
        r.sends[1].reply_to_message_id === undefined,
      JSON.stringify(r.sends.map((s) => s.reply_to_message_id)),
    );
    check(
      "C5 stale anchor: 'preview-reply-stale-anchor' logged + draft pending",
      r.logs.some((l) => l.action === "preview-reply-stale-anchor") &&
        r.draftFile &&
        r.draftFile.status === "pending",
      JSON.stringify(r.logs),
    );
  }
  {
    // C6 LIVE/SIM label + banner matrix
    const live = await runCompose({
      draft: { id: "d1" },
      items: [msg("d1", "none", [])],
      env: { PUBLISH_PLATFORMS: "vk" },
    });
    const kb = live.sends[0].reply_markup.inline_keyboard[0][0];
    check(
      "C6 LIVE: banner + 'Approve (LIVE)'",
      live.sends[0].text.startsWith("=== [LIVE PUBLISH] ===") &&
        kb.text === "Approve (LIVE)" &&
        kb.callback_data.startsWith("ap:d1:"),
      `${live.sends[0].text.slice(0, 60)} / ${kb.text}`,
    );
    const sim = await runCompose({
      draft: { id: "d1" },
      items: [msg("d1", "none", [])],
      env: { PUBLISH_SIMULATE: "1" },
    });
    const kb2 = sim.sends[0].reply_markup.inline_keyboard[0][0];
    check(
      "C6 SIM: banner + 'Approve (SIM)'",
      sim.sends[0].text.startsWith("--- [SIMULATED PUBLISH] ---") &&
        kb2.text === "Approve (SIM)" &&
        kb2.callback_data.startsWith("ap:d1:"),
      `${sim.sends[0].text.slice(0, 60)} / ${kb2.text}`,
    );
    const dis = await runCompose({
      draft: { id: "d1", platform: "vk" },
      items: [msg("d1", "none", [])],
      env: { PUBLISH_PLATFORMS: "linkedin" },
    });
    const kb3 = dis.sends[0].reply_markup.inline_keyboard[0][0];
    check(
      "C6 disabled platform: SIM banner + 'Approve (SIM)'",
      dis.sends[0].text.startsWith("--- [SIMULATED PUBLISH] ---") && kb3.text === "Approve (SIM)",
      `${dis.sends[0].text.slice(0, 60)} / ${kb3.text}`,
    );
  }
  {
    // C7 blockquote position: footer is LAST, after the text
    const r = await runCompose({
      draft: { id: "d1", text: "clean post body", media: [], warnings: ["w1 & <x>"], scope: "sc" },
      items: [msg("d1", "none", [])],
    });
    const t = r.sends[0].text;
    const bqOpen = t.indexOf("<blockquote expandable>");
    check(
      "C7 footer: single expandable blockquote at the end of the card",
      bqOpen > 0 &&
        t.trimEnd().endsWith("</blockquote>") &&
        t.indexOf("</blockquote>") > bqOpen &&
        t.indexOf("clean post body") < bqOpen &&
        t.indexOf("clean post body") > 0,
      t.slice(-200),
    );
    check(
      "C7 footer contains [DRAFT] line, Scope, [WARNINGS]",
      t.includes("[DRAFT d1 | vk]") &&
        t.includes("Scope: sc") &&
        t.includes("[WARNINGS - verifier]"),
      t.slice(-400),
    );
    check(
      "C7 escaping: warning entities escaped inside blockquote",
      t.includes("- w1 &amp; &lt;x&gt;") && !t.includes("- w1 & <x>"),
      t.slice(-300),
    );
  }
  {
    // C8 structural checksum - clean 6-block article
    const article = [
      "[01 / Hook] line1",
      "body",
      "[02 / Constraints] x",
      "body [See Fig 1]",
      "[03 / Timeline] x",
      "body [See Fig 2]",
      "[04 / Architecture] x",
      "body",
      "[05 // Telemetry] x",
      "body",
      "[06 // CTA] x",
      "body",
    ].join("\n");
    const r = await runCompose({
      draft: { id: "d1", text: article, media: mediaList(2) },
      items: [albumOk([801, 802]), msg("d1", "album", mediaList(2))],
    });
    check(
      "C8 structure: 'Structure: 6/6 blocks | Figs referenced: [1,2] (attached: 2)'",
      r.sends[0].text.includes("Structure: 6/6 blocks | Figs referenced: [1,2] (attached: 2)") &&
        !r.sends[0].text.includes("structure mismatch"),
      r.sends[0].text.slice(-500),
    );
    // mismatch: 5 blocks + 2 figs vs 1 attached
    const article5 = [
      "[01 / Hook] a",
      "body [See Fig 1]",
      "[02 / Constraints] b",
      "body",
      "[03 / Timeline] c",
      "body [See Fig 2]",
      "[04 / Architecture] d",
      "body",
      "[05 / Telemetry] e",
      "body",
    ].join("\n");
    const r2 = await runCompose({
      draft: { id: "d1", text: article5, media: mediaList(1) },
      items: [photoOk(601), msg("d1", "photo", ["f1.png"])],
    });
    check(
      "C8 structure mismatch: 5/6 + figs-vs-attached warning",
      r2.sends[0].text.includes("Structure: 5/6 blocks | Figs referenced: [1,2] (attached: 1)") &&
        r2.sends[0].text.includes("[WARN] structure mismatch"),
      r2.sends[0].text.slice(-600),
    );
    // non-article draft gets no Structure line
    const r3 = await runCompose({
      draft: { id: "d1", text: "plain post, no markers" },
      items: [msg("d1", "none", [])],
    });
    check(
      "C8 non-article: no Structure line",
      !r3.sends[0].text.includes("Structure:"),
      r3.sends[0].text.slice(-200),
    );
  }
  {
    // C9 HTML escaping of the post text, blockquote tags literal
    const r = await runCompose({
      draft: { id: "d1", text: "a < b & c > d" },
      items: [msg("d1", "none", [])],
    });
    const t = r.sends[0].text;
    check(
      "C9 text escaped, blockquote literal",
      t.includes("a &lt; b &amp; c &gt; d") &&
        t.includes("<blockquote expandable>") &&
        t.endsWith("</blockquote>"),
      t.slice(-300),
    );
  }
  {
    // C-extra: legacy batch without media_mode still works
    const r = await runCompose({
      draft: { id: "d1", media: mediaList(2) },
      items: [
        photoOk(601),
        photoOk(602),
        { kind: "msg", draft_id: "d1", chat_id: "4242", media_ok: ["a", "b"], media_failed: [] },
      ],
    });
    check(
      "legacy markers: positional sendPhoto results still slice correctly",
      r.sends[0].reply_to_message_id === 601 && r.draftFile.media_sent === 2,
      JSON.stringify(r.out[0]),
    );
  }
  {
    // C-extra: mixed batch - photo draft + album draft, stream order
    const r = await runCompose({
      draft: { id: "d1", media: mediaList(1) },
      items: [
        photoOk(601), // photo pool
        albumOk([501, 502]), // album pool - belongs to d2... but d2 has no draft file here
        msg("d1", "photo", ["f1.png"]),
        { kind: "msg", ok: false, draft_id: "d2", error: "x" },
      ],
    });
    check(
      "mixed batch: photo marker consumes only its pool item",
      r.sends[0].reply_to_message_id === 601 && r.draftFile.media_sent === 1,
      JSON.stringify(r.out),
    );
  }

  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall card-UX checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error("FAIL: harness crashed:", e);
  process.exit(1);
});
