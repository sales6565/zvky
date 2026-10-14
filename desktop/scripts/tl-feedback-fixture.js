/* THE STUDIO THE SUBMIT FEEDBACK WINDOW TEST LOOKS AT, built through the real API.
 *
 * scripts/tl-feedback.js runs in Electron, and Electron's main process cannot be
 * the one to do this: tests/helpers.js starts the server with
 * spawn(process.execPath, ['app.js']), and under Electron process.execPath is the
 * Electron binary, so that call starts a second application instead of a server
 * and nothing ever answers. So this half runs as plain Node, prints one READY
 * line of JSON, and stays up until it is killed.
 *
 * One project with a lead on its review team, one artist, and one asset driven
 * all the way to TL Approved through its own routes — start, submit, approve — so
 * the stage the window opens on is one the application really makes.
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
process.env.TEST_DB_NAME = process.env.TEST_DB_NAME || 'zvky_test';
process.env.TEST_DB_USER = process.env.TEST_DB_USER || 'zvkytest';
process.env.TEST_DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'zvkytest';
require(path.join(ROOT, 'tests', 'test-env.js'));
const { config, resetSchema, startServer, api, openStudio } =
  require(path.join(ROOT, 'tests', 'helpers.js'));

const PASSWORD = process.env.TLFB_PASSWORD || 'TlFbWindow-1!';

(async () => {
  const cfg = config('tlfbwindow');
  await resetSchema(cfg);
  const server = await startServer(cfg,
    { BOOTSTRAP_TOKEN: 'tlfbw', WORK_HOURS_SWEEP_MINUTES: '0' });
  const as = (token, p, o = {}) => api(server.base, p, { ...o, token });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'tlfbw', name: 'Root', email: 'root@tlfbw.test', password: PASSWORD } });
  const root = await login('root@tlfbw.test');
  await openStudio(server.base, root);

  const mk = async (name, role, extra = {}) => {
    const r = await as(root, '/users', { method: 'POST',
      body: { name, email: `${name}@tlfbw.test`, role, password: PASSWORD, ...extra } });
    if (r.status !== 201) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
    return r.body.user.id;
  };
  const leadId = await mk('priya', 'team_lead');
  const anaId = await mk('ana', 'game_artist', { teamLeadId: leadId });
  const leadToken = await login('priya@tlfbw.test');

  const client = (await as(root, '/clients')).body.clients[0];
  const project = (await as(root, '/projects', { method: 'POST',
    body: { name: 'Gatehouse', clientId: client.id, teamLeadIds: [leadId] } })).body.project;
  const asset = (await as(root, `/assets/project/${project.id}`, { method: 'POST',
    body: { name: 'Hero Prop', type: 'prop', assigneeId: anaId } })).body.asset;

  await as(await login('ana@tlfbw.test'), `/assets/${asset.id}/start`, { method: 'POST' });
  const submitted = await as(await login('ana@tlfbw.test'), `/assets/${asset.id}/submit`,
    { method: 'POST', body: { link: 'https://example.com/v1' } });
  if (submitted.status !== 201) throw new Error(`submit: ${JSON.stringify(submitted.body)}`);
  const approved = await as(leadToken, `/assets/${asset.id}/review`,
    { method: 'POST', body: { decision: 'approved' } });
  if (approved.body.asset.status !== 'tl_approved') {
    throw new Error(`not in TL Approved: ${JSON.stringify(approved.body)}`);
  }

  process.stdout.write('READY ' + JSON.stringify({
    url: server.base.replace(/\/api$/, ''), email: 'priya@tlfbw.test', password: PASSWORD,
    asset: asset.id, assetCode: asset.code, project: project.id,
  }) + '\n');
  setInterval(() => {}, 1 << 30);
})().catch((err) => { process.stderr.write(String(err && err.stack) + '\n'); process.exit(1); });
