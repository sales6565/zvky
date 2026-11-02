/* THE MEMBERS PANEL, IN A REAL BROWSER, FOR ALL FOUR KINDS OF VIEWER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE SERVER SUITE CANNOT. The server refuses what it
 * should; this is about what is DRAWN. Two different claims:
 *
 *   an action the viewer cannot perform is not on the screen at all — not
 *      disabled, not greyed, not there, because a Remove button on another
 *      admin that answers 403 teaches somebody the screen lies to them;
 *   and a promotion reaches everybody else on the poll chat already has, with
 *      nobody reloading anything.
 *
 * THE REAL PAGE, THE REAL SERVER, FOUR SESSIONS. The members panel is drawn
 * from the page's own renderChatManage against a live conversation, so what is
 * asserted is the markup the studio sees. Served on the server's own origin:
 * Chrome will not let a page on a public-looking origin reach loopback from an
 * insecure context, which cost a run in Prompt 59.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROLES = require('../src/chat-group-roles');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('chatadminbrowser');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'Admins-Browser-11!';
const FIXTURE_PATH = '/__chat-admins-fixture';

const lift = (name) => {
  const m = PAGE.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)\\n}\\n`));
  assert.ok(m, `public/index.html has no ${name}`);
  return `function ${name}(${m[1]}\n}`;
};
const liftAsync = (name) => {
  const m = PAGE.match(new RegExp(`\\nasync function ${name}\\(([\\s\\S]*?)\\n}\\n`));
  assert.ok(m, `public/index.html has no async ${name}`);
  return `async function ${name}(${m[1]}\n}`;
};
const liftShared = () => {
  const from = PAGE.indexOf(ROLES.SHARED_START);
  const to = PAGE.indexOf(ROLES.SHARED_END, from + 1);
  assert.ok(from !== -1 && to > from, 'the page carries the shared block');
  return PAGE.slice(from, to + ROLES.SHARED_END.length);
};
const liftConst = (name) => {
  const at = PAGE.indexOf(`const ${name} = `);
  assert.ok(at !== -1, `public/index.html has no ${name}`);
  const end = PAGE.indexOf(';\n', at);
  return PAGE.slice(at, end + 1);
};

/* The page's own member-row renderer and the real askConfirm, with the handful
   of helpers they lean on stubbed — avatarHTML draws a picture and roleInfo
   names a designation, neither of which this file is about. */
function fixture(base, token) {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');
  return `<!doctype html><html><head><meta charset="UTF-8"><style>${css}</style></head>
<body>
<div id="chatPanel"><div id="chatHead"></div><div id="chatBody"></div><div id="chatFoot"></div></div>
${(() => {
  /* THE REAL ASK MODAL'S MARKUP, lifted from the page. openAsk fills these
     elements in; without them it reports "this page could not open its dialog"
     and resolves nothing, which is how the first run of this file failed —
     silently, with no modal and therefore no promotion. */
  const at = PAGE.indexOf('<div class="modal-wrap" id="askWrap">');
  const end = PAGE.indexOf('</div>\n</div>', at);
  assert.ok(at !== -1 && end > at, 'the page has the ask modal');
  return PAGE.slice(at, end + '</div>\n</div>'.length);
})()}
<script>
const API_BASE = ${JSON.stringify(base)};
const state = { token: ${JSON.stringify(token)} };
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
window.__toasts = [];
function showToast(msg){ window.__toasts.push(String(msg)); }
const avatarHTML = () => '';
const roleInfo = (r) => ({ label: String(r || '') });
const chatPeopleMatching = () => window.__people || [];
const chatState = { conversation:null, conversationId:null, members:[], search:'',
  maxMembers:null, features:{ groupAdmins:true }, view:'manage' };
window.chatState = chatState;

/* NO NATIVE DIALOGS. The desktop web view has none; any case that reaches one
   fails here rather than hanging. */
for (const name of ['alert','confirm','prompt']) {
  window[name] = () => { throw new Error('native ' + name); };
}

/* THE REAL IN-PAGE MODAL, lifted whole: the brief asks that everything uses
   in-page confirmations, and a stub of askConfirm would be this file agreeing
   with itself. */
const askWrap = document.getElementById('askWrap');
let askActive = null;
function askClose(){ askWrap.classList.remove('show'); askActive = null; }
${(() => {
  const at = PAGE.indexOf('function openAsk(');
  const end = PAGE.indexOf('\nconst askConfirm', at);
  assert.ok(at !== -1 && end > at, 'the page has openAsk');
  return PAGE.slice(at, end);
})()}
const askConfirm = (opts) => openAsk({ confirmLabel:'Yes, continue', ...opts, input:null });

${liftShared()}
${liftConst('CHAT_ADMIN_CAN')}
${liftConst('CHAT_ADMIN_CANNOT')}
${liftConst('chatMyGroupRole')}
${lift('chatRowActions')}
${lift('chatRoleBadge')}
${lift('renderChatManage')}
${liftAsync('chatSetMemberRole')}

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    method: (opts.method || 'GET'),
    headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + state.token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const said = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(said.error || 'failed');
  return said;
}
function renderChat(){ window.__paint(); }
async function refreshChatConversation(){
  const got = await api('/chat/' + chatState.conversationId + '/messages');
  chatState.conversation = got.conversation;
  chatState.maxMembers = got.conversation.maxMembers;
  chatState.features.groupAdmins = window.__groupAdmins !== false;
}
window.__open = async (id) => {
  chatState.conversationId = id;
  await refreshChatConversation();
  window.__paint();
};
window.__paint = () => {
  renderChatManage(document.getElementById('chatHead'),
    document.getElementById('chatBody'), document.getElementById('chatFoot'));
};
/* The panel's click handling, for the three actions this file exercises. */
document.addEventListener('click', async (e) => {
  const mk = e.target.closest('[data-make-admin]');
  if(mk){ await chatSetMemberRole(mk.dataset.makeAdmin, 'admin'); return; }
  const dr = e.target.closest('[data-drop-admin]');
  if(dr){ await chatSetMemberRole(dr.dataset.dropAdmin, 'member'); return; }
});
window.__ready = true;
<\/script></body></html>`;
}

test('what each kind of viewer sees in a group', { skip: SKIP }, async (t) => {
  let server;
  let browser;
  const tok = {};
  const id = {};
  let group;
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'adminbrowser', CHAT_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'adminbrowser', name: 'Root', email: 'root@gab.test', password: PASSWORD } });
    tok.root = await login('root@gab.test');
    for (const [who, name, role] of [['ana', 'Ana', 'team_lead'], ['bo', 'Bo', 'game_artist'],
      ['cas', 'Cas', 'game_artist'], ['dee', 'Dee', 'game_artist']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name, email: `${who}@gab.test`, password: PASSWORD, role } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      id[who] = made.body.user.id;
      tok[who] = await login(`${who}@gab.test`);
    }
    group = (await as('ana', '/chat/groups', { method: 'POST',
      body: { title: 'The panel', memberIds: [id.bo, id.cas, id.dee] } })).body.conversationId;
    browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  });
  t.after(async () => {
    if (browser) await browser.close();
    if (server) stopServer(server);
  });

  const open = async (who, { groupAdmins = true } = {}) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const origin = new URL(server.base).origin;
    /* BUILT BEFORE THE ROUTE IS REGISTERED. fixture() asserts its way through a
       dozen slices of the real page, and an assertion that throws inside a
       route handler does not fail the test — it leaves the request unanswered
       and the case dies thirty seconds later on "page.goto: Timeout", which
       says nothing about which slice was wrong. That cost a run. */
    const html = fixture(server.base, tok[who]);
    await page.route(origin + FIXTURE_PATH, (route) => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto(origin + FIXTURE_PATH, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    await page.evaluate((on) => { window.__groupAdmins = on; }, groupAdmins);
    await page.evaluate((g) => window.__open(g), group);
    return { page, errors };
  };
  /* THE PANEL'S TEXT, NOT THE DOCUMENT'S. document.body.textContent includes
     the text inside <script> elements, so a fixture that carries the page's own
     source would "contain" every string in it — including 'Add people' and
     'Make admin'. That turned one assertion into a tautology and another into a
     false failure, in the same run. */
  const panelText = (page) => page.evaluate(() =>
    (document.getElementById('chatHead').textContent + ' '
      + document.getElementById('chatBody').textContent).replace(/\s+/g, ' ').trim());
  const modalText = (page) => page.evaluate(() => {
    const wrap = document.getElementById('askWrap');
    return wrap && wrap.classList.contains('show')
      ? wrap.textContent.replace(/\s+/g, ' ').trim() : '';
  });

  /* What is on the screen for one member's row, by data attribute — which is
     what "hidden, not disabled" means in a test: the element is absent. */
  const rowActions = (page, userId) => page.evaluate((who) => {
    const row = document.querySelector(`[data-member="${who}"]`);
    if (!row) return null;
    return {
      remove: !!row.querySelector('[data-remove]'),
      makeAdmin: !!row.querySelector('[data-make-admin]'),
      dropAdmin: !!row.querySelector('[data-drop-admin]'),
      badge: (row.querySelector('.chat-badge') || {}).textContent || '',
      disabled: [...row.querySelectorAll('button')].some((b) => b.disabled),
    };
  }, userId);

  await t.test('the owner sees Make admin, and the modal says what an admin may do', async () => {
    const { page, errors } = await open('ana');
    const bo = await rowActions(page, id.bo);
    assert.strictEqual(bo.makeAdmin, true, 'Make admin is offered on an ordinary member');
    assert.strictEqual(bo.dropAdmin, false, 'and not Remove admin, which is for an admin');
    assert.strictEqual(bo.remove, true, 'the owner may remove them');
    assert.strictEqual(bo.disabled, false, 'nothing is drawn disabled');

    /* THE OWNER'S OWN ROW offers neither: there is nothing to change about
       being the owner, and Remove on yourself is Leave group. */
    const ana = await rowActions(page, id.ana);
    assert.strictEqual(ana.makeAdmin, false);
    assert.strictEqual(ana.dropAdmin, false);
    assert.strictEqual(ana.remove, false);
    assert.strictEqual(ana.badge.trim(), 'owner', 'and it is badged as the owner');

    /* THE CONFIRMATION, in the page, saying both halves. */
    await page.click(`[data-member="${id.bo}"] [data-make-admin]`);
    await page.waitForFunction(() =>
      document.getElementById('askWrap').classList.contains('show'), null, { timeout: 5000 });
    const text = await modalText(page);
    assert.match(text, /Make Bo an admin\?/);
    assert.match(text, /add members/i, 'what they will be able to do');
    assert.match(text, /remove ordinary members/i);
    assert.match(text, /rename the group/i);
    assert.match(text, /will not be able to/i, 'and what they will not');
    assert.match(text, /make anybody else an admin/i);

    /* CONFIRMED, and the badge appears without a reload. */
    await page.click('#ask_confirm');
    await page.waitForFunction((who) => {
      const row = document.querySelector(`[data-member="${who}"]`);
      return !!(row && row.querySelector('.chat-badge-admin'));
    }, id.bo, { timeout: 10000 });
    const after = await rowActions(page, id.bo);
    assert.strictEqual(after.badge.trim(), 'admin');
    assert.strictEqual(after.dropAdmin, true, 'and the action becomes Remove admin');
    assert.strictEqual(after.makeAdmin, false);
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('another member sees the badge on the normal refresh, without reloading', async () => {
    /* THE SECOND SESSION. Cas has the panel open and nobody touches their
       browser: the members list is re-read by the refresh chat already does,
       which is what the brief asks for and why no new polling loop was
       added. */
    const { page, errors } = await open('cas');
    assert.strictEqual((await rowActions(page, id.dee)).badge.trim(), '',
      'Dee is an ordinary member to start with');

    await as('ana', `/chat/groups/${group}/members/${id.dee}`,
      { method: 'PATCH', body: { role: 'admin' } });

    /* The fixture calls the same refreshChatConversation the poll calls. */
    await page.evaluate(() => refreshChatConversation().then(() => window.__paint()));
    await page.waitForFunction((who) => {
      const row = document.querySelector(`[data-member="${who}"]`);
      return !!(row && row.querySelector('.chat-badge-admin'));
    }, id.dee, { timeout: 10000 });
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('an admin sees Add and Remove on ordinary members only', async () => {
    /* Bo is an admin, Dee is an admin, Cas is an ordinary member, Ana owns it. */
    const { page, errors } = await open('bo');
    const cas = await rowActions(page, id.cas);
    assert.strictEqual(cas.remove, true, 'an ordinary member may be removed');
    assert.strictEqual(cas.makeAdmin, false, 'but an admin hands out nothing');
    assert.strictEqual(cas.dropAdmin, false);

    for (const [who, what] of [[id.ana, 'the owner'], [id.dee, 'another admin']]) {
      const row = await rowActions(page, who);
      assert.strictEqual(row.remove, false, `no Remove on ${what}`);
      assert.strictEqual(row.makeAdmin, false, `no Make admin on ${what}`);
      assert.strictEqual(row.dropAdmin, false, `no Remove admin on ${what}`);
    }
    /* AND THE DELEGATED JOBS ARE THERE: rename and add. */
    assert.strictEqual(await page.locator('#chatRenameGo').count(), 1, 'an admin may rename');
    assert.match(await panelText(page), /Add people/, 'and may add people');
    /* NOTHING IS DRAWN DISABLED anywhere on this screen. */
    assert.strictEqual(await page.locator('button[disabled]').count(), 0);
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('an ordinary member sees none of it', async () => {
    const { page, errors } = await open('cas');
    for (const who of [id.ana, id.bo, id.dee]) {
      const row = await rowActions(page, who);
      assert.deepStrictEqual([row.remove, row.makeAdmin, row.dropAdmin], [false, false, false],
        'a member manages nobody');
    }
    assert.strictEqual(await page.locator('#chatRenameGo').count(), 0, 'and cannot rename');
    assert.ok(!/Add people/.test(await panelText(page)), 'and cannot add');
    /* THE BADGES ARE STILL THERE: who runs the group is not a secret. */
    assert.strictEqual((await rowActions(page, id.ana)).badge.trim(), 'owner');
    assert.strictEqual((await rowActions(page, id.bo)).badge.trim(), 'admin');
    assert.strictEqual(await page.locator('#chatLeave').count(), 1, 'and they may still leave');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('Remove admin works, and the badge goes', async () => {
    const { page, errors } = await open('ana');
    await page.click(`[data-member="${id.dee}"] [data-drop-admin]`);
    await page.waitForFunction(() =>
      document.getElementById('askWrap').classList.contains('show'), null, { timeout: 5000 });
    const text = await modalText(page);
    assert.match(text, /Remove Dee as admin\?/);
    assert.match(text, /stay in the group/i, 'and says what does NOT happen to them');
    assert.strictEqual(await page.textContent('#ask_confirm'), 'Remove admin',
      'and the button says what it does');
    await page.click('#ask_confirm');
    await page.waitForFunction((who) => {
      const row = document.querySelector(`[data-member="${who}"]`);
      return !!(row && !row.querySelector('.chat-badge-admin'));
    }, id.dee, { timeout: 10000 });
    const after = await rowActions(page, id.dee);
    assert.strictEqual(after.badge.trim(), '');
    assert.strictEqual(after.makeAdmin, true, 'and they can be made one again');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('with the switch off the action is gone and no badge is drawn', async () => {
    /* The server stops reporting anybody as an admin and tells the page the
       feature is off; both halves are needed, and this is the page half. */
    const policy = (await as('root', '/admin/settings/chat-policy')).body.settings;
    const save = (on) => as('root', '/admin/settings/chat-policy', { method: 'PUT',
      body: { attachmentHours: policy.attachmentHours, repliesEnabled: policy.repliesEnabled,
        emojiPickerEnabled: policy.emojiPickerEnabled, groupAdminsEnabled: on } });
    assert.strictEqual((await save(false)).status, 200);
    try {
      const { page, errors } = await open('ana', { groupAdmins: false });
      const bo = await rowActions(page, id.bo);
      assert.strictEqual(bo.makeAdmin, false, 'no Make admin while the feature is off');
      assert.strictEqual(bo.dropAdmin, false, 'and no Remove admin');
      assert.strictEqual(bo.badge.trim(), '', 'and no admin badge');
      /* THE OWNER IS NOT PART OF THE FEATURE and still runs the group. */
      assert.strictEqual((await rowActions(page, id.ana)).badge.trim(), 'owner');
      assert.strictEqual(bo.remove, true, 'the owner may still remove people');
      assert.strictEqual(await page.locator('#chatRenameGo').count(), 1);
      assert.deepStrictEqual(errors, []);
      await page.close();
    } finally {
      assert.strictEqual((await save(true)).status, 200);
    }
    /* AND THE ROLE WAS KEPT: back on, the badge is back, with nobody
       re-promoting anybody. */
    const { page } = await open('ana');
    assert.strictEqual((await rowActions(page, id.bo)).badge.trim(), 'admin');
    await page.close();
  });

  await t.test('nothing on this screen uses a native dialog', async () => {
    /* alert, confirm and prompt all throw in the fixture, so a case that
       reached one would have failed above with "native confirm". This asserts
       the stronger thing: the page's own source does not call them in the chat
       panel at all. */
    const chatPart = PAGE.slice(PAGE.indexOf('function renderChatManage'),
      PAGE.indexOf('function renderChatManage') + 6000);
    for (const native of ['window.confirm', 'confirm(', 'alert(', 'prompt(']) {
      assert.ok(!chatPart.includes(native), `the members panel does not call ${native}`);
    }
    assert.ok(PAGE.includes('askConfirm({ title: `Make ${who} an admin?`')
      || PAGE.includes('title: `Make ${who} an admin?`'),
    'the promotion asks through the in-page modal');
  });
});
