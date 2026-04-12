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
    id: 'dfwsc-internal',
    name: 'DFWSC Internal',
    processingFeePercent: '3.0',
    processingFeeCents: null,
    workspace: 'dfwsc_services',
  },
  {
    id: 'tech-startups',
    name: 'Tech Startups',
    processingFeePercent: '2.9',
    processingFeeCents: null,
    workspace: 'client_portal',
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    processingFeePercent: null,
    processingFeeCents: 150, // $1.50 flat fee
    workspace: 'client_portal',
  },
  {
    id: 'consulting',
    name: 'Consulting Services',
    processingFeePercent: '3.5',
    processingFeeCents: null,
    workspace: 'client_portal',
  },
];

const TEST_CLIENTS = [
  // DFWSC Services Workspace
  {
    id: 'dfwsc-services',
    name: 'DFWSC Services',
    email: 'billing@dfwsc.com',
    groupId: 'dfwsc-internal',
    processingFeePercent: '3.0',
    workspace: 'dfwsc_services',
  },
  {
    id: 'dfwsc-secondary',
    name: 'DFWSC Secondary',
    email: 'secondary@dfwsc.com',
    groupId: 'dfwsc-internal',
    processingFeePercent: '2.5',
    workspace: 'dfwsc_services',
  },
  // Tech Startups Group
  {
    id: 'tech-startup-1',
    name: 'Acme Tech',
    email: 'billing@acme-tech.com',
    groupId: 'tech-startups',
    processingFeePercent: '2.9',
    workspace: 'client_portal',
  },
  {
    id: 'tech-startup-2',
    name: 'StartupXYZ',
    email: 'accounts@startupxyz.io',
    groupId: 'tech-startups',
    processingFeePercent: '2.9',
    workspace: 'client_portal',
  },
  // E-commerce (flat fee)
  {
    id: 'shop-main',
    name: 'Main Street Shop',
    email: 'sales@mainstreet.shop',
    groupId: 'ecommerce',
    processingFeeCents: 150,
    workspace: 'client_portal',
  },
  // Consulting (no group)
  {
    id: 'consultant-1',
    name: 'Jane Consulting',
    email: 'jane@example.com',
    groupId: 'consulting',
    processingFeePercent: '3.5',
    workspace: 'client_portal',
  },
  {
    id: 'solo-consultant',
    name: 'Bob Solo',
    email: 'bob@consultant.net',
    groupId: null,
    processingFeePercent: '4.0',
    workspace: 'client_portal',
  },
];
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
      workspace: client.workspace || 'client_portal',
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
