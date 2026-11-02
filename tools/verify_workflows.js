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
// Exit: 0 = every repo spec matches its published DB version;
//       1 = drift, missing workflow, or unreadable DB.
// The n8n container does NOT need to be stopped (read-only open).
//
// What is compared: for each spec, the workflow_published_version row
// (the snapshot n8n actually executes) -> workflow_history.nodes and
// .connections are deep-compared to spec.nodes/spec.connections after
// canonicalization (object keys sorted). The entity's activeVersionId
// is also reported when it differs from the published snapshot -
// that is a half-applied deploy, not drift.

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
const hasPublished = tableHas("workflow_published_version");

const rows = db.prepare("SELECT id, name, activeVersionId FROM workflow_entity").all();
const byName = new Map(rows.map((r) => [r.name, r]));
const pubOf = hasPublished
  ? new Map(
      db
        .prepare("SELECT workflowId, publishedVersionId FROM workflow_published_version")
        .all()
        .map((r) => [r.workflowId, r.publishedVersionId]),
    )
  : new Map();
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
  specNames.add(spec.name);
  const ent = byName.get(spec.name);
  if (!ent) {
    console.log(`FAIL ${f} (${spec.name}): not present in live DB`);
    fails++;
    continue;
  }
  const pubId = pubOf.get(ent.id);
  if (!pubId) {
    console.log(
      `FAIL ${f} (${spec.name}): no published version in DB (never deployed or deactivated)`,
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
  const liveNodes = JSON.parse(hist.nodes);
  const liveConn = JSON.parse(hist.connections || "{}");
  const diffs = [];
  if (!same(liveNodes, spec.nodes)) {
    const liveNames = new Set(liveNodes.map((n) => n.name));
    const specNames2 = new Set(spec.nodes.map((n) => n.name));
    const missing = [...specNames2].filter((n) => !liveNames.has(n));
    const extra = [...liveNames].filter((n) => !specNames2.has(n));
    const changed = spec.nodes.filter(
      (n) =>
        liveNames.has(n.name) &&
        !same(
          n,
          liveNodes.find((m) => m.name === n.name),
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
    ent.activeVersionId && ent.activeVersionId !== pubId
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
  if (!specNames.has(r.name)) {
    console.log(
      `WARN DB workflow "${r.name}" has no repo spec - ` +
        "outside git control, will not survive a volume wipe",
    );
  }
}
console.log(fails ? `verify: ${fails} workflow(s) drifted` : "verify: all workflows match repo");
process.exit(fails ? 1 : 0);
