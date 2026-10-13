/* THE STUDIO THE WINDOW TEST LOOKS AT, built through the real API.
 *
 * scripts/timesheet-day.js runs in Electron, and Electron's main process cannot
 * be the one to do this: tests/helpers.js starts the server with
 * spawn(process.execPath, ['app.js']), and under Electron process.execPath is
 * the Electron binary, so that call starts a second application instead of a
 * server and nothing ever answers. So this half runs as plain Node, prints one
 * READY line of JSON, and stays up until it is killed.
 *
 * The acceptance example from the brief: one person, one asset, started 6:00 PM
 * on 8 Oct and finished 11:00 AM on 9 Oct, studio hours 9:30 - 19:00 with lunch
 * 13:00 - 14:00. The seconds column is written the way src/work-log.js close()
 * writes it, so the row is shaped like a real one.
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
process.env.TEST_DB_NAME = process.env.TEST_DB_NAME || 'zvky_test';
process.env.TEST_DB_USER = process.env.TEST_DB_USER || 'zvkytest';
process.env.TEST_DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'zvkytest';
require(path.join(ROOT, 'tests', 'test-env.js'));
const { config, resetSchema, startServer, api, sql, setRecordingWindows } =
  require(path.join(ROOT, 'tests', 'helpers.js'));
const workingTime = require(path.join(ROOT, 'src', 'working-time.js'));

const DAY1 = '2026-10-08';          /* a Thursday */
const DAY2 = '2026-10-09';          /* a Friday */
const PASSWORD = process.env.TS_PASSWORD || 'TsWindow-1!';
const IST = 5.5 * 3600 * 1000;
const at = (day, hour, min = 0) =>
  Date.parse(`${day}T00:00:00Z`) - IST + ((hour * 60 + min) * 60000);
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const STUDIO = { workingDays: [1, 2, 3, 4, 5], dayStart: 570, dayEnd: 1140,
  breaks: [{ label: 'Lunch', key: 'lunch', start: 780, end: 840 }],
  holidays: [], timezone: 'IST' };

(async () => {
  const cfg = config('tswindow');
  await resetSchema(cfg);
  const server = await startServer(cfg,
    { BOOTSTRAP_TOKEN: 'tsw', WORK_HOURS_SWEEP_MINUTES: '0' });
  const as = (token, pathname, opts = {}) => api(server.base, pathname, { ...opts, token });
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'tsw', name: 'Root', email: 'root@tsw.test', password: PASSWORD } });
  const root = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@tsw.test', password: PASSWORD } })).body.token;
  await as(root, '/branding/schedule', { method: 'PUT',
    body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], dayStart: 570, dayEnd: 1140,
      lunchStart: '13:00', lunchEnd: '14:00',
      morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '' } });
  await setRecordingWindows(server.base, root, [
    { type: 'recording', label: 'Core hours', startTime: '09:30', endTime: '19:00',
      daysOfWeek: [1, 2, 3, 4, 5] },
    { type: 'non_recording', label: 'Lunch', startTime: '13:00', endTime: '14:00' }]);
  const person = (await as(root, '/users', { method: 'POST',
    body: { name: 'ana', email: 'ana@tsw.test', role: 'game_artist', password: PASSWORD } }))
    .body.user;
  if (!person) throw new Error('the person was not created');
  const client = (await as(root, '/clients')).body.clients[0];
  const project = (await as(root, '/projects', { method: 'POST',
    body: { name: 'Overnight', clientId: client.id } })).body.project;
  const asset = (await as(root, `/assets/project/${project.id}`, { method: 'POST',
    body: { name: 'Started Late Finished Next Morning', type: 'prop',
      assigneeId: person.id } })).body.asset;
  const start = at(DAY1, 18, 0);
  const end = at(DAY2, 11, 0);
  await sql(cfg,
    'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason) '
    + "VALUES (UUID(), ?, ?, 1, ?, ?, ?, 'submitted')",
    [asset.id, person.id, stamp(start), stamp(end),
      workingTime.workingSecondsBetween(start, end, STUDIO)]);
  process.stdout.write('READY ' + JSON.stringify({
    url: server.base.replace(/\/api$/, ''), email: 'ana@tsw.test', password: PASSWORD,
    asset: asset.id, project: project.id, client: client.id, day1: DAY1, day2: DAY2,
  }) + '\n');
  setInterval(() => {}, 1 << 30);
})().catch((err) => { process.stderr.write(String(err && err.stack) + '\n'); process.exit(1); });
