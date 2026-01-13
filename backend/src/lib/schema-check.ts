import { db } from '../db/client';
import { sql } from 'drizzle-orm';

type TableColumns = {
  table: string;
  columns: string[];
};

const REQUIRED_TABLES: TableColumns[] = [
  {
    table: 'clients',
    columns: [
      'id',
      'name',
      'email',
      'stripe_account_id',
      'status',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: 'webhook_events',
    columns: [
      'id',
      'stripe_event_id',
      'type',
      'payload',
      'processed_at',
      'created_at',
    ],
  },
];

export async function verifyDatabaseSchema(): Promise<void> {
  for (const { table, columns } of REQUIRED_TABLES) {
    const result = await db.execute(
      sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${table}
      `,
    );

    const rows = (result.rows ?? []) as Array<{ column_name: string }>;
    const existingColumns = new Set<string>(rows.map((row) => row.column_name));

    const missing = columns.filter((column) => !existingColumns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `Database schema incomplete for table "${table}". Missing columns: ${missing.join(
          ', ',
        )}. Please run the latest migrations and restart the server.`,
      );
    }
  }
}
