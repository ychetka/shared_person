#!/usr/bin/env node
// verify_workflows.js - drift check: do the PUBLISHED workflow versions
// in the live n8n DB still match the repo specs in n8n/workflows/*.json?
//
// Policy (issue #13): the repo files are the only source of truth; the
// n8n volume is a disposable cache. Anything in the DB that differs
// from git is drift - a manual UI edit that the next deploy would
// silently overwrite anyway.
//
// Run:  node tools/verify_workflows.js [--db=path|--db path]
// Exit: 0 = every repo spec matches its live DB state; 1 = drift or
//       unreadable DB. The n8n container does NOT need to be stopped
//       (read-only open).
//
// What is compared: for each spec, the workflow_published_version row
// (the snapshot n8n actually executes) -> workflow_history.nodes and
// .connections are deep-compared to spec.nodes/spec.connections after
// canonicalization (object keys sorted). Specs with active != true are
// expected to have NO published row - the deployer mirrors an n8n
// deactivate by deleting it - so an inactive spec with no published
// row is `ok`, and an inactive spec WITH a live published row is
// reverse drift. The entity's activeVersionId is also reported when it
// differs from the published snapshot - a half-applied deploy.

const { DatabaseSync } = require("node:sqlite");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const arg = (k) => {
  const eq = argv.find((a) => a.startsWith(`--${k}=`));
  if (eq !== undefined) return eq.slice(k.length + 3);
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    return argv[i + 1];
  }
  return "";
};
const dbFlagGiven = argv.some((a) => a === "--db" || a.startsWith("--db="));
const defaultDb = () => {
  try {
    const mp = execSync(
      'docker volume inspect shared-person_n8n_storage --format "{{.Mountpoint}}"',
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    if (mp) return path.join(mp, ".n8n", "database.sqlite");
  } catch (_e) {}
  return null;
};
const DB = dbFlagGiven ? arg("db") : defaultDb();
if (dbFlagGiven && !DB) {
  console.error("--db requires a path value: --db=<path>/database.sqlite or --db <path>");
  process.exit(1);
}
if (!DB || !fs.existsSync(DB)) {
  console.error(
    `n8n DB not found (${DB || "unresolved"}) - set DOCKER_HOST for ` +
      "rootless docker or pass --db <path>/database.sqlite",
  );
  process.exit(1);
}

const WF_DIR = path.join(__dirname, "..", "n8n", "workflows");
const specFiles = fs
  .readdirSync(WF_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
if (!specFiles.length) {
  console.error(`no workflow specs in ${WF_DIR}`);
  process.exit(1);
}

// canonical deep-compare: DB stores JSON.stringify(spec.nodes), but key
// order inside stored node objects may differ after an n8n round-trip
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const db = new DatabaseSync(DB, { readOnly: true });
const tableHas = (t) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined;
const colHas = (t, c) =>
  db
    .prepare(`PRAGMA table_info(${t})`)
    .all()
    .some((r) => r.name === c);
const hasPublished = tableHas("workflow_published_version");
const hasHistory = tableHas("workflow_history");
const hasActiveVer = colHas("workflow_entity", "activeVersionId");
const hasArchived = colHas("workflow_entity", "isArchived");
if (!hasPublished || !hasHistory) {
  console.error(
    "DB schema predates published-version tables " +
      "(workflow_published_version/workflow_history missing) - " +
      "cannot compare live snapshots on this n8n version",
  );
  process.exit(1);
}

const entCols = `id, name${hasActiveVer ? ", activeVersionId" : ""}${hasArchived ? ", isArchived" : ""}`;
const rows = db.prepare(`SELECT ${entCols} FROM workflow_entity`).all();
// name -> [rows]: duplicate names are a data error deploy_workflow.js
// refuses on write; collapsing them here would report drift against an
// arbitrary row, so they get their own explicit FAIL below
const byName = new Map();
for (const r of rows) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}
const pubOf = new Map(
  db
    .prepare("SELECT workflowId, publishedVersionId FROM workflow_published_version")
    .all()
    .map((r) => [r.workflowId, r.publishedVersionId]),
);
const histGet = db.prepare("SELECT nodes, connections FROM workflow_history WHERE versionId = ?");

let fails = 0;
const specNames = new Set();
for (const f of specFiles) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(WF_DIR, f), "utf8"));
  } catch (e) {
    console.log(`FAIL ${f}: spec does not parse - ${e.message}`);
    fails++;
    continue;
  }
  // spec-shape guard: a malformed spec must FAIL its own line, not
  // crash the run mid-loop (same contract as deploy_workflow.js's
  // specFail, read-only side)
  if (
    !spec ||
    typeof spec !== "object" ||
    typeof spec.name !== "string" ||
    !spec.name.trim() ||
    !Array.isArray(spec.nodes) ||
    !spec.nodes.length ||
    !spec.nodes.every((n) => n && typeof n.name === "string")
  ) {
    console.log(`FAIL ${f}: spec shape invalid (needs name + non-empty nodes[] with names)`);
    fails++;
    continue;
  }
  specNames.add(spec.name);
  const specActive = spec.active === true;
  const ents = byName.get(spec.name) || [];
  if (ents.length > 1) {
    console.log(
      `FAIL ${f} (${spec.name}): ${ents.length} workflow_entity rows share ` +
        "this name - ambiguous, deploy_workflow.js refuses this too; " +
        "deduplicate in the DB first",
    );
    fails++;
    continue;
  }
  const ent = ents[0];
  if (!ent) {
    console.log(`FAIL ${f} (${spec.name}): not present in live DB`);
    fails++;
    continue;
  }
  const pubId = pubOf.get(ent.id);
  if (!specActive) {
    // inactive spec: no published row is the correct mirrored state
    if (!pubId) {
      console.log(`ok   ${f} (${spec.name}) [inactive by spec]`);
    } else {
      console.log(
        `FAIL ${f} (${spec.name}): spec is inactive but the DB still ` +
          "has a published version - deploy with --update to mirror the deactivate",
      );
      fails++;
    }
    continue;
  }
  if (!pubId) {
    console.log(
      `FAIL ${f} (${spec.name}): active spec but no published version ` +
        "in DB (never deployed or deactivated)",
    );
    fails++;
    continue;
  }
  const hist = histGet.get(pubId);
  if (!hist) {
    console.log(`FAIL ${f} (${spec.name}): published version ${pubId} has no history row`);
    fails++;
    continue;
  }
  let liveNodes, liveConn;
  try {
    liveNodes = JSON.parse(hist.nodes);
    liveConn = JSON.parse(hist.connections || "{}");
  } catch (e) {
    console.log(`FAIL ${f} (${spec.name}): history row does not parse - ${e.message}`);
    fails++;
    continue;
  }
  if (!Array.isArray(liveNodes)) {
    console.log(`FAIL ${f} (${spec.name}): history nodes is not an array`);
    fails++;
    continue;
  }
  const diffs = [];
  if (!same(liveNodes, spec.nodes)) {
    const liveNames = new Set(liveNodes.map((n) => n?.name));
    const specNames2 = new Set(spec.nodes.map((n) => n.name));
    const missing = [...specNames2].filter((n) => !liveNames.has(n));
    const extra = [...liveNames].filter((n) => !specNames2.has(n));
    const changed = spec.nodes.filter(
      (n) =>
        liveNames.has(n.name) &&
        !same(
          n,
          liveNodes.find((m) => m && m.name === n.name),
        ),
    );
    diffs.push(
      `nodes differ${missing.length ? ` (missing in DB: ${missing.join(", ")})` : ""}` +
        `${extra.length ? ` (extra in DB: ${extra.join(", ")})` : ""}` +
        `${changed.length ? ` (changed: ${changed.map((n) => n.name).join(", ")})` : ""}`,
    );
  }
  if (!same(liveConn, spec.connections || {})) {
    diffs.push("connections differ");
  }
  const staleActive =
    hasActiveVer && ent.activeVersionId && ent.activeVersionId !== pubId
      ? ` [note: activeVersionId ${ent.activeVersionId} != published ${pubId}]`
      : "";
  if (diffs.length) {
    console.log(`FAIL ${f} (${spec.name}): ${diffs.join("; ")}${staleActive}`);
    fails++;
  } else {
    console.log(`ok   ${f} (${spec.name})${staleActive}`);
  }
}
for (const r of rows) {
  if (hasArchived && r.isArchived) continue;
  if (!specNames.has(r.name)) {
    console.log(
      `WARN DB workflow "${r.name}" has no repo spec - ` +
        "outside git control, will not survive a volume wipe",
    );
  }
}
db.close();
console.log(fails ? `verify: ${fails} workflow(s) drifted` : "verify: all workflows match repo");
process.exitCode = fails ? 1 : 0;
