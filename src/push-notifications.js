// Native push, to the phones the studio actually carries.
//
// WHY THERE ARE NO NEW DEPENDENCIES HERE. This application is deployed by
// uploading a folder to cPanel. Every dependency added is a thing that can fail
// to install on a host nobody can SSH into, and firebase-admin alone pulls in
// something like forty packages. Both services this file talks to are plain
// HTTPS with a signed JWT for authentication, and Node has everything needed:
// `crypto` signs the tokens, `http2` speaks to APNs, `fetch` speaks to FCM.
//
// APNs and FCM are reached DIRECTLY rather than both through Firebase. Routing
// iOS through FCM would mean uploading the APNs key to Google and adding a
// second party to the path a message about somebody's work takes.
//
// WHAT IS SENT, AND WHAT IS NOT. The payload carries the same one-line summary
// the in-app bell already shows, and the ids needed to open the right screen.
// It does NOT carry message bodies, client names or anything else that would
// end up on a lock screen in a coffee shop. A push says "Ana assigned you
// CHR-014"; the app is where the work is read.
//
// SILENT BY DEFAULT WHEN UNCONFIGURED. A studio that has not set up APNs or FCM
// keys gets an application that works exactly as it did, with the bell and the
// emails. Every function here returns quietly rather than throwing, for the
// same reason src/mailer.js does: a notification failing must never fail the
// action that raised it.

const crypto = require('node:crypto');
const http2 = require('node:http2');

/* One row per device per user. A person with a phone and a tablet gets two,
   and the same phone signed in as somebody else gets its own — the token is
   about the installation, the row is about the pairing. */
const TABLE = 'push_devices';

/* How long a device row survives without being seen again. A token that stops
   being registered is a phone that was wiped, reset or signed out; sending to
   it forever earns a slow rate-limiting from both services. */
const STALE_DAYS = 90;

/* --- configuration, read from the environment ------------------------------
 *
 * All optional. Anything missing switches that platform off rather than
 * breaking the other one. */
function config() {
  return {
    apns: {
      keyId: process.env.APNS_KEY_ID || '',
      teamId: process.env.APNS_TEAM_ID || '',
      /* The .p8 contents. Newlines survive an env var badly, so \n is accepted
         as an escape — the same accommodation src/email-secret.js makes. */
      key: (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n'),
      bundleId: process.env.APNS_BUNDLE_ID || '',
      /* api.push.apple.com is production; api.sandbox.push.apple.com is what a
         development build talks to. An Ad Hoc build is a PRODUCTION build, so
         the default is right for the distribution this studio uses. */
      host: process.env.APNS_HOST || 'api.push.apple.com',
    },
    fcm: {
      projectId: process.env.FCM_PROJECT_ID || '',
      clientEmail: process.env.FCM_CLIENT_EMAIL || '',
      privateKey: (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
  };
}

const apnsReady = (c) => Boolean(c.apns.keyId && c.apns.teamId && c.apns.key && c.apns.bundleId);
const fcmReady = (c) => Boolean(c.fcm.projectId && c.fcm.clientEmail && c.fcm.privateKey);

/* Whether either platform is configured, for the screen that says so. */
function status() {
  const c = config();
  return {
    apns: apnsReady(c),
    fcm: fcmReady(c),
    configured: apnsReady(c) || fcmReady(c),
    bundleId: c.apns.bundleId || null,
    fcmProject: c.fcm.projectId || null,
  };
}

// --- schema -----------------------------------------------------------------

async function ensureTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id          CHAR(36)     NOT NULL PRIMARY KEY,
    user_id     CHAR(36)     NOT NULL,
    /* The device token. APNs tokens are 64 hex characters today and FCM's are
       long opaque strings that have grown before; 512 is room for both to
       change without a migration. UNIQUE, because a token identifies exactly
       one installation: if a phone is handed to somebody else and they sign
       in, the row moves to them rather than the old owner keeping a copy. */
    token       VARCHAR(512) NOT NULL,
    platform    VARCHAR(16)  NOT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_push_token (token(191)),
    KEY idx_push_user (user_id)
  )`);
}

/* Register, or re-point an existing token at whoever is signed in now. */
async function register(db, { userId, token, platform }) {
  const clean = String(token || '').trim();
  if (!userId || !clean) return { ok: false, error: 'A device token is required.' };
  if (clean.length > 512) return { ok: false, error: 'That device token is too long.' };
  if (platform !== 'ios' && platform !== 'android') {
    return { ok: false, error: 'The platform must be ios or android.' };
  }
  await db.query(
    `INSERT INTO ${TABLE} (id, user_id, token, platform) VALUES (UUID(),$1,$2,$3)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform),
       last_seen_at = CURRENT_TIMESTAMP`,
    [userId, clean, platform]
  ).catch(() => null);
  return { ok: true };
}

async function unregister(db, token) {
  const clean = String(token || '').trim();
  if (!clean) return;
  await db.query(`DELETE FROM ${TABLE} WHERE token = $1`, [clean]).catch(() => null);
}

/* Every device belonging to one person, minus the long-dead ones. */
async function devicesFor(db, userId) {
  const { rows } = await db.query(
    `SELECT token, platform FROM ${TABLE}
      WHERE user_id = $1 AND last_seen_at > DATE_SUB(NOW(), INTERVAL ${STALE_DAYS} DAY)`,
    [userId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

// --- authentication tokens ---------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* APNs wants an ES256 JWT, and Apple asks that it be REUSED rather than minted
   per request — a new one on every push is treated as abuse. Cached for 50
   minutes against Apple's 60-minute limit. */
let apnsCache = { token: null, at: 0, key: '' };
function apnsJwt(c) {
  const now = Date.now();
  /* Keyed on the credentials, not only on the clock. A deployment that rotates
     its APNs key would otherwise keep presenting the old token for up to fifty
     minutes, and Apple's refusal names neither the key nor the staleness. */
  const cacheKey = `${c.apns.keyId}:${c.apns.teamId}:${c.apns.key.length}`;
  if (apnsCache.token && apnsCache.key === cacheKey && now - apnsCache.at < 50 * 60 * 1000) {
    return apnsCache.token;
  }
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: c.apns.keyId }));
  const claims = b64url(JSON.stringify({ iss: c.apns.teamId, iat: Math.floor(now / 1000) }));
  const signer = crypto.createSign('SHA256');
  signer.update(`${header}.${claims}`);
  /* dsaEncoding matters: JWT wants the raw r||s pair, and OpenSSL's default is
     DER. Without this every token is rejected as malformed. */
  const sig = signer.sign({ key: c.apns.key, dsaEncoding: 'ieee-p1363' });
  apnsCache = { token: `${header}.${claims}.${b64url(sig)}`, at: now, key: cacheKey };
  return apnsCache.token;
}

/* FCM wants a Google OAuth access token, obtained by presenting an RS256 JWT
   signed with the service account key. Cached until shortly before it expires. */
let fcmCache = { token: null, expires: 0 };
/* The signed assertion, split out from the exchange below so its shape can be
   checked without a network. A wrong `aud` or a missing scope is rejected by
   Google with a generic invalid_grant, which names nothing. */
function fcmAssertion(c) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: c.fcm.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(c.fcm.privateKey))}`;
}

async function fcmAccessToken(c) {
  if (fcmCache.token && Date.now() < fcmCache.expires - 60_000) return fcmCache.token;
  const assertion = fcmAssertion(c);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed (${res.status})`);
  const body = await res.json();
  fcmCache = { token: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return fcmCache.token;
}

// --- sending -----------------------------------------------------------------

/* One APNs push, over HTTP/2.
 *
 * Returns 'gone' for the two statuses that mean the token is dead, so the
 * caller can delete the row rather than retry it forever. */
function sendApns(c, token, message) {
  return new Promise((resolve) => {
    let client;
    try { client = http2.connect(`https://${c.apns.host}`); }
    catch { resolve('error'); return; }

    const done = (outcome) => { try { client.close(); } catch { /* already gone */ } resolve(outcome); };
    client.on('error', () => done('error'));
    /* Apple holds the connection open; without a deadline a hung socket would
       keep the request alive for as long as the process runs. */
    client.setTimeout(10_000, () => done('error'));

    const payload = JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        'thread-id': message.tag || 'zvky',
        badge: message.badge,
      },
      ...message.data,
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsJwt(c)}`,
      'apns-topic': c.apns.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.on('error', () => done('error'));
    req.setEncoding('utf8');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (status === 200) return done('sent');
      /* 410 Gone: the token is no longer valid. 400 with BadDeviceToken: it
         never was. Both mean delete, not retry. */
      if (status === 410 || /BadDeviceToken|Unregistered/.test(body)) return done('gone');
      return done('error');
    });
    req.end(payload);
  });
}

async function sendFcm(c, token, message) {
  let access;
  try { access = await fcmAccessToken(c); } catch { return 'error'; }
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${c.fcm.projectId}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          /* Every value must be a string — FCM refuses numbers and nulls in the
             data map, and refuses the whole message rather than the field. */
          data: Object.fromEntries(
            Object.entries(message.data || {}).map(([k, v]) => [k, String(v == null ? '' : v)])
          ),
          android: { priority: 'HIGH', notification: { tag: message.tag || 'zvky' } },
        },
      }),
    }
  ).catch(() => null);
  if (!res) return 'error';
  if (res.ok) return 'sent';
  const body = await res.text().catch(() => '');
  if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(body)) return 'gone';
  return 'error';
}

/* Push one message to one person, on every device they have registered.
 *
 * NEVER THROWS, and never blocks the caller: raising a notification must not
 * fail because a phone company had a bad minute. The promise is returned for
 * the tests; production callers let it run. */
async function pushTo(db, userId, message) {
  const c = config();
  if (!apnsReady(c) && !fcmReady(c)) return { sent: 0, skipped: 'not configured' };

  /* The SAME opt-out the emails respect, so a person who has turned
     notifications off is not reached by a route they did not know about. A
     deployment whose column is missing reads as "not opted out". */
  const { rows } = await db.query(
    'SELECT push_opt_out AS optOut FROM users WHERE id = $1', [userId]
  ).catch(() => ({ rows: null }));
  if (rows && rows.length && rows[0].optOut) return { sent: 0, skipped: 'opted out' };

  const devices = await devicesFor(db, userId);
  if (!devices.length) return { sent: 0, skipped: 'no devices' };

  let sent = 0;
  const dead = [];
  for (const device of devices) {
    const ready = device.platform === 'ios' ? apnsReady(c) : fcmReady(c);
    if (!ready) continue;
    let outcome;
    try {
      outcome = device.platform === 'ios'
        ? await sendApns(c, device.token, message)
        : await sendFcm(c, device.token, message);
    } catch { outcome = 'error'; }
    if (outcome === 'sent') sent += 1;
    if (outcome === 'gone') dead.push(device.token);
  }
  /* A token the service says is dead is deleted here rather than left to rot.
     Both services start throttling a sender that keeps writing to gone
     addresses, which would eventually cost the live ones too. */
  for (const token of dead) await unregister(db, token);
  return { sent, removed: dead.length };
}

module.exports = {
  TABLE, STALE_DAYS, config, status, ensureTables,
  register, unregister, devicesFor, pushTo,
  // exported for the tests, which sign tokens without a network
  apnsJwt, fcmAssertion, b64url,
};
