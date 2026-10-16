/* THE CLOCK, WHICH IS THE ONE THING IN THIS FEATURE NOBODY CONTROLS.
 *
 * A token lives sixty seconds. An office machine whose clock is two minutes out
 * rejects every one of them, and from the browser's side that looks exactly like
 * a broken feature: no error anybody can act on, just nothing working. The
 * system answers that in four places, and this pins all four:
 *
 *   the leeway       ±30 seconds by default, configurable, HARD-CAPPED at 120
 *   the verification expiry and nbf are both checked with it
 *   the heartbeat    carries Forge's time, so the drift is measured and stored
 *   the verdict      above the leeway FAILS, above 15 seconds WARNS
 *
 * WHY THE CAP MATTERS ENOUGH TO TEST. Without it, GATEWAY_CLOCK_LEEWAY_SECONDS
 * is a way to turn token expiry off: set it to 86400 and a stolen link works for
 * a day. Clamping rather than refusing is deliberate — a gateway that would not
 * start over a mistyped number is worse than one that runs at the documented
 * maximum — but the clamp is the security property, so it is pinned here.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const tokens = require('../gateway/src/tokens');
const probes = require('../gateway/src/probes');
const minter = require('../src/server-tokens');

const keys = minter.generate();
const AUDIENCE = 'GW-CLOCK';

/* One upload token, minted as Forge mints it, at a chosen moment. */
function token({ at = Date.now(), seconds } = {}) {
  return minter.mint({
    privateKey: keys.privateKey, kid: keys.kid, audience: AUDIENCE,
    userId: 'u-1', op: 'list', path: 'Alpha', now: at, seconds,
  }).token;
}

const verify = (t, opts = {}) => tokens.verify(t, {
  keys: [{ kid: keys.kid, publicKey: keys.publicKey }], audience: AUDIENCE, ...opts,
});

test('the leeway: thirty seconds by default, configurable, capped at two minutes', () => {
  assert.strictEqual(tokens.SKEW_DEFAULT_SECONDS, 30);
  assert.strictEqual(tokens.SKEW_CAP_SECONDS, 120);
  assert.strictEqual(tokens.leewayFor(undefined), 30, 'nothing configured');
  assert.strictEqual(tokens.leewayFor(45), 45, 'configured, inside the cap');
  assert.strictEqual(tokens.leewayFor(120), 120, 'exactly the cap');
  /* THE CAP. Anything beyond it is clamped, not honoured — otherwise this
     setting is a way to make a sixty-second link last a day. */
  assert.strictEqual(tokens.leewayFor(121), 120);
  assert.strictEqual(tokens.leewayFor(86400), 120);
  assert.strictEqual(tokens.leewayFor(Number.MAX_SAFE_INTEGER), 120);
  // Junk and negatives fall back to the default rather than to no leeway at all.
  assert.strictEqual(tokens.leewayFor('nonsense'), 30);
  assert.strictEqual(tokens.leewayFor(-5), 30);
  assert.strictEqual(tokens.leewayFor(null), 30);
  // And 0 is a real answer: somebody who wants no leeway may have none.
  assert.strictEqual(tokens.leewayFor(0), 0);
});

test('a token just past its expiry is accepted inside the leeway and not outside it', () => {
  const now = Date.now();
  // A list token lives 60 seconds. Minted 70 seconds ago: expired by 10.
  const tenPast = token({ at: now - 70_000 });
  assert.strictEqual(verify(tenPast, { now }).ok, true, 'ten seconds past, inside ±30');

  // Minted 100 seconds ago: expired by 40, which is outside it.
  const fortyPast = token({ at: now - 100_000 });
  const out = verify(fortyPast, { now });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'expired', JSON.stringify(out));

  // With a wider leeway configured, the same token verifies.
  assert.strictEqual(verify(fortyPast, { now, leewaySeconds: 60 }).ok, true);
  /* AND BEYOND THE CAP IT STILL DOES NOT. Expired by ten minutes, with a leeway
     of a day asked for: the clamp decides. */
  const longPast = token({ at: now - 660_000 });
  const capped = verify(longPast, { now, leewaySeconds: 86400 });
  assert.strictEqual(capped.ok, false, 'the cap is what answers this');
  assert.strictEqual(capped.reason, 'expired');

  // With no leeway at all, ten seconds past is refused.
  assert.strictEqual(verify(tenPast, { now, leewaySeconds: 0 }).ok, false);
});

test('a clock AHEAD of Forge is the same outage in the other direction', () => {
  /* nbf is not minted today, so it is built by hand: the gateway must tolerate
     one that is slightly in the future, because a machine whose clock is ahead
     would otherwise refuse a token issued a moment ago. */
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const sign = (payload) => {
    const b64u = (b) => Buffer.from(b).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const header = b64u(JSON.stringify({ alg: tokens.ALG, kid: keys.kid }));
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.sign(null, Buffer.from(`${header}.${body}`, 'ascii'),
      crypto.createPrivateKey(keys.privateKey));
    return `${header}.${body}.${b64u(sig)}`;
  };
  const base = {
    iss: tokens.ISSUER, aud: AUDIENCE, sub: 'u-1', op: 'list', path: 'Alpha',
    jti: crypto.randomUUID(),
  };

  const soon = sign({ ...base, iat: seconds + 20, nbf: seconds + 20, exp: seconds + 80 });
  assert.strictEqual(verify(soon, { now }).ok, true, 'twenty seconds early, inside ±30');

  const tooSoon = sign({ ...base, jti: crypto.randomUUID(),
    iat: seconds + 45, nbf: seconds + 45, exp: seconds + 105 });
  const out = verify(tooSoon, { now });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'too-early', JSON.stringify(out));
  assert.match(out.detail, /clock on this machine/);
});

test('the verdict the doctor and Settings both read', () => {
  const leeway = tokens.leewayFor(undefined);
  assert.strictEqual(probes.CLOCK_WARN_SECONDS, 15);
  assert.strictEqual(probes.clockVerdict(0, leeway), 'pass');
  assert.strictEqual(probes.clockVerdict(15, leeway), 'pass', 'exactly the warning line is still fine');
  assert.strictEqual(probes.clockVerdict(16, leeway), 'warn');
  assert.strictEqual(probes.clockVerdict(-16, leeway), 'warn', 'behind counts the same as ahead');
  assert.strictEqual(probes.clockVerdict(30, leeway), 'warn', 'exactly the leeway still works');
  assert.strictEqual(probes.clockVerdict(31, leeway), 'fail');
  assert.strictEqual(probes.clockVerdict(-31, leeway), 'fail');
  /* AND THE CAP AGAIN, through the verdict: a studio that configures a day of
     leeway still gets a FAILURE at three minutes, because leewayFor clamped it
     to two. A doctor that could be configured into silence would be worse than
     no doctor. */
  assert.strictEqual(probes.clockVerdict(180, tokens.leewayFor(86400)), 'fail');
  assert.strictEqual(probes.clockVerdict(100, tokens.leewayFor(86400)), 'warn');
});
