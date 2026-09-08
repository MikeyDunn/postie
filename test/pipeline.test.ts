import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/store';
import { processSendJob } from '../src/postcard/pipeline';

/** A Slack client that fails loudly if the pipeline reaches for it. */
const untouchableSlack = new Proxy({} as WebClient, {
  get(_target, prop) {
    throw new Error(`Slack API touched while paused: ${String(prop)}`);
  },
});

describe('processSendJob', () => {
  it('drops queued jobs without calling Slack while the workspace is paused', async () => {
    const store = new MemoryStore();
    await store.updateTeamConfig('T1', { paused: true });
    await expect(
      processSendJob(
        { type: 'send', teamId: 'T1', channelId: 'C1', messageTs: '111.222' },
        { store, slack: untouchableSlack, botToken: 'xoxb-test' },
      ),
    ).resolves.toBeUndefined();
    // Nothing was locked — a reaction after `/postie on` can still send it.
    expect(await store.acquireCardLock('T1', 'C1', '111.222')).toBe(true);
  });
});
