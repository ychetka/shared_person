# Platform Access

How each target platform is reached for publishing, where credentials live,
and how they were obtained. All secrets are in `../ENV` (never committed).

> **Real publishing is OFF by developer decision (2026-11-07, issue #41)
> until an explicit go-live.** Compose injects
> `PUBLISH_SIMULATE=${PUBLISH_SIMULATE:-1}` - simulated mode is the
> DEPLOYMENT DEFAULT, and going live requires explicitly setting
> `PUBLISH_SIMULATE=0` in `../ENV` (that flip IS the go-live
> decision): both sp-publish drivers skip every external
> API call (no VK `wall.post`/upload/`wall.delete`, no LinkedIn
> `assets.registerUpload`/binary PUT/`ugcPosts`/`DELETE`) and record
> synthetic `external_id`s - `sim-*`
> prefixed for VK (`sim-<draft_id>`), `sim-urn:li:share:<draft_id>`
> for LinkedIn (plus `sim-asset-<n>` media urns) - marked
> `status: "simulated"` in `published.jsonl`,
> `publish/simulated` registry events, `simulated` platform status,
> and `SIMULATED` in the Telegram summary. The credentials below are
> ready for go-live but nothing is posted until the flag is flipped.

## VK

- Method: VK API `wall.post` to the user's own wall.
- Token: `VK_ACCESS_TOKEN` in `../ENV` — standalone implicit-flow token
  issued to the Kate Mobile client (`client_id=2685278`).
- `VK_USER_ID=29642349`.
- Why Kate Mobile: VK does not grant the `wall` scope to newly created
  standalone apps (restriction since ~2017). Well-known grandfathered
  client ids still receive `wall` on implicit flow.
- Token TTL changed (observed 2026-11-06): newly issued `vk1.a.*`
  tokens return `expires_in=86400` - VK ID moved standalone tokens
  to a ~24h lifetime. The ENV token is therefore a short-lived
  fallback; the resilient primary path is `vk_token_service.py`
  (web-session extraction from the logged-in tab, see tools/README).
- To re-issue (automated, issue #3): `uv run tools/vk_token_issue.py`
  - opens the authorize URL in the audit Chrome (CDP :9223),
    OS-clicks the VK ID "Продолжить" consent (DOM read-only for
    coordinates, xdotool trusted click), harvests `access_token`
    from the `blank.html#...` fragment, verifies `wall` scope via
    `account.getAppPermissions`, and appends `VK_ACCESS_TOKEN=` to
    `../ENV` (env_val.sh last-assignment-wins). Token never reaches
    stdout.
- Manual fallback: open in the logged-in browser
  `https://oauth.vk.ru/authorize?client_id=2685278&scope=wall%2Coffline&redirect_uri=https%3A%2F%2Foauth.vk.ru%2Fblank.html&display=page&response_type=token&v=5.199`
  → "Продолжить" → copy `access_token` from the `blank.html#...` fragment.
- API host: `https://api.vk.com/method/<method>?access_token=...&v=5.199`.
- Caveat: the home IP may hit `error_code=9` (Flood control) on bursts.
  Callers should retry with backoff; error 9 is NOT an auth failure
  (auth failure is error 5).
- Note: creating a *new* VK standalone app now requires a VK ID business
  profile (ИНН) — avoided entirely by the Kate Mobile path.

## LinkedIn

- Method: LinkedIn API `POST /rest/posts` (or `/v2/ugcPosts`) as member.
- Two developer apps exist:
  - "Shared Person" (app id `265036256`), created 2026-10-23,
    associated page "LinkedIn" (default page for individual
    developers) - holds the currently working `LINKEDIN_ACCESS_TOKEN`.
  - "shared-person content pipeline" (app id `265095434`, client id
    `77y5g76kt1qs8o`), created 2026-11-06, associated page
    "Trade AI Analyst" (company page built for the algo-trading
    project, industry: software development) - the long-term app;
    `ENV` `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET` are this
    app's credentials. Its OAuth is pending a developer password
    re-auth (LinkedIn gates every token grant behind "Welcome Back").
- `../ENV`: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
  `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` (`urn:li:person:CzvpUCPSve`).
- Redirect URLs registered: `http://localhost:8793/linkedin/callback`
  on the new app (host listener captures `?code=` for exchange);
  `https://www.linkedin.com/developers/tools/oauth/redirect` on the
  old app (token-generator tool).
- Products enabled on BOTH apps: "Share on LinkedIn" (Default Tier,
  instant approval) → `w_member_social`; "Sign In with LinkedIn
  using OpenID Connect" → `openid profile email`.
- Token TTL: ~60 days (`expires_in=5183999`). No refresh token on this
  tier — re-auth needed by ~2026-12-22.
- Re-auth procedure (3-legged, ~1 min in the logged-in browser):
  1. Open `https://www.linkedin.com/developers/tools/oauth/token-generator`
     → select "Shared Person" → 3-legged → check scopes →
     "Request access token"; OR navigate directly to
     `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=<ID>&redirect_uri=https%3A%2F%2Fwww.linkedin.com%2Fdevelopers%2Ftools%2Foauth%2Fredirect&scope=openid%20profile%20email%20w_member_social`
     → sign in (Chrome autofills saved credentials) → "Разрешить".
  2. Exchange the returned `code`:
     `POST https://www.linkedin.com/oauth/v2/accessToken`
     `grant_type=authorization_code&code=...&client_id=...&client_secret=...&redirect_uri=...`
     (URL-encode the secret).
  3. Update `LINKEDIN_ACCESS_TOKEN` in `../ENV`.
- Verify: `GET https://api.linkedin.com/v2/userinfo` with
  `Authorization: Bearer <token>` → returns `sub` (= person id for the
  author URN), name, email.
- Posting: `POST https://api.linkedin.com/rest/posts` body
  `{author: "urn:li:person:CzvpUCPSve", commentary: ..., visibility:
  "PUBLIC", lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false}`
  with header `LinkedIn-Version: 202405` (or `/v2/ugcPosts` legacy).
- Image attach (issue #50): `POST /v2/assets?action=registerUpload`
  (recipe `urn:li:digitalmediaRecipe:feedshare-image`) -> binary `PUT`
  to the returned `uploadUrl` -> `media[]` of the returned
  `urn:li:digitalmediaAsset:<id>` on the share body with
  `shareMediaCategory: IMAGE`. `w_member_social` covers asset
  registration for member shares - no extra product/scope needed.

## Facebook / Instagram

- Sessions exist in the audit Chrome profile (`:9223`,
  `~/.chrome-audit-profile`) — used by hands-agent recipes for now.
- Official API path (Graph API, Page + IG Business/Creator publishing)
  is not configured yet; needs a Meta developer app + Page access token.
- Instagram is a Creator account — for `instagram_content_publish` it
  must be switched to Business or linked to a FB Page (iteration 2).

## YouTube

- Not configured yet. Will need a Google Cloud project + OAuth client
  with `youtube.upload` scope. hands-agent fallback meanwhile.
