import type { WebClient } from '@slack/web-api';
import { JoinAllJob } from '../core/types';

/**
 * Slack only delivers reaction events for conversations the bot is in, so
 * Postie joins every public channel itself (scope: channels:join) instead of
 * waiting for invites. Private channels still require an invite — Slack does
 * not allow self-joining those, by design.
 */
export async function processJoinAllJob(job: JoinAllJob, slack: WebClient): Promise<void> {
  let cursor: string | undefined;
  let joined = 0;
  let already = 0;
  let failed = 0;

  do {
    const res = await slack.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const channel of res.channels ?? []) {
      if (!channel.id) continue;
      if (channel.is_member) {
        already++;
        continue;
      }
      try {
        await slack.conversations.join({ channel: channel.id });
        joined++;
      } catch (err) {
        failed++;
        console.warn(`[postie] could not join #${channel.name}:`, err);
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const summary =
    `:postbox: Joined ${joined} public channel${joined === 1 ? '' : 's'}` +
    `${already ? ` (already in ${already})` : ''}${failed ? `, ${failed} failed` : ''}. ` +
    'Postcard reactions now work everywhere public. Private channels still need `/invite @postie`.';

  try {
    await fetch(job.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text: summary }),
    });
  } catch (err) {
    console.error('[postie] join-all summary failed:', err);
  }
}
