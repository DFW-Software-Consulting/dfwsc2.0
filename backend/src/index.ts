import dotenv from 'dotenv';

// Load environment variables synchronously before any other imports
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Now import and start the server after env vars are loaded
async function start() {
  const { buildServer } = await import('./app');
  const { runMigrations } = await import('./lib/migrate');
  const { verifyDatabaseSchema } = await import('./lib/schema-check');

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