import { db } from '../db/client';
import { clients } from '../db/schema';
import { hashApiKey } from '../lib/auth';
import { eq, isNotNull } from 'drizzle-orm';

/**
 * Migrates existing plaintext API keys to hashed format
 * This script should be run after the schema migration is applied
 */
async function migrateApiKeys() {
  console.log('Starting API key migration...');
  
  try {
    // Find all clients with plaintext API keys
    const clientsWithPlaintextKeys = await db
      .select({ id: clients.id, apiKey: clients.apiKey })
      .from(clients)
      .where(isNotNull(clients.apiKey));

    console.log(`Found ${clientsWithPlaintextKeys.length} clients with plaintext API keys`);

    for (const client of clientsWithPlaintextKeys) {
      if (client.apiKey) {
        console.log(`Hashing API key for client: ${client.id}`);
        
        // Hash the plaintext API key
        const hashedKey = await hashApiKey(client.apiKey);
        
        // Update the client record with the hash and clear the plaintext
        await db
          .update(clients)
          .set({ apiKeyHash: hashedKey, apiKey: null })
          .where(eq(clients.id, client.id));
          
        console.log(`Successfully migrated client: ${client.id}`);
      }
    }

    console.log('API key migration completed successfully!');
  } catch (error) {
    console.error('Error during API key migration:', error);
    process.exit(1);
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  migrateApiKeys();
}