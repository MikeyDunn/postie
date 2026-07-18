import { getParameter } from '@aws-lambda-powertools/parameters/ssm';

/**
 * Secrets resolve from a direct env var, or from SSM when only the
 * `<NAME>_PARAM` env var (holding an SSM parameter name) is set. Powertools
 * handles the SSM client, decryption, and caching.
 */
async function resolveSecret(envName: string): Promise<string> {
  const direct = process.env[envName];
  if (direct) return direct;
  const paramName = process.env[`${envName}_PARAM`];
  if (paramName) {
    const value = await getParameter(paramName, { decrypt: true, maxAge: 300 });
    if (value) return value;
  }
  throw new Error(`Neither ${envName} nor ${envName}_PARAM is set`);
}

export interface SlackSecrets {
  botToken: string;
  signingSecret: string;
}

export async function getSlackSecrets(): Promise<SlackSecrets> {
  return {
    botToken: await resolveSecret('SLACK_BOT_TOKEN'),
    signingSecret: await resolveSecret('SLACK_SIGNING_SECRET'),
  };
}
