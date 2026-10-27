#!/usr/bin/env node
// deploy_workflow.js - insert or update an n8n workflow directly in the
// n8n SQLite DB (n8n REST API needs auth; the sqlite patch path is proven).
//
// Run with the n8n container STOPPED:
//   node tools/deploy_workflow.js workflows/media-trend-scout.json [--update]
//   node tools/deploy_workflow.js <file.json> --db=/path/database.sqlite
//   node tools/deploy_workflow.js <file.json> --db /path/database.sqlite
//
// Default DB: resolved at runtime via
// `docker volume inspect shared-person_n8n_storage` - the volume's
// _data dir can sit under an unrelated project's docker-data tree
// (rootless docker keeps all volumes in one per-user store), so a
// hardcoded host path would silently patch the wrong n8n. When docker
// cannot resolve it, pass --db explicitly.
//
// Workflow file format:
//   { "name": "...", "active": true,
//     "nodes": [...], "connections": {...},
//     "settings": {...} (optional),
//     "triggers": [ {"node": "Webhook X", "path": "my-hook"} ]  (optional)
//   }
//
// Activation pointers (n8n 2.x): workflow_entity.activeVersionId,
// workflow_published_version.publishedVersionId, plus for triggers:
// webhook_entity rows and workflow_publication_trigger_status.
// Credentials: node credentials in the JSON reference credential names;
// shared_workflow row is created for the owner project automatically.

const { DatabaseSync } = require('node:sqlite');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
// supports both `--db=path` and `--db path` forms
const arg = (k) => {
  const eq = argv.find((a) => a.startsWith(`--${k}=`));
  if (eq !== undefined) return eq.slice(k.length + 3);
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) {
    return argv[i + 1];
  }
  return '';
};
// the workflow file is the first *.json positional - flag arguments
// (--db=x.json) and the value of `--db <file>.json` must not match it
const file = argv.find((a, i) =>
  a.endsWith('.json') && !a.startsWith('--') && argv[i - 1] !== '--db');
const UPDATE = argv.includes('--update');
// resolve the n8n DB from the docker volume instead of hardcoding a
// host path - see the header comment
const defaultDb = () => {
  try {
    const mp = execSync(
      'docker volume inspect shared-person_n8n_storage --format "{{.Mountpoint}}"',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (mp) return path.join(mp, '.n8n', 'database.sqlite');
  } catch (e) {}
  return null;
};
const DB = arg('db') || defaultDb();

if (!file) {
  console.error('usage: node tools/deploy_workflow.js <workflow.json> [--update] [--db=path|--db path]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`workflow file not found: ${file}`);
  process.exit(1);
}
if (!DB) {
  console.error('could not resolve the n8n DB from docker volume ' +
    'shared-person_n8n_storage - pass --db <path>/database.sqlite');
  process.exit(1);
}
if (!fs.existsSync(DB)) {
  console.error(`n8n DB not found: ${DB}`);
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
const { name, nodes, connections } = spec;
const settings = spec.settings ?? { executionOrder: 'v1' };
const triggers = spec.triggers ?? [];
const active = spec.active === false ? 0 : 1;

const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
const VER_ID = crypto.randomUUID();
const nodesJson = JSON.stringify(nodes);
const connJson = JSON.stringify(connections);

const db = new DatabaseSync(DB);

// schema-adaptive insert: keep only columns the table actually has
// (n8n versions differ: webhook_entity may lack createdAt/updatedAt,
// trigger status uses nodeId+triggerKind vs nodeName+nodeType)
const colsOf = (table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const ins = (table, row) => {
  const cols = colsOf(table);
  const keys = Object.keys(row).filter((k) => cols.has(k));
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')})
    VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
};

// trigger + webhook registration for one workflow id. Activation drops
// webhook_entity and workflow_publication_trigger_status rows, so both
// create and --update paths have to write them again.
const registerTriggers = (wfId) => {
  for (const t of triggers) {
    const node = nodes.find((n) => n.name === t.node);
    if (t.path) {
      const webhookId = node?.webhookId || node?.parameters?.webhookId || crypto.randomUUID();
      const variant = `${wfId}/${encodeURIComponent(t.node)}/${t.path}`;
      for (const p of [t.path, variant]) {
        ins('webhook_entity', {
          webhookPath: p, method: t.method || 'POST', node: t.node,
          webhookId, workflowId: wfId, pathLength: p.length,
          createdAt: now, updatedAt: now,
        });
      }
    }
    ins('workflow_publication_trigger_status', {
      workflowId: wfId,
      nodeId: node?.id || t.node,
      nodeName: t.node,
      nodeType: t.path ? 'persisted' : 'in-memory',
      triggerKind: t.path ? 'persisted' : 'in-memory',
      versionId: VER_ID,
      status: 'activated',
      createdAt: now, updatedAt: now,
    });
  }
};

db.exec('BEGIN');
try {
  if (UPDATE) {
    const wf = db.prepare('SELECT id FROM workflow_entity WHERE name = ?').get(name);
    if (!wf) { console.error(`workflow "${name}" not found - run without --update first`); process.exit(1); }
    db.prepare(`INSERT INTO workflow_history
      (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(VER_ID, wf.id, 'deploy_workflow.js --update', now, now, nodesJson, connJson, name, 0);
    // schema-adaptive UPDATE like the rest of the script: n8n 2.x
    // versions differ on whether workflow_entity still has an `active`
    // column (2.x leans on activeVersionId) - write only the columns
    // that exist so a missing one cannot throw mid-transaction and
    // roll the whole deploy back
    const wfCols = colsOf('workflow_entity');
    const sets = [];
    const vals = [];
    for (const [col, val] of [
      ['nodes', nodesJson],
      ['connections', connJson],
      // spec-level settings (executionOrder, timeouts, ...) apply on
      // --update too - dropping them kept the values from the
      // original insert, so a spec change looked deployed but was not
      ['settings', JSON.stringify(settings)],
      ['versionId', VER_ID],
      ['activeVersionId', active ? VER_ID : null],
      ['active', active],
      ['updatedAt', now],
    ]) {
      if (wfCols.has(col)) { sets.push(`${col}=?`); vals.push(val); }
    }
    db.prepare(`UPDATE workflow_entity SET ${sets.join(',')} WHERE id=?`)
      .run(...vals, wf.id);
    // published-version and trigger rows only make sense for an ACTIVE
    // workflow - writing 'activated' rows for an inactive spec leaves
    // registry entries pointing at a version that never runs
    if (active) {
      // published_version row may be missing after a deactivation - upsert
      db.prepare(`INSERT INTO workflow_published_version
        (workflowId,publishedVersionId,createdAt,updatedAt) VALUES (?,?,?,?)
        ON CONFLICT(workflowId) DO UPDATE SET publishedVersionId=excluded.publishedVersionId,updatedAt=excluded.updatedAt`)
        .run(wf.id, VER_ID, now, now);
      // clear the previous registration first: INSERT OR REPLACE below
      // only writes rows for triggers in the new spec - rows left over
      // from a renamed node or a changed webhook path would stay live
      // and keep routing to this workflow (ghost webhooks)
      for (const t of ['workflow_publication_trigger_status', 'webhook_entity']) {
        // guard on the column, not just the table: a schema without
        // workflowId would throw mid-transaction on the DELETE
        if (colsOf(t).has('workflowId')) {
          db.prepare(`DELETE FROM ${t} WHERE workflowId=?`).run(wf.id);
        }
      }
      // trigger status + webhook rows are also dropped on deactivation -
      // re-register (schema-adaptive, same helper as the create path)
      registerTriggers(wf.id);
    } else {
      // spec deactivates the workflow: clear stale 'activated'
      // registrations left over from a previously active version.
      // Verified against n8n 2.41.3 source (useWorkflowPublicationService
      // is the default on 2.x): deactivateWorkflow ->
      // _unpublishViaOutbox clears workflow_entity.active/
      // activeVersionId synchronously, then the outbox consumer's
      // WorkflowPublicationApplier.unpublish() tears down trigger
      // registrations AND calls
      // workflowPublishedVersionRepository.removePublishedVersion() -
      // so a real n8n deactivate DOES delete the
      // workflow_published_version row (asynchronously, same final
      // state). Deleting all three tables here mirrors exactly that.
      for (const t of ['workflow_published_version',
        'workflow_publication_trigger_status', 'webhook_entity']) {
        if (colsOf(t).has('workflowId')) {
          db.prepare(`DELETE FROM ${t} WHERE workflowId=?`).run(wf.id);
        }
      }
    }
    console.log('updated workflow', wf.id, 'version', VER_ID, 'active', active);
  } else {
    const WF_ID = crypto.randomUUID().slice(0, 16);
    // cyclic FK entity<->history: entity first with NULL activeVersionId,
    // then history, then back-update. Same column-existence guard as the
    // update path - a schema without `active`/`activeVersionId` must not
    // throw mid-transaction
    ins('workflow_entity', {
      id: WF_ID, name, active, nodes: nodesJson, connections: connJson,
      settings: JSON.stringify(settings), versionId: VER_ID,
      triggerCount: triggers.length, createdAt: now, updatedAt: now,
      isArchived: 0, versionCounter: 1, activeVersionId: null,
    });
    db.prepare(`INSERT INTO workflow_history
      (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(VER_ID, WF_ID, 'deploy_workflow.js', now, now, nodesJson, connJson, name, 0);
    // same invariant as the update path: published-version and
    // activeVersionId pointers only exist for an ACTIVE spec - an
    // inactive create must not register a version that never runs
    if (active) {
      db.prepare(`UPDATE workflow_entity SET activeVersionId=? WHERE id=?`).run(VER_ID, WF_ID);
      db.prepare(`INSERT INTO workflow_published_version
        (workflowId,publishedVersionId,createdAt,updatedAt) VALUES (?,?,?,?)`)
        .run(WF_ID, VER_ID, now, now);
    }

    // owner binding - required, else EntityNotFoundError on publish
    const proj = db.prepare(
      `SELECT id FROM project WHERE type='personal' LIMIT 1`).get();
    if (proj) {
      db.prepare(`INSERT INTO shared_workflow
        (createdAt,updatedAt,role,workflowId,projectId) VALUES (?,?,?,?,?)`)
        .run(now, now, 'workflow:owner', WF_ID, proj.id);
    }

    // trigger + webhook registration (schema-adaptive ins() helper)
    if (active) registerTriggers(WF_ID);
    console.log('inserted workflow', WF_ID, 'version', VER_ID, 'triggers', triggers.length);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
} finally {
  db.close();
}
console.log('done:', name);
