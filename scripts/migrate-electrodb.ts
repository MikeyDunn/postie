/**
 * One-shot migration: rewrite every existing row through the ElectroDB
 * entities so items gain the library's bookkeeping attributes. Key templates
 * match the legacy layout, so keys are unchanged — puts overwrite in place.
 * Legacy MSEVENT rows (removed webhook feature) are deleted.
 *
 *   AWS_PROFILE=... TABLE_NAME=postie npx tsx scripts/migrate-electrodb.ts
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  bindTable,
  CardEntity,
  ConfigEntity,
  CounterEntity,
  DayEntity,
} from '../src/core/entities';

async function main() {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  bindTable();
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const { Items = [] } = await doc.send(new ScanCommand({ TableName: table }));
  console.log(`${Items.length} item(s) to migrate`);

  const counts: Record<string, number> = {};
  for (const item of Items) {
    const pk = String(item.pk);
    const sk = String(item.sk);
    const teamId = pk.replace(/^TEAM#/, '');
    const strip = (o: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(o).filter(
          ([k, v]) => !['pk', 'sk', 'gsi1pk', 'gsi1sk'].includes(k) && v !== null,
        ),
      );

    if (pk.startsWith('MSEVENT#')) {
      await doc.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
      counts.deleted = (counts.deleted ?? 0) + 1;
    } else if (sk === 'CONFIG') {
      await ConfigEntity.upsert({ ...strip(item), teamId }).go();
      counts.config = (counts.config ?? 0) + 1;
    } else if (sk.startsWith('CARD#')) {
      await CardEntity.put({ ...strip(item), teamId } as Parameters<typeof CardEntity.put>[0]).go();
      counts.card = (counts.card ?? 0) + 1;
    } else if (sk.startsWith('DAY#')) {
      await DayEntity.put({
        ...strip(item),
        teamId,
        date: sk.replace(/^DAY#/, ''),
      } as Parameters<typeof DayEntity.put>[0]).go();
      counts.day = (counts.day ?? 0) + 1;
    } else if (sk === 'COUNTER') {
      await CounterEntity.put({ ...strip(item), teamId } as Parameters<
        typeof CounterEntity.put
      >[0]).go();
      counts.counter = (counts.counter ?? 0) + 1;
    } else {
      console.warn(`skipping unknown row: ${pk} / ${sk}`);
      counts.skipped = (counts.skipped ?? 0) + 1;
    }
  }
  console.log('migrated:', counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
