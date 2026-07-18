import { WebClient } from '@slack/web-api';
import type { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';
import { getSlackSecrets } from '../core/secrets';
import { getStore } from '../core/store';
import type { Job } from '../core/types';
import { type PipelineDeps, processSendJob } from '../postcard/pipeline';
import { processTrackAll } from '../postcard/tracker';
import { processJoinAllJob, reportJoinAllFailure } from '../slack/autojoin';

let depsPromise: Promise<PipelineDeps> | undefined;

async function getDeps(): Promise<PipelineDeps> {
  if (!depsPromise) {
    depsPromise = (async () => {
      const { botToken } = await getSlackSecrets();
      const slack = new WebClient(botToken);
      const auth = await slack.auth.test();
      return {
        store: getStore(),
        slack,
        botToken,
        botUserId: auth.user_id,
        teamName: auth.team,
      };
    })();
  }
  return depsPromise;
}

export const handler: SQSHandler = async (event) => {
  const deps = await getDeps();
  const batchItemFailures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    const attempt = Number(record.attributes.ApproximateReceiveCount ?? '1');
    try {
      const job = JSON.parse(record.body) as Job;
      if (job.type === 'join_all') {
        try {
          await processJoinAllJob(job, deps.slack);
        } catch (err) {
          // Surface to the admin who ran the command instead of dying silently.
          if (attempt >= 3) {
            await reportJoinAllFailure(job.responseUrl);
            continue;
          }
          throw err;
        }
      } else if (job.type === 'track_all') {
        await processTrackAll(deps);
      } else {
        await processSendJob(job, deps, attempt);
      }
    } catch (err) {
      console.error('[postie] job failed (will retry via SQS):', err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
