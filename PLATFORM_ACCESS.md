# Platform Access

How each target platform is reached for publishing, where credentials live,
and how they were obtained. All secrets are in `../ENV` (never committed).

## VK

- Method: VK API `wall.post` to the user's own wall.
- Token: `VK_ACCESS_TOKEN` in `../ENV` — standalone implicit-flow token
  issued to the Kate Mobile client (`client_id=2685278`).
- `VK_USER_ID=29642349`.
- Why Kate Mobile: VK does not grant the `wall` scope to newly created
  standalone apps (restriction since ~2017). Well-known grandfathered
  client ids still receive `wall` on implicit flow.
- `expires_in=0` — the token does not expire unless the user revokes the
  app's access in VK settings.
- To re-issue: open in the logged-in browser
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
- App: "Shared Person" (app id `265036256`), created 2026-10-23 in
  https://www.linkedin.com/developers/apps, associated page "LinkedIn"
  (default page for individual developers).
- `../ENV`: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
  `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` (`urn:li:person:CzvpUCPSve`).
- Products enabled: "Share on LinkedIn" (Default Tier, instant approval)
  → `w_member_social`; "Sign In with LinkedIn using OpenID Connect"
  → `openid profile email`.
- Authorized redirect URL registered:
  `https://www.linkedin.com/developers/tools/oauth/redirect`.
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
