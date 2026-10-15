/* THE STUDIO THE START-OF-DAY WINDOW TEST LOOKS AT, built through the real API.
 *
 * scripts/start-of-day.js runs in Electron, and Electron's main process cannot
 * be the one to do this: tests/helpers.js starts the server with
 * spawn(process.execPath, ['app.js']), and under Electron process.execPath is
 * the Electron binary, so that call starts a second application instead of a
 * server and nothing ever answers. So this half runs as plain Node, prints one
 * READY line of JSON, and stays up until it is killed.
 *
 * THE STUDIO'S CLOCK IS ANCHORED TO NOW, which is the whole reason this fixture
 * is more than three users and an asset. The banner only appears after the
 * grace period following the studio's OPENING, so a window at a fixed time of
 * day would make this script pass in the afternoon and fail at nine in the
 * morning. The window here opened ninety minutes ago and closes in eight hours,
 * so with the default sixty-minute grace the banner is due whatever time it is
 * run — which is the same reasoning tests/helpers.js's own setRecordingWindows
 * carries.
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
process.env.TEST_DB_NAME = process.env.TEST_DB_NAME || 'zvky_test';
process.env.TEST_DB_USER = process.env.TEST_DB_USER || 'zvkytest';
process.env.TEST_DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'zvkytest';
require(path.join(ROOT, 'tests', 'test-env.js'));
const { config, resetSchema, startServer, api, setRecordingWindows } =
  require(path.join(ROOT, 'tests', 'helpers.js'));

const PASSWORD = process.env.SOD_PASSWORD || 'StartDayWindow-1!';
const IST = 5 * 60 + 30;

/* One read of the clock, turned into two times — the mistake helpers.js
   documents at length is reading it twice and letting a minute tick between. */
function windowAroundNow(openedAgo, closesIn) {
  const at = Date.now();
  const minute = (() => {
    const d = new Date(at + IST * 60000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  const wrap = (m) => ((Math.round(m) % 1440) + 1440) % 1440;
  const label = (m) => `${String(Math.floor(wrap(m) / 60)).padStart(2, '0')}:${String(wrap(m) % 60).padStart(2, '0')}`;
  const start = wrap(minute - openedAgo);
  const end = wrap(minute + closesIn);
  return { startTime: label(start), endTime: label(end), spansMidnight: end < start };
}

(async () => {
  const cfg = config('sodwindow');
  await resetSchema(cfg);
  const server = await startServer(cfg, {
    BOOTSTRAP_TOKEN: 'sodw',
    WORK_HOURS_SWEEP_MINUTES: '0',
    /* The sweep is off: this script is about the SCREEN, and a reminder landing
       in the bell mid-run would be a second thing moving. */
    START_REMINDER_SWEEP_MINUTES: '0',
  });
  const as = (token, p, o = {}) => api(server.base, p, { ...o, token });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'sodw', name: 'Root', email: 'root@sodw.test', password: PASSWORD } });
  const root = await login('root@sodw.test');

  /* OPEN NINETY MINUTES AGO, closing in eight hours, every day of the week, with
     no break in it — so the clock is recording now and the grace has passed. */
  await setRecordingWindows(server.base, root, [
    { ...windowAroundNow(90, 480), type: 'recording', name: 'Smoke window' },
  ]);

  const mk = async (name, role, extra = {}) => {
    const r = await as(root, '/users', { method: 'POST',
      body: { name, email: `${name}@sodw.test`, role, password: PASSWORD, ...extra } });
    if (r.status !== 201) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
    return r.body.user.id;
  };
  const anaId = await mk('ana', 'game_artist');
  /* NOT CREATED TODAY. "Created today is not expected" is the rule from Prompt
     34 that this fixture would otherwise trip over for its own artist. */
  const { sql } = require(path.join(ROOT, 'tests', 'helpers.js'));
  await sql(cfg, "UPDATE users SET created_at = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE email LIKE '%@sodw.test'");

  const client = (await as(root, '/clients')).body.clients[0];
  const project = await as(root, '/projects', { method: 'POST',
    body: { name: 'Start Of Day', clientId: client.id } });
  if (project.status !== 201) throw new Error(JSON.stringify(project.body));
  const projectId = project.body.project.id;
  await as(root, `/users/${anaId}`, { method: 'PATCH', body: { projectId } });

  const asset = async (name, due) => {
    const r = await as(root, `/assets/project/${projectId}`, { method: 'POST',
      body: { name, type: 'character', assigneeId: anaId, due } });
    if (r.status !== 201) throw new Error(`${name}: ${JSON.stringify(r.body)}`);
    return r.body.asset.id;
  };
  const first = await asset('Hero Overdue', '2026-01-10');
  const second = await asset('Crate', null);

  const anaToken = await login('ana@sodw.test');
  process.stdout.write(`READY ${JSON.stringify({
    base: server.base, origin: server.base.replace(/\/api$/, ''),
    anaToken, rootToken: root, anaId, projectId, first, second,
  })}\n`);
  setInterval(() => {}, 1 << 30);
})().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
