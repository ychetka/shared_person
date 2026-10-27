#!/usr/bin/env node
// deploy_workflow.js - insert or update an n8n workflow directly in the
// n8n SQLite DB (n8n REST API needs auth; the sqlite patch path is proven).
//
// Run with the n8n container STOPPED:
//   node tools/deploy_workflow.js workflows/media-trend-scout.json [--update]
//   node tools/deploy_workflow.js <file.json> --db=/path/database.sqlite
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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const file = process.argv.find((a) => a.endsWith('.json'));
const UPDATE = process.argv.includes('--update');
const DB = arg('db') || path.join(
  process.env.HOME || '',
  'projects/trade-ai-analitic/docker-data/volumes/shared-person_n8n_storage/_data/.n8n/database.sqlite');

if (!file) {
  console.error('usage: node tools/deploy_workflow.js <workflow.json> [--update] [--db=path]');
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
          webhookId, workflowId: wfId, pathLength: t.path.length,
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
    db.prepare(`UPDATE workflow_entity SET nodes=?,connections=?,versionId=?,activeVersionId=?,active=?,updatedAt=? WHERE id=?`)
      .run(nodesJson, connJson, VER_ID, active ? VER_ID : null, active, now, wf.id);
    // published-version and trigger rows only make sense for an ACTIVE
    // workflow - writing 'activated' rows for an inactive spec leaves
    // registry entries pointing at a version that never runs
    if (active) {
      // published_version row may be missing after a deactivation - upsert
      db.prepare(`INSERT INTO workflow_published_version
        (workflowId,publishedVersionId,createdAt,updatedAt) VALUES (?,?,?,?)
        ON CONFLICT(workflowId) DO UPDATE SET publishedVersionId=excluded.publishedVersionId,updatedAt=excluded.updatedAt`)
        .run(wf.id, VER_ID, now, now);
      // trigger status + webhook rows are also dropped on deactivation -
      // re-register (schema-adaptive, same helper as the create path)
      registerTriggers(wf.id);
    } else {
      // spec deactivates the workflow: n8n drops these rows on
      // deactivate too - clear stale 'activated' registrations left
      // over from a previously active version
      for (const t of ['workflow_published_version',
        'workflow_publication_trigger_status', 'webhook_entity']) {
        if (colsOf(t).size) {
          db.prepare(`DELETE FROM ${t} WHERE workflowId=?`).run(wf.id);
        }
      }
    }
    console.log('updated workflow', wf.id, 'version', VER_ID, 'active', active);
  } else {
    const WF_ID = crypto.randomUUID().slice(0, 16);
    // cyclic FK entity<->history: entity first with NULL, then history, then back-update
    db.prepare(`INSERT INTO workflow_entity
      (id,name,active,nodes,connections,settings,versionId,triggerCount,createdAt,updatedAt,isArchived,versionCounter,activeVersionId)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run(WF_ID, name, active, nodesJson, connJson,
        JSON.stringify(settings), VER_ID, triggers.length, now, now, 0, 1);
    db.prepare(`INSERT INTO workflow_history
      (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(VER_ID, WF_ID, 'deploy_workflow.js', now, now, nodesJson, connJson, name, 0);
    db.prepare(`UPDATE workflow_entity SET activeVersionId=? WHERE id=?`).run(VER_ID, WF_ID);
    db.prepare(`INSERT INTO workflow_published_version
      (workflowId,publishedVersionId,createdAt,updatedAt) VALUES (?,?,?,?)`)
      .run(WF_ID, VER_ID, now, now);

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
