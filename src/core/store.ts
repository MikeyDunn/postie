import {
  bindTable,
  CardEntity,
  ConfigEntity,
  CounterEntity,
  DayEntity,
  isConditionalFailure,
} from './entities';
import { type CardRecord, CONFIG_DEFAULTS, type TeamConfig } from './types';

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

const DAY_SECONDS = 24 * 60 * 60;

export class DynamoStore implements Store {
  constructor() {
    bindTable();
  }

  async getTeamConfig(teamId: string): Promise<TeamConfig> {
    const { data } = await ConfigEntity.get({ teamId }).go();
    return { ...CONFIG_DEFAULTS, ...(data ?? {}), teamId } as TeamConfig;
  }

  async updateTeamConfig(teamId: string, patch: Partial<TeamConfig>): Promise<void> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(defined).length === 0) return;
    await ConfigEntity.upsert({ teamId, ...defined }).go();
  }

  async acquireCardLock(teamId: string, channelId: string, messageTs: string): Promise<boolean> {
    try {
      await CardEntity.put({
        teamId,
        channelId,
        messageTs,
        status: 'sending',
        startedAt: new Date().toISOString(),
      })
        .where((a, op) => `${op.notExists(a.status)} OR ${op.eq(a.status, 'failed')}`)
        .go();
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async releaseCardLock(
    teamId: string,
    channelId: string,
    messageTs: string,
    error?: string,
  ): Promise<void> {
    await CardEntity.update({ teamId, channelId, messageTs })
      .set({ status: 'failed', error: error ?? 'unknown' })
      .go();
  }

  async markCardSent(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { postcardId: string; proofUrl?: string },
  ): Promise<void> {
    await CardEntity.update({ teamId, channelId, messageTs })
      .set({
        status: 'sent',
        postcardId: info.postcardId,
        sentAt: new Date().toISOString(),
        ...(info.proofUrl ? { proofUrl: info.proofUrl } : {}),
      })
      .remove(['error'])
      .go();
  }

  async listTrackedCards(): Promise<CardRecord[]> {
    const { data } = await CardEntity.scan
      .where((a, op) => `${op.eq(a.status, 'sent')} AND ${op.notExists(a.trackingDone)}`)
      .go({ pages: 'all' });
    return data as CardRecord[];
  }

  async updateCardTracking(
    teamId: string,
    channelId: string,
    messageTs: string,
    info: { mailstreamStatus: string; done: boolean },
  ): Promise<void> {
    await CardEntity.update({ teamId, channelId, messageTs })
      .set({
        mailstreamStatus: info.mailstreamStatus,
        ...(info.done ? { trackingDone: true } : {}),
      })
      .go();
  }

  async incrementDailyCount(teamId: string, date: string, cap: number): Promise<number> {
    try {
      const { data } = await DayEntity.update({ teamId, date })
        .add({ cnt: 1 })
        .set({ ttl: Math.floor(Date.now() / 1000) + 40 * DAY_SECONDS })
        .where((a, op) => `${op.notExists(a.cnt)} OR ${op.lt(a.cnt, cap)}`)
        .go({ response: 'updated_new' });
      return data?.cnt ?? 1;
    } catch (err) {
      if (isConditionalFailure(err)) throw new DailyCapExceededError(cap);
      throw err;
    }
  }

  async decrementDailyCount(teamId: string, date: string): Promise<void> {
    await DayEntity.update({ teamId, date }).subtract({ cnt: 1 }).go();
  }

  async getDailyCount(teamId: string, date: string): Promise<number> {
    const { data } = await DayEntity.get({ teamId, date }).go();
    return data?.cnt ?? 0;
  }

  async getCardTotal(teamId: string): Promise<number> {
    const { data } = await CounterEntity.get({ teamId }).go();
    return data?.total ?? 0;
  }

  async allocateCardNumber(teamId: string): Promise<number> {
    const { data } = await CounterEntity.update({ teamId })
      .add({ total: 1 })
      .go({ response: 'updated_new' });
    return data?.total ?? 1;
  }

  async releaseCardNumber(teamId: string): Promise<void> {
    await CounterEntity.update({ teamId }).subtract({ total: 1 }).go();
  }
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
