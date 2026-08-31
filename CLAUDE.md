# Postie — project context

Slack app: messages that collect N `:postcard:` reactions get rendered into a
print-ready postcard and mailed via Mailstream. See README.md for architecture
and setup; this file is for context that isn't obvious from the code.

## Roadmap
TODO.md holds the audited public-release roadmap (phases 1-4 + watch-items).
Work phases in order; check items off as they land.

## Commands
- `npm run typecheck` / `npm test` — tests write sample card renders to `test/__output__/*.png`
- `npm run gallery` — renders all representative message shapes (front+back) to `test/__output__/gallery/index.html`; THE layout-iteration loop. Run after touching `src/postcard/render.ts`.
- `npm run deploy` / `npm run deploy:fast` — CloudFormation deploy / Lambda hotswap (set AWS_PROFILE; deployment specifics live in gitignored CLAUDE.local.md)
- Deploy etiquette: hotswap for code-only changes (~15s); full deploy for infra. Run `cdk diff` FIRST when a change touches IAM/public exposure — unreviewed `--require-approval never` deploys get blocked, and public-exposure changes need the user's explicit yes.
- After gallery/tests, view output PNGs with the Read tool (it renders images) — visual inspection catches what dimension asserts can't (missing emoji, layout drift).
- There is NO local dev environment — by choice. One Slack app, one deployment; iterate via tests/gallery + hotswap deploys.

## Load-bearing decisions
- **Mailstream contract fully verified live** (probes 2026-07-13, first real
  card 2026-07-16). Base URL `https://my.mailstream.app/api/v1` (NOT
  api.mailstream.app — doesn't resolve). Artwork fields take **HTML strings**
  capped at 100k chars → rendered images live in the public-objects S3 bucket
  and ship as `<img src>` URLs. Artwork keys are DETERMINISTIC per
  message+side so retries produce byte-identical payloads (their
  Idempotency-Key header requires a UUID and replays only on identical
  bodies). Create response: `uuid` (psc_…), `campaign_uuid` (singles are
  auto-wrapped in a campaign — that's where they appear/cancel in their
  dashboard), `url` = signed proof PDF (~7-day expiry, renders async
  ~20 min), `status` ("pending"), `send_date` (next day). A 4x6 first-class
  card costs **0.9 print points, charged at creation** (402 with balance
  breakdown when underfunded → Postie posts preview-only cards). Their MCP
  server needs a paid plan; advertised npm SDK not published.
- **Delivery tracking = polling, not webhooks.** Mailstream ships no tracking
  webhook events (only preview.*/created), so an EventBridge tick (4h) sends
  a `track_all` job; the worker diffs each open card's `status` via
  `GET /postcards/{uuid}` and posts thread updates on change
  (src/postcard/tracker.ts + statusLines.ts). Terminal statuses or 30 days
  stop tracking. OPEN QUESTION: whether their `status` progresses through
  USPS scans to `delivered` — card № 1 is the experiment. The webhook lambda
  was REMOVED (Phase 1, 2026-07-16) — it was redundant and the worst setup
  step (per-workspace dashboard config + secret exchange); recover from git
  if Mailstream ever ships real tracking webhooks.
- **The Mailstream key lives in `.env`** (gitignored) — never commit it,
  never move it into user-scope config. App code never reads it: each
  workspace's key arrives via `/postie setup` (KMS-encrypted per team).
- **No native binaries in the image stack** (satori + resvg-wasm + jimp, not
  sharp). Deliberate: `NodejsFunction` bundling runs npm on the deploying Mac,
  so platform-specific binaries would silently break in Lambda. Don't add
  sharp back without switching to docker bundling. Same reason there's no AI
  outpainting: it would bill OUR account for other workspaces' cards —
  square/portrait images get the blur-fill treatment instead. And no
  native-HTML artwork (letting Mailstream render): we own the card archive —
  their proofs expire in 7 days; our renders in S3 are the permanent record
  (bucket has NO lifecycle expiration, deliberately).
- **Card grammar: front = the moment, back = the information.** Photo cards
  (wide → full-bleed; square/portrait → blur-fill) carry zero text on the
  front; message + attribution + senders live on the back. Text cards put the
  message + author on the front; their back skips both. One meta line on the
  back (team · #channel · date) is the only home for context — nothing
  appears twice. Back's writable area is the LEFT 40% only (their return
  address prints from ~44% width — verified against their template proof).
- **Card text = editorial hierarchy, not raw faithfulness.** Slack's block
  types encode emphasis: rich_text/section/header are the author's words
  (content); context blocks are small-gray metadata (chrome). Cards print
  content → else the human's prompt echoed as the chrome's *bold* run (bot
  posts only) → else the top-level `text` (the bot author's own one-line
  summary) → else chrome as last resort. `blocksToTokens`
  (src/postcard/blocks.ts) classifies; the normalizer selects. Never
  special-case a specific bot's message shape — adjust the hierarchy
  generically. Provenance follows the same rule: a bot post is attributed to
  the last user mentioned BEFORE the chrome's bold echo ("— sam · via bot") —
  credit lines put the words' owner directly ahead of them ("@sam | *prompt*",
  "…on @paul's message: *echo*"); mentions inside the echo are people being
  talked about. Echo-free chrome falls back to the first mention (the acting
  user).
- **Exactly-once = the DynamoDB conditional put** (`acquireCardLock`), not the
  reaction count. `reaction_added` fires per-person with no total; the worker
  re-reads counts via `reactions.get` and treats them as a hint only. A
  `failed` card is re-acquirable so a fresh reaction can retry it.
- **satori quirks**: it won't fetch remote images reliably into resvg — all
  images (avatars, custom emoji, twemoji, the brand mark) are pre-fetched to
  data URIs before render. Body text is split into word-level spans because
  satori is a flexbox engine, not a text-flow engine (long styled spans break
  inline wrapping). Fonts must be static TTF/OTF (no variable fonts, no
  woff2) — hence Inter 3.19 statics in `assets/fonts`, not Inter 4.x.
- **jimp v1 API** (not the googleable v0): `new Jimp({width, height, color: 0xRRGGBBAA})`, `image.cover({w, h})`, `await image.getBuffer('image/jpeg', {quality})`, `.clone()`, `.blur(n)`, `.scale(f)`. EXIF rotation applies on decode.
- **Bolt on Lambda**: `processBeforeResponse: true` + listeners that only
  enqueue; anything slow lives in the SQS worker. Slack retries un-acked
  events after 3s, which would double-process.
- **Admin gating**: every config-mutating command (setup/address/emoji/
  threshold/cap/size/presence/join-all) requires is_admin||is_owner, failing
  closed. `here`/`leave`/`status`/`help` are deliberately open. Reactions
  themselves stay democratic — threshold + daily cap are the spend fence.
- **Presence is a config, not a constant** (`presence: everywhere|invited`,
  default `everywhere`). Slack only delivers reaction events for channels the
  bot is in, so "invited" mode fails *silently* in other channels — that's why
  everywhere is the single-workspace default. Flip the default to `invited`
  before public distribution (TODO Phase 3).

## State
- Deployment-specific values (AWS profile/account, domain, Slack team id,
  live card ids, Mailstream balance) live in gitignored CLAUDE.local.md —
  the repo itself is deployment-agnostic: domain/hostedZone/alertEmail come
  from the gitignored infra/cdk.context.json, everything else from SSM/DynamoDB.
- Single-workspace by design for now; store is keyed by `team_id` everywhere,
  so multi-workspace = OAuth + installation store (TODO Phase 2), not a
  refactor.
- Secrets: Slack creds in SSM SecureStrings (`/postie/slack/*`), per-team
  Mailstream keys KMS-encrypted in DynamoDB (`kms:`/`plain:` prefix scheme —
  `plain:` is the no-KMS test path only).
- Brand: `assets/postcard-emoji.png` is the mark everywhere (Slack emoji, app
  icon; generator recipe lives in git history), card fronts/backs via `brandMarkUri`.
