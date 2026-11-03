/* WHY "Download timesheets" NEVER APPEARED, AND THE TWO THINGS THAT HID IT.
 *
 * ===========================================================================
 * THE REPORT. Prompt 62 added the permission `timesheet.export`; it showed up
 * in Settings → Permissions, and the Time Sheet tab had no button.
 *
 * ROOT CAUSE 1 — THE BUTTON WAS NEVER WRITTEN. Prompt 62 built the whole server
 * half (the row query, the workbook writer, /api/timesheet/export, the key, the
 * studio switch, the audit line) and stopped before public/index.html. The page
 * contained no occurrence of the id, the key, the modal or the route, so there
 * was nothing on the screen to be hidden by anything — not a permission that
 * failed to resolve, not a stale role record, not a cached page. Measured
 * before the fix:
 *
 *     $ grep -c "timesheet-export-btn\|Download timesheets\|timesheet/export" public/index.html
 *     0
 *     $ grep -n "timesheet.export" public/index.html
 *     (nothing)
 *
 * The first block below is the regression test for that, and it is deliberately
 * a test of the SHIPPED FILE rather than of a fixture: the bug was an absence
 * in public/index.html, so only a test that reads public/index.html can fail
 * for it. Every assertion in it fails if the button, its id, its two conditions,
 * its wiring or its modal is removed.
 *
 * ROOT CAUSE 2 — AND IT WOULD HAVE HIDDEN THE BUTTON AGAIN A DAY LATER.
 * src/timesheet-settings.js save() writes `v.exportEnabled ? 1 : 0`, and
 * validate() never put exportEnabled into `value`. So every save of the Time
 * Sheet options screen — a change to the day cap, a loggable day, anything —
 * wrote 0 to export_enabled and switched the studio's download off. A fresh
 * installation was fine, because the column defaults to 1; the first press of
 * Save broke it, silently, with no entry in the audit line to say so. The
 * second block is the regression test for that one.
 *
 * WHAT WAS NOT WRONG, checked before anything was changed and pinned here so
 * the next person does not re-investigate it:
 *   · Super Admin cannot be missing a catalogue key. effectiveFor() returns the
 *     whole catalogue for any super_admin-tier role, before it reads a single
 *     stored row.
 *   · A role written to role_permissions before the key existed does not hide
 *     it either: topUpRole() INSERT IGNOREs the new key's default.
 *   · The page is served `Cache-Control: no-cache`, so no browser cache clear
 *     is involved — see tests/build-stamp.test.js.
 * The third block proves the first two of those against the database.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const WEEK_ROUTE = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'timesheets.js'), 'utf8');

const cfg = config('tsexportbtn');
const PASSWORD = 'Export-Button-1!';

/* The one function the button lives in, cut out of the page so an assertion
   about "the Timesheet tab's header" cannot accidentally be satisfied by
   another tab's markup. */
function timesheetRender() {
  const from = PAGE.indexOf('async function renderTimesheet(){');
  assert.ok(from !== -1, 'renderTimesheet is in the page');
  const to = PAGE.indexOf('\nfunction wireTimesheet(', from);
  assert.ok(to > from, 'and wireTimesheet follows it');
  return PAGE.slice(from, to);
}

/* ---- root cause 1: the button is in the shipped page -------------------- */

test('the Timesheet tab renders the download button, gated and wired', () => {
  const render = timesheetRender();

  /* THE ID THE BRIEF ASKS FOR, exactly once in the whole file: a second one
     would mean two buttons and a browser test that passed on the wrong one. */
  assert.strictEqual((PAGE.match(/id="timesheet-export-btn"/g) || []).length, 1,
    'one button with the stable id');
  assert.ok(render.includes('id="timesheet-export-btn"'),
    'and it is inside renderTimesheet, not some other screen');

  /* IN THE HEADER BAR, WHICH IS THE WHOLE OF THE FIX. The .ts-bar is drawn once
     per render for every state the tab has, so a button in it is a button in
     all of them: your own week, somebody else's through the picker, any week,
     an empty week, a submitted and locked day. Asserted by position rather than
     by eye — the button must come after the bar opens and before it closes. */
  const bar = render.indexOf('<div class="ts-bar">');
  const week = render.indexOf('<div class="ts-week">');
  const button = render.indexOf('id="timesheet-export-btn"');
  assert.ok(bar !== -1 && week > bar, 'the bar is drawn, then the days');
  assert.ok(button > bar && button < week,
    'the button is in the header bar and not inside the day cards');

  /* BOTH CONDITIONS, AND NOTHING ELSE. The studio's switch, published with the
     week's policy, and the permission. `!== false` rather than a truth test, so
     a backend that has not been restarted and sends no such field still shows
     the button to the roles that hold the key — the endpoint refuses if the
     switch really is off, which is the honest failure. */
  const gate = render.slice(Math.max(0, button - 400), button);
  assert.match(gate, /wd\.exportEnabled !== false/, 'the studio switch');
  assert.match(gate, /can\('timesheet\.export'\)/, 'and the permission');

  /* NOT GATED ON ANYTHING TO DO WITH A SUB-VIEW OR A PERSON. A condition on
     tsState.userId or on week.mayEdit is how a button comes back in one state
     of a tab and not another. */
  assert.ok(!/tsState\.userId|mayEdit|day\.locked/.test(gate),
    'and on nothing about which week or whose week is open');

  /* WIRED. A rendered button with no handler is the same bug one step later. */
  const wire = PAGE.slice(PAGE.indexOf('\nfunction wireTimesheet('));
  const wired = wire.slice(0, wire.indexOf('\nconst TS_STATUS'));
  assert.match(wired, /querySelector\('#timesheet-export-btn'\)/, 'wireTimesheet finds it');
  assert.match(wired, /openTimesheetExport\(\)/, 'and opens the modal');

  /* AND THE MODAL IT OPENS EXISTS, in the static markup with the three ids the
     page's own wiring reaches for — getElementById throws on none of them. */
  for (const id of ['tsExportWrap', 'tsExportBody', 'tsExportCancel', 'tsExportGo']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} is in the page`);
  }
  assert.match(PAGE, /getElementById\('tsExportCancel'\)\.addEventListener/);
  assert.match(PAGE, /getElementById\('tsExportGo'\)\.addEventListener/);

  /* THE MODAL TALKS TO THE ROUTES PROMPT 62 BUILT, rather than to a second
     copy of them. */
  assert.match(PAGE, /\/timesheet\/export\/count\?/, 'the count line');
  assert.match(PAGE, /\/timesheet\/export\?/, 'and the download');
  /* THROUGH THE SHARED TRANSPORT. The Artist Report's download is the one that
     carries the Prompt 54 lesson about handing bytes over untouched; a second
     fetch here would be a second chance to lose it. */
  assert.match(PAGE, /await downloadAuthed\(`\/timesheet\/export\?\$\{want\.query\}`, \{ rethrow: true \}\)/,
    'the download goes through downloadAuthed, not a fetch of its own');
  assert.strictEqual((PAGE.match(/async function downloadAuthed/g) || []).length, 1,
    'and there is still only one of those');

  /* THE SENTENCE THE BRIEF ASKS FOR, for somebody who holds the key and can see
     nobody else. Pinned on the words because that is what the studio reads. */
  assert.match(PAGE, /You can only download timesheets you are\s+allowed to view/,
    'the only-your-own message');

  /* AND THE SERVER PUBLISHES THE SWITCH WITH THE WEEK, which is what spares the
     tab a second request on every visit. */
  assert.match(WEEK_ROUTE, /exportEnabled: policy\(\)\.exportEnabled/,
    'the week payload carries the studio switch');
});

/* The Super Admin switch that turns it off for everybody, which is the other
   half of the condition above and was missing from the page too. */
test('Settings → Time Sheet has the download switch, and the form sends it', () => {
  assert.ok(PAGE.includes('<h4>Timesheet report download</h4>'), 'the switch has a heading');
  assert.strictEqual((PAGE.match(/id="tso_exportEnabled"/g) || []).length, 1);
  assert.match(PAGE, /exportEnabled: document\.getElementById\('tso_exportEnabled'\)\.checked/,
    'and Save sends it — see root cause 2 for what an unsent boolean does');
});

/* ---- the server ---------------------------------------------------------- */

test('the download button’s two conditions, against the real server',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    let server;
    const token = {};
    const people = {};
    const call = (p, o) => api(server.base, p, o);
    const as = (who, p, o = {}) => call(p, { ...o, token: token[who] });
    const MON = '2026-03-02';

    t.before(async () => {
      await resetSchema(cfg);
      server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'teb-token' });
      await call('/auth/bootstrap', { method: 'POST',
        body: { token: 'teb-token', name: 'Root', email: 'root@teb.test', password: PASSWORD } });
      const login = async (email) => (await call('/auth/login', {
        method: 'POST', body: { email, password: PASSWORD } })).body.token;
      token.root = await login('root@teb.test');
      await openStudio(server.base, token.root);

      const clientId = (await as('root', '/clients')).body.clients[0].id;
      const projectId = (await as('root', '/projects', { method: 'POST',
        body: { clientId, name: 'Button Test' } })).body.project.id;
      for (const [who, role] of [['lee', 'team_lead'], ['ana', 'game_artist']]) {
        const made = await as('root', '/users', { method: 'POST',
          body: { name: who, email: `${who}@teb.test`, role, password: PASSWORD, projectId } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        people[who] = made.body.user.id;
        token[who] = await login(`${who}@teb.test`);
      }
      await as('root', `/users/${people.ana}`, { method: 'PATCH',
        body: { reportsToId: people.lee, teamLeadId: people.lee } });
    });
    t.after(() => stopServer(server));

    const policy = async (who) =>
      (await as(who, `/timesheets/week?date=${MON}`)).body.workingDay;

    await t.test('the week payload says the download is on, by default', async () => {
      /* THE DEFAULT IS ON AND NOBODY HAS SAVED ANYTHING YET, which is the state
         a studio upgrading into this feature is in. The page draws the button
         from this field and the permission; if this came back false or absent,
         the button would be missing on a fresh installation. */
      assert.strictEqual((await policy('root')).exportEnabled, true);
      assert.strictEqual((await policy('ana')).exportEnabled, true,
        'the same answer for somebody who does not hold the key — it is the studio’s switch, '
        + 'not the viewer’s');
    });

    await t.test('Super Admin holds timesheet.export, stored rows or not', async () => {
      const me = await as('root', '/auth/me');
      assert.ok(me.body.user.permissions.includes('timesheet.export'),
        JSON.stringify(me.body.user.permissions.filter((k) => k.startsWith('timesheet'))));

      /* AND IT SURVIVES A STORED RECORD FOR THE ROLE. This is the thing the
         report suspected: a super_admin row in role_permissions written before
         the key existed, hiding it. It cannot — effectiveFor() returns the whole
         catalogue for a super_admin-tier role before it reads a stored row — and
         this is the test that says so, by writing exactly that row. */
      await sql(cfg,
        `INSERT INTO role_permissions (role_key, permission_key, enabled)
         VALUES ('super_admin', 'timesheet.own', 1)
         ON DUPLICATE KEY UPDATE enabled = 1`);
      const again = await as('root', '/auth/me');
      assert.ok(again.body.user.permissions.includes('timesheet.export'),
        'a stored super_admin record does not narrow the catalogue');
    });

    await t.test('a granted role gets the key; an ungranted one does not', async () => {
      const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      assert.ok(!held.includes('timesheet.export'), 'a lead does not hold it by default');
      await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: [...held, 'timesheet.export'] } });

      const lee = await as('lee', '/auth/me');
      assert.ok(lee.body.user.permissions.includes('timesheet.export'));
      const ana = await as('ana', '/auth/me');
      assert.ok(!ana.body.user.permissions.includes('timesheet.export'),
        'and an artist still does not');
    });

    await t.test('the count never exceeds what the asker may see', async () => {
      /* Two submitted days: Ana's and Lee's. Lee leads Ana, so Lee's count
         covers both; Ana, granted the key but holding neither timesheet.team
         nor timesheet.all, counts only her own — which is the case the brief
         names, and the reason the modal has a sentence for it. */
      const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      await as('root', '/permissions/roles/game_artist', { method: 'PUT',
        body: { permissions: [...held, 'timesheet.export'] } });

      for (const who of ['ana', 'lee']) {
        const line = await as(who, '/timesheets/entries', { method: 'POST',
          body: { date: MON, hours: 2, nonProject: 'admin' } });
        assert.strictEqual(line.status, 201, JSON.stringify(line.body));
        const sent = await as(who, '/timesheets/submit', { method: 'POST', body: { date: MON } });
        assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
      }

      const count = async (who, extra = '') => {
        const got = await as(who, `/timesheet/export/count?from=${MON}&to=${MON}${extra}`);
        assert.strictEqual(got.status, 200, `${who}: ${JSON.stringify(got.body)}`);
        return got.body;
      };
      assert.deepStrictEqual(
        { lines: (await count('ana')).lines, people: (await count('ana')).people },
        { lines: 1, people: 1 }, 'her own day only');
      assert.strictEqual((await count('lee')).people, 2, 'Lee sees her team and herself');

      /* ASKING FOR SOMEBODY ELSE BY ID DOES NOT WIDEN IT. The id is dropped,
         silently, and the count falls to nought rather than to Lee's day —
         src/timesheet-export.js rowsFor() explains why it is silent. */
      assert.deepStrictEqual((await count('ana', `&users=${people.lee}`)),
        { lines: 0, people: 0, from: MON, to: MON, cap: 100000 });
    });

    /* ---- root cause 2 -------------------------------------------------- */

    await t.test('saving the Time Sheet options does not switch the download off', async () => {
      /* THE REGRESSION TEST FOR ROOT CAUSE 2. Save the screen with the switch
         ticked and change something else entirely; the download must still be
         on, and the button must still be in the week's policy. Before the fix
         this wrote 0 and the button vanished for the whole studio. */
      const before = (await as('root', '/admin/settings/timesheet')).body.settings;
      assert.strictEqual(before.exportEnabled, true);
      const saved = await as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: {
          maxDayHours: 9,
          minLineHours: before.minLineHours,
          maxLineHours: before.maxLineHours,
          backdateDays: before.backdateDays === null ? '' : before.backdateDays,
          futureDays: before.futureDays === null ? '' : before.futureDays,
          loggableDays: before.loggableDays,
          requirePreviousDay: before.requirePreviousDay,
          tlAction: before.tlAction,
          exportEnabled: true,
        } });
      assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
      assert.strictEqual(saved.body.settings.maxDayHours, 9, 'the unrelated change landed');
      assert.strictEqual(saved.body.settings.exportEnabled, true,
        'and the download is still on');
      assert.strictEqual((await policy('root')).exportEnabled, true,
        'which is what the tab reads to draw the button');
      assert.strictEqual((await as('root',
        `/timesheet/export/count?from=${MON}&to=${MON}`)).status, 200);
    });

    await t.test('and a Super Admin can still turn it off on purpose', async () => {
      const before = (await as('root', '/admin/settings/timesheet')).body.settings;
      const off = await as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: {
          maxDayHours: before.maxDayHours,
          minLineHours: before.minLineHours,
          maxLineHours: before.maxLineHours,
          backdateDays: before.backdateDays === null ? '' : before.backdateDays,
          futureDays: before.futureDays === null ? '' : before.futureDays,
          loggableDays: before.loggableDays,
          requirePreviousDay: before.requirePreviousDay,
          tlAction: before.tlAction,
          exportEnabled: false,
        } });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      assert.strictEqual(off.body.settings.exportEnabled, false);
      /* The page stops drawing the button... */
      assert.strictEqual((await policy('root')).exportEnabled, false);
      /* ...and the endpoint refuses even the Super Admin, which is what makes
         the hiding a courtesy rather than the rule. */
      const refused = await as('root', `/timesheet/export?from=${MON}&to=${MON}`);
      assert.strictEqual(refused.status, 403);
      assert.strictEqual(refused.body.code, 'export_disabled');

      // Back on, so this suite leaves the studio as it found it.
      await as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: { ...off.body.settings, backdateDays: '', futureDays: '', exportEnabled: true } });
      assert.strictEqual((await policy('root')).exportEnabled, true);
    });

    await t.test('the audit line names the switch', async () => {
      /* A change to this switch has to be findable afterwards: it is the one
         setting on that screen that makes everybody's hours downloadable. */
      const log = (await as('root', '/activity?module=settings&limit=20')).body;
      const entries = (log.entries || log.items || []).filter(
        (e) => e.action === 'timesheet.options_updated');
      assert.ok(entries.length, 'the saves above were logged');
      assert.ok(entries.some((e) => /timesheet download (on|off)/.test(e.summary || '')),
        entries.map((e) => e.summary).join(' | '));
    });
  });
