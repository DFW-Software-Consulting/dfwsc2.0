import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from './src/db/schema';

async function checkSchema() {
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();
  const db = drizzle(client, { schema });

  // Query the table structure directly
  const result = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'onboarding_tokens' 
    ORDER BY ordinal_position;
  `);

  console.log('Current onboarding_tokens table structure:');
  result.rows.forEach(row => {
    console.log(`  ${row.column_name}: ${row.data_type}`);
  });

  await client.end();
}

checkSchema().catch(console.error);