import { decryptSecret } from '../core/crypto';
import { getMailstreamClient, isStubMode } from '../mailstream/client';
import { PipelineDeps } from './pipeline';
import { statusLine, TERMINAL_STATUSES } from './statusLines';

const MAX_TRACK_DAYS = 30;

/**
 * Delivery tracking without webhooks: Mailstream has no tracking events (as
 * of 2026-07), but the postcard resource's `status` field exists and USPS
 * IMb scan tracking is advertised — so an EventBridge tick polls every open
 * card and posts thread updates on change. If statuses turn out never to
 * progress past "sent", cards quietly age out after MAX_TRACK_DAYS.
 */
export async function processTrackAll(deps: PipelineDeps): Promise<void> {
  if (isStubMode()) return;
  const cards = await deps.store.listTrackedCards();
  if (!cards.length) return;
  console.log(`[postie] tracking ${cards.length} open card(s)`);

  const keyCache = new Map<string, string | undefined>();

  for (const card of cards) {
    if (!card.postcardId) continue;

    const ageDays = card.sentAt
      ? (Date.now() - new Date(card.sentAt).getTime()) / 86_400_000
      : 0;
    if (ageDays > MAX_TRACK_DAYS) {
      await deps.store.updateCardTracking(card.teamId, card.channelId, card.messageTs, {
        mailstreamStatus: card.mailstreamStatus ?? 'unknown',
        done: true,
      });
      continue;
    }

    try {
      if (!keyCache.has(card.teamId)) {
        const config = await deps.store.getTeamConfig(card.teamId);
        keyCache.set(
          card.teamId,
          config.mailstreamApiKey ? await decryptSecret(config.mailstreamApiKey) : undefined,
        );
      }
      const apiKey = keyCache.get(card.teamId);
      if (!apiKey) continue;

      const remote = await getMailstreamClient(apiKey).getPostcard(card.postcardId);
      const lastSeen = card.mailstreamStatus ?? 'pending';
      if (remote.status === lastSeen) continue;

      await deps.slack.chat.postMessage({
        channel: card.channelId,
        thread_ts: card.messageTs,
        text: statusLine(remote.status),
      });
      await deps.store.updateCardTracking(card.teamId, card.channelId, card.messageTs, {
        mailstreamStatus: remote.status,
        done: TERMINAL_STATUSES.has(remote.status),
      });
    } catch (err) {
      // 404 = the card doesn't exist upstream (stub-era ids, deletions) —
      // stop tracking it. Anything else is transient; next tick retries.
      if (String(err).includes('Mailstream 404')) {
        await deps.store.updateCardTracking(card.teamId, card.channelId, card.messageTs, {
          mailstreamStatus: 'not_found',
          done: true,
        });
        continue;
      }
      console.warn(`[postie] tracking check failed for ${card.postcardId}:`, err);
    }
  }
}
