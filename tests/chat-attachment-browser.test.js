/* THE THREE STATES, IN A REAL BROWSER, AGAINST THE REAL SERVER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE SERVER SUITE CANNOT. tests/chat-file-states covers
 * what the server answers; this covers what somebody actually SEES — which is
 * the whole of the complaint. The studio's two bug reports were both a sentence
 * on a screen, and both times the sentence was wrong about what had happened.
 *
 * NOT A MOCK OF THE SERVER. A real server, a real upload, the page's real
 * loader, and the real fetch across an origin — so the state that decides the
 * sentence travels the whole way: table → route → JSON → page. A stubbed
 * response would be this file asserting against its own fixture, which is
 * exactly the mistake Prompt 58's switch case made.
 *
 * THE FIXTURE PAGE IS SERVED ON THE SERVER'S OWN ORIGIN, through a route that
 * fulfils one path locally while every other request goes to the real server.
 * It was on an origin of its own first, with CORS_ORIGIN pointed at it, and
 * Chrome refused every call: a page on a public-looking origin may not reach
 * `loopback` from an insecure context (Private Network Access), which is a
 * browser rule no server header can waive. Same origin, no CORS, no PNA — and
 * it is also what the real page does, since Forge serves its own API.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('chatattbrowser');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'Chat-Browser-11!';
const ROOT = path.join(os.homedir(), '.zvky-test-chat-uploads', 'browser');
/* The one path the fixture answers on. Anything else on this origin is the real
   server, which is the point. */
const FIXTURE_PATH = '/__chat-attachment-fixture';

function lift(name) {
  const m = PAGE.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)\\n}\\n`));
  assert.ok(m, `public/index.html has no ${name}`);
  return `function ${name}(${m[1]}\n}`;
}
function liftAsync(name) {
  const m = PAGE.match(new RegExp(`\\nasync function ${name}\\(([\\s\\S]*?)\\n}\\n`));
  assert.ok(m, `public/index.html has no async ${name}`);
  return `async function ${name}(${m[1]}\n}`;
}

function fixture(base, token) {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');
  return `<!doctype html><html><head><meta charset="UTF-8"><style>${css}</style></head>
<body><div id="thread"></div>
<script>
const API_BASE = ${JSON.stringify(base)};
const state = { token: ${JSON.stringify(token)} };
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const chatState = { blobs: new Map(), limits: { hours: 12 } };
function fmtBytes(n){ return n + ' B'; }
${lift('chatSize')}
${lift('chatExpiryLabel')}
${lift('chatDownloadButton')}
${lift('chatAttachmentsHTML')}
${lift('chatFileSentence')}
${liftAsync('loadChatAttachment')}

/* THE THREAD, PAINTED THE WAY THE PANEL PAINTS IT: the markup from the real
   renderer, then the loader on every attachment in it. */
window.__paint = (message) => {
  document.getElementById('thread').innerHTML = chatAttachmentsHTML(message);
  document.querySelectorAll('[data-attach]').forEach(loadChatAttachment);
};
window.__text = () => document.getElementById('thread').textContent.replace(/\\s+/g, ' ').trim();
window.__ready = true;
</script></body></html>`;
}

test('what somebody sees when an attachment does not arrive', { skip: SKIP }, async (t) => {
  let server;
  let browser;
  const tok = {};
  const ids = {};
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'attbrowser', CHAT_UPLOAD_DIR: ROOT,
      CHAT_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'attbrowser', name: 'Root', email: 'root@attb.test', password: PASSWORD } });
    tok.root = await login('root@attb.test');
    for (const [who, name] of [['ana', 'Ana'], ['bo', 'Bo'], ['cas', 'Cas']]) {
      const made = await api(server.base, '/users', { method: 'POST', token: tok.root,
        body: { name, email: `${who}@attb.test`, password: PASSWORD, role: 'game_artist' } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      ids[who] = made.body.user.id;
      tok[who] = await login(`${who}@attb.test`);
    }
    ids.conv = (await api(server.base, '/chat/direct',
      { method: 'POST', token: tok.ana, body: { userId: ids.bo } })).body.conversationId;
    browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  });
  t.after(async () => {
    if (browser) await browser.close();
    if (server) stopServer(server);
  });

  const upload = async (name) => {
    const form = new FormData();
    form.set('body', 'here it is');
    form.append('files',
      new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }), name);
    const res = await fetch(`${server.base}/chat/${ids.conv}/messages`,
      { method: 'POST', headers: { Authorization: `Bearer ${tok.ana}` }, body: form });
    const text = await res.text();
    assert.strictEqual(res.status, 201, text);
    return JSON.parse(text).message;
  };

  /* The message as the panel would have it, fetched back from the server so the
     shape is the server's and not this file's idea of it. */
  const messageFor = async (who, id) => {
    const r = await api(server.base, `/chat/${ids.conv}/messages`, { token: tok[who] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const found = r.body.messages.find((m) => m.id === id);
    assert.ok(found, `the message is in the thread for ${who}`);
    return found;
  };

  const open = async (who) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const origin = new URL(server.base).origin;
    await page.route(origin + FIXTURE_PATH, (route) => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8', body: fixture(server.base, tok[who]) }));
    await page.goto(origin + FIXTURE_PATH, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    return { page, errors };
  };

  await t.test('a file sent half an hour ago is there, with its countdown', async () => {
    const message = await upload('thirty-minutes.png');
    /* THIRTY MINUTES OF AGE, SIMULATED IN THE ONE PLACE AGE LIVES: the row. The
       clock is not touched, because the whole lesson of the first bug is that
       this application must never have two of them. */
    await sql(cfg,
      `UPDATE chat_attachments SET created_at = NOW() - INTERVAL 30 MINUTE,
              expires_at = NOW() + INTERVAL 11 HOUR + INTERVAL 30 MINUTE
        WHERE message_id = ?`, [message.id]);

    const { page, errors } = await open('bo');
    const shown = await messageFor('bo', message.id);
    await page.evaluate((m) => window.__paint(m), shown);
    await page.waitForFunction(() => !!document.querySelector('img[src^="blob:"]'), null,
      { timeout: 10000 });

    const text = await page.evaluate(() => window.__text());
    /* A PICTURE CARRIES ITS NAME IN alt, not in the text — the panel shows the
       image itself, and the name is what a screen reader reads and what the
       tooltip says. */
    assert.strictEqual(await page.getAttribute('img[data-attach]', 'alt'), 'thirty-minutes.png',
      'the file is named for anybody who cannot see it');
    assert.match(text, /Expires in 11h/, 'and the countdown says how long it has left');
    assert.ok(!/expired|missing|access/i.test(text), `nothing is wrong with it: ${text}`);
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('a RELOAD does not lose it — the bytes are outside the application folder',
    async () => {
    /* THE SECOND BUG, FROM THE USER'S SIDE. A second page, a second fetch, a
       second blob: nothing is cached between them, so this is the file being
       read from disk again. With the root inside the application folder, a
       deploy between these two loads is what the studio was living with. */
    const message = await upload('after-reload.png');
    const shown = await messageFor('bo', message.id);
    for (const pass of [1, 2]) {
      const { page } = await open('bo');
      await page.evaluate((m) => window.__paint(m), shown);
      await page.waitForFunction(() => !!document.querySelector('img[src^="blob:"]'), null,
        { timeout: 10000 });
      const text = await page.evaluate(() => window.__text());
      assert.ok(!/expired|missing/i.test(text), `pass ${pass}: still there (${text})`);
      await page.close();
    }
  });

  await t.test('once it has expired it says "attachment expired", and nothing else', async () => {
    const message = await upload('aged-out.png');
    await sql(cfg,
      'UPDATE chat_attachments SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE message_id = ?',
      [message.id]);
    const shown = await messageFor('bo', message.id);
    assert.strictEqual(shown.attachments[0].expired, true, 'the server says so');
    assert.strictEqual(shown.attachments[0].url, null, 'and offers no url');

    const { page, errors } = await open('bo');
    await page.evaluate((m) => window.__paint(m), shown);
    const text = await page.evaluate(() => window.__text());
    assert.match(text, /attachment expired/i);
    assert.match(text, /aged-out\.png/, 'and still says which file');
    assert.ok(!/missing on the server/i.test(text), 'and does not call it a fault');
    assert.strictEqual(await page.locator('img[data-attach]').count(), 0,
      'with nothing trying to load');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('a file taken off the disk says it is MISSING, not expired', async () => {
    const message = await upload('deleted-by-the-test.png');
    const row = (await sql(cfg,
      'SELECT stored_name AS s FROM chat_attachments WHERE message_id = ?', [message.id]))[0];
    const shown = await messageFor('bo', message.id);
    assert.strictEqual(shown.attachments[0].expired, false,
      'the row still says the file is live, which is the point');

    /* WHAT A DEPLOY DOES, in one line. */
    fs.rmSync(path.join(ROOT, row.s), { force: true });

    const { page, errors } = await open('bo');
    await page.evaluate((m) => window.__paint(m), shown);
    await page.waitForFunction(() => /missing/i.test(document.getElementById('thread').textContent),
      null, { timeout: 10000 });
    const text = await page.evaluate(() => window.__text());
    assert.match(text, /missing on the server/i);
    assert.match(text, /not expected/i);
    assert.match(text, /ask your admin/i);
    assert.ok(!/expired/i.test(text),
      `and never says expired, which is the whole point of this case: ${text}`);
    assert.match(await page.locator('.chat-file-fault').first().textContent(), /missing/i,
      'and it is marked as a fault rather than as an ordinary expiry');
    assert.deepStrictEqual(errors, []);
    await page.close();

    /* AND THE SERVER WROTE IT DOWN, so the next report arrives with evidence. */
    const inc = await sql(cfg,
      `SELECT detail FROM chat_file_incidents WHERE kind = 'missing_before_expiry'
        ORDER BY created_at DESC LIMIT 1`);
    assert.strictEqual(inc.length, 1);
    assert.match(inc[0].detail, /deleted-by-the-test\.png/);
  });

  await t.test('somebody who is not in the conversation is told that, and nothing more',
    async () => {
    const message = await upload('not-for-cas.png');
    const shown = await messageFor('bo', message.id);

    /* CAS'S OWN TOKEN, against a message Cas can see nothing of. The markup
       comes from the thread Bo can read, which is how a leaked link behaves:
       the id is known and the conversation is not theirs. */
    const { page, errors } = await open('cas');
    await page.evaluate((m) => window.__paint(m), shown);
    await page.waitForFunction(() => /access/i.test(document.getElementById('thread').textContent),
      null, { timeout: 10000 });
    const text = await page.evaluate(() => window.__text());
    assert.match(text, /do not have access/i);
    assert.ok(!/expired|missing on the server/i.test(text),
      `and is not dressed up as either of the others: ${text}`);
    assert.deepStrictEqual(errors, []);
    await page.close();
  });
});
