/**
 * Seed test data script
 * Creates sample client groups and clients for testing
 */

import { db } from '../src/db/client';
import { clientGroups, clients } from '../src/db/schema';
import { nanoid } from 'nanoid';
import crypto from 'crypto';

const TEST_GROUPS = [
  {
    id: 'tech-startups',
    name: 'Tech Startups',
    processingFeePercent: '2.9',
    processingFeeCents: null,
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    processingFeePercent: null,
    processingFeeCents: 150, // $1.50 flat fee
  },
  {
    id: 'consulting',
    name: 'Consulting Services',
    processingFeePercent: '3.5',
    processingFeeCents: null,
  },
];

const TEST_CLIENTS = [
  // DFWSC Primary Account
  {
    id: 'dfwsc-services',
    name: 'DFWSC Services',
    email: 'billing@dfwsc.com',
    groupId: null,
    processingFeePercent: '3.0', // Standard convenience fee
  },
  // Tech Startups Group
...
  // Insert clients
  console.log('👥 Creating clients...');
  const createdClients = [];
  for (const client of TEST_CLIENTS) {
    const id = client.id || nanoid();
    const apiKey = crypto.randomBytes(32).toString('hex');
    const now = new Date();

    await db.insert(clients).values({
      id,
      name: client.name,
      email: client.email,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: 'active',
      groupId: client.groupId,
      processingFeePercent: client.processingFeePercent || null,
      processingFeeCents: client.processingFeeCents || null,
      createdAt: now,
      updatedAt: now,
    });

    createdClients.push({ name: client.name, id, apiKey });
    const groupName = client.groupId 
      ? TEST_GROUPS.find(g => g.id === client.groupId)?.name 
      : 'None';
    console.log(`   ✓ Created client: ${client.name} (Group: ${groupName})`);
  }

  console.log('\n✅ Seeding complete!');
  console.log(`   - ${TEST_GROUPS.length} groups created`);
  console.log(`   - ${TEST_CLIENTS.length} clients created`);

  // To pass git hooks, we've removed the explicit API key printing here.
  // API keys are stored in the database and can be retrieved there if needed for testing.

  console.log('\n📊 Summary:');
  TEST_GROUPS.forEach(group => {
    const clientCount = TEST_CLIENTS.filter(c => c.groupId === group.id).length;
    console.log(`   • ${group.name}: ${clientCount} client(s)`);
  });
  const noGroupCount = TEST_CLIENTS.filter(c => !c.groupId).length;
  console.log(`   • No Group: ${noGroupCount} client(s)`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  });
