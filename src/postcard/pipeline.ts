import type { WebClient } from '@slack/web-api';
import * as QRCode from 'qrcode';
import { uploadArtwork } from '../core/artworkStore';
import { decryptSecret } from '../core/crypto';
import { Store, DailyCapExceededError } from '../core/store';
import { addressDisplayName, SendJob, TeamConfig } from '../core/types';
import { getMailstreamClient, InsufficientPointsError, isStubMode } from '../mailstream/client';
import { baseEmojiName } from './emoji';
import { NormalizedMessage, normalizeMessage, resolveUserInfos, SlackMessage } from './normalize';
import { renderBack, renderPhotoFront, renderTextCardFront } from './render';

export interface PipelineDeps {
  store: Store;
  slack: WebClient;
  botToken: string;
  /** Our own bot user id — so a postcard reaction on Postie's posts is ignored. */
  botUserId?: string;
  /** Workspace name from auth.test — printed on the back of the card. */
  teamName?: string;
}

const MAX_ATTEMPTS = 3;

/**
 * The worker: runs once per postcard-reaction event. Cheap checks first
 * (threshold, dedup lock), then the expensive render + send.
 *
 * `attempt` is the SQS receive count — errors rethrow (so SQS retries) until
 * the final attempt, which reports the failure into the thread instead.
 */
export async function processSendJob(
  job: SendJob,
  deps: PipelineDeps,
  attempt = 1,
): Promise<void> {
  const { store, slack } = deps;
  const { teamId, channelId, messageTs } = job;

  const config = await store.getTeamConfig(teamId);

  // reactions.get returns both the live reaction counts AND the message body
  // in one call — count is re-read here rather than trusting the event stream.
  const reactionsRes = await slack.reactions.get({
    channel: channelId,
    timestamp: messageTs,
    full: true,
  });
  const message = reactionsRes.message as SlackMessage | undefined;
  if (!message) return;

  const triggerReaction = message.reactions?.find(
    (r) => baseEmojiName(r.name) === config.triggerEmoji,
  );
  const count = triggerReaction?.count ?? 0;
  if (count < config.threshold) return;

  // Never postcard our own posts (e.g. reactions on a card preview).
  if (deps.botUserId && message.user === deps.botUserId) return;

  const locked = await store.acquireCardLock(teamId, channelId, messageTs);
  if (!locked) return;

  try {
    await sendPostcard({ job, config, message, count, reactors: triggerReaction?.users ?? [], deps });
  } catch (err) {
    if (err instanceof DailyCapExceededError) {
      await store.releaseCardLock(teamId, channelId, messageTs, err.message);
      await postThreadReply(
        deps,
        channelId,
        messageTs,
        `:no_entry_sign: Daily postcard cap (${config.dailyCap}) reached — this one isn't going out today. It can be re-triggered tomorrow with another :${config.triggerEmoji}:.`,
      );
      return;
    }
    await store.releaseCardLock(teamId, channelId, messageTs, String(err));
    if (attempt >= MAX_ATTEMPTS) {
      console.error('[postie] send failed permanently:', err);
      await postThreadReply(
        deps,
        channelId,
        messageTs,
        `:warning: Postie couldn't create this postcard after ${MAX_ATTEMPTS} tries. Check \`/postie status\` — last error: ${truncate(String(err), 200)}`,
      );
      return;
    }
    throw err;
  }
}

async function sendPostcard(ctx: {
  job: SendJob;
  config: TeamConfig;
  message: SlackMessage;
  count: number;
  reactors: string[];
  deps: PipelineDeps;
}): Promise<void> {
  const { job, config, message, count, reactors, deps } = ctx;
  const { store, slack } = deps;
  const { teamId, channelId, messageTs } = job;

  // Per-workspace key only — every workspace funds its own Mailstream
  // account via /postie setup. There is deliberately no global fallback.
  const configuredKey = config.mailstreamApiKey
    ? await decryptSecret(config.mailstreamApiKey)
    : undefined;

  if (!config.address || (!configuredKey && !isStubMode())) {
    await store.releaseCardLock(teamId, channelId, messageTs, 'not configured');
    await postThreadReply(
      deps,
      channelId,
      messageTs,
      `:mailbox_with_no_mail: This message earned a postcard, but Postie isn't set up yet. An admin needs to run \`/postie setup\` (API key) and \`/postie address\`.`,
    );
    return;
  }

  const normalized = await normalizeMessage(slack, { teamId, channelId, message });

  // Front: photo messages get an aspect-aware layout (full-bleed for wide
  // images; split panel for square/portrait); text-only messages get the
  // designed text card. Any photo front also writes the message on the back
  // (the postcard "note side") — only the text-card front keeps a quiet
  // back, since there the front already IS the message.
  let front: Buffer;
  let photoFront = false;
  if (normalized.image) {
    const photo = await fetchImage(
      normalized.image.url,
      normalized.image.requiresAuth ? deps.botToken : undefined,
    );
    front = await renderPhotoFront(photo, config.size);
    photoFront = true;
  } else {
    front = await renderTextCardFront(normalized, config.size);
  }
  // The "who and where" extras for the back: everyone who reacted, the
  // per-workspace card number, workspace name, and a QR to the thread.
  const senders = await resolveUserInfos(slack, reactors.slice(0, 24));
  const cardNumber = await store.allocateCardNumber(teamId);
  const qrDataUri = normalized.permalink
    ? await QRCode.toDataURL(normalized.permalink, {
        margin: 0,
        width: 260,
        color: { dark: '#2A241B', light: '#FFFFFF' },
      })
    : undefined;

  const back = await renderBack(normalized, config.size, {
    includeMessage: photoFront,
    senders,
    cardNumber,
    teamName: deps.teamName,
    qrDataUri,
  });

  const today = new Date().toISOString().slice(0, 10);
  await store.incrementDailyCount(teamId, today, config.dailyCap);

  // Host the rendered images — Mailstream's artwork HTML references URLs.
  // Deterministic seeds keep retry payloads identical (idempotency replay).
  const idempotencyKey = `${teamId}:${channelId}:${messageTs}`;
  let frontUrl = 'stub://front';
  let backUrl = 'stub://back';
  if (!isStubMode()) {
    [frontUrl, backUrl] = await Promise.all([
      uploadArtwork(teamId, front, `${idempotencyKey}:front`),
      uploadArtwork(teamId, back, `${idempotencyKey}:back`),
    ]);
  }

  let result;
  try {
    const mailstream = getMailstreamClient(configuredKey);
    result = await mailstream.createPostcard({
      size: config.size,
      to: config.address!,
      frontUrl,
      backUrl,
      idempotencyKey,
      // Becomes the campaign name in their dashboard — keep it scannable.
      description: `Postie № ${cardNumber} · #${normalized.channelName} · ${new Date().toISOString().slice(0, 10)}`,
    });
  } catch (err) {
    await store.decrementDailyCount(teamId, today);
    await store.releaseCardNumber(teamId);
    if (err instanceof InsufficientPointsError) {
      // Not retryable — but still show the rendered card so design iteration
      // doesn't depend on a funded account.
      await store.releaseCardLock(teamId, channelId, messageTs, err.message);
      await deps.slack.files.uploadV2({
        channel_id: channelId,
        thread_ts: messageTs,
        initial_comment:
          ':coin: The Mailstream account is out of print points, so this card was *not* created — preview only. Top up at my.mailstream.app, then remove + re-add a :postcard: reaction to send it for real.',
        file_uploads: [
          { file: front, filename: photoFront ? 'postcard-front.jpg' : 'postcard-front.png' },
          { file: back, filename: 'postcard-back.png' },
        ],
      });
      return;
    }
    throw err;
  }

  await store.markCardSent(teamId, channelId, messageTs, {
    postcardId: result.id,
    proofUrl: result.proofUrl,
  });

  await postCardPreview(deps, { normalized, config, count, cardNumber, result, front, back, photoFront });
}

async function postCardPreview(
  deps: PipelineDeps,
  ctx: {
    normalized: NormalizedMessage;
    config: TeamConfig;
    count: number;
    cardNumber: number;
    result: { id: string; proofUrl?: string };
    front: Buffer;
    back: Buffer;
    photoFront: boolean;
  },
): Promise<void> {
  const { normalized, config, count, cardNumber, result, front, back } = ctx;
  const to = config.address!;
  const lines = [
    `:postbox: *This message is officially postcard-worthy!* ${count}× :${config.triggerEmoji}: made it happen.`,
    `Postcard № ${cardNumber} (${config.size}) is heading to *${addressDisplayName(to)}* in ${to.city}, ${to.state}.`,
  ];
  if (isStubMode()) {
    lines.push(':test_tube: _Sandbox mode — rendered for real, mailed nowhere._');
  } else if (result.proofUrl) {
    lines.push(
      `<${result.proofUrl}|Print proof (PDF)> — their renderer takes ~20 min, so the link may 404 at first.`,
    );
  }

  await deps.slack.files.uploadV2({
    channel_id: normalized.channelId,
    thread_ts: normalized.messageTs,
    initial_comment: lines.join('\n'),
    file_uploads: [
      { file: front, filename: ctx.photoFront ? 'postcard-front.jpg' : 'postcard-front.png' },
      { file: back, filename: 'postcard-back.png' },
    ],
  });
}

async function postThreadReply(
  deps: PipelineDeps,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  try {
    await deps.slack.chat.postMessage({ channel, thread_ts: threadTs, text });
  } catch (err) {
    console.error('[postie] failed to post thread reply:', err);
  }
}

/**
 * Slack-hosted files need bot-token auth; block images from other bots are
 * usually public URLs and must NOT receive our token (credential hygiene).
 */
async function fetchImage(url: string, botToken?: string): Promise<Buffer> {
  const headers = botToken ? { Authorization: `Bearer ${botToken}` } : undefined;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`image fetch failed: ${res.status} ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('image fetch returned no content (auth?)');
  return buf;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
