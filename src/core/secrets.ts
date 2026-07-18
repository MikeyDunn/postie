import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

let ssm: SSMClient | undefined;
const paramCache = new Map<string, string>();

async function getParam(name: string): Promise<string> {
  const cached = paramCache.get(name);
  if (cached) return cached;
  if (!ssm) ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  paramCache.set(name, value);
  return value;
}

/**
 * Resolves a secret from a direct env var, or from SSM when only the
 * `<NAME>_PARAM` env var (holding an SSM parameter name) is set.
 */
async function resolveSecret(envName: string): Promise<string> {
  const direct = process.env[envName];
  if (direct) return direct;
  const paramName = process.env[`${envName}_PARAM`];
  if (paramName) return getParam(paramName);
  throw new Error(`Neither ${envName} nor ${envName}_PARAM is set`);
}

export interface SlackSecrets {
  botToken: string;
  signingSecret: string;
}

let slackSecrets: Promise<SlackSecrets> | undefined;

export function getSlackSecrets(): Promise<SlackSecrets> {
  if (!slackSecrets) {
    slackSecrets = (async () => ({
      botToken: await resolveSecret('SLACK_BOT_TOKEN'),
      signingSecret: await resolveSecret('SLACK_SIGNING_SECRET'),
    }))();
  }
  return slackSecrets;
}
