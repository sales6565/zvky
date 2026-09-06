// The blocklist: addresses barred outright, whatever else would let them in.
//
// It sits beside the allowlist and reads like its mirror image, but three of
// its rules are deliberately NOT the allowlist's, and each of those three is
// the kind of difference that is only a difference until somebody assumes
// otherwise. So each is tested here as a fact about behaviour rather than left
// to the comments:
//
//   1. A block beats the allowlist. An address on both lists is refused.
//   2. A block applies in MONITOR mode, where the allowlist refuses nobody.
//   3. A block never beats the server-environment escape hatches, so a mistake
//      is always recoverable without editing the database by hand.
//
// And one rule that is stricter than the allowlist's rather than different:
// blocking your own address is refused outright, with no confirm-and-proceed.

const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, raw, sql, SKIP_REASON } = require('./helpers');
const blocklist = require('../src/ip-blocklist');

const cfg = config('ipblocklist');

const OFFICE = '106.51.81.61';      // where the administrator is sitting
const BADGUY = '203.0.113.9';       // the address being blocked
const NEIGHBOUR = '203.0.113.10';   // in the same /24, not blocked on its own
const RESCUE = '198.51.100.7';      // an emergency address, set in the environment

const from = (ip) => ({ 'X-Forwarded-For': ip });

// --- expiry, without a database ----------------------------------------------
// The whole of "temporary" is this one comparison, evaluated on every request
// rather than by a scheduled job, so it is worth checking on its own.

test('an entry with no expiry never runs out', () => {
  assert.strictEqual(blocklist.isExpired({ address: BADGUY, expiresAt: null }), false);
  assert.strictEqual(blocklist.isExpired({ address: BADGUY }), false);
  assert.strictEqual(blocklist.isExpired(null), false);
});

test('an entry runs out at its expiry, not before and not after', () => {
  const at = new Date('2026-01-01T12:00:00Z');
  const entry = { address: BADGUY, expiresAt: at };
  assert.strictEqual(blocklist.isExpired(entry, at.getTime() - 1), false);
  // The boundary counts as expired: a block "until 12:00" is not in force at 12:00.
  assert.strictEqual(blocklist.isExpired(entry, at.getTime()), true);
  assert.strictEqual(blocklist.isExpired(entry, at.getTime() + 1), true);
});

test('an unparseable expiry is treated as no expiry rather than as expired', () => {
  // Refusing to guess: a row nobody can read the date of must not silently
  // become a block that has lapsed, because that is the failure that looks
  // exactly like it is working.
  assert.strictEqual(blocklist.isExpired({ address: BADGUY, expiresAt: 'not a date' }), false);
});

test('an expiry in the past is refused at the point of entry', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { errors } = blocklist.validate(BADGUY, { expiresAt: past });
  assert.ok(errors.some((e) => e.field === 'expiresAt'), 'a block that never blocks must not be accepted');
  const { errors: none } = blocklist.validate(BADGUY, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.deepStrictEqual(none, []);
});

test('the address itself is validated the same way the allowlist validates one', () => {
  assert.ok(blocklist.validate('not an address', {}).errors.length);
  assert.ok(blocklist.validate('', {}).errors.length);
  assert.strictEqual(blocklist.validate('106.51.81.61/32', {}).canonical, OFFICE);
});

// --- against a live server ---------------------------------------------------

test('the IP blocklist', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Blocklist-Test-1!';
  let server;
  let superToken;
  let staffToken;

  const call = (path, options) => api(server.base, path, options);
  const page = (ip, headers = {}) =>
    raw(server.base.replace(/\/api$/, '') + '/', '', { headers: { ...from(ip), ...headers } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token',
      TRUST_PROXY: '1',
      /* MONITOR MODE ON PURPOSE, and it is the single most important line in
         this file. Monitor is the shipped default, so it is the state most
         deployments are actually in — and it is the state where the allowlist
         refuses nobody. If a block only worked under enforce, everything below
         would pass on a server that was quietly not blocking anyone. */
      IP_ALLOWLIST_MODE: 'monitor',
      IP_ALLOWLIST_SEED: OFFICE,
      // The way back in when a block is a mistake. Tested, not assumed.
      IP_ALLOWLIST_EMERGENCY: RESCUE,
    });
    await call('/auth/bootstrap', {
      headers: from(OFFICE), method: 'POST',
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

  // --- who may open the screen at all ---------------------------------------

  await t.test('only a holder of the blocklist permission can read or change it', async () => {
    const mine = await call('/ip-blocklist', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));

    for (const [method, path, body] of [
      ['GET', '/ip-blocklist', undefined],
      ['POST', '/ip-blocklist', { address: BADGUY }],
      ['DELETE', '/ip-blocklist/x', undefined],
    ]) {
      const res = await call(path, { headers: from(OFFICE), token: staffToken, method, body });
      assert.strictEqual(res.status, 403, `${method} ${path} should be refused to an ordinary account`);
    }

    // And signed out entirely — the permission check must not be the only gate.
    const anon = await call('/ip-blocklist', { headers: from(OFFICE) });
    assert.strictEqual(anon.status, 401);
  });

  await t.test('the permission is Super Admin only by default, and is not a hardcoded role check', async () => {
    // Read from the catalogue the way the Settings screen does, so this tests
    // what ships rather than what this file believes ships.
    const roles = await call('/permissions/roles/game_artist', { headers: from(OFFICE), token: superToken });
    const entry = roles.body.role.permissions.find((p) => p.key === 'settings.ip_blocklist');
    assert.ok(entry, 'the permission should appear in the catalogue for every role');
    assert.strictEqual(entry.enabled, false, 'an ordinary designation must not hold it by default');

    /* Granting it to that designation must be enough — if blocking were gated
       on a role name somewhere, this would still be refused after the grant. */
    const held = roles.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    const set = (keys) => call('/permissions/roles/game_artist', {
      headers: from(OFFICE), token: superToken, method: 'PUT', body: { permissions: keys },
    });
    assert.strictEqual((await set([...held, 'settings.ip_blocklist'])).status, 200);
    const granted = await call('/ip-blocklist', { headers: from(OFFICE), token: staffToken });
    assert.strictEqual(granted.status, 200, 'the grant alone should open the feature');

    assert.strictEqual((await set(held)).status, 200);
    const revoked = await call('/ip-blocklist', { headers: from(OFFICE), token: staffToken });
    assert.strictEqual(revoked.status, 403, 'and revoking it should close it again');
  });

  // --- the blocking itself ---------------------------------------------------

  let blockId;

  await t.test('a blocked address is refused on the very next request, in monitor mode', async () => {
    const before = await call('/projects', { headers: from(BADGUY), token: superToken });
    assert.strictEqual(before.status, 200, 'monitor mode should be letting it through to begin with');

    const added = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { address: BADGUY, reason: 'Repeated sign-in attempts' },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    blockId = added.body.entry.id;
    assert.strictEqual(added.body.entry.address, BADGUY);
    assert.strictEqual(added.body.entry.expiresAt, null, 'no expiry given means permanent');

    const after = await call('/projects', { headers: from(BADGUY), token: superToken });
    assert.strictEqual(after.status, 403, 'the block must apply immediately, with no restart');
    assert.strictEqual(after.body.reason, 'blocked');
    // A neighbour in the same /24 is untouched: a single address is one address.
    const nearby = await call('/projects', { headers: from(NEIGHBOUR), token: superToken });
    assert.strictEqual(nearby.status, 200);
  });

  await t.test('the check runs before sign-in, so a blocked address cannot try passwords', async () => {
    const wrong = await call('/auth/login', {
      headers: from(BADGUY), method: 'POST', body: { email: 'super@zvky.test', password: 'wrong' },
    });
    assert.strictEqual(wrong.status, 403);
    const right = await call('/auth/login', {
      headers: from(BADGUY), method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    });
    assert.strictEqual(right.status, 403, 'even the correct password must not get a token');
  });

  await t.test('a browser gets a page that says blocked, and nothing about the rule', async () => {
    /* The desktop wrapper is a window pointed at this same server: it makes the
       same HTTP request, with a browser Accept header, and the gate runs before
       any of the app's own code. So this one assertion covers both. */
    const res = await page(BADGUY, { Accept: 'text/html,application/xhtml+xml' });
    assert.strictEqual(res.status, 403);
    assert.match(res.contentType, /text\/html/);
    assert.match(res.text, /blocked/i);
    assert.ok(res.text.includes(BADGUY), 'it should name the address, so it can be quoted to an administrator');
    // Nothing that helps whoever is on the other end work around it.
    assert.ok(!/Repeated sign-in attempts/.test(res.text), 'the reason must not be disclosed');
    assert.ok(!res.text.includes('super@zvky.test'), 'nor who blocked them');
    assert.ok(!res.text.includes(OFFICE), 'nor anything about what is allowed');
  });

  await t.test('the block beats the allowlist, which is the whole point', async () => {
    // Put the blocked address on the allowlist as well: it must still be refused.
    const allowed = await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { address: BADGUY, label: 'Should not save them' },
    });
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));

    const res = await call('/projects', { headers: from(BADGUY), token: superToken });
    assert.strictEqual(res.status, 403, 'an address on both lists is refused');
    assert.strictEqual(res.body.reason, 'blocked');

    // And a range block cuts one machine out of an allowed range, which is the
    // case the feature exists for.
    await call('/ip-allowlist', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { address: '203.0.113.0/24', label: 'Partner network' },
    });
    assert.strictEqual((await call('/projects', { headers: from(NEIGHBOUR), token: superToken })).status, 200);
    assert.strictEqual((await call('/projects', { headers: from(BADGUY), token: superToken })).status, 403);
  });

  await t.test('blocking is said back when the address was also allowed', async () => {
    // Somebody who blocks an address already on the allowlist should not have to
    // work out from two screens which one won.
    const added = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: NEIGHBOUR },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    assert.match(String(added.body.note || ''), /allowlist/i);
    assert.match(String(added.body.note || ''), /block wins|refused/i);
    await call('/ip-blocklist/' + added.body.entry.id, { headers: from(OFFICE), token: superToken, method: 'DELETE' });
  });

  await t.test('the environment escape hatches still get in, so a mistake is recoverable', async () => {
    /* THE ORDER THAT MAKES A MISTAKEN BLOCK SURVIVABLE. Block the emergency
       address itself — the worst case — and it must still reach the app,
       because the emergency list is checked before the blocklist. If this ever
       reverses, the only way out of a bad block is editing the database. */
    const added = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { address: RESCUE, reason: 'Blocked by mistake' },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));

    const res = await call('/ip-blocklist', { headers: from(RESCUE), token: superToken });
    assert.strictEqual(res.status, 200, 'an emergency address must outrank a block on it');

    // And it can undo the mistake from there, which is the point of getting in.
    const undone = await call('/ip-blocklist/' + added.body.entry.id, {
      headers: from(RESCUE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(undone.status, 200);
  });

  await t.test('the health check stays reachable, so a block is never an outage loop', async () => {
    const res = await call('/health', { headers: from(BADGUY) });
    assert.strictEqual(res.status, 200);
  });

  // --- the self-lockout refusal ---------------------------------------------

  await t.test('you cannot block your own address, and it is a refusal rather than a warning', async () => {
    const res = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: OFFICE },
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.wouldLockYouOut, true);
    assert.strictEqual(res.body.yourAddress, OFFICE);
    assert.match(res.body.error, /lock you out/i);

    /* No confirm-and-proceed, unlike the allowlist's removal. Try every shape a
       caller might reach for, because a refusal with an undocumented override
       is not a refusal. */
    for (const attempt of [
      { path: '/ip-blocklist?confirm=yes', body: { address: OFFICE } },
      { path: '/ip-blocklist', body: { address: OFFICE, confirm: true } },
      { path: '/ip-blocklist', body: { address: OFFICE, force: true } },
    ]) {
      const forced = await call(attempt.path, {
        headers: from(OFFICE), token: superToken, method: 'POST', body: attempt.body,
      });
      assert.strictEqual(forced.status, 409, `${JSON.stringify(attempt)} must not get through`);
    }

    // Nothing was written, so the screen does not show a block that is not one.
    const list = await call('/ip-blocklist', { headers: from(OFFICE), token: superToken });
    assert.ok(!list.body.entries.some((e) => e.address === OFFICE));
  });

  await t.test('a RANGE covering your own address is refused too, which is the likelier mistake', async () => {
    const res = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: '106.51.81.0/24' },
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.wouldLockYouOut, true);

    // A range that does NOT cover the caller is accepted, so the guard is about
    // the caller rather than about ranges.
    const fine = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: '192.0.2.0/24' },
    });
    assert.strictEqual(fine.status, 201, JSON.stringify(fine.body));
    assert.strictEqual((await call('/projects', { headers: from('192.0.2.5'), token: superToken })).status, 403);
    await call('/ip-blocklist/' + fine.body.entry.id, { headers: from(OFFICE), token: superToken, method: 'DELETE' });
  });

  // --- expiry, end to end ----------------------------------------------------

  await t.test('a temporary block lapses on its own, with no sweep and no restart', async () => {
    const address = '198.51.100.44';
    const added = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { address, reason: 'Cooling off', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    assert.ok(added.body.entry.expiresAt, 'the expiry should be stored');
    assert.strictEqual((await call('/projects', { headers: from(address), token: superToken })).status, 403);

    /* Move the stored expiry into the past rather than waiting an hour. This is
       also the check that the timestamp round-trips through the database
       correctly: the gate reads the column back and compares it to the clock,
       so a value written in the wrong timezone would show up here as a block
       that lapses early — or one that never lapses at all. */
    await sql(cfg, 'UPDATE ip_blocklist SET expires_at = ? WHERE address = ?',
      [new Date(Date.now() - 60 * 1000), address]);
    // The cache is reloaded on any write, so make one that touches nothing else.
    const throwaway = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: '192.0.2.99' },
    });
    await call('/ip-blocklist/' + throwaway.body.entry.id, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });

    const after = await call('/projects', { headers: from(address), token: superToken });
    assert.strictEqual(after.status, 200, 'an expired block must stop blocking without anything being run');

    // Still listed, marked as lapsed rather than vanishing — somebody looking
    // for why an address was blocked last week needs to find it.
    const list = await call('/ip-blocklist', { headers: from(OFFICE), token: superToken });
    const row = list.body.entries.find((e) => e.address === address);
    assert.ok(row, 'the lapsed entry should still be listed');
    assert.strictEqual(row.expired, true);
  });

  // --- unblocking ------------------------------------------------------------

  await t.test('unblocking restores access, and the allowlist decides from there', async () => {
    const res = await call('/ip-blocklist/' + blockId, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.removed.address, BADGUY);

    const after = await call('/projects', { headers: from(BADGUY), token: superToken });
    assert.strictEqual(after.status, 200);

    // Gone from the list, not left switched off — the Activity Log holds the history.
    const list = await call('/ip-blocklist', { headers: from(OFFICE), token: superToken });
    assert.ok(!list.body.entries.some((e) => e.address === BADGUY));

    const missing = await call('/ip-blocklist/' + blockId, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(missing.status, 404, 'unblocking twice should say so rather than pretend');
  });

  await t.test('the same address cannot be blocked twice', async () => {
    const first = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: '198.51.100.60' },
    });
    assert.strictEqual(first.status, 201);
    const again = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: '198.51.100.60' },
    });
    assert.strictEqual(again.status, 400, JSON.stringify(again.body));
    assert.match(again.body.error, /already blocked/i);
    // Including in a different spelling of the same thing.
    const spelt = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST', body: { address: '198.51.100.60/32' },
    });
    assert.strictEqual(spelt.status, 400);
    await call('/ip-blocklist/' + first.body.entry.id, { headers: from(OFFICE), token: superToken, method: 'DELETE' });
  });

  // --- accountability --------------------------------------------------------

  await t.test('every block and unblock is in the Activity Log, with the address and the reason', async () => {
    const address = '198.51.100.81';
    const added = await call('/ip-blocklist', {
      headers: from(OFFICE), token: superToken, method: 'POST',
      body: { address, reason: 'Scanning the login page' },
    });
    assert.strictEqual(added.status, 201);
    await call('/ip-blocklist/' + added.body.entry.id, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });

    const log = await call('/activity?limit=200', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(log.status, 200, JSON.stringify(log.body));
    const rows = log.body.entries.filter((e) => e.entity && e.entity.label === address);

    const blockedRow = rows.find((e) => e.action === 'ip.blocked');
    assert.ok(blockedRow, 'blocking should be recorded');
    assert.strictEqual(blockedRow.module, 'settings', 'it belongs with the other Settings actions');
    assert.strictEqual(blockedRow.actor.email, 'super@zvky.test');
    assert.match(blockedRow.summary, /Scanning the login page/, 'the reason is the point of reading this later');

    const unblockedRow = rows.find((e) => e.action === 'ip.unblocked');
    assert.ok(unblockedRow, 'unblocking should be recorded too');
    assert.strictEqual(unblockedRow.module, 'settings');
    assert.match(unblockedRow.summary, new RegExp(`Unblocked ${address}`));
  });

  // --- the screen's own facts ------------------------------------------------

  await t.test('the screen is told the block applies even though the allowlist is only monitoring', async () => {
    const res = await call('/ip-blocklist', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(res.body.gate.mode, 'monitor');
    assert.strictEqual(res.body.gate.blocksApply, true,
      'this is the fact somebody reading the allowlist screen will get wrong');
    assert.match(res.body.gate.note, /blocks still apply|refused now/i);
    assert.strictEqual(res.body.yourAddress, OFFICE);
  });

  await t.test('an entry covering the caller is marked rather than hidden', async () => {
    /* A LAPSED range that covers the caller, written directly because the API
       refuses to create one. This is not a contrived state: it is what a
       temporary range block leaves behind the moment it runs out, and it is the
       only way somebody sees this marker from an address a block covers —
       while such a block is in force they are not reaching this screen at all,
       which is the self-lockout refusal doing its job. */
    await sql(cfg,
      'INSERT INTO ip_blocklist (id, address, is_active, expires_at) VALUES (?, ?, 1, ?)',
      ['covers-you-test-id', '106.51.81.0/24', new Date(Date.now() - 60 * 1000)]);
    // Any write reloads the gate's cache; make one from an address the range
    // does not cover, so this test cannot lock itself out.
    const nudge = await call('/ip-blocklist', {
      headers: from(RESCUE), token: superToken, method: 'POST', body: { address: '192.0.2.200' },
    });
    assert.strictEqual(nudge.status, 201, JSON.stringify(nudge.body));

    const res = await call('/ip-blocklist', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(res.status, 200, 'a lapsed block must not be refusing anybody');
    const row = res.body.entries.find((e) => e.address === '106.51.81.0/24');
    assert.ok(row, 'the entry should still be listed');
    assert.strictEqual(row.coversYou, true,
      'the entry somebody most needs to see is the one that covers them');
    assert.strictEqual(row.expired, true);

    await call('/ip-blocklist/' + nudge.body.entry.id, {
      headers: from(RESCUE), token: superToken, method: 'DELETE',
    });
    await sql(cfg, 'DELETE FROM ip_blocklist WHERE id = ?', ['covers-you-test-id']);
  });

  await t.test('the observed table says which addresses are already blocked', async () => {
    // Display only, and the reason it is computed on the server: a CIDR block
    // covering an observed address is not something the browser can work out.
    const added = await call('/ip-blocklist', {
      headers: from(RESCUE), token: superToken, method: 'POST', body: { address: '203.0.113.0/24' },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    const res = await call('/ip-allowlist/observed', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(res.status, 200);
    const rows = [...res.body.wouldBeRefused, ...res.body.reaching];
    const seen = rows.find((e) => e.address === BADGUY);
    assert.ok(seen, 'the blocked address should have been observed');
    assert.strictEqual(seen.blockedNow, true, 'covered by a range, and said so');
    const mine = rows.find((e) => e.address === OFFICE);
    if (mine) assert.strictEqual(mine.blockedNow, false);
    await call('/ip-blocklist/' + added.body.entry.id, {
      headers: from(RESCUE), token: superToken, method: 'DELETE',
    });
  });

  // --- and the allowlist beside it, unchanged --------------------------------

  await t.test('the allowlist behaves exactly as it did before any of this existed', async () => {
    /* The one requirement that is about what did NOT change. Each assertion
       here mirrors one in tests/ip-allowlist.test.js. */
    const res = await call('/ip-allowlist', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.enforcement.mode, 'monitor', 'the mode toggle is untouched');
    assert.strictEqual(res.body.enforcement.enabled, true);
    assert.strictEqual(res.body.enforcement.effective, false, 'monitor still refuses nobody on the allowlist');
    assert.strictEqual(res.body.yourAddress, OFFICE);
    const seeded = res.body.entries.find((e) => e.address === OFFICE);
    assert.ok(seeded && seeded.coversYou, 'the seeded entry still marks the caller');

    // An address on neither list still gets through in monitor mode: the
    // blocklist must not have turned monitor mode into enforcement.
    const stranger = await call('/projects', { headers: from('198.51.100.123'), token: superToken });
    assert.strictEqual(stranger.status, 200, 'monitor mode must still let unknown addresses through');

    // The allowlist's own guard is still a confirmation, not a refusal — this
    // is the asymmetry the blocklist deliberately does not copy.
    const withoutConfirm = await call('/ip-allowlist/' + seeded.id, {
      headers: from(OFFICE), token: superToken, method: 'DELETE',
    });
    assert.strictEqual(withoutConfirm.status, 200,
      'in monitor mode the allowlist removal is not a lockout, so it goes through');

    // Its audit trail still works and still holds only allowlist changes.
    const audit = await call('/ip-allowlist/audit', { headers: from(OFFICE), token: superToken });
    assert.strictEqual(audit.status, 200);
    /* Its trail records only allowlist actions. BADGUY appears in it — it was
       put on the allowlist earlier in this file — so the check is on the ACTION,
       which is where a leak would show: blocking and unblocking are recorded in
       the Activity Log, and this trail stays the allowlist's own record. */
    const actions = new Set(audit.body.entries.map((e) => e.action));
    assert.ok(!actions.has('blocked') && !actions.has('unblocked'),
      `blocklist changes belong in the Activity Log, not here: ${[...actions].join(', ')}`);
    assert.ok([...actions].every((a) => ['added', 'removed', 'updated', 'seeded'].includes(a)),
      `unexpected action in the allowlist trail: ${[...actions].join(', ')}`);
  });
});
