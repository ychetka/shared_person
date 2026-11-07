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
// Sandbox contract: the Code node sees require('fs'), $input.all(),
// $env.NAME and this.helpers.httpRequest - all stubbed here. The fs
// stub swallows the state/log appends so nothing touches the disk;
// httpRequest is routed by URL to per-scenario fakes (llm-gateway
// /run and /image, the viz renderer, the moderation-draft webhook).
//
// Run:  node tools/check_fig_numbering.js    (exit 0 = all pass)

const fs = require("node:fs");
const path = require("node:path");

const WF = path.join(
  __dirname, "..", "n8n", "workflows", "sp-content-gen.json");
const spec = JSON.parse(fs.readFileSync(WF, "utf8"));
const node0 = spec.nodes.find((n) => n.name === "Generate Drafts");
if (!node0 || !node0.parameters || !node0.parameters.jsCode) {
  console.error("FAIL: Generate Drafts jsCode not found in " + WF);
  process.exit(1);
}

// the Code node wraps user code in an async function with require /
// $input / $env in scope and `this` carrying .helpers - mirror that
const factory = new Function(
  "require",
  "$input",
  "$env",
  "return (async function () {\n" + node0.parameters.jsCode + "\n});",
);

const fsStub = {
  mkdirSync() {},
  appendFileSync() {},
  writeFileSync() {},
  renameSync() {},
  truncateSync() {},
  readFileSync() {
    throw new Error("fs stub: no files");
  },
  statSync() {
    throw new Error("fs stub: no files");
  },
};
const fakeRequire = (m) => (m === "fs" ? fsStub : require(m));

// n8n exposes $env as a plain object (the Code node reads $env[n])
const $env = {
  CONTENT_GEN_WEBHOOK_SECRET: "cg-secret-for-harness",
  DRAFT_WEBHOOK_SECRET: "draft-secret-for-harness",
  VIZ_RENDERER_URL: "viz://render",
};

// brief gate needs >=200 chars of context plus >=2 digit-bearing
// fact tokens; entity check needs the two fact entities in the text
const CONTEXT = "harness supplied material ".repeat(10) + " rev1 rev2";

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
  title: type + " " + block,
  caption: "cap " + block,
  dataset: { kind: type, data: { label: "d1" } },
});
const hero = (block) => ({
  block,
  type: "image",
  prompt: "blueprint hero",
  caption: "hero " + block,
});

const runScenario = async (sc) => {
  const dispatched = [];
  const calls = [];
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
        const role = opts.body && opts.body.role;
        return roles[role] || { json: {} };
      }
      if (opts.url === "http://127.0.0.1:5780/webhook/moderation-draft") {
        dispatched.push(opts.body);
        return { ok: true, draft_id: opts.body.draft_id };
      }
      throw new Error("unexpected httpRequest url: " + opts.url);
    },
  };
  const fn = factory(fakeRequire, { all: () => [item(sc.body)] }, $env);
  const out = await fn.call({ helpers });
  const results = out && out[0] && out[0].json && out[0].json.results;
  return { dispatched, calls, results };
};

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("ok   " + name);
  } else {
    console.log("FAIL " + name + (detail ? " - " + detail : ""));
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
    const text =
      "React n8n hook [See Fig 1]. mid [See Fig 2] tail [See Fig 3] end";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [
          chart("B4", "pipeline"),
          hero("B1"),
          chart("B3", "timeline"),
        ],
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
          (w) => w.startsWith("fig 1 render failed: pipeline/B4") &&
            w.includes("no-data"),
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
          (w) => w.startsWith("fig 1 render failed: timeline/B3") &&
            w.includes("render call failed"),
        ) &&
        d.warnings.some(
          (w) => w.startsWith("fig 3 render failed") &&
            w.includes("non-object"),
        ),
      JSON.stringify(d.warnings),
    );
    check(
      "S2 caption_note: only the rendered image listed",
      typeof d.caption_note === "string" &&
        d.caption_note.includes("Fig 1: image/B1"),
      d.caption_note,
    );
  }

  // S3: pointers at figures that were never requested are dropped
  // and warned once per number; the surviving pointer is untouched.
  {
    const text =
      "React n8n x [See Fig 1] y [See Fig 9] z [See Fig 2]. w";
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
    check("S3 media", eq(d.media, ["materials/viz/p1.png"]),
      JSON.stringify(d.media));
  }

  // S4: all tasks render - pointers keep their numbers, no warnings.
  {
    const text =
      "React n8n one [See Fig 1] two [See Fig 2] three [See Fig 3]";
    const { dispatched } = await runScenario({
      writer: {
        platform: "vk",
        lang: "ru",
        text,
        hashtags: [],
        visuals: [
          chart("B2", "matrix"),
          chart("B3", "timeline"),
          hero("B1"),
        ],
      },
      viz: {
        ok: true,
        paths: ["materials/viz/m.png", "materials/viz/t.png"],
        skipped: [],
      },
      image: { path: "materials/img/h.png" },
    });
    const d = dispatched[0] || {};
    check(
      "S4 all-rendered: text unchanged",
      d.text === text,
      JSON.stringify(d.text),
    );
    check(
      "S4 media: all three attached in requested order",
      eq(d.media, [
        "materials/viz/m.png",
        "materials/viz/t.png",
        "materials/img/h.png",
      ]),
      JSON.stringify(d.media),
    );
    check(
      "S4 no warnings on a clean run",
      d.warnings === undefined,
      JSON.stringify(d.warnings),
    );
    check(
      "S4 caption_note covers all rendered figs",
      typeof d.caption_note === "string" &&
        ["Fig 1: matrix/B2", "Fig 2: timeline/B3", "Fig 3: image/B1"]
          .every((s) => d.caption_note.includes(s)),
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
          (w) => w.startsWith("fig 2 render failed: image/B1") &&
            w.includes("image render failed"),
        ),
      JSON.stringify(d.warnings),
    );
    check("S5 media", eq(d.media, ["materials/viz/only.png"]),
      JSON.stringify(d.media));
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
      d.media === undefined &&
        d.caption_note === undefined &&
        d.warnings === undefined,
      JSON.stringify({
        media: d.media,
        caption_note: d.caption_note,
        warnings: d.warnings,
      }),
    );
  }

  console.log(fails ? "fig-numbering: " + fails + " check(s) failed"
    : "fig-numbering: all checks pass");
  process.exit(fails ? 1 : 0);
};

main().catch((e) => {
  console.error("FAIL harness crashed: " + (e && e.stack || e));
  process.exit(1);
});
