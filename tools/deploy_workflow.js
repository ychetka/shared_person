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
//   "active" is explicit opt-in: only `true` registers triggers and
//   webhooks - absent or non-boolean values deploy INACTIVE (with a
//   warning).
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
// `--db` present but valueless (`--db` alone, or `--db` followed by
// another flag) made arg('db') return '' and the run silently fell
// back to the docker-volume DB - a typo'd invocation would then patch
// a DB the operator never asked for. The flag's presence means
// intent: a missing/empty value is a hard error.
const dbFlagGiven = argv.some((a) => a === '--db' || a.startsWith('--db='));
const DB = dbFlagGiven ? arg('db') : defaultDb();

if (!file) {
  console.error('usage: node tools/deploy_workflow.js <workflow.json> [--update] [--db=path|--db path]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`workflow file not found: ${file}`);
  process.exit(1);
}
if (dbFlagGiven && !DB) {
  console.error('--db requires a path value: ' +
    '--db=<path>/database.sqlite or --db <path>');
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
// parse + sanity-check the spec BEFORE opening the DB and BEGIN: a
// corrupt file (missing name, empty/mistyped nodes, broken JSON) used
// to reach the first INSERT and die on an opaque driver error
// mid-transaction, leaving the operator to guess which field broke.
// Fail fast here with a message that names the broken field.
let spec;
try {
  spec = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`invalid workflow spec ${file}: not valid JSON - ${e.message}`);
  process.exit(1);
}
const specFail = (m) => {
  console.error(`invalid workflow spec ${file}: ${m}`);
  process.exit(1);
};
if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
  specFail('top level must be a JSON object');
}
const { name, nodes, connections } = spec;
const settings = spec.settings ?? { executionOrder: 'v1' };
const triggers = spec.triggers ?? [];
// activation is explicit opt-in: only spec.active === true registers
// triggers and webhooks. An absent field used to default to ACTIVE -
// a spec that simply forgot the key silently published a workflow
// with live webhook endpoints. Inactive is the safe default; warn on
// absence so a forgotten key does not silently deploy dead either.
const active = spec.active === true ? 1 : 0;
if (spec.active === undefined) {
  console.warn('warning: spec has no "active" field - deploying ' +
    'INACTIVE (set "active": true to register triggers)');
} else if (spec.active !== true && spec.active !== false) {
  console.warn(`warning: spec "active" is ${JSON.stringify(spec.active)}, ` +
    'not a boolean - deploying INACTIVE (use true to activate)');
}

if (typeof name !== 'string' || !name.trim()) {
  specFail('"name" must be a non-empty string');
}
if (!Array.isArray(nodes) || !nodes.length) {
  specFail('"nodes" must be a non-empty array');
}
nodes.forEach((n, i) => {
  if (!n || typeof n !== 'object' || Array.isArray(n) ||
      typeof n.name !== 'string' || !n.name.trim()) {
    specFail(`nodes[${i}] must be an object with a non-empty "name"`);
  }
  if (typeof n.type !== 'string' || !n.type.trim()) {
    specFail(`nodes[${i}] ("${n.name}") is missing a non-empty "type"`);
  }
});
if (!connections || typeof connections !== 'object' ||
    Array.isArray(connections)) {
  specFail('"connections" must be an object ({} is valid)');
}
if (!Array.isArray(triggers)) {
  specFail('"triggers" must be an array when present');
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  specFail('"settings" must be an object when present');
}

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
  // an empty projection - extreme schema drift where NONE of the
  // row's keys exist as columns - would emit
  // 'INSERT OR REPLACE INTO t () VALUES ()', which SQLite rejects
  // with a cryptic syntax error that rolls the whole deploy back.
  // A row with no matching columns is a no-op on this schema: skip
  // it loudly instead of dying mid-transaction.
  if (!keys.length) {
    console.warn(`ins(${table}): no row keys match the schema - row skipped`);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')})
    VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
};

// schema-adaptive upsert twin of ins(): where a row may already exist
// (the published-version pointer survives a deactivation), ON CONFLICT
// ... DO UPDATE must touch only the pointer columns - ins()'s
// INSERT OR REPLACE would rewrite the whole row and reset every column
// this schema carries that the row does not name. updateCols lists the
// columns a conflict may overwrite; anything else keeps its value.
const upsert = (table, row, conflictCol, updateCols) => {
  const cols = colsOf(table);
  const keys = Object.keys(row).filter((k) => cols.has(k));
  const upd = updateCols.filter((k) => keys.includes(k));
  // without the conflict column the ON CONFLICT target cannot resolve,
  // and with nothing to update the upsert degenerates to a plain
  // insert - both are silent no-ops worth warning about, same as
  // ins()'s empty-projection guard
  if (!keys.includes(conflictCol) || !upd.length) {
    console.warn(`upsert(${table}): schema lacks the conflict/update ` +
      'columns - row skipped');
    return;
  }
  db.prepare(`INSERT INTO ${table} (${keys.join(',')})
    VALUES (${keys.map(() => '?').join(',')})
    ON CONFLICT(${conflictCol}) DO UPDATE SET
    ${upd.map((k) => `${k}=excluded.${k}`).join(',')}`)
    .run(...keys.map((k) => row[k]));
};

// trigger + webhook registration for one workflow id. Activation drops
// webhook_entity and workflow_publication_trigger_status rows, so both
// create and --update paths have to write them again.
// priorWebhookIds: node name -> webhookId the previous registration
// used (snapshot taken before the --update DELETE below)
const registerTriggers = (wfId, priorWebhookIds = new Map()) => {
  for (const t of triggers) {
    const node = nodes.find((n) => n.name === t.node);
    // fail-fast on a typo'd triggers[].node: without this check the
    // loop registers webhook_entity / trigger_status rows for a node
    // the spec does not have - the deploy reports success while the
    // path routes nowhere (a silent dead webhook). Throw here, inside
    // the transaction, so the catch's ROLLBACK leaves no partial
    // registration behind - same loudness contract as the webhook
    // hijack guard below.
    if (!node) {
      throw new Error(`trigger node "${t.node}" not found in ` +
        'spec.nodes - fix the triggers[] entry or the node name');
    }
    if (t.path) {
      // webhook_entity.webhookId must not desync from the node the
      // runtime activates: n8n writes node.webhookId here, so a random
      // fallback can silently break webhook routing. Resolution order:
      // the spec's own id first; then the id this workflow already
      // registered for the node (a --update re-registration keeps the
      // established id instead of orphaning it); then the spec's
      // deterministic node id; a fresh UUID only when nothing else
      // exists - never a silent random desync on re-deploy.
      const webhookId = node?.webhookId || node?.parameters?.webhookId ||
        priorWebhookIds.get(t.node) || node?.id || crypto.randomUUID();
      const variant = `${wfId}/${encodeURIComponent(t.node)}/${t.path}`;
      const whMethod = t.method || 'POST';
      for (const p of [t.path, variant]) {
        // webhook hijack guard: webhook_entity is keyed on
        // (webhookPath, method), so INSERT OR REPLACE would silently
        // re-point a path ANOTHER workflow still owns at this
        // workflowId - hijacking its callback routing without a
        // trace. Refuse the overwrite and fail the deploy (ROLLBACK
        // keeps the DB consistent); the operator must clear the
        // foreign registration first. The --update path already
        // deleted THIS workflow's rows above, so a surviving row can
        // only be foreign - the workflowId check just keeps a
        // same-id re-register idempotent.
        const whCols = colsOf('webhook_entity');
        if (whCols.has('webhookPath') && whCols.has('method') &&
            whCols.has('workflowId')) {
          const owner = db.prepare(
            'SELECT workflowId FROM webhook_entity ' +
            'WHERE webhookPath=? AND method=?').get(p, whMethod);
          if (owner && owner.workflowId !== wfId) {
            throw new Error(`refusing to hijack webhook path "${p}" ` +
              `(${whMethod}): already registered to workflow ` +
              `${owner.workflowId} - remove that registration or ` +
              'deactivate the owning workflow first');
          }
        } else if (whCols.has('webhookPath') && whCols.has('method')) {
          // schema drift: the routing key exists but workflowId does
          // not, so the ownership probe above CANNOT run - yet the
          // INSERT OR REPLACE below still keys on (webhookPath,
          // method) and would silently re-point a path another
          // workflow owns, exactly what this guard exists to prevent.
          // Do NOT skip quietly: warn loudly so the operator knows
          // this registration ran unguarded.
          console.error('!! webhook hijack guard SKIPPED for "' + p +
            '" (' + whMethod + '): webhook_entity lacks the ' +
            'workflowId column - ownership cannot be checked. ' +
            'The insert below proceeds UNGUARDED and may re-point a ' +
            'path owned by another workflow. Verify no other workflow ' +
            'registers this path, or fix the schema drift.');
        }
        ins('webhook_entity', {
          webhookPath: p, method: whMethod, node: t.node,
          webhookId, workflowId: wfId, pathLength: p.length,
          createdAt: now, updatedAt: now,
        });
      }
    }
    ins('workflow_publication_trigger_status', {
      workflowId: wfId,
      nodeId: node?.id || t.node,
      nodeName: t.node,
      // nodeType carries the node's n8n type ('n8n-nodes-base.webhook'),
      // NOT the persistence kind - verified against the live DB: the
      // current n8n 2.x schema has no nodeType column at all (ins()
      // drops it silently), but where a schema does carry it the
      // persistence kind already lives in triggerKind (CHECK
      // 'in-memory'/'persisted'), so duplicating it into nodeType
      // would write a wrong value
      nodeType: node.type,
      triggerKind: t.path ? 'persisted' : 'in-memory',
      versionId: VER_ID,
      status: 'activated',
      createdAt: now, updatedAt: now,
    });
  }
};

// resolve the UPDATE target BEFORE BEGIN: a process.exit() inside the
// transaction would bypass the catch's ROLLBACK (exit does not unwind
// try/finally), leaving a dangling write transaction until the
// process dies - and on WAL that still holds the write lock
let wf = null;
if (UPDATE) {
  // n8n allows duplicate workflow names, so WHERE name = ? can match
  // several rows - taking the first would silently patch a different
  // workflow than the operator intended. Count first and refuse the
  // ambiguity loudly.
  const named = db.prepare(
    'SELECT id FROM workflow_entity WHERE name = ?').all(name);
  if (!named.length) {
    console.error(`workflow "${name}" not found - run without --update first`);
    process.exit(1);
  }
  if (named.length > 1) {
    console.error(`workflow name "${name}" is ambiguous - ` +
      `${named.length} rows share it (` +
      named.map((r) => r.id).join(', ') + '). Rename the duplicates ' +
      'or delete the stale one in n8n, then retry --update.');
    process.exit(1);
  }
  wf = named[0];
}

db.exec('BEGIN');
try {
  if (UPDATE) {
    // schema-adaptive ins() like every other write in the script:
    // a schema without autosaved/authors would throw mid-transaction
    // on a fixed column list, contradicting the design the
    // workflow_entity UPDATE below follows
    ins('workflow_history', {
      versionId: VER_ID, workflowId: wf.id,
      authors: 'deploy_workflow.js --update',
      createdAt: now, updatedAt: now,
      nodes: nodesJson, connections: connJson, name, autosaved: 0,
    });
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
      // the spec's trigger list can change between deploys - refresh
      // the count like every other column or it stays stale from the
      // original insert
      ['triggerCount', triggers.length],
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
      // published_version row may be missing after a deactivation -
      // upsert. ON CONFLICT(workflowId) is safe here: verified
      // empirically on the live n8n DB (PRAGMA
      // index_list(workflow_published_version) ->
      // sqlite_autoindex_workflow_published_version_1, unique, origin
      // 'pk') - workflowId IS the primary key, so the conflict target
      // always resolves to a real unique index on this schema. The
      // upsert() helper keeps this column-filtered like every other
      // write in the script - a schema that drops/renames one of the
      // four pointer columns skips loudly instead of throwing
      // mid-transaction.
      upsert('workflow_published_version',
        { workflowId: wf.id, publishedVersionId: VER_ID,
          createdAt: now, updatedAt: now },
        'workflowId', ['publishedVersionId', 'updatedAt']);
      // snapshot the webhookIds of the current registration BEFORE the
      // delete below: registerTriggers reuses them for spec nodes that
      // carry no webhookId of their own, so a re-deploy cannot rotate
      // an id the runtime already knows
      const priorWebhookIds = new Map();
      const whCols = colsOf('webhook_entity');
      if (whCols.has('workflowId') && whCols.has('node') && whCols.has('webhookId')) {
        for (const r of db.prepare(
          'SELECT node, webhookId FROM webhook_entity WHERE workflowId=?').all(wf.id)) {
          if (r.webhookId) priorWebhookIds.set(r.node, r.webhookId);
        }
      }
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
      registerTriggers(wf.id, priorWebhookIds);
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
    // schema-adaptive ins() like the update path above - a fixed
    // column list would throw mid-transaction on a schema missing
    // autosaved/authors
    ins('workflow_history', {
      versionId: VER_ID, workflowId: WF_ID,
      authors: 'deploy_workflow.js',
      createdAt: now, updatedAt: now,
      nodes: nodesJson, connections: connJson, name, autosaved: 0,
    });
    // same invariant as the update path: published-version and
    // activeVersionId pointers only exist for an ACTIVE spec - an
    // inactive create must not register a version that never runs
    if (active) {
      // same column-existence guard as the update path - a schema
      // without activeVersionId must not throw mid-transaction
      if (colsOf('workflow_entity').has('activeVersionId')) {
        db.prepare(`UPDATE workflow_entity SET activeVersionId=? WHERE id=?`).run(VER_ID, WF_ID);
      }
      // schema-adaptive ins() like every other write - a fresh
      // workflow has no row to conflict with, so the plain
      // INSERT OR REPLACE form is enough
      ins('workflow_published_version', {
        workflowId: WF_ID, publishedVersionId: VER_ID,
        createdAt: now, updatedAt: now,
      });
    }

    // owner binding - required, else EntityNotFoundError on publish
    const proj = db.prepare(
      `SELECT id FROM project WHERE type='personal' LIMIT 1`).get();
    if (proj) {
      // schema-adaptive ins() like the rest of the script - a schema
      // missing `role` or a timestamp column would otherwise throw
      // mid-transaction
      ins('shared_workflow', {
        createdAt: now, updatedAt: now, role: 'workflow:owner',
        workflowId: WF_ID, projectId: proj.id,
      });
    }

    // trigger + webhook registration (schema-adaptive ins() helper)
    if (active) registerTriggers(WF_ID);
    console.log('inserted workflow', WF_ID, 'version', VER_ID, 'triggers', triggers.length);
  }
  db.exec('COMMIT');
} catch (e) {
  // ROLLBACK can itself throw - no transaction is open when BEGIN
  // failed or the driver already rolled the writes back - and a
  // throwing rollback would mask the real error caught above. The DB
  // stays consistent either way; rethrow the original failure.
  try { db.exec('ROLLBACK'); } catch (e2) {}
  throw e;
} finally {
  db.close();
}
console.log('done:', name);
