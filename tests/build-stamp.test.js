/* WHAT IS RUNNING, AND IS THE PAGE IN FRONT OF SOMEBODY THE ONE WE SENT?
 *
 * THE FOURTH REPORT OF THE HOLD BUTTON COULD NOT ANSWER EITHER QUESTION, which
 * is why this exists. The report arrived as "Prompt 36 did not resolve it in
 * practice", and before any code could be looked at there were three
 * explanations to tell apart:
 *
 *   the fix is wrong                 (it was)
 *   the fix is not deployed          (unknowable: no version anywhere)
 *   the browser has the old page      (unknowable: no stamp to compare)
 *
 * package.json has read 1.0.0 since the first commit and nothing surfaced it.
 *
 * ---------------------------------------------------------------------------
 * THE STAMP IS COMPUTED, NEVER WRITTEN DOWN. This project has no build step —
 * package.json says so in as many words — so a stamp a human or a script has to
 * remember to bump is a stamp that is wrong exactly when it matters. It is a
 * hash of public/index.html's own bytes, so it cannot be stale.
 *
 * AND THE PAGE REPORTS ITS OWN, not the server's. That is the whole design and
 * the easy thing to get wrong: fetching the version and printing it prints what
 * the server would send NOW, which on a stale page is the one number that is not
 * running. The stamp is injected into the HTML as it is served, so it travels
 * with the page; comparing the two is what detects staleness, and nothing else
 * can.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const buildInfo = require('../src/build-info');
const themeDelivery = require('../src/theme-delivery');
const { config, resetSchema, startServer, stopServer, api, raw, SKIP_REASON } = require('./helpers');

const cfg = config('buildstamp');
const PAGE_PATH = path.join(__dirname, '..', 'public', 'index.html');
const PAGE = fs.readFileSync(PAGE_PATH, 'utf8');

test('the stamp is derived from the page, so it cannot be stale', () => {
  const expected = crypto.createHash('sha256')
    .update(fs.readFileSync(PAGE_PATH)).digest('hex').slice(0, 12);
  assert.strictEqual(buildInfo.pageStamp(), expected,
    'the stamp is the first twelve hex digits of a SHA-256 over the page');
  assert.match(buildInfo.pageStamp(), /^[0-9a-f]{12}$/);

  /* MEMOISED ON mtime AND size — the same pair src/theme-delivery.js keys its
     cache on. mtime alone is not enough on a host whose copy tool flattens
     timestamps; size alone misses an edit that keeps the length. */
  assert.strictEqual(buildInfo.pageStamp(), expected, 'and the second call agrees');

  const current = buildInfo.current();
  assert.strictEqual(current.page, expected);
  assert.strictEqual(current.version, require('../package.json').version);
  assert.match(current.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(current.node, process.version);
  /* The commit is present in a git checkout and null on a zip deployment, which
     is this project's documented path — hence the hash above, which works
     there. Either is valid; a string that is not a hash is not. */
  if (current.commit !== null) assert.match(current.commit, /^[0-9a-f]{7,40}$/);
});

test('a changed page changes the stamp', () => {
  /* THE PROPERTY THAT MAKES IT USEFUL, asserted rather than assumed: the whole
     point is that a deploy moves this number without anybody doing anything. */
  const before = buildInfo.pageStamp();
  const tmp = path.join(require('node:os').tmpdir(), `zvky-stamp-${process.pid}.html`);
  fs.writeFileSync(tmp, `${PAGE}\n<!-- one more byte -->`);
  try {
    const other = crypto.createHash('sha256')
      .update(fs.readFileSync(tmp)).digest('hex').slice(0, 12);
    assert.notStrictEqual(other, before, 'one byte is enough');
  } finally { fs.unlinkSync(tmp); }
});

test('the page carries the marker the stamp is injected into', () => {
  assert.ok(PAGE.includes(themeDelivery.STAMP_MARKER),
    'public/index.html has no <!-- BUILD:STAMP --> marker');
  /* IN THE HEAD, before anything that could fail. A <meta> rather than a script:
     nothing has to run for it to be readable, so it survives a JavaScript error
     early in the page — which is one of the states somebody would be reporting. */
  const at = PAGE.indexOf(themeDelivery.STAMP_MARKER);
  assert.ok(at < PAGE.indexOf('</head>'), 'and it is in the head');
  assert.ok(at > 0 && at < 2000, 'near the top, before the stylesheet');

  const rendered = themeDelivery.render({ now: true });
  assert.ok(rendered, 'the page renders');
  assert.ok(rendered.html.includes(`<meta name="zvky-build" content="${buildInfo.pageStamp()}">`),
    'the rendered page reports its own hash');
  assert.ok(rendered.html.includes('<meta name="zvky-version"'),
    'and the version a human reads');
  assert.ok(!rendered.html.includes(themeDelivery.STAMP_MARKER),
    'and the marker is consumed, not left beside it');
  assert.strictEqual(rendered.stamp, buildInfo.pageStamp());
});

test('the page compares its own stamp with the server\'s, not the other way round', () => {
  /* THE MISTAKE THIS ASSERTION EXISTS TO PREVENT. Reading the version from
     /api/version and printing it would print the server's — which is right on a
     fresh page and useless on a stale one, the only case the stamp is for. The
     page's own value has to come out of the document. */
  assert.match(PAGE, /meta\[name="\$\{n\}"\]/,
    'the page reads its stamp out of its own <meta>');
  assert.match(PAGE, /BUILD_SERVER\.page !== BUILD\.page/,
    'and staleness is its own stamp disagreeing with the server\'s');
  assert.match(PAGE, /this page is out of date/,
    'and it says so in words');
  assert.match(PAGE, /id="buildReload"/, 'with a reload beside it');
  /* fetch(), not the page's api() helper: that one prefixes /api, attaches the
     token and treats a non-JSON answer as a dead backend — and this call has to
     work with no session, which is a state a stale page may well be in. */
  const at = PAGE.indexOf('async function refreshBuildStamp()');
  assert.ok(at !== -1);
  const body = PAGE.slice(at, at + 700);
  assert.match(body, /fetch\('\/api\/version', \{ cache:'no-store' \}\)/);
  /* Comments stripped: the note beside the fetch says "NO api() HERE", and
     naming the thing it is not using is the point of the note. */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bapi\(/.test(code), 'and not through the authenticated helper');
});

test('every served file that changes behaviour is revalidated', () => {
  /* THE CACHE SITUATION, PINNED. express.static's own default for these files is
     `public, max-age=0`, which does revalidate — but `public` lets any proxy
     between the studio and this process keep a copy, and this application is
     deployed behind cPanel on shared hosting whose caching is not ours to
     inspect. A lead on a page cached by something in the middle would go on
     seeing the previous build's behaviour however many times we fixed it, which
     is one of the three explanations the fourth report had to rule out.
     
     `no-cache` is not "do not store": the copy is kept and revalidated, so the
     common answer is still a 304 with no body. */
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /const REVALIDATE = \/\\\.\(\?:html\|js\|mjs\|css\|webmanifest\)\$\/i;/,
    'the extensions whose staleness changes behaviour');
  assert.match(server, /res\.setHeader\('Cache-Control', 'no-cache'\)/);
  const delivery = fs.readFileSync(path.join(__dirname, '..', 'src', 'theme-delivery.js'), 'utf8');
  assert.match(delivery, /res\.setHeader\('Cache-Control', 'no-cache'\)/,
    'and the HTML itself, which goes out through the theme middleware');
  /* THE PAGE'S HASH IS IN THE ETag. Without it a deploy that changes the HTML
     but not the theme keeps the old tag, and a browser holding the previous page
     is told 304 and goes on running it — which is the exact failure the stamp
     exists to make visible. */
  assert.match(delivery, /page-\$\{Buffer\.byteLength\(rendered\.html\)\}-\$\{rendered\.version\}-\$\{rendered\.stamp\}/);

  // And there is no service worker to hold a copy of its own.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'sw.js')));
  assert.ok(!/serviceWorker/.test(PAGE), 'nothing registers one');
});

test('against a live server', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'bs' });
  });
  t.after(async () => { if (server) await stopServer(server); });

  const site = () => server.base.replace(/\/api$/, '');

  await t.test('GET /api/version answers without a session', async () => {
    /* UNAUTHENTICATED ON PURPOSE. A build identifier is not a secret: it is a
       hash of a file every visitor already downloads in full, and a version
       string. Behind a login it would be useless for the one case it is for —
       somebody on a stale page, which is a page that may not be able to log in. */
    const r = await api(server.base, '/version');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.page, buildInfo.pageStamp());
    assert.strictEqual(r.body.version, require('../package.json').version);
    assert.ok(r.body.startedAt, 'and when this process came up');
    /* NOTHING ELSE. It names no table, no column and no path, unlike
       /api/health/errors next door which is authenticated for exactly that
       reason. */
    assert.deepStrictEqual(Object.keys(r.body).sort(),
      ['commit', 'node', 'page', 'startedAt', 'version']);
  });

  await t.test('the page arrives carrying its own stamp', async () => {
    const page = await raw(site(), '/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes(`<meta name="zvky-build" content="${buildInfo.pageStamp()}">`),
      'injected as it was served');
    assert.ok(!page.text.includes('<!-- BUILD:STAMP -->'), 'and the marker is gone');
  });

  await t.test('the page is revalidated, and its ETag moves with the page', async () => {
    const res = await fetch(`${site()}/`);
    assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
    const etag = res.headers.get('etag');
    assert.ok(etag, 'an ETag is sent');
    assert.ok(etag.includes(buildInfo.pageStamp()),
      'and it carries the page hash, so a changed page cannot be answered 304');
    const again = await fetch(`${site()}/`, { headers: { 'If-None-Match': etag } });
    assert.strictEqual(again.status, 304, 'an unchanged page is one cheap 304');
  });

  await t.test('the served scripts are revalidated too', async () => {
    const res = await fetch(`${site()}/native-bridge.js`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-cache',
      'a stale script is a stale behaviour, same as a stale page');
  });

  await t.test('/api/health says what is running, as well as whether it is well', async () => {
    const r = await api(server.base, '/health');
    assert.ok([200, 503].includes(r.status), JSON.stringify(r.body));
    if (r.status === 200) {
      assert.strictEqual(r.body.build.page, buildInfo.pageStamp(),
        'one URL answers both questions');
      assert.strictEqual(r.body.build.version, require('../package.json').version);
    }
  });
});
