(async () => {
  if (process.env.NODE_ENV !== 'production') {
    await import('dotenv/config');
  }
})();

import { buildServer } from './app';
import { runMigrations } from './lib/migrate';
import { verifyDatabaseSchema } from './lib/schema-check';

async function start() {
  const server = await buildServer();

  try {
    if (process.env.NODE_ENV !== 'production') {
      await runMigrations(server);
    }
    await verifyDatabaseSchema();
    await server.listen({ port: Number(process.env.PORT) || 4242, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
