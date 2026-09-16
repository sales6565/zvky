/* Registering a phone, and taking it off again.
 *
 * Three routes and no permission of its own. Registering a device is a thing
 * you do to YOUR OWN account from a phone you are already signed in on — the
 * authentication is the authorisation, exactly as it is for changing your own
 * password. A permission here would be a gate on the act of holding a phone.
 */
const { asyncRouter } = require('../async-router');
const { authenticate } = require('../middleware/auth');
const push = require('../push-notifications');
const db = require('../db');

const router = asyncRouter();
router.use(authenticate);

/* What the app asks before it bothers the person for permission. A build
   talking to a deployment with no keys configured should not raise an iOS
   permission prompt it cannot honour. */
router.get('/config', (req, res) => {
  const s = push.status();
  res.json({ configured: s.configured, ios: s.apns, android: s.fcm });
});

router.post('/devices', async (req, res) => {
  const { token, platform } = req.body || {};
  const verdict = await push.register(db, { userId: req.user.id, token, platform });
  if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: 'token' });
  return res.status(201).json({ ok: true });
});

/* Sign-out, and any other moment the app knows this pairing is over. Idempotent
   on a token that is already gone: the app calls this on a best-effort basis
   while it is also throwing the session away. */
router.delete('/devices/:token', async (req, res) => {
  await push.unregister(db, req.params.token);
  res.json({ ok: true });
});

/* "Send one to me, now." The only way to find out whether a certificate, a
   bundle id and a device token actually agree is to put a notification on a
   real phone, and doing that by assigning yourself a task is a silly way to
   test a push pipeline. */
router.post('/test', async (req, res) => {
  const s = push.status();
  if (!s.configured) {
    return res.status(400).json({
      error: 'Push is not configured on this deployment. See mobile/README.md for the keys it needs.',
    });
  }
  const result = await push.pushTo(db, req.user.id, {
    title: 'Zvky',
    body: 'Push notifications are working on this device.',
    tag: 'test',
    data: { kind: 'test' },
  });
  if (!result.sent) {
    return res.status(200).json({
      ok: false,
      /* Not an error status: the request worked, the delivery did not, and the
         difference is what tells somebody whether to look at their keys or at
         their phone. */
      message: result.skipped === 'no devices'
        ? 'No phone is registered against your account yet. Open the mobile app and allow notifications.'
        : result.skipped === 'opted out'
          ? 'You have turned push notifications off in your Profile.'
          : 'Nothing was delivered. Check the APNs and FCM keys in the environment.',
      ...result,
    });
  }
  return res.json({ ok: true, ...result });
});

module.exports = router;
