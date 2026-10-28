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

const fs = require('fs');
const path = require('path');

const WF_DIR = path.join(__dirname, '..', 'n8n', 'workflows');

// platform tokens the enabled-platforms members must agree on.
// Whole-word matching keeps 'writer-fb' contributing 'fb' while
// ordinary prose inside the copies' comments cannot add a phantom
// token; 'all' is the fan-out token (MAP.all -> every writer) and
// counts like a platform name, the aliases 'fb'/'ig' count too.
const PLATFORM_TOKEN_RE =
  /\b(?:all|facebook|fb|ig|instagram|linkedin|tiktok|twitter|vk|youtube)\b/g;

// expect = exact number of copies that must carry the marker pair, so
// a deleted or newly added copy is caught as well as an edited one.
// normalize = [regex, replacement] pairs applied before comparison.
// maxClasses = how many distinct normalized bodies the group may have
// (default 1 - all copies identical); tokenSet = a regex whose whole-
// word matches must yield the same SET on every copy's raw text.
const GROUPS = {
  // plain tmp+rename writeJsonAtomic: Handle TG Update, Prepare Draft,
  // Compose Message (sp-tg-moderation), Generate Drafts
  // (sp-content-gen), Resolve Chat + Webhook (sp-tg-setup)
  'write-json-atomic': { expect: 5 },
  // Publish Tick's copy is the hardened 0o600 variant - intentionally
  // different from the plain copies, tracked under its own group so
  // the marker itself stays accounted for
  'write-json-atomic-hardened': { expect: 1 },
  // secretOk padded compare: Handle TG Update (WEBHOOK_SECRET),
  // Prepare Draft (DRAFT_SECRET) - both sp-tg-moderation - and
  // Generate Drafts' cgSecretOk (CG_SECRET, sp-content-gen)
  'padded-compare': {
    expect: 3,
    normalize: [
      [/\bcgSecretOk\b/g, 'secretOk'],
      [/\b(?:DRAFT_SECRET|WEBHOOK_SECRET|CG_SECRET)\b/g, 'SECRET']
    ]
  },
  // bounded-append counter: Handle TG Update's logCapped (ctrFile
  // param, events_seen field) and Generate Drafts' logReject
  // (REJECT_CTR const, rejects_seen field)
  'bounded-append': {
    expect: 2,
    normalize: [
      [/\b(?:ctrFile|REJECT_CTR)\b/g, 'CTR'],
      [/\b(?:events_seen|rejects_seen)\b/g, 'seen']
    ]
  },
  // the coupled platform list in its two shapes: the gate blocks
  // (ALL_PLATFORMS fan-out list, facebook->fb alias map, ENABLED
  // expansion loop) run as identical copies in Publish Tick
  // (sp-publish) and Handle TG Update (sp-tg-moderation); Generate
  // Drafts' MAP (sp-content-gen) carries the same platform list as
  // platform -> writer-* role keys - a different shape, so it forms
  // its own normalized class (maxClasses: 2 allows exactly the two
  // shapes while still demanding the gate copies stay
  // line-identical). tokenSet then compares the one property every
  // shape must share - the platform list itself - so a platform
  // added to MAP but not to ALL_PLATFORMS fails the same way an
  // edited gate copy does
  'enabled-platforms': {
    expect: 3,
    maxClasses: 2,
    tokenSet: PLATFORM_TOKEN_RE
  },
  // REWRITE_WINDOW_MS const: Prepare Draft plus the 'ap' and 'ed'
  // refusal sites in Handle TG Update (all sp-tg-moderation) - the
  // copies sit at different nesting depths, so leading indentation
  // is stripped before comparing
  'rewrite-window-ms': {
    expect: 3,
    normalize: [
      [/^\s+/gm, '']
    ]
  }
};

const BEGIN = /^\s*\/\/\s*SYNC-BEGIN:\s*([A-Za-z0-9_-]+)\s*$/;
const END = /^\s*\/\/\s*SYNC-END:\s*([A-Za-z0-9_-]+)\s*$/;

// collect every marked block: [{group, where, lines}]
const blocks = [];
let bad = 0;
for (const file of fs.readdirSync(WF_DIR).filter((f) =>
  f.endsWith('.json')).sort()) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));
  } catch (e) {
    console.log('FAIL %s: unreadable JSON (%s)', file, e.message);
    bad++;
    continue;
  }
  for (const node of doc.nodes || []) {
    const code = node.parameters && node.parameters.jsCode;
    if (!code) continue;
    const where = file + ' / ' + node.name;
    let open = null;
    code.split('\n').forEach((line, i) => {
      const b = BEGIN.exec(line);
      const e = END.exec(line);
      if (b) {
        if (open) {
          console.log('FAIL %s:%d: SYNC-BEGIN inside open block %s',
            where, i + 1, open.group);
          bad++;
        }
        open = { group: b[1], where: where + ':' + (i + 1), lines: [] };
      } else if (e) {
        if (!open || open.group !== e[1]) {
          console.log('FAIL %s:%d: SYNC-END %s without matching ' +
            'SYNC-BEGIN', where, i + 1, e[1]);
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
      console.log('FAIL %s: SYNC-BEGIN %s never closed', where,
        open.group);
      bad++;
    }
  }
}

const normalize = (group, lines) => {
  let text = lines.join('\n');
  for (const [re, rep] of (GROUPS[group].normalize || [])) {
    text = text.replace(re, rep);
  }
  return text;
};

for (const [group, cfg] of Object.entries(GROUPS)) {
  const members = blocks.filter((b) => b.group === group);
  if (members.length !== cfg.expect) {
    console.log('FAIL %s: expected %d copies, found %d (%s)', group,
      cfg.expect, members.length,
      members.map((m) => m.where).join(', ') || 'none');
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
    const a = [...classes.keys()][0].split('\n');
    const b = [...classes.keys()][1].split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log('FAIL %s: %s differs from %s at line %d\n' +
      '    %s: %s\n    %s: %s', group, cb[0].where, ca[0].where,
      i + 1, ca[0].where, a[i] || '<eof>', cb[0].where,
      b[i] || '<eof>');
    bad++;
    continue;
  }
  // tokenSet: the shared property several shapes must agree on - for
  // enabled-platforms that is the platform list itself, reduced to a
  // sorted token set per copy. Compared on the RAW lines (normalize
  // rewrites identifiers, the tokens must come from the real text)
  if (cfg.tokenSet) {
    const sets = members.map((m) =>
      [...new Set(m.lines.join('\n').match(cfg.tokenSet) || [])]
        .sort().join(','));
    if (!sets.every((s) => s === sets[0])) {
      console.log('FAIL %s: token sets differ (%s)', group,
        members.map((m, i) => m.where + ' -> ' + sets[i]).join('; '));
      bad++;
      continue;
    }
  }
  console.log('ok   %s: %d copies%s (%s)', group, members.length,
    classes.size === 1 ? ' identical'
      : ' in ' + classes.size + ' shapes, token sets equal',
    members.map((m) => m.where).join(', '));
}

// a marker group with no GROUPS entry would silently go unchecked -
// treat it as a failure so new helpers must be registered here
for (const b of blocks) {
  if (!GROUPS[b.group]) {
    console.log('FAIL %s: unknown SYNC group %s - add it to GROUPS ' +
      'in tools/check_sync.js', b.where, b.group);
    bad++;
  }
}

process.exit(bad ? 1 : 0);
