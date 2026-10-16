/* The gateway, in its own process, on http over loopback — so the RSS measured
   in the parent is the gateway's and nothing else's. */
const http = require('node:http');
const fs = require('node:fs');
const gwServer = require('../src/server');
const gwConfig = require('../src/config');

const share = process.env.SHARE;
const keyFile = process.env.PUBKEY;
const gw = gwServer.create({
  local: {
    fileRoot: share, stateDir: process.env.STATE,
    gatewayId: 'GW-BIG', gatewaySecret: 'b'.repeat(64),
    forgeUrl: 'http://127.0.0.1:1', listenAddress: '127.0.0.1', listenPort: 0,
    rateLimitPerMinute: 10 ** 7, heartbeatSeconds: 10 ** 6, configSeconds: 10 ** 6,
    clockLeewaySeconds: 30,
  },
  log: () => {},
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
});
Object.assign(gw.ctx, {
  config: () => gwConfig.shape({
    version: 1, maxFileBytes: 8 * 1024 ** 3, chunkBytes: 32 * 1024 * 1024,
    keys: [{ kid: process.env.KID, publicKey: fs.readFileSync(keyFile, 'utf8') }],
  }),
  callback: () => {},
  verifyLater: () => {},        // the checksum pass is measured separately
});
const server = http.createServer((req, res) => gw.handler(req, res));
server.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port, pid: process.pid });
});
