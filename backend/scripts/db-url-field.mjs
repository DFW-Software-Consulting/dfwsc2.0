#!/usr/bin/env node
import { URL } from 'node:url';

const field = process.argv[2];
if (!field) {
  console.error('Usage: node scripts/db-url-field.mjs <name|user|password|host|port>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.exit(0);
}

const url = new URL(connectionString);

const outputs = {
  name: url.pathname.replace(/^\//, ''),
  user: url.username,
  password: url.password,
  host: url.hostname,
  port: url.port || '5432',
};

const value = outputs[field];
if (value === undefined) {
  console.error(`Unknown field "${field}" requested`);
  process.exit(1);
}

process.stdout.write(value);
