# code/ - all profile-growth system code

Structure (filled by iteration, see `../architecture_plan.md`):

- `n8n-workflows/` - exported n8n JSON workflows:
  `trend-scout` (RSS digest), `content-gen` (multi-pass generation
  pipeline + humanizer), `publish` (LinkedIn API / VK wall.post),
  `moderation` (Telegram approver)
- `hands-agent/` - python daemon for OS-level automation: real
  mouse/keyboard (xdotool/ydotool) + computer vision (OpenCV/vision
  model) for posting to Facebook (personal page) and other
  API-less platforms. Platform recipes as separate files.
- `scripts/` - utilities: humanizer filter, anti-slop regex,
  metrics collection, deploy scripts

Rules:
- Secrets only via `.env` / environment variables, never in code.
- Every module has a README with deployment instructions
  (goal: the system redeploys from scratch using repo docs).
