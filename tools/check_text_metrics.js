#!/usr/bin/env node
// check_text_metrics.js - harness for the task 342 cheap eval
// metrics (tools/text_metrics.js + tools/pilot_metrics.js). Asserts:
//
//   M1  identical texts: meaningCosine ~1.0, lengthRatio 1.0 / no flag;
//   M2  disjoint texts: meaningCosine materially below 1 (vocab
//       disjoint -> ~0);
//   M3  lengthRatio flags the HumanizerBench penalty band: 0.5x
//       deflation and 1.5x inflation both flag, 1.0x does not;
//   M4  readability against a dead gateway returns
//       {score:null, error:'gateway_unavailable'} and never throws;
//   M5  fluency-judge contract on a stub /run endpoint: request is
//       {role:'fluency-judge', input:{source_text,language}}, a
//       wrapped {json:{score:0-100 HIGHER=WORSE}} reply inverts to
//       readability 1-score/100, a labelled 'score: N' in a raw
//       text blob parses, bare digits inside a timestamp do NOT,
//       and an unparseable reply degrades like a dead gateway;
//   M6  pilot_metrics.js on a temp pilot dir: appends one metrics
//       row per artifact (paired rows carry meaning/vs); a metrics
//       row whose readability is null does NOT seal the variant -
//       the next run re-appends it - while a real readability score
//       seals and --force re-appends everything.
//
// All offline: the readability path is pointed at a dead loopback
// port or a local stub /run server so runs are deterministic with
// or without the real gateway.
//
// Run:  node tools/check_text_metrics.js    (exit 0 = all pass)

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

// execFileSync blocks the event loop, which starves the in-process
// judge stub - runs that need a live /run answer go through the
// async execFile instead
const execFileAsync = (args, opts) =>
  new Promise((res, rej) => {
    execFile(process.execPath, args, opts, (e, stdout, stderr) =>
      e ? rej(Object.assign(e, { stdout, stderr })) : res({ stdout, stderr }),
    );
  });

const M = require("./text_metrics.js");
const PILOT = path.join(__dirname, "pilot_metrics.js");
// a port nothing listens on - connection refused, instantly
const DEAD_GW = "http://127.0.0.1:9";

// a minimal llm-gateway /run stub: captures each request body and
// answers from a per-request reply queue (the last entry repeats
// once the queue runs dry)
const judgeStub = async (replies) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ url: req.url, body });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, server, url: `http://127.0.0.1:${server.address().port}` };
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
  // --- M1 identical texts ------------------------------------------
  {
    const t = "The quick brown fox jumps over the lazy dog near the river bank.";
    const c = M.meaningCosine(t, t);
    const l = M.lengthRatio(t, t);
    check(
      "M1 identical: cosine ~1.0, ratio 1.0, no flag",
      c >= 0.999 && l.ratio === 1 && l.flag === false,
      JSON.stringify({ c, l }),
    );
  }

  // --- M2 disjoint texts -------------------------------------------
  {
    const a = "alpha beta gamma delta epsilon zeta eta theta";
    const b = "quartz jasper onyx garnet topaz beryl opal pumice";
    const c = M.meaningCosine(a, b);
    const cSame = M.meaningCosine(a, `${a} extra alpha`);
    check(
      "M2 disjoint: cosine ~0, paraphrase scores higher",
      c <= 0.05 && cSame > c,
      JSON.stringify({ c, cSame }),
    );
  }

  // --- M3 length flag band ------------------------------------------
  {
    const w = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const base = w(100);
    const half = M.lengthRatio(base, w(50));
    const onehalf = M.lengthRatio(base, w(150));
    const same = M.lengthRatio(base, w(110));
    check(
      "M3 band: 0.5x and 1.5x flagged, 1.1x clean",
      half.ratio === 0.5 &&
        half.flag === true &&
        onehalf.ratio === 1.5 &&
        onehalf.flag === true &&
        same.flag === false,
      JSON.stringify({ half, onehalf, same }),
    );
  }

  // --- M4 dead gateway -> clean degradation --------------------------
  {
    let r;
    let threw = false;
    try {
      r = await M.readability("some text to judge", { gateway: DEAD_GW, timeoutMs: 2000 });
    } catch (_e) {
      threw = true;
    }
    check(
      "M4 dead gateway: {score:null, error} and no throw",
      threw === false && r?.score === null && r?.error === "gateway_unavailable",
      JSON.stringify(r),
    );
  }

  // --- M5 fluency-judge contract on a stub /run endpoint -----------
  {
    const stub = await judgeStub([
      // 1: the gateway-wrapped fluency-judge reply
      {
        role: "fluency-judge",
        model: "stub",
        backend: "stub",
        json: { score: 42, rationale: "borderline EN", issues: [] },
      },
      // 2: a raw text blob with an explicit score label
      { text: "2026-01-15T10:30:00Z audit line - score: 37" },
      // 3: raw text whose only digits live inside a timestamp
      { text: "run 2026-01-15T10:30:00Z produced no verdict" },
      // 4: a bare digit run alongside a timestamp - the timestamp
      //    parts must not win
      { text: "2026-01-15T10:30:00Z judge answered 37" },
    ]);
    try {
      const gw = { gateway: stub.url, timeoutMs: 2000 };
      const r1 = await M.readability("Some EN text to judge.", gw);
      const req = JSON.parse(stub.seen[0]?.body || "{}");
      let input = null;
      try {
        input = JSON.parse(req.input);
      } catch (_e) {
        input = null;
      }
      check(
        "M5 stub judge: POST /run {role:'fluency-judge', input:{source_text,language}}",
        stub.seen[0]?.url === "/run" &&
          req.role === "fluency-judge" &&
          input?.source_text === "Some EN text to judge." &&
          input?.language === "en",
        stub.seen[0]?.body,
      );
      check(
        "M5 inversion: damage score 42 -> readability 0.58",
        r1?.score === 0.58 && !r1?.error,
        JSON.stringify(r1),
      );
      const r2 = await M.readability("more text", gw);
      check(
        "M5 raw fallback: labelled 'score: 37' -> readability 0.63",
        r2?.score === 0.63 && !r2?.error,
        JSON.stringify(r2),
      );
      const r3 = await M.readability("more text", gw);
      check(
        "M5 raw fallback: timestamp digits do not parse as a score",
        r3?.score === null && r3?.error === "gateway_unavailable",
        JSON.stringify(r3),
      );
      const r4 = await M.readability("more text", gw);
      check(
        "M5 raw fallback: bare 37 beside a timestamp -> readability 0.63",
        r4?.score === 0.63 && !r4?.error,
        JSON.stringify(r4),
      );
    } finally {
      stub.server.close();
    }
  }

  // --- M6 pilot_metrics seal-on-real-readability on a temp copy ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-metrics-"));
    fs.writeFileSync(path.join(dir, "mp_draft.txt"), "alpha beta gamma delta words here");
    fs.writeFileSync(path.join(dir, "mp_v1.txt"), "alpha beta gamma delta words here plus more");
    fs.writeFileSync(path.join(dir, "solo.txt"), "a standalone artifact with no pair");
    // one variant pre-seeded with a sealed metrics row (real
    // readability) + one historical non-metrics row + one malformed
    // line that must survive verbatim
    fs.writeFileSync(
      path.join(dir, "ledger.jsonl"),
      [
        JSON.stringify({
          ts: "2026-11-12T00:00:00Z",
          variant: "mp_draft",
          words: 6,
          label: "metrics",
          score: null,
          metrics: { readability: 0.5 },
          note: "prior",
        }),
        JSON.stringify({
          ts: "2026-11-12T00:00:00Z",
          variant: "mp_v1",
          words: 8,
          label: "AI",
          score: "1.0",
          note: "old pangram row",
        }),
        '{"ts": "broken", "verdict":}',
      ].join("\n") + "\n",
    );
    const deadEnv = {
      ...process.env,
      PILOT_DIR: dir,
      LLM_GATEWAY_URL: DEAD_GW,
      TEXT_METRICS_TIMEOUT_MS: "2000",
    };
    const readRows = () =>
      fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    const parsed = () =>
      readRows()
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (_e) {
            return null;
          }
        })
        .filter(Boolean);

    const before = readRows().length;
    execFileSync(process.execPath, [PILOT], { env: deadEnv, stdio: "pipe" });
    const rows1 = parsed();
    const m1 = rows1.filter((r) => r.label === "metrics");
    check(
      "M6 first run: metrics rows only for un-sealed variants",
      readRows().length === before + 2 &&
        m1.filter((r) => r.variant === "mp_draft").length === 1 &&
        m1.filter((r) => r.variant === "mp_v1").length === 1 &&
        m1.filter((r) => r.variant === "solo").length === 1,
      JSON.stringify(m1.map((r) => r.variant)),
    );
    const mpv1 = m1.find((r) => r.variant === "mp_v1");
    check(
      "M6 paired row: mp_v1 carries meaning/vs/length vs mp_draft",
      mpv1?.metrics?.vs === "mp_draft" &&
        typeof mpv1.metrics.meaning === "number" &&
        mpv1.metrics.meaning > 0.5 &&
        mpv1.metrics.length_flag === false &&
        mpv1.metrics.readability === null &&
        mpv1.metrics.readability_error === "gateway_unavailable",
      JSON.stringify(mpv1),
    );
    const solo = m1.find((r) => r.variant === "solo");
    check(
      "M6 unpaired row: readability only, no meaning block",
      solo && !("meaning" in solo.metrics) && !("vs" in solo.metrics),
      JSON.stringify(solo),
    );
    check(
      "M6 malformed and prior rows untouched",
      readRows().includes('{"ts": "broken", "verdict":}') &&
        rows1.some((r) => r.variant === "mp_v1" && r.label === "AI"),
    );
    const after1 = readRows().length;
    execFileSync(process.execPath, [PILOT], { env: deadEnv, stdio: "pipe" });
    check(
      "M6 second run: null-readability rows do not seal - mp_v1+solo re-append",
      readRows().length === after1 + 2 &&
        parsed().filter((r) => r.label === "metrics" && r.variant === "mp_draft").length === 1,
      `${before} -> ${after1} -> ${readRows().length}`,
    );
    const after2 = readRows().length;
    execFileSync(process.execPath, [PILOT, "--force"], { env: deadEnv, stdio: "pipe" });
    check(
      "M6 --force: all three variants re-appended",
      readRows().length === after2 + 3,
      `${after2} -> ${readRows().length}`,
    );
    // a live judge lands real readability scores and seals: the
    // next run appends nothing even for variants that accumulated
    // several null-readability rows
    const stub = await judgeStub([
      {
        role: "fluency-judge",
        model: "stub",
        backend: "stub",
        json: { score: 20, rationale: "clean", issues: [] },
      },
    ]);
    try {
      const liveEnv = { ...deadEnv, LLM_GATEWAY_URL: stub.url };
      const afterForce = readRows().length;
      await execFileAsync([PILOT], { env: liveEnv });
      const live = parsed().filter((r) => r.label === "metrics" && r.metrics?.readability === 0.8);
      check(
        "M6 live judge: mp_v1+solo get real readability (mp_draft stays sealed)",
        readRows().length === afterForce + 2 &&
          live.length === 2 &&
          live.every((r) => r.metrics.readability_error === undefined),
        `${afterForce} -> ${readRows().length} ${JSON.stringify(live.map((r) => r.variant))}`,
      );
      const afterLive = readRows().length;
      await execFileAsync([PILOT], { env: liveEnv });
      check(
        "M6 live re-run: real readability seals - zero new rows",
        readRows().length === afterLive,
        `${afterLive} -> ${readRows().length}`,
      );
    } finally {
      stub.server.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall checks passed");
};

main().catch((e) => {
  console.error(`check_text_metrics error: ${String(e?.message || e)}`);
  process.exit(1);
});
