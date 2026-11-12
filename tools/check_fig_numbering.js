#!/usr/bin/env node
// check_fig_numbering.js - harness for the article-visuals figure
// contract (issue #51). Runs the REAL 'Generate Drafts' jsCode from
// n8n/workflows/sp-content-gen.json inside a stubbed n8n Code-node
// sandbox and asserts on the moderation-draft dispatch body:
//
//   1. '[See Fig N]' / '[см. Fig N]' pointers renumber to the FINAL
//      attach order in draft.media (post-render), so a pointer can
//      never land on the wrong attached image;
//   2. a visual task whose render failed loses its pointer (no
//      dangling '[See Fig N]') and surfaces a 'fig N render failed'
//      warnings[] line that lands on the moderation card;
//   3. caption_note describes the RENDERED figures in attach order
//      (Fig N -> what it is), not the requested task list;
//   4. an empty visuals[] leaves the legacy path byte-identical:
//      text untouched, no media, no caption_note, no warnings.
//
// Issue #52 adds the critic-side contract: the verifier used to see
// {draft} only, so numbers inside visuals[] datasets bypassed
// fact-checking. Scenarios S7/S8 capture the /run request bodies and
// assert the critic input carries one flattened claim line per visual
// ('visual k <type>/<block> "title": key=value; ...') when visuals[]
// is non-empty, and keeps the legacy payload shape (no 'visuals' key)
// when it is empty.
//
// Issue #64 adds the perf_summary.json read side: a seeded analytics
// file feeds up to 5 trimmed top_performers into the writer brief for
// matching platforms only, marks the moderation card 'perf-informed',
// and logs {action:'perf-summary'} once - while a missing/corrupt file
// fails OPEN with a logged skip and a byte-identical legacy brief
// (S9-S11).
//
// Sandbox contract: the Code node sees require('fs'), $input.all(),
// $env.NAME and this.helpers.httpRequest - all stubbed here. The fs
// stub serves sc.files and captures the log appends, so nothing
// touches the disk; httpRequest is routed by URL to per-scenario
// fakes (llm-gateway /run and /image, the viz renderer, the
// moderation-draft webhook).
//
// Run:  node tools/check_fig_numbering.js    (exit 0 = all pass)

const fs = require("node:fs");
const path = require("node:path");

const WF = path.join(__dirname, "..", "n8n", "workflows", "sp-content-gen.json");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const node0 = spec.nodes.find((n) => n.name === "Generate Drafts");
if (!node0?.parameters?.jsCode) {
  console.error(`FAIL: Generate Drafts jsCode not found in ${WF}`);
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

// per-scenario fs stub: sc.files seeds readable files (issue #64's
// perf_summary.json), every appendFileSync is captured per path so the
// content-gen.jsonl log lines can be asserted on, and the read miss is
// a real ENOENT - the perf-summary fail-open path classifies by code
const mkFsStub = (sc) => {
  const files = sc.files || {};
  const appends = {};
  const stub = {
    mkdirSync() {},
    appendFileSync(p, data) {
      appends[p] = (appends[p] || "") + String(data);
    },
    writeFileSync() {},
    renameSync() {},
    truncateSync() {},
    readFileSync(p) {
      if (files[p] != null) return files[p];
      throw Object.assign(new Error("fs stub: no files"), { code: "ENOENT" });
    },
    statSync() {
      throw Object.assign(new Error("fs stub: no files"), { code: "ENOENT" });
    },
  };
  return { stub, appends };
};

// n8n exposes $env as a plain object (the Code node reads $env[n])
const $env = {
  CONTENT_GEN_WEBHOOK_SECRET: "cg-secret-for-harness",
  DRAFT_WEBHOOK_SECRET: "draft-secret-for-harness",
  VIZ_RENDERER_URL: "viz://render",
};

// brief gate needs >=200 chars of context plus >=2 digit-bearing
// fact tokens; entity check needs the two fact entities in the text
const CONTEXT = `${"harness supplied material ".repeat(10)} rev1 rev2`;

const item = (body) => ({
  json: {
    headers: { "x-content-gen-secret": $env.CONTENT_GEN_WEBHOOK_SECRET },
    body: {
      platform: "vk",
      topic: "harness topic",
      context: CONTEXT,
      ...body,
    },
  },
});

const chart = (block, type) => ({
  block,
  type,
  title: `${type} ${block}`,
  caption: `cap ${block}`,
  dataset: { kind: type, data: { label: "d1" } },
});
const hero = (block) => ({
  block,
  type: "image",
  prompt: "blueprint hero",
  caption: `hero ${block}`,
});

const runScenario = async (sc) => {
  const dispatched = [];
  const calls = [];
  const runs = []; // {role, input} of every llm-gateway /run call
  const roles = {
    "extract-facts": { json: { stack: ["React"], metrics: ["n8n"] } },
    critic: { json: { verdict: "pass", issues: [] } },
    "writer-vk": { json: sc.writer },
    "writer-linkedin": { json: sc.writer },
    "writer-fb": { json: sc.writer },
  };
  const helpers = {
    httpRequest: async (opts) => {
      calls.push(opts.url);
      if (opts.url === $env.VIZ_RENDERER_URL) {
        if (sc.vizThrow) throw new Error("render service down");
        return sc.viz || { ok: true, paths: [], skipped: [] };
      }
      if (opts.url === "http://127.0.0.1:8787/image") {
        if (sc.imgThrow) throw new Error("image gateway down");
        return sc.image || { path: "materials/img/hero.png" };
      }
      if (opts.url === "http://127.0.0.1:8787/run") {
        const role = opts.body?.role;
        runs.push({ role, input: String(opts.body?.input || "") });
        return roles[role] || { json: {} };
      }
      if (opts.url === "http://127.0.0.1:5780/webhook/moderation-draft") {
        dispatched.push(opts.body);
        return { ok: true, draft_id: opts.body.draft_id };
      }
      throw new Error(`unexpected httpRequest url: ${opts.url}`);
    },
  };
  const fsm = mkFsStub(sc);
  const fn = factory(
    (m) => (m === "fs" ? fsm.stub : require(m)),
    { all: () => [item(sc.body)] },
    $env,
  );
  const out = await fn.call({ helpers });
  const results = out?.[0]?.json?.results;
  const logs = (fsm.appends["/home/node/.n8n/logs/content-gen.jsonl"] || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  return { dispatched, calls, runs, results, logs };
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const main = async () => {
  // S1: mid-list chart task skipped by the renderer -> the later
  // pointers renumber down, the failed fig's pointer is removed and
  // warned, caption_note lists the rendered figs in attach order.
  // Requested: Fig1 = pipeline (fails), Fig2 = hero image, Fig3 =
  // timeline. Attach: [hero img (Fig1), timeline png (Fig2)].
  {
    const text = "React n8n hook [See Fig 1]. mid [See Fig 2] tail [See Fig 3] end";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [chart("B4", "pipeline"), hero("B1"), chart("B3", "timeline")],
      },
      viz: {
        ok: true,
        paths: ["materials/viz/d1_1_v1-b3.png"],
        skipped: [{ viz_id: "v0-b4", reason: "no-data" }],
      },
      image: { path: "materials/img/d1_art2.png" },
    });
    const d = dispatched[0] || {};
    check(
      "S1 renumber: pointers follow final attach order",
      d.text === "React n8n hook. mid [See Fig 1] tail [See Fig 2] end",
      JSON.stringify(d.text),
    );
    check(
      "S1 media: requested attach order (image before chart)",
      eq(d.media, ["materials/img/d1_art2.png", "materials/viz/d1_1_v1-b3.png"]),
      JSON.stringify(d.media),
    );
    check(
      "S1 warning: fig 1 render failed surfaces on the card",
      Array.isArray(d.warnings) &&
        d.warnings.some(
          (w) => w.startsWith("fig 1 render failed: pipeline/B4") && w.includes("no-data"),
        ),
      JSON.stringify(d.warnings),
    );
    check(
      "S1 caption_note: rendered figs only, attach order",
      typeof d.caption_note === "string" &&
        d.caption_note.includes("Fig 1: image/B1") &&
        d.caption_note.includes("Fig 2: timeline/B3") &&
        !d.caption_note.includes("pipeline"),
      d.caption_note,
    );
  }

  // S2: the whole chart batch throws -> every chart task fails and
  // warns, the image still attaches as Fig 1, RU '[см. Fig N]'
  // pointers and a non-object visuals[] entry are handled.
  {
    const text = "React n8n a [см. Fig 1]. b [см. Fig 2] c [см. Fig 3] d";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [chart("B3", "timeline"), hero("B1"), "garbage-entry"],
      },
      vizThrow: true,
      image: { path: "materials/img/d2_art2.png" },
    });
    const d = dispatched[0] || {};
    check(
      "S2 batch failure: dropped pointers leave clean text",
      d.text === "React n8n a. b [см. Fig 1] c d",
      JSON.stringify(d.text),
    );
    check(
      "S2 media: image survives the dead render service",
      eq(d.media, ["materials/img/d2_art2.png"]),
      JSON.stringify(d.media),
    );
    check(
      "S2 warnings: chart failure + invalid task both reported",
      Array.isArray(d.warnings) &&
        d.warnings.some(
          (w) =>
            w.startsWith("fig 1 render failed: timeline/B3") && w.includes("render call failed"),
        ) &&
        d.warnings.some((w) => w.startsWith("fig 3 render failed") && w.includes("non-object")),
      JSON.stringify(d.warnings),
    );
    check(
      "S2 caption_note: only the rendered image listed",
      typeof d.caption_note === "string" && d.caption_note.includes("Fig 1: image/B1"),
      d.caption_note,
    );
  }

  // S3: pointers at figures that were never requested are dropped
  // and warned once per number; the surviving pointer is untouched.
  {
    const text = "React n8n x [See Fig 1] y [See Fig 9] z [See Fig 2]. w";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [chart("B3", "timeline")],
      },
      viz: { ok: true, paths: ["materials/viz/p1.png"], skipped: [] },
    });
    const d = dispatched[0] || {};
    check(
      "S3 unknown-fig pointers removed without mangling spaces",
      d.text === "React n8n x [See Fig 1] y z. w",
      JSON.stringify(d.text),
    );
    check(
      "S3 warnings: out-of-range fig numbers reported",
      Array.isArray(d.warnings) &&
        d.warnings.some((w) => w.startsWith("fig 2 pointer removed")) &&
        d.warnings.some((w) => w.startsWith("fig 9 pointer removed")),
      JSON.stringify(d.warnings),
    );
    check("S3 media", eq(d.media, ["materials/viz/p1.png"]), JSON.stringify(d.media));
  }

  // S4: all tasks render - pointers keep their numbers, no warnings.
  {
    const text = "React n8n one [See Fig 1] two [See Fig 2] three [See Fig 3]";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [chart("B2", "matrix"), chart("B3", "timeline"), hero("B1")],
      },
      viz: {
        ok: true,
        paths: ["materials/viz/m.png", "materials/viz/t.png"],
        skipped: [],
      },
      image: { path: "materials/img/h.png" },
    });
    const d = dispatched[0] || {};
    check("S4 all-rendered: text unchanged", d.text === text, JSON.stringify(d.text));
    check(
      "S4 media: all three attached in requested order",
      eq(d.media, ["materials/viz/m.png", "materials/viz/t.png", "materials/img/h.png"]),
      JSON.stringify(d.media),
    );
    check("S4 no warnings on a clean run", d.warnings === undefined, JSON.stringify(d.warnings));
    check(
      "S4 caption_note covers all rendered figs",
      typeof d.caption_note === "string" &&
        ["Fig 1: matrix/B2", "Fig 2: timeline/B3", "Fig 3: image/B1"].every((s) =>
          d.caption_note.includes(s),
        ),
      d.caption_note,
    );
  }

  // S5: image render throws - pointer dropped, chart keeps Fig 1.
  {
    const text = "React n8n p [See Fig 1] q [See Fig 2] r";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [chart("B3", "timeline"), hero("B1")],
      },
      viz: { ok: true, paths: ["materials/viz/only.png"], skipped: [] },
      imgThrow: true,
    });
    const d = dispatched[0] || {};
    check(
      "S5 image failure: its pointer drops, chart stays Fig 1",
      d.text === "React n8n p [See Fig 1] q r",
      JSON.stringify(d.text),
    );
    check(
      "S5 warning: image render failure reported",
      Array.isArray(d.warnings) &&
        d.warnings.some(
          (w) => w.startsWith("fig 2 render failed: image/B1") && w.includes("image render failed"),
        ),
      JSON.stringify(d.warnings),
    );
    check("S5 media", eq(d.media, ["materials/viz/only.png"]), JSON.stringify(d.media));
  }

  // S6: legacy path byte-compat - no visuals[] means the dispatch is
  // exactly what the pre-#51 code produced: text verbatim (even a
  // stray pointer-like token is left alone), no media, no
  // caption_note, no warnings.
  {
    const text = "React n8n plain article text [See Fig 1] unchanged";
    const { dispatched } = await runScenario({
      writer: { platform: "vk", lang: "ru", text, hashtags: ["#a"] },
    });
    const d = dispatched[0] || {};
    check(
      "S6 legacy: text byte-identical without visuals[]",
      d.text === text,
      JSON.stringify(d.text),
    );
    check(
      "S6 legacy: no media/caption_note/warnings fields",
      d.media === undefined && d.caption_note === undefined && d.warnings === undefined,
      JSON.stringify({
        media: d.media,
        caption_note: d.caption_note,
        warnings: d.warnings,
      }),
    );
  }

  // S7: critic fact-checks visual dataset claims (issue #52). The
  // verifier payload must carry one flattened claim line per visual so
  // diagram numbers/labels get the same facts-only check as the text;
  // an image task with no dataset still contributes its caption.
  {
    const text = "React n8n body [See Fig 1] tail [See Fig 2]";
    const { runs } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [
          {
            block: "B2",
            type: "matrix",
            title: "opts",
            caption: "matrix cap B2",
            dataset: {
              kind: "matrix",
              data: {
                columns: ["speed", "cost"],
                rows: [{ label: "opt-a", values: [42, "free"] }],
              },
            },
          },
          hero("B1"),
        ],
      },
      viz: { ok: true, paths: ["materials/viz/m.png"], skipped: [] },
    });
    const criticInputs = runs.filter((r) => r.role === "critic").map((r) => JSON.parse(r.input));
    check(
      "S7 critic called once on a clean verdict",
      criticInputs.length === 1,
      String(criticInputs.length),
    );
    const vlines = criticInputs[0]?.visuals;
    check(
      "S7 critic input carries one claim line per visual",
      Array.isArray(vlines) && vlines.length === 2,
      JSON.stringify(vlines),
    );
    check(
      "S7 dataset numbers/labels reach the critic flattened",
      Array.isArray(vlines) &&
        vlines[0].startsWith('visual 1 matrix/B2 "opts":') &&
        vlines[0].includes("columns=speed|cost") &&
        vlines[0].includes("label=opt-a") &&
        vlines[0].includes("values=42|free"),
      JSON.stringify(vlines?.[0]),
    );
    check(
      "S7 dataset visual still sends its caption claim (issue #56)",
      Array.isArray(vlines) &&
        vlines[0].includes("columns=speed|cost") &&
        vlines[0].includes("caption=matrix cap B2"),
      JSON.stringify(vlines?.[0]),
    );
    check(
      "S7 claim lines bounded at 640 chars incl. head (issue #56)",
      Array.isArray(vlines) && vlines.every((v) => v.length <= 640),
      JSON.stringify(vlines?.map((v) => v.length)),
    );
    check(
      "S7 dataset-less image task keeps its caption claim",
      Array.isArray(vlines) &&
        vlines[1].startsWith("visual 2 image/B1") &&
        vlines[1].includes("caption=hero B1"),
      JSON.stringify(vlines?.[1]),
    );
    check(
      "S7 draft text still passed to the critic verbatim",
      criticInputs[0]?.draft === text,
      JSON.stringify(criticInputs[0]?.draft),
    );
  }

  // S8: no visuals[] -> the critic payload keeps its legacy shape -
  // no 'visuals' key at all, so non-article drafts are byte-identical
  // to the pre-#52 input.
  {
    const { runs } = await runScenario({
      writer: { platform: "vk", lang: "ru", text: "React n8n plain text", hashtags: [] },
    });
    const ci = runs.filter((r) => r.role === "critic").map((r) => JSON.parse(r.input))[0];
    check(
      "S8 legacy: critic input has no visuals key without visuals[]",
      ci && !("visuals" in ci) && typeof ci.draft === "string",
      JSON.stringify(ci),
    );
  }

  // S9: perf_summary.json present (issue #64) - the writer brief gains
  // a trimmed top_performers list limited to posts matching the
  // writer's own platform, the moderation card note reports
  // 'perf-informed: N top posts' and exactly one {action:'perf-summary'}
  // line records the posts/matched counts.
  {
    const perf = {
      schema_v: 1,
      generated_at: "2026-11-10T00:00:00Z",
      window_days: 30,
      posts: [
        {
          post_id: "p_a",
          platform: "vk",
          external_id: "1_2",
          views: 100,
          likes: 9,
          comments: 3,
          reposts: 1,
          engagement: 13,
        },
        {
          post_id: "p_b",
          platform: "linkedin",
          external_id: "urn:li:share:9",
          views: 50,
          likes: 4,
          comments: 1,
          engagement: 5,
        },
        {
          post_id: "p_c",
          platform: "vk",
          external_id: "1_3",
          views: null,
          likes: 7,
          comments: 2,
          reposts: 0,
          engagement: 9,
        },
      ],
    };
    const { dispatched, runs, logs } = await runScenario({
      writer: { platform: "vk", lang: "ru", text: "React n8n perf article", hashtags: [] },
      files: { "/home/node/.n8n/state/analytics/perf_summary.json": JSON.stringify(perf) },
    });
    const wb = JSON.parse(runs.find((r) => r.role === "writer-vk")?.input || "{}");
    check(
      "S9 writer brief carries top_performers for the writer's platform only",
      Array.isArray(wb.top_performers) && wb.top_performers.length === 2,
      JSON.stringify(wb.top_performers),
    );
    check(
      "S9 entries trimmed to the reference fields, nulls dropped",
      eq(wb.top_performers, [
        { post_id: "p_a", external_id: "1_2", views: 100, engagement: 13 },
        { post_id: "p_c", external_id: "1_3", engagement: 9 },
      ]),
      JSON.stringify(wb.top_performers),
    );
    check(
      "S9 caption_note marks perf-informed generation",
      typeof dispatched[0]?.caption_note === "string" &&
        dispatched[0].caption_note.includes("perf-informed: 2 top posts"),
      dispatched[0]?.caption_note,
    );
    check(
      "S9 one perf-summary log line with posts/matched/delivered counts",
      logs.filter((l) => l && l.action === "perf-summary").length === 1 &&
        logs.some(
          (l) =>
            l &&
            l.action === "perf-summary" &&
            l.posts === 3 &&
            l.matched === 2 &&
            l.delivered === 1,
        ),
      JSON.stringify(logs.filter((l) => l && l.action === "perf-summary")),
    );
  }

  // S10: perf_summary present but nothing on the writer's platform -
  // the brief keeps the legacy shape (no top_performers key at all)
  // and no perf-informed marker is emitted; the summary line still
  // logs once with matched:0.
  {
    const perf = {
      schema_v: 1,
      posts: [
        {
          post_id: "p_b",
          platform: "linkedin",
          external_id: "urn:li:share:9",
          views: 50,
          engagement: 5,
        },
      ],
    };
    const { dispatched, runs, logs } = await runScenario({
      writer: { platform: "vk", lang: "ru", text: "React n8n plain text", hashtags: [] },
      files: { "/home/node/.n8n/state/analytics/perf_summary.json": JSON.stringify(perf) },
    });
    const wb = JSON.parse(runs.find((r) => r.role === "writer-vk")?.input || "{}");
    check(
      "S10 no top_performers key when nothing matches",
      wb && !("top_performers" in wb) && typeof wb.topic === "string",
      JSON.stringify(wb),
    );
    check(
      "S10 no perf-informed marker on the card",
      dispatched[0]?.caption_note === undefined,
      dispatched[0]?.caption_note,
    );
    check(
      "S10 perf-summary log still emitted once",
      logs.some(
        (l) =>
          l && l.action === "perf-summary" && l.posts === 1 && l.matched === 0 && l.delivered === 0,
      ),
      JSON.stringify(logs.filter((l) => l && l.action === "perf-summary")),
    );
  }

  // S11: corrupt perf_summary fails OPEN - generation runs exactly as
  // without the file (no top_performers, draft still dispatched) and
  // the skip reason lands in the log instead of blocking the run.
  {
    const { dispatched, runs, logs } = await runScenario({
      writer: { platform: "vk", lang: "ru", text: "React n8n plain text", hashtags: [] },
      files: { "/home/node/.n8n/state/analytics/perf_summary.json": "{corrupt json," },
    });
    const wb = JSON.parse(runs.find((r) => r.role === "writer-vk")?.input || "{}");
    check(
      "S11 corrupt file: no top_performers key",
      wb && !("top_performers" in wb),
      JSON.stringify(wb),
    );
    check(
      "S11 corrupt file: draft still dispatched",
      dispatched.length === 1 && dispatched[0]?.text === "React n8n plain text",
      JSON.stringify(dispatched),
    );
    check(
      "S11 corrupt file: skip reason logged",
      logs.some(
        (l) =>
          l &&
          l.action === "perf-summary" &&
          typeof l.skipped === "string" &&
          l.skipped.includes("unreadable"),
      ),
      JSON.stringify(logs.filter((l) => l && l.action === "perf-summary")),
    );
  }

  console.log(fails ? `fig-numbering: ${fails} check(s) failed` : "fig-numbering: all checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error(`FAIL harness crashed: ${e?.stack || e}`);
  process.exit(1);
});
