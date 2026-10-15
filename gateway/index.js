#!/usr/bin/env node
/* The gateway, started. See gateway/README.md for installation on Windows
   (as a service) and Linux (as a systemd unit). */
const config = require('./src/config');
const server = require('./src/server');

try { require('node:fs').accessSync(require('node:path').join(__dirname, '.env')); require('dotenv/config'); }
catch { /* no .env, which is the normal case: IT sets real environment variables */ }

const local = config.local(process.env);
if (local.missing.length) {
  console.error('The office file gateway cannot start: its configuration is incomplete.');
  for (const name of local.missing) console.error(`  missing: ${name}`);
  console.error('\ngateway/README.md lists every value and where it comes from.');
  process.exit(1);
}
server.create({ local }).start();
