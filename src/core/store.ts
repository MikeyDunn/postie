import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { type CardRecord, type CardStatus, CONFIG_DEFAULTS, type TeamConfig } from './types';

export class DailyCapExceededError extends Error {
  constructor(cap: number) {
    super(`Daily postcard cap of ${cap} reached`);
    this.name = 'DailyCapExceededError';
  }
}

export interface Store {
  getTeamConfig(teamId: string): Promise<TeamConfig>;
  updateTeamConfig(teamId: string, patch: Partial<TeamConfig>): Promise<void>;
  /**
   * Exactly-once send lock. Returns true if this caller won the right to send
   * the postcard for this message; false if a send is in flight or done.
   * A previously failed send may be re-acquired (so a fresh reaction retries).
   */
  acquireCardLock(teamId: string, channelId: string, messageTs: string): Promise<boolean>;
  /** Marks the card failed, making the lock re-acquirable. */
  releaseCardLock(
    teamId: string,
    channelId: string,
    messageTs: string,
    error?: string,
  ): Promise<void>;
  markCardSent(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { postcardId: string; proofUrl?: string },
  ): Promise<void>;
  /** Atomically increments today's count; throws DailyCapExceededError at the cap. */
  incrementDailyCount(teamId: string, date: string, cap: number): Promise<number>;
  decrementDailyCount(teamId: string, date: string): Promise<void>;
  getDailyCount(teamId: string, date: string): Promise<number>;
  /** Per-workspace running postcard number ("Postie № 12"). */
  allocateCardNumber(teamId: string): Promise<number>;
  /** Lifetime cards sent (the counter behind card numbers). */
  getCardTotal(teamId: string): Promise<number>;
  /** Sent cards still awaiting delivery-status tracking. */
  listTrackedCards(): Promise<CardRecord[]>;
  updateCardTracking(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { mailstreamStatus: string; done: boolean },
  ): Promise<void>;
  /** Best-effort compensation when a send fails after allocation. */
  releaseCardNumber(teamId: string): Promise<void>;
}

const teamPk = (teamId: string) => `TEAM#${teamId}`;
const cardSk = (channelId: string, messageTs: string) => `CARD#${channelId}#${messageTs}`;
const daySk = (date: string) => `DAY#${date}`;

const DAY_SECONDS = 24 * 60 * 60;

export class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient;
  constructor(private table: string = requireTable()) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async getTeamConfig(teamId: string): Promise<TeamConfig> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: teamPk(teamId), sk: 'CONFIG' } }),
    );
    const item = res.Item ?? {};
    return { ...CONFIG_DEFAULTS, ...item, teamId } as TeamConfig;
  }

  async updateTeamConfig(teamId: string, patch: Partial<TeamConfig>): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
      return `#k${i} = :v${i}`;
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: 'CONFIG' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async acquireCardLock(teamId: string, channelId: string, messageTs: string): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: teamPk(teamId),
            sk: cardSk(channelId, messageTs),
            teamId,
            channelId,
            messageTs,
            status: 'sending' satisfies CardStatus,
            startedAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(pk) OR #status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed' },
        }),
      );
      return true;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async releaseCardLock(
    teamId: string,
    channelId: string,
    messageTs: string,
    error?: string,
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: cardSk(channelId, messageTs) },
        UpdateExpression: 'SET #status = :failed, #error = :error',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: { ':failed': 'failed', ':error': error ?? 'unknown' },
      }),
    );
  }

  async markCardSent(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { postcardId: string; proofUrl?: string },
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: cardSk(channelId, messageTs) },
        UpdateExpression:
          'SET #status = :sent, postcardId = :pid, proofUrl = :proof, sentAt = :now REMOVE #error',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':sent': 'sent',
          ':pid': info.postcardId,
          ':proof': info.proofUrl ?? null,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }

  async listTrackedCards(): Promise<CardRecord[]> {
    // Scan is fine at Postie's scale (a few cards/day, 30-day tracking window).
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression:
          'begins_with(sk, :card) AND #st = :sent AND attribute_not_exists(trackingDone)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':card': 'CARD#', ':sent': 'sent' },
      }),
    );
    return (res.Items ?? []) as unknown as CardRecord[];
  }

  async updateCardTracking(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { mailstreamStatus: string; done: boolean },
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: cardSk(channelId, messageTs) },
        UpdateExpression: info.done
          ? 'SET mailstreamStatus = :ms, trackingDone = :done'
          : 'SET mailstreamStatus = :ms',
        ExpressionAttributeValues: info.done
          ? { ':ms': info.mailstreamStatus, ':done': true }
          : { ':ms': info.mailstreamStatus },
      }),
    );
  }

  async incrementDailyCount(teamId: string, date: string, cap: number): Promise<number> {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: teamPk(teamId), sk: daySk(date) },
          UpdateExpression: 'ADD cnt :one SET #ttl = if_not_exists(#ttl, :ttl)',
          ConditionExpression: 'attribute_not_exists(cnt) OR cnt < :cap',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':cap': cap,
            ':ttl': Math.floor(Date.now() / 1000) + 40 * DAY_SECONDS,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return (res.Attributes?.cnt as number) ?? 1;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') {
        throw new DailyCapExceededError(cap);
      }
      throw err;
    }
  }

  async decrementDailyCount(teamId: string, date: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: daySk(date) },
        UpdateExpression: 'ADD cnt :minus',
        ExpressionAttributeValues: { ':minus': -1 },
      }),
    );
  }

  async getDailyCount(teamId: string, date: string): Promise<number> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: teamPk(teamId), sk: daySk(date) } }),
    );
    return (res.Item?.cnt as number) ?? 0;
  }

  async getCardTotal(teamId: string): Promise<number> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: teamPk(teamId), sk: 'COUNTER' } }),
    );
    return (res.Item?.total as number) ?? 0;
  }

  async allocateCardNumber(teamId: string): Promise<number> {
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: 'COUNTER' },
        UpdateExpression: 'ADD #t :one',
        ExpressionAttributeNames: { '#t': 'total' },
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return (res.Attributes?.total as number) ?? 1;
  }

  async releaseCardNumber(teamId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: teamPk(teamId), sk: 'COUNTER' },
        UpdateExpression: 'ADD #t :minus',
        ExpressionAttributeNames: { '#t': 'total' },
        ExpressionAttributeValues: { ':minus': -1 },
      }),
    );
  }
}

function requireTable(): string {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME is not set');
  return t;
}

/** In-memory Store for tests. Same contract as DynamoStore, no AWS. */
export class MemoryStore implements Store {
  private configs = new Map<string, Partial<TeamConfig>>();
  private cards = new Map<string, CardRecord>();
  private counts = new Map<string, number>();

  async getTeamConfig(teamId: string): Promise<TeamConfig> {
    return { ...CONFIG_DEFAULTS, ...this.configs.get(teamId), teamId } as TeamConfig;
  }

  async updateTeamConfig(teamId: string, patch: Partial<TeamConfig>): Promise<void> {
    this.configs.set(teamId, { ...this.configs.get(teamId), ...patch });
  }

  async acquireCardLock(teamId: string, channelId: string, messageTs: string): Promise<boolean> {
    const key = `${teamId}/${channelId}/${messageTs}`;
    const existing = this.cards.get(key);
    if (existing && existing.status !== 'failed') return false;
    this.cards.set(key, { teamId, channelId, messageTs, status: 'sending' });
    return true;
  }

  async releaseCardLock(
    teamId: string,
    channelId: string,
    messageTs: string,
    error?: string,
  ): Promise<void> {
    const key = `${teamId}/${channelId}/${messageTs}`;
    const card = this.cards.get(key);
    if (card) Object.assign(card, { status: 'failed', error });
  }

  async markCardSent(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { postcardId: string; proofUrl?: string },
  ): Promise<void> {
    const key = `${teamId}/${channelId}/${messageTs}`;
    const card = this.cards.get(key);
    if (card) {
      Object.assign(card, { status: 'sent', ...info, sentAt: new Date().toISOString() });
    }
  }

  async incrementDailyCount(teamId: string, date: string, cap: number): Promise<number> {
    const key = `${teamId}/${date}`;
    const current = this.counts.get(key) ?? 0;
    if (current >= cap) throw new DailyCapExceededError(cap);
    this.counts.set(key, current + 1);
    return current + 1;
  }

  async decrementDailyCount(teamId: string, date: string): Promise<void> {
    const key = `${teamId}/${date}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) - 1);
  }

  async getDailyCount(teamId: string, date: string): Promise<number> {
    return this.counts.get(`${teamId}/${date}`) ?? 0;
  }

  async listTrackedCards(): Promise<CardRecord[]> {
    return [...this.cards.values()].filter((c) => c.status === 'sent' && !c.trackingDone);
  }

  async updateCardTracking(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { mailstreamStatus: string; done: boolean },
  ): Promise<void> {
    const card = this.cards.get(`${teamId}/${channelId}/${messageTs}`);
    if (card) {
      card.mailstreamStatus = info.mailstreamStatus;
      if (info.done) card.trackingDone = true;
    }
  }

  async getCardTotal(teamId: string): Promise<number> {
    return this.counts.get(`${teamId}/counter`) ?? 0;
  }

  async allocateCardNumber(teamId: string): Promise<number> {
    const key = `${teamId}/counter`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async releaseCardNumber(teamId: string): Promise<void> {
    const key = `${teamId}/counter`;
    this.counts.set(key, (this.counts.get(key) ?? 0) - 1);
  }
}

export function getStore(): Store {
  return new DynamoStore();
}
