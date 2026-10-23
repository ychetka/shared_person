# n8n-workflows

Exported workflow JSON specs live in `workflows/`. Deploy them into the
project n8n instance (`shared-person-n8n`, data volume
`shared-person_n8n_storage`) with the offline SQLite deployer:

```bash
docker stop shared-person-n8n
node ../tools/deploy_workflow.js workflows/<name>.json          # insert
node ../tools/deploy_workflow.js workflows/<name>.json --update # new version of existing
docker start shared-person-n8n
```

n8n must be stopped while the deployer rewrites `database.sqlite` - it
updates all three version pointers (`workflow_entity.versionId`,
`activeVersionId`, `workflow_published_version`) plus `webhook_entity`,
`shared_workflow` and `workflow_publication_trigger_status` so triggers
register correctly on n8n 2.x.

Workflow JSON conventions:

- `name` - unique, deployer matches existing workflows by name
- `nodes`/`connections` - standard n8n export shape
- `active` - whether triggers should register
- Node references in expressions must use exact node names
- Webhook nodes need a `webhookId` field
- Code nodes can use `require('fs')` (compose sets
  `NODE_FUNCTION_ALLOW_BUILTIN=fs`); state files go to
  `/home/node/.n8n/` inside the volume
- Secrets come from env (`$env.TELEGRAM_BOT_TOKEN` etc.) or n8n
  credentials - never hardcode tokens in node parameters
