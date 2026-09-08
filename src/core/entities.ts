import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Entity } from 'electrodb';

/**
 * ElectroDB entity models for the single table. Key templates match the
 * original hand-rolled layout exactly (TEAM#<id> / CONFIG etc.), so the
 * physical rows are unchanged — ElectroDB replaces the key-string and
 * expression engineering, not the data design.
 */

const client = new DynamoDBClient({});

let bound = false;
/** Bind TABLE_NAME lazily so importing this module never requires env. */
export function bindTable(): void {
  if (bound) return;
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME is not set');
  for (const entity of [ConfigEntity, CardEntity, DayEntity, CounterEntity]) {
    entity.setTableName(t);
  }
  bound = true;
}

const address = {
  type: 'map',
  properties: {
    firstName: { type: 'string', required: true },
    lastName: { type: 'string', required: true },
    line1: { type: 'string', required: true },
    line2: { type: 'string' },
    city: { type: 'string', required: true },
    state: { type: 'string', required: true },
    postalCode: { type: 'string', required: true },
  },
} as const;

export const ConfigEntity = new Entity(
  {
    model: { entity: 'config', version: '1', service: 'postie' },
    attributes: {
      teamId: { type: 'string', required: true },
      mailstreamApiKey: { type: 'string' },
      address,
      // Optional "copy to me" recipient — same shape as the primary address.
      ccAddress: address,
      threshold: { type: 'number' },
      triggerEmoji: { type: 'string' },
      dailyCap: { type: 'number' },
      size: { type: ['4x6', '6x9', '6x11'] as const },
      presence: { type: ['everywhere', 'invited'] as const },
      paused: { type: 'boolean' },
    },
    indexes: {
      record: {
        pk: { field: 'pk', composite: ['teamId'], template: 'TEAM#${teamId}' },
        sk: { field: 'sk', composite: [], template: 'CONFIG' },
      },
    },
  },
  { client },
);

export const CardEntity = new Entity(
  {
    model: { entity: 'card', version: '1', service: 'postie' },
    attributes: {
      teamId: { type: 'string', required: true },
      channelId: { type: 'string', required: true },
      messageTs: { type: 'string', required: true },
      status: { type: ['sending', 'sent', 'failed'] as const, required: true },
      startedAt: { type: 'string' },
      sentAt: { type: 'string' },
      postcardId: { type: 'string' },
      proofUrl: { type: 'string' },
      error: { type: 'string' },
      mailstreamStatus: { type: 'string' },
      trackingDone: { type: 'boolean' },
    },
    indexes: {
      record: {
        pk: { field: 'pk', composite: ['teamId'], template: 'TEAM#${teamId}' },
        sk: {
          field: 'sk',
          composite: ['channelId', 'messageTs'],
          template: 'CARD#${channelId}#${messageTs}',
        },
      },
    },
  },
  { client },
);

export const DayEntity = new Entity(
  {
    model: { entity: 'day', version: '1', service: 'postie' },
    attributes: {
      teamId: { type: 'string', required: true },
      date: { type: 'string', required: true },
      cnt: { type: 'number' },
      ttl: { type: 'number' },
    },
    indexes: {
      record: {
        pk: { field: 'pk', composite: ['teamId'], template: 'TEAM#${teamId}' },
        sk: { field: 'sk', composite: ['date'], template: 'DAY#${date}' },
      },
    },
  },
  { client },
);

export const CounterEntity = new Entity(
  {
    model: { entity: 'counter', version: '1', service: 'postie' },
    attributes: {
      teamId: { type: 'string', required: true },
      total: { type: 'number' },
    },
    indexes: {
      record: {
        pk: { field: 'pk', composite: ['teamId'], template: 'TEAM#${teamId}' },
        sk: { field: 'sk', composite: [], template: 'COUNTER' },
      },
    },
  },
  { client },
);

export function isConditionalFailure(err: unknown): boolean {
  return /conditional/i.test(String(err));
}
