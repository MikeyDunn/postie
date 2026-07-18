# Postie roadmap

Public-release audit findings (2026-07-16). Work through phases in order;
each phase is independently shippable. See CLAUDE.md for design invariants.

## Phase 1 — simplify + harden (hours; do first, valuable regardless of public timing)

- [x] Remove the Mailstream webhook stack (redundant since the polling tracker):
      `src/lambda/mailstreamWebhook.ts`, its API route/integration in the CDK
      stack, the `webhook_secret` field in the setup modal, the
      `mailstreamWebhookSecret` config field, `markEventProcessed` + MSEVENT
      dedup rows, `findCardByPostcardId`, and the now-unused `gsi1` index
      (stop writing gsi keys in `markCardSent`).
- [x] Remove `POSTIE_SKIP_ADMIN_CHECK` entirely (dev remnant; a misconfigured
      env var would disable every admin gate).
- [x] DLQ CloudWatch alarm → SNS → email (failed jobs currently die silently).
- [x] CloudWatch log retention (1 month) on all three Lambdas.
- [x] `/postie status`: show lifetime card total (read the COUNTER item).
- [x] Make `fetchAsDataUri` private; clarify `plain:` crypto prefix is test-only.

## Phase 2 — multi-workspace install (the one real project; ~1–2 focused days)

- [ ] Slack OAuth: `GET /slack/install` + `GET /slack/oauth_redirect` handlers
      (`@slack/oauth` InstallProvider) on the existing HTTP API —
      AwsLambdaReceiver has no built-in OAuth routes.
- [ ] InstallationStore in DynamoDB: `TEAM#<id> / INSTALL` holding the bot
      token (KMS-encrypted), bot user id, installer user id.
- [ ] Receiver App switches from static token to `authorize` (per-team lookup).
- [ ] Worker + tracker: `slackClientFor(teamId)` with cache replaces
      `getSlackSecrets().botToken`; all jobs already carry teamId.
- [ ] SSM additions: client id, client secret, state secret. Slack app config:
      enable public distribution + redirect URL.
- [ ] Migration: seed the existing workspace's installation row from the existing token.
- [ ] End-to-end test with a scratch second workspace (install via link).

## Phase 3 — onboarding + distribution polish (ride-along with Phase 2)

- [ ] Post-install DM to installer: checklist + `postcard-emoji.png` attached
      ("upload as :postcard: or run /postie emoji mailbox_with_mail"),
      `/postie setup`, `/postie address`, presence choice.
- [ ] Flip `CONFIG_DEFAULTS.presence` to `'invited'` (public posture).
- [ ] Manifest + README install docs for other teams (install link — public
      distribution does NOT require Marketplace review).
- [ ] Optional: App Home tab with setup status.

## Phase 4 — Slack Marketplace (only if directory discoverability matters)

- [ ] Privacy policy + terms + support pages (message content flows to
      Mailstream and public-URL S3 artwork — must be disclosed).
- [ ] Scope justifications write-up; listing assets; review submission.

## Idea backlog (from live learnings)

- [ ] `/postie cancel` (admin): cards batch to next-day send dates and
      campaigns expose POST /campaigns/{uuid}/cancel — a free ~1-day undo
      window for mistakes. (Verified: API cards go straight to Scheduled;
      there is NO proof-approval gate — reactions are the only approval.)
- [ ] Recipient-address flow: on threshold, DM the message author for a
      destination address (consent + privacy + the viral "it arrived" loop).
- [ ] Free first card on install (marketing spend ≈ $1/install).

## Open watch-items

- [ ] Does Mailstream's postcard `status` actually progress (printed →
      delivered)? Card № 1 (ids in CLAUDE.local.md, sent 2026-07-16) is the experiment; tracker posts changes to its thread.
- [ ] Whether their idempotency layer caches 402 errors (avoid reusing
      pre-topup message keys, or verify and note).
- [ ] 6x9 / 6x11 layouts untested; `fitBodySize` tuned for 4x6 only.
- [ ] Physical card QA when № 1 arrives: color on stock, QR scannability.
