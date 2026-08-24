const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, raw, SKIP_REASON } = require('./helpers');
const ipMatch = require('../src/ip-match');

const cfg = config('ipallowlist');

// The address the studio is seeded with, and the one these tests treat as
// "the office".
const OFFICE = '106.51.81.61';
const OUTSIDE = '203.0.113.9';

// --- matching ----------------------------------------------------------------
// This is the part that decides who gets in, so it is tested on its own, without
// a server in the way.

test('single addresses match themselves and nothing else', () => {
  assert.ok(ipMatch.matches(OFFICE, OFFICE));
  assert.ok(!ipMatch.matches('106.51.81.62', OFFICE));
  assert.ok(!ipMatch.matches('106.51.81.6', OFFICE));
  assert.ok(!ipMatch.matches('106.51.81.610', OFFICE));
});

test('CIDR ranges cover their members and stop at the boundary', () => {
  assert.ok(ipMatch.matches('10.0.0.1', '10.0.0.0/24'));
  assert.ok(ipMatch.matches('10.0.0.255', '10.0.0.0/24'));
  assert.ok(!ipMatch.matches('10.0.1.0', '10.0.0.0/24'));
  // A prefix that does not fall on a byte boundary is where a hand-rolled
  // matcher usually goes wrong.
  assert.ok(ipMatch.matches('192.168.1.100', '192.168.0.0/23'));
  assert.ok(!ipMatch.matches('192.168.2.1', '192.168.0.0/23'));
  assert.ok(ipMatch.matches('1.2.3.4', '0.0.0.0/0'));
});

test('the IPv4-mapped IPv6 form is the same host as its IPv4 form', () => {
  // A dual-stack socket reports 127.0.0.1 as ::ffff:127.0.0.1. If those did not
  // compare equal, an entry someone added would silently stop matching.
  assert.ok(ipMatch.matches('::ffff:106.51.81.61', OFFICE));
  assert.ok(ipMatch.matches(OFFICE, '::ffff:106.51.81.61'));
  assert.strictEqual(ipMatch.normalise('::FFFF:106.51.81.61'), OFFICE);
});

test('IPv6 addresses and ranges match', () => {
  assert.ok(ipMatch.matches('2001:db8::1', '2001:db8::/32'));
  assert.ok(!ipMatch.matches('2001:db9::1', '2001:db8::/32'));
  assert.ok(ipMatch.matches('fe80::1%eth0', 'fe80::1'), 'a zone id names an interface, not a host');
  // Different families never match each other, whatever the bytes look like.
  assert.ok(!ipMatch.matches('2001:db8::1', '0.0.0.0/0'));
});

test('anything ambiguous or malformed is refused rather than guessed at', () => {
  for (const bad of [
    '', '   ', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-1',
    '010.1.1.1',            // octal in some parsers, decimal in others
    '0x7f.0.0.1',           // hex
    '1.2.3.4/33', '::1/129', '1.2.3.4/abc', '1.2.3.4/8/8',
    '2001:db8:::1', '12345::1', 'not an address',
  ]) {
    assert.ok(!ipMatch.isValidEntry(bad), `"${bad}" must not parse as an allowlist entry`);
    assert.ok(!ipMatch.matches(OFFICE, bad), `"${bad}" must never match anything`);
  }
  assert.strictEqual(ipMatch.parseIP(null), null);
  assert.strictEqual(ipMatch.parseIP(undefined), null);
  assert.strictEqual(ipMatch.parseIP(12345), null);
});

test('entries are stored in one canonical spelling', () => {
  assert.strictEqual(ipMatch.normaliseEntry(' 106.51.81.61 '), OFFICE);
  assert.strictEqual(ipMatch.normaliseEntry('106.51.81.61/32'), OFFICE, 'a /32 is a single address');
  assert.strictEqual(ipMatch.normaliseEntry('10.0.0.0/8'), '10.0.0.0/8');
  assert.strictEqual(ipMatch.normaliseEntry('::ffff:106.51.81.61'), OFFICE);
});

// --- against a live server ---------------------------------------------------
//
// Every request below chooses the address the server sees by setting
// X-Forwarded-For, which is exactly what a proxy does. The server runs with
// TRUST_PROXY=1, so it takes the rightmost entry — the one the nearest proxy
// wrote — and that is what makes the spoofing test below meaningful.

const from = (ip) => ({ 'X-Forwarded-For': ip });

// The front door: the app's own page. Public, so a 200 means the gate let the
// request through rather than that some token happened to be valid, and it is
// what a person actually opens.
async function reach(server, ip, headers = {}) {
  const res = await raw(server.base.replace(/\/api$/, '') + '/', '', { headers: { ...from(ip), ...headers } });
  return res.status;
}

test('the IP allowlist', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Allowlist-Test-1!';
  let server;
  let superToken;
  let staffToken;

  const call = (path, options) => api(server.base, path, options);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token',
      IP_ALLOWLIST_SEED: OFFICE,
      TRUST_PROXY: '1',
    });
    // Signing in has to happen from an allowed address — which is the point.
    await call('/auth/bootstrap', {
      headers: from(OFFICE),
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'IP Admin', email: 'super@zvky.test', password: PASSWORD },
    });
    superToken = (await call('/auth/login', {
      headers: from(OFFICE), method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    })).body.token;
    await call('/users', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { name: 'Ordinary Person', email: 'staff@zvky.test', role: 'game_artist', password: PASSWORD },
    });
    staffToken = (await call('/auth/login', {
      headers: from(OFFICE), method: 'POST', body: { email: 'staff@zvky.test', password: PASSWORD },
    })).body.token;
  });

  t.after(() => stopServer(server));

  await t.test('the seeded address is on the list and is what let us in', async () => {
    const res = await call('/ip-allowlist', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.yourAddress, OFFICE);
    assert.strictEqual(res.body.yourAccess, 'allowed');
    assert.strictEqual(res.body.enforcement.effective, true);
    const seeded = res.body.entries.find((e) => e.address === OFFICE);
    assert.ok(seeded, 'the seeded address should be listed');
    assert.strictEqual(seeded.coversYou, true, 'it should be flagged as the entry covering the caller');
  });

  await t.test('a request from any other address is refused', async () => {
    const res = await call('/projects', { headers: from(OUTSIDE), token: superToken });
    assert.strictEqual(res.status, 403);
    assert.match(res.body.error, /not permitted/i);
    // Told their own address and nothing else — enough to ask for access,
    // nothing about who else has it.
    assert.strictEqual(res.body.yourAddress, OUTSIDE);
    assert.ok(!JSON.stringify(res.body).includes(OFFICE), 'must not disclose what is allowed');
  });

  await t.test('a browser gets a readable Access Denied page, not raw JSON', async () => {
    const res = await raw(server.base.replace('/api', '') + '/', '', {
      headers: { ...from(OUTSIDE), Accept: 'text/html,application/xhtml+xml' },
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.contentType, /text\/html/);
    assert.match(res.text, /Access denied/i);
    assert.ok(res.text.includes(OUTSIDE), 'the page should name the address to ask for');
  });

  await t.test('the check runs before sign-in, so a blocked address cannot try passwords', async () => {
    // If the gate ran after authentication this would be a 401 telling an
    // attacker their guess was wrong, which is most of what the restriction is
    // meant to prevent.
    const res = await call('/auth/login', {
      headers: from(OUTSIDE), method: 'POST', body: { email: 'super@zvky.test', password: 'wrong' },
    });
    assert.strictEqual(res.status, 403);
    const right = await call('/auth/login', {
      headers: from(OUTSIDE), method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    });
    assert.strictEqual(right.status, 403, 'even the correct password must not get a token');
  });

  await t.test('a spoofed X-Forwarded-For does not get anyone in', async () => {
    // With one proxy in front, a client that sends its own X-Forwarded-For has
    // the real address appended to the right of it by that proxy. The server
    // reads the rightmost entry, so the invented one is ignored.
    const spoofed = await call('/projects', {
      headers: { 'X-Forwarded-For': `${OFFICE}, ${OUTSIDE}` }, token: superToken,
    });
    assert.strictEqual(spoofed.status, 403, 'the leftmost, client-supplied address must be ignored');
    assert.strictEqual(spoofed.body.yourAddress, OUTSIDE);

    // Several invented hops do not help either.
    const stacked = await call('/projects', {
      headers: { 'X-Forwarded-For': `${OFFICE}, ${OFFICE}, ${OFFICE}, ${OUTSIDE}` }, token: superToken,
    });
    assert.strictEqual(stacked.status, 403);

    // And the same header written by a real proxy does work, which is what
    // makes the case above a check rather than an accident.
    const genuine = await call('/projects', {
      headers: { 'X-Forwarded-For': `${OUTSIDE}, ${OFFICE}` }, token: superToken,
    });
    assert.strictEqual(genuine.status, 200);

    // Headers other proxies use are not consulted at all.
    for (const header of ['X-Real-IP', 'X-Client-IP', 'True-Client-IP', 'CF-Connecting-IP', 'Forwarded']) {
      const res = await call('/projects', {
        headers: { ...from(OUTSIDE), [header]: OFFICE }, token: superToken,
      });
      assert.strictEqual(res.status, 403, `${header} must not override the resolved address`);
    }
  });

  await t.test('the health check stays reachable so a bad list is not an outage loop', async () => {
    const res = await call('/health', { headers: from(OUTSIDE) });
    assert.strictEqual(res.status, 200);
  });

  await t.test('an address added now works on the very next request', async () => {
    const before = await call('/projects', { headers: from('198.51.100.4'), token: superToken });
    assert.strictEqual(before.status, 403);

    const added = await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken,
      method: 'POST', body: { address: '198.51.100.4', label: 'Second office' },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));

    const after = await call('/projects', { headers: from('198.51.100.4'), token: superToken });
    assert.strictEqual(after.status, 200, 'no restart should be needed');
  });

  await t.test('a range covers everything inside it and nothing outside', async () => {
    const added = await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken,
      method: 'POST', body: { address: '192.0.2.0/24', label: 'VPN' },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    assert.strictEqual(added.body.entry.address, '192.0.2.0/24');

    assert.strictEqual((await call('/projects', { headers: from('192.0.2.1'), token: superToken })).status, 200);
    assert.strictEqual((await call('/projects', { headers: from('192.0.2.254'), token: superToken })).status, 200);
    assert.strictEqual((await call('/projects', { headers: from('192.0.3.1'), token: superToken })).status, 403);
  });

  await t.test('nonsense entries are refused with an example to copy', async () => {
    for (const address of ['', '   ', 'localhost', '1.2.3', '256.0.0.1', '10.0.0.0/33', '010.1.1.1']) {
      const res = await call('/ip-allowlist', {
        headers: from(OFFICE), token: superToken, method: 'POST', body: { address },
      });
      assert.strictEqual(res.status, 400, `"${address}" should have been refused`);
      assert.ok(res.body.error, 'the refusal should say something');
    }
    const example = await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: 'localhost' },
    });
    assert.match(example.body.error, /106\.51\.81\.61/, 'the message should show what a valid entry looks like');
  });

  await t.test('the same address cannot be added twice, however it is spelled', async () => {
    const duplicate = await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: `  ${OFFICE}/32 ` },
    });
    assert.strictEqual(duplicate.status, 400);
    assert.match(duplicate.body.error, /already on the list/i);
  });

  await t.test('deactivating an entry takes effect at once, and reactivating brings it back', async () => {
    const list = await call('/ip-allowlist', { headers: from(OFFICE), token: superToken });
    const second = list.body.entries.find((e) => e.address === '198.51.100.4');

    await call(`/ip-allowlist/${second.id}`, {
      headers: from(OFFICE), token: superToken, method: 'PATCH', body: { isActive: false },
    });
    assert.strictEqual((await call('/projects', { headers: from('198.51.100.4'), token: superToken })).status, 403);

    await call(`/ip-allowlist/${second.id}`, {
      headers: from(OFFICE), token: superToken, method: 'PATCH', body: { isActive: true },
    });
    assert.strictEqual((await call('/projects', { headers: from('198.51.100.4'), token: superToken })).status, 200);
  });

  await t.test('removing the entry that covers you is refused until you say you mean it', async () => {
    const list = await call('/ip-allowlist', { headers: from(OFFICE), token: superToken });
    const mine = list.body.entries.find((e) => e.address === OFFICE);
    assert.strictEqual(mine.coversYou, true);

    const blocked = await call(`/ip-allowlist/${mine.id}`, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.requiresConfirmation, true);
    assert.strictEqual(blocked.body.yourAddress, OFFICE);
    assert.strictEqual(blocked.body.stillCoveredByAnother, false);
    assert.match(blocked.body.error, /lock you out/i);
    // Refusing means refusing: the entry is still there and still working.
    assert.strictEqual((await call('/projects', { headers: from(OFFICE), token: superToken })).status, 200);

    // Removing an entry that is not yours needs no ceremony.
    const other = list.body.entries.find((e) => e.address === '192.0.2.0/24');
    const easy = await call(`/ip-allowlist/${other.id}`, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(easy.status, 200, JSON.stringify(easy.body));
    assert.strictEqual((await call('/projects', { headers: from('192.0.2.1'), token: superToken })).status, 403);
  });

  await t.test('the warning softens when something else would still let you in', async () => {
    await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken,
      method: 'POST', body: { address: '106.51.81.0/24', label: 'Whole office range' },
    });
    const list = await call('/ip-allowlist', { headers: from(OFFICE), token: superToken });
    const mine = list.body.entries.find((e) => e.address === OFFICE);

    const res = await call(`/ip-allowlist/${mine.id}`, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(res.status, 409, 'still worth confirming');
    assert.strictEqual(res.body.stillCoveredByAnother, true);
    assert.match(res.body.error, /another entry still does too/i);

    const confirmed = await call(`/ip-allowlist/${mine.id}?confirm=yes`, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(confirmed.status, 200);
    // Covered by the /24 now, so access continues.
    assert.strictEqual((await call('/projects', { headers: from(OFFICE), token: superToken })).status, 200);
  });

  await t.test('only a Super Admin can see or change the list', async () => {
    const read = await call('/ip-allowlist', { headers: from(OFFICE), token: staffToken });
    assert.strictEqual(read.status, 403);
    const write = await call('/ip-allowlist', {
      headers: from(OFFICE), token: staffToken, method: 'POST', body: { address: '198.51.100.99' },
    });
    assert.strictEqual(write.status, 403);
    const anonymous = await call('/ip-allowlist', { headers: from(OFFICE) });
    assert.strictEqual(anonymous.status, 401);
    // The address is still not on the list.
    assert.strictEqual((await call('/projects', { headers: from('198.51.100.99'), token: superToken })).status, 403);
  });

  await t.test('every change is recorded, with who made it and from where', async () => {
    const res = await call('/ip-allowlist/audit', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(res.status, 200);
    const trail = res.body.entries;

    const seeded = trail.find((e) => e.action === 'seeded' && e.address === OFFICE);
    assert.ok(seeded, 'the initial seed should be recorded');

    const added = trail.find((e) => e.action === 'added' && e.address === '192.0.2.0/24');
    assert.strictEqual(added.actor, 'super@zvky.test');
    assert.strictEqual(added.actorIp, OFFICE);

    const removed = trail.find((e) => e.action === 'removed' && e.address === OFFICE);
    assert.ok(removed, 'removals are the ones worth having afterwards');
    assert.strictEqual(removed.actor, 'super@zvky.test');
    assert.match(removed.detail, /own address/i, 'a self-removal should be marked as such');

    const staffAttempt = trail.find((e) => e.actor === 'staff@zvky.test');
    assert.strictEqual(staffAttempt, undefined, 'a refused change should not appear as a change');
  });

  await t.test('emptying the list opens the app rather than closing it to everyone', async () => {
    // Clear the list the way a person would have to: the entries that do not
    // cover the caller first. Removing your own cover while others remain locks
    // you out mid-loop — which is the behaviour the previous test asserts, and
    // simply the wrong order to empty a list in.
    for (let guard = 0; guard <= 20; guard++) {
      const list = await call('/ip-allowlist', { headers: from(OFFICE), token: superToken });
      assert.strictEqual(list.status, 200, 'should still have access while clearing the list');
      if (!list.body.entries.length) break;
      assert.notStrictEqual(guard, 20, 'the list should have emptied by now');
      const next = list.body.entries.find((e) => !e.coversYou) || list.body.entries[0];
      const removed = await call(`/ip-allowlist/${next.id}?confirm=yes`, {
        headers: from(OFFICE), token: superToken, method: 'DELETE',
      });
      assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
    }
    const after = await call('/ip-allowlist', { headers: from(OUTSIDE), token: superToken });
    assert.strictEqual(after.status, 200, 'an empty list must not lock everybody out');
    assert.strictEqual(after.body.entries.length, 0);
    assert.strictEqual(after.body.enforcement.effective, false, 'and it should say so plainly');
    assert.strictEqual(after.body.yourAccess, 'unconfigured');
  });
});

// --- the ways back in --------------------------------------------------------
// These live in the environment on purpose: a safeguard that can be edited
// through the thing it safeguards is not a safeguard. Each gets its own server,
// because each is a different environment.

test('the emergency ways back in', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const UNREACHABLE = '203.0.113.7'; // an address nobody in these tests has
  const RESCUE = '198.51.100.20';
  const TOKEN = 'emergency-token-for-the-test-suite';

  await t.test('an emergency address gets in when the list would refuse it', async () => {
    await resetSchema(cfg);
    const server = await startServer(cfg, {
      IP_ALLOWLIST_SEED: UNREACHABLE,
      IP_ALLOWLIST_EMERGENCY: `${RESCUE}, 192.0.2.0/24`,
      TRUST_PROXY: '1',
    });
    try {
      // The list is wrong: it allows an address nobody has.
      assert.strictEqual(await reach(server, OUTSIDE), 403);

      // The environment still lets the person fixing it in, single address...
      assert.strictEqual(await reach(server, RESCUE), 200, 'the emergency address must reach the app');
      // ...and by range.
      assert.strictEqual(await reach(server, '192.0.2.55'), 200);

      assert.match(server.output(), /EMERGENCY ADDRESS USED/, 'using it must be logged');
    } finally {
      stopServer(server);
    }
  });

  await t.test('a bypass token gets in when no address will', async () => {
    await resetSchema(cfg);
    const server = await startServer(cfg, {
      IP_ALLOWLIST_SEED: UNREACHABLE,
      IP_ALLOWLIST_BYPASS_TOKEN: TOKEN,
      TRUST_PROXY: '1',
    });
    try {
      assert.strictEqual(await reach(server, OUTSIDE), 403);
      assert.strictEqual(await reach(server, OUTSIDE, { 'X-Allowlist-Bypass': TOKEN }), 200);

      // A near miss is still a miss.
      for (const wrong of [TOKEN + 'x', TOKEN.slice(0, -1), TOKEN.toUpperCase(), '']) {
        assert.strictEqual(await reach(server, OUTSIDE, { 'X-Allowlist-Bypass': wrong }), 403,
          `"${wrong}" must not be accepted`);
      }
      assert.match(server.output(), /BYPASS TOKEN USED/);
    } finally {
      stopServer(server);
    }
  });

  await t.test('an empty allowlist is treated as not set up, not as a locked door', async () => {
    await resetSchema(cfg);
    const server = await startServer(cfg, { IP_ALLOWLIST_SEED: '', TRUST_PROXY: '1' });
    try {
      for (const ip of [OUTSIDE, OFFICE, '8.8.8.8']) {
        assert.strictEqual(await reach(server, ip), 200, `${ip} should reach an app with nothing configured`);
      }
      assert.match(server.output(), /no entries, so the gate is open/);
    } finally {
      stopServer(server);
    }
  });

  await t.test('the kill switch turns the whole thing off', async () => {
    await resetSchema(cfg);
    const server = await startServer(cfg, {
      IP_ALLOWLIST_SEED: UNREACHABLE, IP_ALLOWLIST_ENABLED: 'false', TRUST_PROXY: '1',
    });
    try {
      assert.strictEqual(await reach(server, OUTSIDE), 200);
      assert.match(server.output(), /disabled \(IP_ALLOWLIST_ENABLED=false\)/);
    } finally {
      stopServer(server);
    }
  });

  await t.test('monitor mode reports what it would have blocked and blocks nothing', async () => {
    // The way to deploy this safely: confirm the address the server actually
    // sees for you before you start refusing everyone else.
    await resetSchema(cfg);
    const server = await startServer(cfg, {
      IP_ALLOWLIST_SEED: UNREACHABLE, IP_ALLOWLIST_MODE: 'monitor', TRUST_PROXY: '1',
    });
    try {
      assert.strictEqual(await reach(server, OUTSIDE), 200);
      assert.match(server.output(), /MONITOR: would have denied 203\.0\.113\.9/);
      assert.match(server.output(), /MONITOR mode: nothing is blocked/);
    } finally {
      stopServer(server);
    }
  });

  await t.test('without a trusted proxy the forwarded header is ignored entirely', async () => {
    // TRUST_PROXY=0 says nothing in front of us is trusted, so X-Forwarded-For
    // is somebody's claim rather than a proxy's record — and is not believed.
    await resetSchema(cfg);
    const server = await startServer(cfg, { IP_ALLOWLIST_SEED: OFFICE, TRUST_PROXY: '0' });
    try {
      const claimed = await api(server.base, '/projects', { headers: from(OFFICE) });
      assert.strictEqual(claimed.status, 403, 'claiming to be the allowed address must not work');
      assert.strictEqual(claimed.body.yourAddress, '127.0.0.1', 'the real peer address is what counts');
    } finally {
      stopServer(server);
    }
  });
});
