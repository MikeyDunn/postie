import { describe, expect, it } from 'vitest';
import { DailyCapExceededError, MemoryStore } from '../src/core/store';

describe('MemoryStore (contract shared with DynamoStore)', () => {
  it('grants the card lock exactly once while in flight or sent', async () => {
    const store = new MemoryStore();
    expect(await store.acquireCardLock('T1', 'C1', '111.222')).toBe(true);
    expect(await store.acquireCardLock('T1', 'C1', '111.222')).toBe(false);
    await store.markCardSent('T1', 'C1', '111.222', { postcardId: 'psc_1' });
    expect(await store.acquireCardLock('T1', 'C1', '111.222')).toBe(false);
  });

  it('lets a failed send re-acquire the lock', async () => {
    const store = new MemoryStore();
    await store.acquireCardLock('T1', 'C1', '111.222');
    await store.releaseCardLock('T1', 'C1', '111.222', 'boom');
    expect(await store.acquireCardLock('T1', 'C1', '111.222')).toBe(true);
  });

  it('enforces the daily cap and supports compensation', async () => {
    const store = new MemoryStore();
    expect(await store.incrementDailyCount('T1', '2026-07-13', 2)).toBe(1);
    expect(await store.incrementDailyCount('T1', '2026-07-13', 2)).toBe(2);
    await expect(store.incrementDailyCount('T1', '2026-07-13', 2)).rejects.toThrow(
      DailyCapExceededError,
    );
    await store.decrementDailyCount('T1', '2026-07-13');
    expect(await store.incrementDailyCount('T1', '2026-07-13', 2)).toBe(2);
  });

  it('tracks lifetime card totals through the number counter', async () => {
    const store = new MemoryStore();
    expect(await store.getCardTotal('T1')).toBe(0);
    await store.allocateCardNumber('T1');
    await store.allocateCardNumber('T1');
    expect(await store.getCardTotal('T1')).toBe(2);
  });

});
