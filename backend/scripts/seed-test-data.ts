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
  // Tech Startups Group
  {
    name: 'Acme Tech Inc',
    email: 'billing@acmetech.io',
    groupId: 'tech-startups',
  },
  {
    name: 'CloudScale Systems',
    email: 'finance@cloudscale.dev',
    groupId: 'tech-startups',
  },
  {
    name: 'DataFlow Analytics',
    email: 'payments@dataflow.ai',
    groupId: 'tech-startups',
  },
  // E-commerce Group
  {
    name: 'StyleHub Fashion',
    email: 'orders@stylehub.shop',
    groupId: 'ecommerce',
  },
  {
    name: 'GearPro Sports',
    email: 'sales@gearpro.co',
    groupId: 'ecommerce',
  },
  {
    name: 'HomeEssentials Plus',
    email: 'billing@homeessentials.store',
    groupId: 'ecommerce',
  },
  // Consulting Services Group
  {
    name: 'Strategic Advisors LLC',
    email: 'contact@strategicadvisors.biz',
    groupId: 'consulting',
  },
  {
    name: 'Growth Partners Group',
    email: 'info@growthpartners.consulting',
    groupId: 'consulting',
  },
  // No Group (Default)
  {
    name: 'DFW Software Consulting',
    email: 'mail@dfwsc.com',
    groupId: null,
  },
];

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function sha256Lookup(apiKey: string): string {
  return crypto.createHash('sha256').update(`lookup:${apiKey}`).digest('hex');
}

async function seed() {
  console.log('🌱 Seeding test data...');

  // Clear existing test data (optional - comment out if you want to keep existing data)
  console.log('🗑️  Clearing existing test data...');
  await db.delete(clients);
  await db.delete(clientGroups);

  // Insert groups
  console.log('📦 Creating groups...');
  for (const group of TEST_GROUPS) {
    const now = new Date();
    await db.insert(clientGroups).values({
      id: group.id,
      name: group.name,
      status: 'active',
      processingFeePercent: group.processingFeePercent,
      processingFeeCents: group.processingFeeCents,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`   ✓ Created group: ${group.name}`);
  }

  // Insert clients
  console.log('👥 Creating clients...');
  for (const client of TEST_CLIENTS) {
    const id = nanoid();
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
      createdAt: now,
      updatedAt: now,
    });

    const groupName = client.groupId 
      ? TEST_GROUPS.find(g => g.id === client.groupId)?.name 
      : 'None';
    console.log(`   ✓ Created client: ${client.name} (Group: ${groupName})`);
  }

  console.log('\n✅ Seeding complete!');
  console.log(`   - ${TEST_GROUPS.length} groups created`);
  console.log(`   - ${TEST_CLIENTS.length} clients created`);
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
