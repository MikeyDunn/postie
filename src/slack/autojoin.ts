import type { WebClient } from '@slack/web-api';
import type { JoinAllJob } from '../core/types';

/**
 * Slack only delivers reaction events for conversations the bot is in, so
 * Postie joins every public channel itself (scope: channels:join) instead of
 * waiting for invites. Private channels still require an invite — Slack does
 * not allow self-joining those, by design.
 */
export async function processJoinAllJob(job: JoinAllJob, slack: WebClient): Promise<void> {
  let joined = 0;
  let already = 0;
  let failed = 0;

  for await (const page of slack.paginate('conversations.list', {
    types: 'public_channel',
    exclude_archived: true,
    limit: 200,
  })) {
    for (const channel of (
      page as { channels?: Array<{ id?: string; name?: string; is_member?: boolean }> }
    ).channels ?? []) {
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
  }

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

/** Final-attempt confession — the admin is otherwise left waiting forever. */
export async function reportJoinAllFailure(responseUrl: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: ':warning: join-all hit an error partway through — some channels may not be joined. Run `/postie join-all` again to finish.',
      }),
    });
  } catch (err) {
    console.error('[postie] could not report join-all failure:', err);
  }
}
