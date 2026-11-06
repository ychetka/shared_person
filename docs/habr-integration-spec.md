# Habr + Habr Career - platform research & hands-agent integration spec

Developer decision: Habr is a supported channel. ALL platform
interaction goes through hands-agent (OS-level browser automation) -
no API dependency is assumed anywhere. This document is the design
input for a future sp-publish driver (`platform: habr`) and the
content-side rules the factory must obey on this channel.

Status: research complete (2026-11), no implementation yet.

## 1. Platform research

### 1.1 Publication formats

Personal publications (`habr.com/ru/articles/`):

- Composer flow: "Написать" (header, top right) -> type selector
  (article / news / translation) -> 1-5 hubs -> optional "Обучающий
  материал" (tutorial) checkbox -> title -> body (HTML or markdown
  markup) -> tags -> optional poll -> "Предпросмотр" -> green
  "Опубликовать". Drafts are private (lock icon); published posts can
  be edited or moved back to drafts via the pencil icon.
- Hub model: 7 top-level sections (Разработка, Администрирование,
  Дизайн, Маркетинг, Управление, Гиктаймс, Разное), each containing
  themed hubs. Readers subscribe to hubs; a publication with no hub is
  effectively invisible, a publication in a wrong hub attracts
  negative moderation. Profile (IT) hubs accept posts at any karma;
  non-profile hubs require karma >= 0 and some have higher thresholds.
- Rate limit: after 3 publications with <24h intervals, the next one
  is blocked for 24h. Up to 5 hubs per publication (a company blog
  counts as one of them).

Posts (short form, `habr.com/ru/posts/`):

- 10-4000 chars, no title, no cut; rendered fully in feed. Up to 5
  hubs. Available from Read&Comment accounts without premoderation.
  Minimal rating impact; positioned as a conversation format.

Q&A (`qna.habr.com`):

- StackOverflow-style questions/answers, a separate service with its
  own mechanics: no likes (subscription to a question instead), the
  asker marks one answer as the solution, voting window is 3 days.
- Questions require karma >= 0; answers, comments and clarifications
  are unrestricted. Entities: question, answer, clarification
  (first-level comment on the question), comment on an answer.
- Useful as a low-risk authority builder: answering niche questions
  earns visibility without passing article moderation.

Company blog (`habr.com/ru/companies/<name>/`):

- Paid subscription product; the only channel where promotional
  content is legal (see 1.3). Branding (company-name username/avatar)
  is allowed only inside the corporate blog while the subscription is
  active. Out of scope until a company entity exists.

Habr Career (`career.habr.com`):

- Separate service. Company cabinet + vacancies (small/medium
  companies can post free and pay per response view); content rules
  for vacancy text are strict and job-board specific - not a content
  channel for us.
- Relevant surface for a solo dev: the public career profile
  (resume/portfolio) linked from the Habr account - worth filling,
  zero automation need.
- Adjacent: `freelance.habr.com` is a separate freelance marketplace,
  not covered here.

### 1.2 Moderation model

- Account tiers: ReadOnly (default after registration) -> Read&Comment
  (after the first pre-moderated comment is approved) -> full-rights.
  ReadOnly comments on posts <30 days old go through author+moderator
  premoderation; full accounts publish and comment freely.
- Sandbox: ReadOnly users submit articles to `habr.com/ru/sandbox/`;
  staff moderators review and either grant the invite (full account)
  or bounce with a stated reason. ~80% of current sandbox submissions
  are rejected as AI-generated (official statement). First
  publication is therefore the hardest gate and should be treated as
  a manual milestone, not an automation target.
- Karma: collective moderation currency. Key thresholds: publish in
  profile hubs at any karma (full accounts); karma >= 30 required for
  "Я пиарюсь"; karma of an author with zero publications caps at +4.
- Post-publish review: every published article is still checked by
  staff moderators after release; violations can move it back to
  drafts or downgrade the account to ReadOnly.

### 1.3 Anti-self-promotion rules (rule #1)

Promotion of own/third-party projects, services, products, events
and personal brands is banned outside company blogs and a one-time
"Я пиарюсь" hub post. The rule covers publications, comments,
usernames, avatars, profile info and private messages. Consequences:
silent edit/removal of promo content, ReadOnly downgrade, account
deactivation for dangerous promotion. Habr holds final judgment on
what counts as promo.

Allowed exceptions relevant to us:

- Useful topical links that materially extend the article - no
  referral parameters, no UTM tags, no URL shorteners.
- Indie projects: an app/game developer may link the app store
  listing even when monetized (Habr decides edge cases).
- One-time mention of a topical non-branded community/channel per
  publication (direct link, no invite links); repeating the same
  mention across posts is treated as ads, including retroactively.
- Own social/contact links only in the dedicated "Контактная
  информация" profile field - not in profile bio text, posts or PMs.
- Position field may carry a company name - bare name, no links,
  slogans or product mentions.
- Authored books and real crowdfunding campaigns get one clean link
  each under stated conditions.

### 1.4 AI-content policy (critical design constraint)

Rule #4 bans "размещение сгенерированных материалов": texts fully or
partially generated by neural nets, texts written/edited with neural
net assistance, dialogues with AI, and articles consisting of AI
answers. Moderators may return suspected publications to drafts.
Sandbox explicitly rejects AI-written articles "even if they reflect
your own thoughts". Sole exception: AI-generated illustration images
(КДПВ) are allowed.

Consequence for the factory: the generate -> humanize -> publish
pipeline used for VK/TG MUST NOT feed Habr articles end-to-end.
Rule-compliant operating mode:

- content-gen produces research briefs, data artifacts and outlines
  (e.g. VOLATILITY TICKER telemetry, registry/post metrics, real
  project diffs) - raw material, not prose;
- the human writes or substantively rewrites the article; the
  writer-style skill's anti-slop rules double as a Habr-compliance
  checklist (no AI-slop phrasing, concrete artifact-first content);
- hands-agent then performs only the mechanical publish step on an
  already-approved human text - which is exactly where browser
  automation is safe and useful.

### 1.5 Comment culture

Habr comments are technical and adversarial to marketing tone;
low-effort or promo-flavoured comments are downvoted hard and feed
the same promo rule. Votes on comments affect author rating; poorly
received comments can trigger removal or downgrade. Operational
rule: comment only where we can add a concrete technical point;
never paste funnel-style replies; link drops in comments follow the
same no-UTM/no-promo policy as articles. Q&A answers are the safest
commenting surface.

## 2. Integration spec

### 2.1 Account strategy

- One personal full-rights account, real-person profile (no brand
  naming/avatars - banned by rule #1). Company name only in the
  position field, contact links only in the designated field.
- If the account starts ReadOnly: the first article goes through the
  sandbox manually or semi-manually (human text + hands-agent
  mechanics). Passing the sandbox is a one-time manual milestone.
- Meanwhile: Q&A answers and comments (from Read&Comment) are the
  automation-friendly warmup path and also satisfy the
  "platform participation before promotion" cadence.

### 2.2 hands-agent automation map

End-to-end automatable (after human text is approved in TG):

- `habr_post` recipe - publication mechanics:
  1. open habr.com (existing logged-in browser profile on the X11
     session), dismiss cookie/upsell overlays per hands-agent UX rules;
  2. click_dom "Написать" -> pick publication type (article);
  3. fill title, select hubs (1-5) via composer UI - DOM-read
     targeting (`click_dom`/cdp.py), the hub picker is a multi-select
     widget and needs a locate/verify loop;
  4. paste the body. The body editor accepts markdown - inject via
     clipboard (ctrl+v) rather than jitter-typing thousands of chars:
     typing a full article keystroke-by-keystroke is slow and
     unnecessary; short fields (title, tags) use jittered `type`;
  5. optional image attach (КДПВ) via the file chooser pattern
     (ctrl+l -> path -> Return), same as linkedin_post/facebook_post;
  6. "Предпросмотр" shot for the audit trail, then click_dom
     "Опубликовать" (exact-match targeting - other buttons share
     the substring), post-publish shot;
  7. scrape the resulting article URL into the queue result so
     sp-publish can record `external_ids`.
- `habr_metrics` recipe - open each published article URL and
  DOM-read counters (views, votes +/-, bookmarks, comments count);
  feeds the analytics collector as a `habr` adapter behind the
  existing collector interface (sp-analytics already emits
  `unsupported` for non-VK platforms - this is the adapter point).
- `habr_qna_answer` recipe (phase 2) - answer text into the answer
  editor on a given question URL.

Explicitly manual / human-assist:

- Article authorship (see 1.4) - human text, mandatory.
- Sandbox first publication - human-supervised milestone.
- CAPTCHA / verification interstitials - recipe aborts to
  `queue/failed/` and escalates to the operator; hands-agent never
  solves captchas.
- Comment replies to our own publications - recommend human-written;
  auto-replies are exactly the pattern rule #4 punishes.
- Account registration, email confirmation, 2FA prompts.

### 2.3 Human-like interaction requirements

- Real OS input only (xdotool): Bezier mouse moves, jittered typing,
  randomized inter-action waits - already the hands-agent defaults.
- Clipboard paste for long bodies is acceptable (it mimics a real
  writer pasting a prepared draft); keystroke-by-keystroke for
  3000+ chars is anti-human, not pro-human.
- Session: reuse the persistent desktop browser profile on DISPLAY
  :1; never log in via recipe (credentials never enter queue payloads).
- Pacing: no more than 1 publication per recipe run; respect the
  3-posts/24h site limit at the sp-publish scheduler level.
- Every mutating step is followed by a `shot` into `queue/done/` -
  the audit trail is mandatory for moderation-sensitive surfaces.

### 2.4 n8n/registry integration

- Queue contract unchanged: `{"recipe": "habr_post", "params":
  {"title": ..., "hubs": [...], "text_md": ..., "image_path": ...}}`
  dropped into `queue/inbox/`; poller lands in `done/`/`failed/`.
- sp-publish gains a `habr` driver that enqueues the recipe task and
  emits registry events with `platform: "habr"`, `external_ids:
  [<article_url>]`; failures keep the existing failed/maybe_live
  semantics (a published article can be confirmed by re-opening the
  profile page and DOM-checking the title - the orphan-probe
  equivalent).
- sp-analytics: `habr` collector adapter calls `habr_metrics`;
  until implemented, `platform: habr` rows correctly emit
  `unsupported`.
- TG moderation gate is unchanged and non-bypassable: nothing
  reaches queue/inbox without an approved draft.

## 3. Risks / open questions

- Detection: Habr actively hunts AI text; even humanized output is a
  risk if it reads generated. Mitigation = the artifact-first,
  human-authored flow above, not a stronger humanizer.
- Composer DOM fragility: the hub multi-select and markdown editor
  are the most likely drift points; the recipe must use
  locate/verify loops, not fixed coordinates.
- Karma floor: a fresh account cannot reach "Я пиарюсь" (karma >= 30)
  quickly; early content must be pure knowledge-sharing with zero
  promo signals - which also matches the North Star (inbound, not
  reach).
- Company blog: worth revisiting only if a legal entity/budget
  appears; personal account carries the brand until then.

## 4. Acceptance criteria (for the future driver issue)

- `habr_post` recipe publishes an approved article end-to-end on a
  test draft (then moved back to drafts), shots land in
  `queue/done/`, article URL returned to sp-publish.
- Registry records `publish/published` with `platform=habr` and the
  article URL in `external_ids`; failure paths emit `failed` /
  `failed+maybe_live` per the registry contract.
- `habr_metrics` returns views/votes/bookmarks/comments for a given
  URL and feeds `state/analytics/metrics.jsonl` via the collector
  interface.
- No credential material in queue payloads, recipes, logs or the
  registry; CAPTCHA/verification aborts escalate to the operator.
- Content-side: every Habr-bound draft carries a human-authorship
  confirmation in the TG moderation payload (explicit flag, not
  implied).

## 5. Sources

- Site rules: https://habr.com/ru/docs/help/rules/ (last edit
  2026-07-08; rules #1 self-promo, #2 topics/format, #4 generated
  content, #5-8 conduct)
- Publications/composer: https://habr.com/ru/docs/help/publications/
- Posts format: https://habr.com/ru/docs/help/posts/
- Hubs: https://habr.com/ru/docs/help/hubs/
- Karma/rating: https://habr.com/ru/docs/help/karma/
- Registration/account tiers: https://habr.com/ru/docs/help/registration/
- Sandbox rejects: https://habr.com/ru/sandbox/start/
- New rules 2026 (AI policy rationale):
  https://habr.com/ru/companies/habr/articles/1019036/
- Company blog prep: https://habr.com/ru/docs/companies/preparations/
- Q&A mechanics: https://qna.habr.com/help/qa
- Habr Career terms: https://career.habr.com/info/legal/toss
