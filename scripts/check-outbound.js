#!/usr/bin/env node
// Can this server reach the office file server, and what IP does it come from?
//
//   node scripts/check-outbound.js sftp.example.com 22
//   node scripts/check-outbound.js 203.0.113.10 2222 --no-ip
//
// Run this ON THE GODADDY ACCOUNT, before anybody changes a firewall rule.
//
// Moving file storage to an office server assumes two things about shared
// hosting that are true on a VPS and often false on shared plans, and both are
// cheaper to test than to discover halfway through the work:
//
//   1. Outbound connections on the port are allowed. Plenty of shared hosts
//      permit outbound 80/443 and nothing else, which rules out SFTP on 22 (and
//      any custom port) no matter what the office end is running.
//   2. The address the host connects OUT from is stable and known. A firewall
//      rule that names one IP is only as good as that IP staying put, and on
//      shared hosting the outbound address is often not the site's inbound one,
//      and can move when the account is migrated between machines.
//
// This answers both. It opens a TCP connection and reads the greeting banner —
// no credentials, nothing written, nothing transferred.

const net = require('node:net');
const https = require('node:https');

const args = process.argv.slice(2).filter((a) => a !== '--no-ip');
const skipIp = process.argv.includes('--no-ip');
const [host, portArg] = args;
const port = Number(portArg || 22);
const TIMEOUT = 8000;

if (!host) {
  console.error('usage: node scripts/check-outbound.js <host> [port] [--no-ip]');
  process.exit(2);
}

/* The outbound address, as an outside observer sees it. Asked over HTTPS, which
   is the one port a shared host is certain to allow — so a failure HERE means
   outbound traffic is restricted more tightly than usual, which is itself the
   answer to the question being asked. */
function outboundIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org', { timeout: TIMEOUT }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? body.trim() : null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Connect, and report the banner if the far end sends one. An SFTP service
// answers with something like "SSH-2.0-OpenSSH_9.6", which confirms not just
// that the port is open but that the thing behind it is the service expected.
function probe() {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let banner = '';
    const done = (result) => {
      sock.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    sock.setTimeout(TIMEOUT);
    sock.once('connect', () => {
      // Give the service a moment to speak first; many do, some never will.
      setTimeout(() => done({ ok: true, banner: banner.trim() }), 1200);
    });
    sock.on('data', (chunk) => { banner += chunk.toString('utf8').slice(0, 200); });
    sock.once('timeout', () => done({ ok: false, reason: `no answer within ${TIMEOUT / 1000}s` }));
    sock.once('error', (err) => done({ ok: false, reason: err.code || err.message }));
    sock.connect(port, host);
  });
}

(async () => {
  console.log(`Checking outbound reachability of ${host}:${port}\n`);

  if (!skipIp) {
    const ip = await outboundIp();
    if (ip) {
      console.log(`Outbound IP address of this server : ${ip}`);
      console.log('  This is the address the office firewall rule has to allow.');
      console.log('  Run this again on a few different days before treating it as fixed —');
      console.log('  shared hosting accounts do get moved between machines.\n');
    } else {
      console.log('Outbound IP address of this server : could not be determined');
      console.log('  The HTTPS request to api.ipify.org did not come back. If plain HTTPS');
      console.log('  is blocked outbound, SFTP on any port will be blocked too.\n');
    }
  }

  const r = await probe();
  if (r.ok) {
    console.log(`REACHABLE  ${host}:${port} answered in ${r.ms}ms`);
    if (r.banner) console.log(`  It said: ${JSON.stringify(r.banner)}`);
    else console.log('  It accepted the connection but sent no banner.');
    console.log('\n  Outbound traffic on this port is permitted from this account.');
    process.exit(0);
  }

  console.log(`NOT REACHABLE  ${host}:${port} — ${r.reason} (after ${r.ms}ms)`);
  console.log('\n  This does not yet say whose fault it is. Three things look identical');
  console.log('  from here, and they need different fixes:');
  console.log('    - the host blocks outbound connections on this port  -> ask GoDaddy support;');
  console.log('      if that is the answer, SFTP is off the table and an HTTPS upload');
  console.log('      endpoint on 443 is the only route that will work');
  console.log('    - the office router is not forwarding the port       -> ask your IT');
  console.log('    - the office firewall is rejecting this IP           -> expected, if the');
  console.log('      allowlist was written before the address above was known');
  console.log('\n  Test from a machine outside the office network first. If it answers there');
  console.log('  and not here, the restriction is on the hosting side.');
  process.exit(1);
})();
