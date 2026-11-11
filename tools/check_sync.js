#!/usr/bin/env node
// check_sync.js - manual drift check for the SYNC-marked helper copies
// that n8n Code nodes force us to duplicate (Code nodes cannot share a
// prelude, so the same helper lives in several workflows' jsCode).
//
// Each shared helper body is bracketed by marker comments inside the
// jsCode strings of n8n/workflows/*.json:
//
//   // SYNC-BEGIN: <group>
//   ...helper code...
//   // SYNC-END: <group>
//
// All blocks in one <group> must be identical after the group-specific
// identifier normalization in GROUPS below - the constant names each
// copy binds (DRAFT_SECRET vs WEBHOOK_SECRET, ctrFile vs REJECT_CTR,
// events_seen vs rejects_seen) legitimately differ per node, while the
// shared LOGIC must match line for line. A group may instead declare
// maxClasses (several allowed normalized shapes, e.g. the
// enabled-platforms gate blocks vs the writer MAP) plus tokenSet (the
// property every shape must share, compared as a sorted token set on
// the raw block text).
//
// deploy_workflow.js runs this as a preflight before touching the n8n
// DB (a drifted helper cannot deploy silently); still runnable by
// hand after touching any SYNC'd helper:
//
//   node tools/check_sync.js
//
// Exit 0 = every group consistent (right member count, identical
// bodies); exit 1 = drift, an unbalanced marker pair, a missing or
// extra member, or a marker group with no config entry.

const fs = require("node:fs");
const path = require("node:path");

const WF_DIR = path.join(__dirname, "..", "n8n", "workflows");

// platform tokens the enabled-platforms members must agree on.
// Whole-word matching keeps 'writer-fb' contributing 'fb' while
// ordinary prose inside the copies' comments cannot add a phantom
// token; 'all' is the fan-out token (MAP.all -> every writer) and
// counts like a platform name, the aliases 'fb'/'ig' count too.
const PLATFORM_TOKEN_RE =
  /\b(?:all|facebook|fb|habr|ig|instagram|linkedin|tiktok|twitter|vk|youtube)\b/g;

// expect = exact number of copies that must carry the marker pair, so
// a deleted or newly added copy is caught as well as an edited one.
// normalize = [regex, replacement] pairs applied before comparison.
// maxClasses = how many distinct normalized bodies the group may have
// (default 1 - all copies identical); tokenSet = a regex whose whole-
// word matches must yield the same SET on every copy's raw text.
const GROUPS = {
  // plain tmp+rename writeJsonAtomic: Handle TG Update, Prepare Draft,
  // Compose Message and Handle Pangram Results (sp-tg-moderation),
  // Generate Drafts (sp-content-gen), Resolve Chat + Webhook
  // (sp-tg-setup), Analytics Tick (sp-analytics), Eval Tick
  // (sp-humanizer-eval)
  "write-json-atomic": { expect: 8 },
  // Publish Tick's copy is the hardened 0o600 variant - intentionally
  // different from the plain copies, tracked under its own group so
  // the marker itself stays accounted for
  "write-json-atomic-hardened": { expect: 1 },
  // secretOk padded compare: Handle TG Update (WEBHOOK_SECRET),
  // Prepare Draft (DRAFT_SECRET) - both sp-tg-moderation - and
  // Generate Drafts' cgSecretOk (CG_SECRET, sp-content-gen)
  "padded-compare": {
    expect: 3,
    normalize: [
      [/\bcgSecretOk\b/g, "secretOk"],
      [/\b(?:DRAFT_SECRET|WEBHOOK_SECRET|CG_SECRET)\b/g, "SECRET"],
    ],
  },
  // bounded-append counter: Handle TG Update's logCapped (ctrFile
  // param, events_seen field) and Generate Drafts' logReject
  // (REJECT_CTR const, rejects_seen field)
  "bounded-append": {
    expect: 2,
    normalize: [
      [/\b(?:ctrFile|REJECT_CTR)\b/g, "CTR"],
      [/\b(?:events_seen|rejects_seen)\b/g, "seen"],
    ],
  },
  // the coupled platform list in its two shapes: the gate blocks
  // (ALL_PLATFORMS fan-out list, facebook->fb alias map, ENABLED
  // expansion loop) run as identical copies in Publish Tick
  // (sp-publish), Handle TG Update and Compose Message
  // (sp-tg-moderation, issue #60 - the card's LIVE/SIM tag reads it);
  // Generate Drafts' MAP (sp-content-gen) carries the same platform
  // list as platform -> writer-* role keys - a different shape, so it
  // forms its own normalized class (maxClasses: 2 allows exactly the
  // two shapes while still demanding the gate copies stay
  // line-identical). tokenSet then compares the one property every
  // shape must share - the platform list itself - so a platform
  // added to MAP but not to ALL_PLATFORMS fails the same way an
  // edited gate copy does
  "enabled-platforms": {
    expect: 4,
    maxClasses: 2,
    tokenSet: PLATFORM_TOKEN_RE,
  },
  // PUBLISH_SIMULATE env-flag parse (issue #41): Publish Tick
  // (sp-publish) reads the flag once for both drivers - a single
  // copy today, tracked under its own group so the marker itself
  // stays accounted for
  "publish-simulate": { expect: 1 },
  // postLink external_id -> operator-facing post reference (issue
  // #43): VK numeric <owner>_<post> folds to a clickable wall URL,
  // LinkedIn share URNs render labeled (not a fake URL), 'sim-' ids
  // stay literal. Publish Tick only (sp-publish) - single copy,
  // tracked so the marker stays accounted for
  "publish-post-link": { expect: 1 },
  // REWRITE_WINDOW_MS const: Prepare Draft plus the 'ap' and 'ed'
  // refusal sites in Handle TG Update (all sp-tg-moderation) - the
  // copies sit at different nesting depths, so leading indentation
  // is stripped before comparing
  "rewrite-window-ms": {
    expect: 3,
    normalize: [[/^\s+/gm, ""]],
  },
  // withLock tokened fs lock + LockBusyError (issue #70): Prepare
  // Draft, Handle TG Update and Handle Pangram Results
  // (sp-tg-moderation), Publish Tick (sp-publish) and Eval Tick
  // (sp-humanizer-eval) - the whole block is one fixed shape, so the
  // copies compare identical with no normalization
  "file-lock": { expect: 5 },
  // updateDraft guarded re-read+mutate: Handle TG Update, Prepare
  // Draft and Handle Pangram Results (all sp-tg-moderation). The
  // load/save lines legitimately differ (loadDraft/saveDraft wrappers
  // vs inline readFileSync/writeJsonAtomic) and normalize to LOAD/SAVE
  // placeholders; the guard/mutate contract must stay identical
  "update-draft": {
    expect: 3,
    normalize: [
      [/const cur = loadDraft\(id\);/, "const cur = LOAD;"],
      [
        /const cur = JSON\.parse\(\s*fs\.readFileSync\(DRAFTS \+ '\/' \+ id \+ '\.json', 'utf8'\)\);/,
        "const cur = LOAD;",
      ],
      [/saveDraft\(cur\);/, "SAVE;"],
      [/writeJsonAtomic\(DRAFTS \+ '\/' \+ id \+ '\.json', cur\);/, "SAVE;"],
    ],
  },
  // validateDraftShape light shape gate (issue #69): identical
  // copies in Handle TG Update, Prepare Draft, Compose Message and
  // Handle Pangram Results (all sp-tg-moderation) - every draft-file
  // write path validates before the tmp+rename
  "draft-shape": { expect: 4 },
  // the guarded-write snapshot comparator: sameDraftSnapshot (an arrow
  // helper in Handle TG Update) vs the inline sameSnapshot const in
  // Compose Message - same field list, different binding names and
  // line wraps, so identifiers fold to the HTU names, the arrow
  // signature is dropped and the whole block collapses to one
  // whitespace-normalized token stream
  "draft-snapshot": {
    expect: 2,
    normalize: [
      [/\b(?:sameDraftSnapshot|sameSnapshot)\b/g, "CMP"],
      [/\bdraftCur\b/g, "cur"],
      [/\bdraft\b/g, "d"],
      [/\(cur, d\) =>/, ""],
      [/\s+/g, " "],
      [/^\s+|\s+$/g, ""],
    ],
  },
  // scrubSecrets secret masking: Generate Drafts (sp-content-gen),
  // Handle TG Update and Handle Pangram Results (sp-tg-moderation),
  // Resolve Chat + Webhook (sp-tg-setup) and Analytics Tick
  // (sp-analytics). The >=8 length floor lives inside the loop in all
  // five copies; SECRET_VALUES collection itself legitimately differs
  // per node and stays outside the markers. Publish Tick's
  // scrub/KNOWN_TOKENS is INTENTIONALLY divergent (a dynamic token
  // set plus access_token= form masking) and must NOT get a copy
  // here
  "scrub-secrets": { expect: 5 },
  // Pangram AI-check warn-gate prelude (issue #76): the PANGRAM_*
  // env reads, the whitespace-split word count, the text FNV-1a and
  // the daily-credits counter loader - identical copies in Prepare
  // Draft (fresh-check enqueue) and Handle Pangram Results (result
  // replies, credit re-sync, the text-hash re-check), both
  // sp-tg-moderation. WARN-mode only: a drifted copy would split the
  // gate's accounting between the two readers
  "pangram-gate": { expect: 2 },
  // the 5MB per-file media cap: Prepare Draft and Fan Out Album (both
  // sp-tg-moderation). Fan Out Album's re-read fallback must cap at
  // exactly the bound Prepare Draft filtered the album's paths by -
  // the paired binaries arrive pre-capped, but a bare literal on each
  // side could drift (issue #60 review). The copies sit at different
  // nesting depths, so leading indentation is stripped
  "media-cap": {
    expect: 2,
    normalize: [[/^\s+/gm, ""]],
  },
  // media path resolution against the read-only materials mount
  // (issue #36): identical copies in Prepare Draft and Fan Out Album
  // (sp-tg-moderation - the mediaGroup fallback re-reads the same
  // paths, issue #60) and Publish Tick (sp-publish). Covers
  // MEDIA_ROOT consts, the underRoot realpath escape guard,
  // resolveMedia's candidate order and mimeOf - the container-side
  // half of the photo-upload contract: the rel path Publish Tick
  // sends to vk_token_service's /vk-photo-upload must resolve under
  // the same root Prepare Draft previewed the file under
  "media-resolve": { expect: 3 },
  // registryEvent append-only event writer (issue #12, the post
  // registry): identical copies in Generate Drafts (sp-content-gen),
  // Handle TG Update (sp-tg-moderation) and Publish Tick (sp-publish).
  // The helper embeds an inline sha1 (Code nodes only require fs), so
  // any fix must replicate to all three or the event streams diverge
  "registry-event": { expect: 3 },
  // preview card assembly (issue #42): the '[DRAFT ...]' message
  // build - cap(), header/TEST/Scope/text/[WARNINGS/[media] lines and
  // the assembled 3900-char cap - shared by Compose Message
  // (sp-tg-moderation) and the Edit 'replace'-mode re-preview in
  // Handle TG Update. Inputs (id/draft/warnings/media/mediaSent/
  // failed) sit outside the markers; the copies sit at different
  // nesting depths, so leading indentation is stripped
  "preview-message": {
    expect: 2,
    normalize: [[/^\s+/gm, ""]],
  },
  // the FNV-1a preview_v token computation over msg + the
  // publish-relevant payload fields: Compose Message and the Edit
  // 'replace'-mode re-preview in Handle TG Update. A ver computed
  // differently between the two would make re-preview buttons
  // bind to a different hash than pipeline previews do
  "preview-v-fnv": {
    expect: 2,
    normalize: [[/^\s+/gm, ""]],
  },
  // the four-button moderation keyboard (issue #42: Approve/Edit/
  // Rework/Reject with '<act>:<id><verSuffix>' callback_data): the
  // preview sendMessage in Compose Message, the replace-mode
  // re-preview send and the rewrite-expired keyboard restore in
  // Handle TG Update. verSuffix is bound per-site (':' + ver, or ''
  // for a legacy pre-preview_v draft) so the blocks stay identical
  "preview-keyboard": {
    expect: 3,
    normalize: [[/^\s+/gm, ""]],
  },
  // mkdirErrs collection prelude: Handle TG Update, Prepare Draft
  // and Handle Pangram Results (all sp-tg-moderation), Resolve Chat
  // + Webhook (sp-tg-setup), Generate Drafts (sp-content-gen),
  // Analytics Tick (sp-analytics) and Eval Tick
  // (sp-humanizer-eval). Only the dir list and the loop variable
  // name differ per node. Publish Tick's plain mkdirSync swallow is
  // a different contract on purpose (a missing dir surfaces through
  // mv()/log() failures there, not per-item refusals) and stays
  // unmarked
  "mkdir-collect": {
    expect: 7,
    normalize: [
      [/of \[[^\]]*\]/, "of [DIRS]"],
      [/\b(?:d0|d)\b/g, "D"],
    ],
  },
  // the api.telegram.org request contract shared by the six tg()
  // helpers (Publish Tick, Handle TG Update, Compose Message,
  // Handle Pangram Results, Resolve Chat + Webhook, Analytics Tick)
  // and Generate Drafts'
  // notify() sendMessage: POST + bot-token URL + json:true +
  // explicit 30s timeout - an unbounded httpRequest hangs the node
  // behind it. Call-opening lines (return await / return / await)
  // and per-node rationale comments legitimately differ; Generate
  // Drafts carries an inline body and a literal /sendMessage URL,
  // so it forms a second normalized class (maxClasses: 2). tokenSet
  // then polices the contract tokens every copy must share on the
  // RAW text
  "tg-timeout": {
    expect: 7,
    maxClasses: 2,
    tokenSet: /api\.telegram\.org|method: 'POST'|json: true|timeout: [0-9]+/g,
    normalize: [
      // whole-line comments differ per node (each explains its own
      // stall consequence) - drop them with their newline
      [/^[ \t]*\/\/[^\n]*(?:\n|$)/gm, ""],
      // collapse the call-opening line (return await / return /
      // await + differing receivers)
      [/^.*httpRequest.*$/m, "REQ("],
      // leading indentation differs by nesting depth
      [/^[ \t]+/gm, ""],
    ],
  },
};

const BEGIN = /^\s*\/\/\s*SYNC-BEGIN:\s*([A-Za-z0-9_-]+)\s*$/;
const END = /^\s*\/\/\s*SYNC-END:\s*([A-Za-z0-9_-]+)\s*$/;

// collect every marked block: [{group, where, lines}]
const blocks = [];
let bad = 0;
for (const file of fs
  .readdirSync(WF_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(WF_DIR, file), "utf8"));
  } catch (e) {
    console.log("FAIL %s: unreadable JSON (%s)", file, e.message);
    bad++;
    continue;
  }
  for (const node of doc.nodes || []) {
    const code = node.parameters?.jsCode;
    if (!code) continue;
    const where = `${file} / ${node.name}`;
    let open = null;
    code.split("\n").forEach((line, i) => {
      const b = BEGIN.exec(line);
      const e = END.exec(line);
      if (b) {
        if (open) {
          console.log("FAIL %s:%d: SYNC-BEGIN inside open block %s", where, i + 1, open.group);
          bad++;
        }
        open = { group: b[1], where: `${where}:${i + 1}`, lines: [] };
      } else if (e) {
        if (!open || open.group !== e[1]) {
          console.log(
            "FAIL %s:%d: SYNC-END %s without matching " + "SYNC-BEGIN",
            where,
            i + 1,
            e[1],
          );
          bad++;
        } else {
          blocks.push(open);
          open = null;
        }
      } else if (open) {
        open.lines.push(line);
      }
    });
    if (open) {
      console.log("FAIL %s: SYNC-BEGIN %s never closed", where, open.group);
      bad++;
    }
  }
}

const normalize = (group, lines) => {
  let text = lines.join("\n");
  for (const [re, rep] of GROUPS[group].normalize || []) {
    text = text.replace(re, rep);
  }
  return text;
};

for (const [group, cfg] of Object.entries(GROUPS)) {
  const members = blocks.filter((b) => b.group === group);
  if (members.length !== cfg.expect) {
    console.log(
      "FAIL %s: expected %d copies, found %d (%s)",
      group,
      cfg.expect,
      members.length,
      members.map((m) => m.where).join(", ") || "none",
    );
    bad++;
    continue;
  }
  // partition members into identical-body classes: most groups allow
  // exactly one (every copy line-identical after normalize); a group
  // whose copies knowingly come in several SHAPES (the
  // enabled-platforms gate blocks vs the writer MAP) declares
  // maxClasses so the shapes may differ while copies of the same
  // shape still must not drift apart
  const classes = new Map();
  for (const m of members) {
    const t = normalize(group, m.lines);
    if (!classes.has(t)) classes.set(t, []);
    classes.get(t).push(m);
  }
  if (classes.size > (cfg.maxClasses || 1)) {
    // first-difference report between the first members of the first
    // two classes, enough to locate the drift by hand
    const [ca, cb] = [...classes.values()];
    const a = [...classes.keys()][0].split("\n");
    const b = [...classes.keys()][1].split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(
      "FAIL %s: %s differs from %s at line %d\n" + "    %s: %s\n    %s: %s",
      group,
      cb[0].where,
      ca[0].where,
      i + 1,
      ca[0].where,
      a[i] || "<eof>",
      cb[0].where,
      b[i] || "<eof>",
    );
    bad++;
    continue;
  }
  // tokenSet: the shared property several shapes must agree on - for
  // enabled-platforms that is the platform list itself, reduced to a
  // sorted token set per copy. Compared on the RAW lines (normalize
  // rewrites identifiers, the tokens must come from the real text)
  if (cfg.tokenSet) {
    const sets = members.map((m) =>
      [...new Set(m.lines.join("\n").match(cfg.tokenSet) || [])].sort().join(","),
    );
    if (!sets.every((s) => s === sets[0])) {
      console.log(
        "FAIL %s: token sets differ (%s)",
        group,
        members.map((m, i) => `${m.where} -> ${sets[i]}`).join("; "),
      );
      bad++;
      continue;
    }
  }
  console.log(
    "ok   %s: %d copies%s (%s)",
    group,
    members.length,
    classes.size === 1 ? " identical" : ` in ${classes.size} shapes, token sets equal`,
    members.map((m) => m.where).join(", "),
  );
}

// cross-group platform guard (issue #69 review): DRAFT_PLATFORMS
// inside the draft-shape copies is a fifth spelling of the platform
// list, living outside the enabled-platforms marker - its token set
// must equal the enabled-platforms set minus the 'all' fan-out
// token, so a platform added on either side fails here instead of
// drifting silently
{
  const tok = (b) =>
    [
      ...new Set(b.lines.join("\n").match(PLATFORM_TOKEN_RE) || []),
    ].sort();
  const ep = blocks.find((b) => b.group === "enabled-platforms");
  const want = ep ? tok(ep).filter((t) => t !== "all") : [];
  let drift = 0;
  for (const m of blocks.filter((b) => b.group === "draft-shape")) {
    const got = tok(m);
    if (got.join(",") !== want.join(",")) {
      console.log(
        "FAIL draft-shape %s: platform tokens %s != enabled-platforms %s (minus 'all')",
        m.where,
        got.join(","),
        want.join(","),
      );
      drift++;
      bad++;
    }
  }
  if (ep && !drift) {
    console.log("ok   draft-shape: platform set matches enabled-platforms minus 'all'");
  }
}

// a marker group with no GROUPS entry would silently go unchecked -
// treat it as a failure so new helpers must be registered here
for (const b of blocks) {
  if (!GROUPS[b.group]) {
    console.log(
      "FAIL %s: unknown SYNC group %s - add it to GROUPS " + "in tools/check_sync.js",
      b.where,
      b.group,
    );
    bad++;
  }
}

process.exit(bad ? 1 : 0);
