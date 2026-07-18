import { App, AwsLambdaReceiver } from '@slack/bolt';
import { SqsJobQueue } from '../core/queue';
import { getSlackSecrets } from '../core/secrets';
import { getStore } from '../core/store';
import { registerListeners } from '../slack/listeners';

// Bolt 5: the AwsLambdaReceiver handler is 2-arg promise-based (no callback).
type AwsHandler = (event: unknown, context: unknown) => Promise<unknown>;

let cached: Promise<AwsHandler> | undefined;

async function init(): Promise<AwsHandler> {
  const { botToken, signingSecret } = await getSlackSecrets();
  const receiver = new AwsLambdaReceiver({ signingSecret });
  const app = new App({
    token: botToken,
    receiver,
    // Lambda freezes after the response, so all listener work must finish
    // before the ack goes out. Listeners here only enqueue — always fast.
    processBeforeResponse: true,
  });
  registerListeners(app, {
    store: getStore(),
    queue: new SqsJobQueue(process.env.QUEUE_URL!),
  });
  return receiver.start() as unknown as Promise<AwsHandler>;
}

export const handler = async (event: unknown, context: unknown) => {
  cached ??= init();
  return (await cached)(event, context);
};
