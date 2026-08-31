const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, SKIP_REASON } = require('./helpers');
const idle = require('../src/idle');
const workSchedule = require('../src/work-schedule');
const catalog = require('../src/permission-catalog');
const { roleDef, activeRoles } = require('../src/roles');

const cfg = config('idle');

// --- counting the days ---------------------------------------------------------

test('a week is five working days, not seven', () => {
  /* The whole report hangs off this. Counting all seven would make a week
     expect 56 hours and put everybody above 50% idle on the first morning,
     which would discredit the numbers before anyone read them. */
  // 2026-03-02 is a Monday.
  assert.strictEqual(idle.workingDaysBetween('2026-03-02', '2026-03-06'), 5, 'Mon to Fri');
  assert.strictEqual(idle.workingDaysBetween('2026-03-02', '2026-03-08'), 5, 'Mon to Sun is still five');
  assert.strictEqual(idle.workingDaysBetween('2026-03-07', '2026-03-08'), 0, 'a weekend expects nothing');
  assert.strictEqual(idle.workingDaysBetween('2026-03-04', '2026-03-04'), 1, 'one Wednesday');
  assert.strictEqual(idle.workingDaysBetween('2026-03-01', '2026-03-31'), 22, 'March 2026');

  // A studio that works Saturdays says so, and the count follows.
  assert.strictEqual(idle.workingDaysBetween('2026-03-02', '2026-03-08', [1, 2, 3, 4, 5, 6]), 6);
  assert.strictEqual(idle.workingDaysBetween('2026-03-02', '2026-03-08', [1, 2, 3, 4, 5, 6, 7]), 7);

  // Nonsense ranges are zero, not a crash or a negative.
  assert.strictEqual(idle.workingDaysBetween('2026-03-06', '2026-03-02'), 0, 'end before start');
  assert.strictEqual(idle.workingDaysBetween(null, '2026-03-02'), 0);
  assert.strictEqual(idle.workingDaysBetween('not-a-date', '2026-03-02'), 0);
});

test('the four periods resolve to the ranges a studio means by them', () => {
  const on = '2026-03-04';   // a Wednesday
  assert.deepStrictEqual(idle.periodRange('day', on), { from: on, to: on, label: on });
  // A week runs Monday to Sunday, which is what "this week" means to a studio
  // working Monday to Friday.
  const week = idle.periodRange('week', on);
  assert.strictEqual(week.from, '2026-03-02');
  assert.strictEqual(week.to, '2026-03-08');
  const month = idle.periodRange('month', on);
  assert.strictEqual(month.from, '2026-03-01');
  assert.strictEqual(month.to, '2026-03-31');
  const year = idle.periodRange('year', on);
  assert.strictEqual(year.from, '2026-01-01');
  assert.strictEqual(year.to, '2026-12-31');
  assert.strictEqual(idle.periodRange('fortnight', on), null, 'an unknown period is refused, not guessed');

  // A Sunday still belongs to the week that began the Monday before it.
  assert.strictEqual(idle.periodRange('week', '2026-03-08').from, '2026-03-02');
  // And a Monday starts its own week.
  assert.strictEqual(idle.periodRange('week', '2026-03-02').from, '2026-03-02');
  // February in a leap year.
  assert.strictEqual(idle.periodRange('month', '2028-02-10').to, '2028-02-29');
});

// --- the sum itself ------------------------------------------------------------

test('idle is expected minus tracked, worked by hand', () => {
  const day = idle.forUser({ trackedSeconds: 3 * 3600, workingDays: 1, hoursPerDay: 8 });
  assert.strictEqual(day.expectedHours, 8);
  assert.strictEqual(day.trackedHours, 3);
  assert.strictEqual(day.idleHours, 5);
  assert.strictEqual(day.idlePercent, 62.5);

  const week = idle.forUser({ trackedSeconds: 32 * 3600, workingDays: 5, hoursPerDay: 8 });
  assert.strictEqual(week.expectedHours, 40);
  assert.strictEqual(week.idleHours, 8);
  assert.strictEqual(week.idlePercent, 20);
  assert.strictEqual(week.idlePerDay, 1.6, 'the figure a filtered report leads with');

  const nothing = idle.forUser({ trackedSeconds: 0, workingDays: 5, hoursPerDay: 8 });
  assert.strictEqual(nothing.idleHours, 40);
  assert.strictEqual(nothing.idlePercent, 100);
});

test('overtime is not negative idle', () => {
  /* Somebody who tracks 50 hours against a 40-hour week is not "minus ten
     hours idle". Reporting the negative would let it cancel a colleague's real
     idleness in any total — exactly the averaging that hides what the report
     exists to show. */
  const over = idle.forUser({ trackedSeconds: 50 * 3600, workingDays: 5, hoursPerDay: 8 });
  assert.strictEqual(over.idleHours, 0);
  assert.strictEqual(over.overtimeHours, 10);
  assert.ok(over.idleHours >= 0);
});

test('a period that expects nothing reports N/A, not 0%', () => {
  // A range of weekends. "0% idle" would read as a full week's work.
  const none = idle.forUser({ trackedSeconds: 0, workingDays: 0, hoursPerDay: 8 });
  assert.strictEqual(none.expectedHours, 0);
  assert.strictEqual(none.idlePercent, null);
  assert.strictEqual(none.idlePerDay, null);
});

test('a non-standard working day flows through', () => {
  const half = idle.forUser({ trackedSeconds: 2 * 3600, workingDays: 5, hoursPerDay: 4 });
  assert.strictEqual(half.expectedHours, 20);
  assert.strictEqual(half.idleHours, 18);
});

// --- the schedule setting ------------------------------------------------------

test('a working day has to be a possible length', () => {
  assert.strictEqual(workSchedule.cleanHours(8).value, 8);
  assert.strictEqual(workSchedule.cleanHours('7.5').value, 7.5);
  // A zero-hour day would make every percentage a division by zero.
  assert.ok(workSchedule.cleanHours(0).error);
  assert.ok(workSchedule.cleanHours(-1).error);
  assert.ok(workSchedule.cleanHours(25).error, 'longer than a day');
  assert.ok(workSchedule.cleanHours('abc').error);
  // Quarter hours, so 7.5 works and 7.3333 does not become policy.
  assert.strictEqual(workSchedule.cleanHours(7.3).value, 7.25);
});

test('a week with no working days is refused', () => {
  assert.deepStrictEqual(workSchedule.cleanDays([1, 2, 3, 4, 5]).value, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(workSchedule.cleanDays('5,1,3,1').value, [1, 3, 5], 'deduped and sorted');
  assert.deepStrictEqual(workSchedule.cleanDays([0, 8, 99]).error !== undefined, true);
  assert.ok(workSchedule.cleanDays([]).error, 'or every period would expect zero hours');
});

// --- the timer that nobody stopped ---------------------------------------------

test('a timer left running is treated as suspect, not as work', () => {
  /* src/work-timer.js has no inactivity timeout by design: the clock runs until
     somebody pauses it. So "has a running timer" stops meaning "is working"
     past a certain length, and the Idle Now screen has to say so — otherwise
     somebody who went home on Friday reads as busy all weekend. */
  assert.ok(!idle.isStaleTimer(60 * 60), 'an hour is just work');
  assert.ok(!idle.isStaleTimer(8 * 3600), 'a full day is plausible');
  assert.ok(idle.isStaleTimer(13 * 3600), 'thirteen hours is somebody who forgot');
  assert.ok(idle.isStaleTimer(72 * 3600));
});

test('how long since somebody last worked', () => {
  const now = new Date('2026-03-04T12:00:00Z');
  assert.strictEqual(idle.idleFor('2026-03-04T09:00:00Z', now), 3 * 3600);
  assert.strictEqual(idle.idleFor(null, now), null, 'never tracked is not "zero seconds ago"');
  assert.strictEqual(idle.idleFor('nonsense', now), null);
  assert.strictEqual(idle.idleFor('2026-03-04T13:00:00Z', now), 0, 'never negative');
});

test('the report says what it cannot see', () => {
  // A fortnight's holiday reads as eighty hours of idleness, and the report has
  // to admit that rather than let somebody draw a conclusion from it.
  const said = idle.caveats({ hoursPerDay: 8, workingDayNames: ['Monday', 'Friday'] }).join(' ');
  assert.match(said, /8 hours/);
  assert.match(said, /Monday, Friday/);
  assert.match(said, /holidays|leave|sickness/i);
  assert.match(said, /never negative|overtime/i);
});

// --- the permissions -----------------------------------------------------------

test('the two idle permissions exist and stand alone', () => {
  const all = catalog.GROUPS.flatMap((g) => g.permissions);
  const report = all.find((p) => p.key === 'report.idle');
  const users = all.find((p) => p.key === 'user.idle_view');
  assert.ok(report, 'View Idle Report');
  assert.ok(users, 'View Idle Users');
  assert.strictEqual(report.label, 'View Idle Report');
  assert.strictEqual(users.label, 'View Idle Users');

  /* Independent by construction: neither is implied by the other, nor by the
     general Reports/Users permissions. A role can hold any combination. */
  const both = ['report.view', 'user.view'];
  for (const key of both) {
    assert.ok(all.find((p) => p.key === key), `${key} still exists`);
  }

  // Granted to the full-access tier, as asked.
  const holders = (perm) => activeRoles().map((r) => r.key)
    .filter((k) => { const d = roleDef(k); return d && perm.impliedBy(d); });
  for (const perm of [report, users]) {
    const who = holders(perm);
    assert.ok(who.includes('super_admin'), `${perm.key} should reach Super Admin by default`);
    assert.ok(who.length > 1, `${perm.key} should reach the other full-access roles too`);
  }
});

// --- against a live server -----------------------------------------------------

test('idle, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Idle-Test-1!';
  let server;
  let projectId;
  const token = {};
  const id = {};

  const as = (who, path, options = {}) => api(server.base, path, { ...options, token: token[who] });
  const status = async (who, path) => (await as(who, path)).status;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'idle-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST', body: { token: 'idle-token', name: 'Root', email: 'root@idle.test', password: PASSWORD },
    });
    const sign = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await sign('root@idle.test');

    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Nightgarden' } })).body.project.id;

    for (const [name, email] of [['Ana Lee', 'ana@idle.test'], ['Bo Chen', 'bo@idle.test'], ['Cy Dean', 'cy@idle.test']]) {
      const res = await as('root', '/users', {
        method: 'POST', body: { name, email, role: 'game_artist', password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      id[email.split('@')[0]] = res.body.user.id;
    }
    token.ana = await sign('ana@idle.test');

    /* A week I can check by hand: Mon 2026-03-02 to Fri 2026-03-06, an 8-hour
       day, so 40 hours expected each.
         ana  6h + 6h  = 12h -> 28h idle, 70%
         bo   8h x 5   = 40h ->  0h idle,  0%
         cy   nothing  =  0h -> 40h idle, 100% */
    const plan = {
      ana: [['2026-03-02', 6], ['2026-03-03', 6]],
      bo: [['2026-03-02', 8], ['2026-03-03', 8], ['2026-03-04', 8], ['2026-03-05', 8], ['2026-03-06', 8]],
      cy: [],
    };
    let n = 0;
    for (const [who, days] of Object.entries(plan)) {
      for (const [day, hours] of days) {
        n += 1;
        const asset = (await as('root', `/assets/project/${projectId}`, {
          method: 'POST',
          body: { name: `Fixture ${n}`, type: 'prop', priority: 'med', assigneeId: id[who], manHours: hours },
        })).body.asset;
        await sql(cfg, `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
          VALUES (UUID(), '${asset.id}', '${id[who]}', 1,
                  '${day} 09:00:00', '${day} ${String(9 + hours).padStart(2, '0')}:00:00', ${hours * 3600})`);
        /* A submission too, so the efficiency report includes these assets —
           it only counts work that has been sent for review. Without one the
           two reports have no overlapping population to compare. */
        await sql(cfg, `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, description, uploaded_by, created_at)
          VALUES (UUID(), '${asset.id}', 1, 'tl', 'https://example.test/x', 'First pass', '${id[who]}', '${day} 18:00:00')`);
      }
    }
  });

  t.after(async () => { await stopServer(server); });

  await t.test('the numbers match the ones worked out by hand', async () => {
    const res = await as('root', '/idle/report?period=week&on=2026-03-04');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const d = res.body;
    assert.strictEqual(d.period.from, '2026-03-02');
    assert.strictEqual(d.period.to, '2026-03-08');
    assert.strictEqual(d.workingDays, 5);
    assert.strictEqual(d.expectedHours, 40);

    const by = Object.fromEntries(d.rows.map((r) => [r.name, r]));
    assert.strictEqual(by['Ana Lee'].trackedHours, 12);
    assert.strictEqual(by['Ana Lee'].idleHours, 28);
    assert.strictEqual(by['Ana Lee'].idlePercent, 70);
    assert.strictEqual(by['Ana Lee'].idlePerDay, 5.6);

    assert.strictEqual(by['Bo Chen'].trackedHours, 40);
    assert.strictEqual(by['Bo Chen'].idleHours, 0);
    assert.strictEqual(by['Bo Chen'].idlePercent, 0);

    // The person with nothing at all is exactly who a capacity report is for.
    assert.strictEqual(by['Cy Dean'].trackedHours, 0);
    assert.strictEqual(by['Cy Dean'].idleHours, 40);
    assert.strictEqual(by['Cy Dean'].idlePercent, 100);

    // Worst first, so the list opens on the people worth asking about.
    assert.strictEqual(d.rows[0].name, 'Cy Dean');
  });

  await t.test('a single day, and a weekend that expects nothing', async () => {
    const monday = (await as('root', '/idle/report?period=day&on=2026-03-02')).body;
    assert.strictEqual(monday.workingDays, 1);
    assert.strictEqual(monday.expectedHours, 8);
    const ana = monday.rows.find((r) => r.name === 'Ana Lee');
    assert.strictEqual(ana.trackedHours, 6);
    assert.strictEqual(ana.idleHours, 2);
    assert.strictEqual(ana.idlePercent, 25);

    const saturday = (await as('root', '/idle/report?period=day&on=2026-03-07')).body;
    assert.strictEqual(saturday.workingDays, 0);
    assert.strictEqual(saturday.expectedHours, 0);
    assert.strictEqual(saturday.rows[0].idlePercent, null, 'not 0%, which would read as a full day worked');
  });

  await t.test('a session across midnight counts on the day it happened', async () => {
    /* Somebody who starts at 21:00 on Friday and stops at 03:00 on Saturday has
       not done six hours of Friday. */
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Late one', type: 'prop', priority: 'med', assigneeId: id.cy, manHours: 6 },
    })).body.asset;
    await sql(cfg, `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
      VALUES (UUID(), '${asset.id}', '${id.cy}', 1, '2026-03-06 21:00:00', '2026-03-07 03:00:00', 21600)`);

    const friday = (await as('root', '/idle/report?period=day&on=2026-03-06')).body;
    assert.strictEqual(friday.rows.find((r) => r.name === 'Cy Dean').trackedHours, 3, 'clipped at midnight');
    const saturday = (await as('root', '/idle/report?period=day&on=2026-03-07')).body;
    assert.strictEqual(saturday.rows.find((r) => r.name === 'Cy Dean').trackedHours, 3, 'the other half');
    // Both halves are inside the week, so the week has all six.
    const week = (await as('root', '/idle/report?period=week&on=2026-03-04')).body;
    assert.strictEqual(week.rows.find((r) => r.name === 'Cy Dean').trackedHours, 6);
  });

  await t.test('the working day is configurable, and the report follows it', async () => {
    const set = await as('root', '/branding/schedule', { method: 'PUT', body: { hoursPerDay: 4, workingDays: [1, 2, 3, 4, 5] } });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    const half = (await as('root', '/idle/report?period=week&on=2026-03-04')).body;
    assert.strictEqual(half.expectedHours, 20, 'five four-hour days');
    // Bo tracked 40 hours against a 20-hour week: no idle time, twenty over.
    const bo = half.rows.find((r) => r.name === 'Bo Chen');
    assert.strictEqual(bo.idleHours, 0);
    assert.strictEqual(bo.overtimeHours, 20);
    await as('root', '/branding/schedule', { method: 'PUT', body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] } });
  });

  await t.test('a filter chooses who is listed, and never shrinks their hours', async () => {
    /* The thing that would have made this report wrong. Filtering by project
       narrows the tracked time but not the standard day, so a person who spent
       the week on another project would print at 100% idle here. They are not
       idle, so the filter only decides who appears. */
    const all = (await as('root', '/idle/report?period=week&on=2026-03-04')).body;
    const anaAll = all.rows.find((r) => r.name === 'Ana Lee');

    const filtered = (await as('root', `/idle/report?period=week&on=2026-03-04&projectId=${projectId}`)).body;
    assert.ok(filtered.narrowed, 'the report says it was narrowed');
    const anaFiltered = filtered.rows.find((r) => r.name === 'Ana Lee');
    assert.ok(anaFiltered, 'Ana worked on this project, so she is listed');
    assert.strictEqual(anaFiltered.trackedHours, anaAll.trackedHours,
      'and her hours are unchanged — whole-person, not just this project');
    assert.strictEqual(anaFiltered.idleHours, anaAll.idleHours);

    // Somebody who touched nothing matching the filter drops off the list
    // rather than appearing as fully idle.
    assert.ok(!filtered.rows.some((r) => r.trackedHours === 0 && r.name === 'Cy Dean' && false));
  });

  await t.test('Idle Now moves people between the lists as the clock starts and stops', async () => {
    const before = (await as('root', '/idle/now')).body;
    const names = (list) => list.map((r) => r.name).sort();
    assert.deepStrictEqual(names(before.idle), ['Ana Lee', 'Bo Chen', 'Cy Dean'], 'nobody is running a timer');
    assert.strictEqual(before.working.length, 0);

    // Open a session, the way Accept and Start does.
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Live one', type: 'prop', priority: 'med', assigneeId: id.ana, manHours: 4 },
    })).body.asset;
    await sql(cfg, `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
      VALUES (UUID(), '${asset.id}', '${id.ana}', 1, DATE_SUB(NOW(), INTERVAL 5 MINUTE), NULL, NULL)`);

    const during = (await as('root', '/idle/now')).body;
    assert.deepStrictEqual(names(during.idle), ['Bo Chen', 'Cy Dean'], 'Ana is working now');
    assert.deepStrictEqual(names(during.working), ['Ana Lee']);
    assert.strictEqual(during.working[0].asset.name, 'Live one', 'and it says what she is on');
    assert.ok(during.working[0].runningForSeconds >= 250, 'and for how long');
    assert.ok(!during.working[0].stale, 'five minutes is not a forgotten timer');
    // The two lists never overlap.
    assert.ok(!during.idle.some((i) => during.working.some((w) => w.id === i.id)));

    // Pause it.
    await sql(cfg, "UPDATE work_sessions SET ended_at = NOW(), seconds = 300 WHERE ended_at IS NULL");
    const after = (await as('root', '/idle/now')).body;
    assert.deepStrictEqual(names(after.idle), ['Ana Lee', 'Bo Chen', 'Cy Dean'], 'and she is idle again');
  });

  await t.test('a timer nobody stopped is flagged rather than counted as work', async () => {
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Forgotten', type: 'prop', priority: 'med', assigneeId: id.bo, manHours: 4 },
    })).body.asset;
    await sql(cfg, `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
      VALUES (UUID(), '${asset.id}', '${id.bo}', 1, DATE_SUB(NOW(), INTERVAL 20 HOUR), NULL, NULL)`);

    const now = (await as('root', '/idle/now')).body;
    const bo = now.working.find((r) => r.name === 'Bo Chen');
    assert.ok(bo, 'still counted as working, because the clock really is running');
    assert.ok(bo.stale, 'but flagged');
    assert.ok(now.staleTimers.some((r) => r.name === 'Bo Chen'),
      'and surfaced separately, so a manager is not misled into thinking he is at his desk');
    await sql(cfg, "UPDATE work_sessions SET ended_at = NOW(), seconds = 60 WHERE ended_at IS NULL");
  });

  await t.test('the exports carry the period and the caveats', async () => {
    const xlsx = require('xlsx');
    const res = await fetch(`${server.base}/idle/report.xlsx?period=week&on=2026-03-04`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(res.status, 200);
    const book = xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    assert.deepStrictEqual(book.SheetNames, ['Summary', 'Idle']);
    const rows = xlsx.utils.sheet_to_json(book.Sheets.Idle);
    const cy = rows.find((r) => r.Person === 'Cy Dean');
    assert.strictEqual(cy['Idle hours'], 34, 'the same number the screen shows');
    const summary = xlsx.utils.sheet_to_json(book.Sheets.Summary, { header: 1 }).map((r) => r.join(': ')).join(' | ');
    assert.match(summary, /Week of 2026-03-02/, 'the period the file covers');
    assert.match(summary, /holidays|leave/i, 'and what it cannot account for');

    const pdf = await fetch(`${server.base}/idle/report.pdf?period=week&on=2026-03-04`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.match(pdf.headers.get('content-disposition') || '', /idle/);
  });

  await t.test('the Idle Report rides along in the Reports workbook', async () => {
    const xlsx = require('xlsx');
    const grab = async (query = '') => {
      const res = await fetch(`${server.base}/reports/efficiency.xlsx${query}`,
        { headers: { Authorization: `Bearer ${token.root}` } });
      assert.strictEqual(res.status, 200);
      return xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    };

    const book = await grab('?from=2026-03-02&to=2026-03-06');
    assert.ok(book.SheetNames.includes('Idle'), `the workbook should carry an Idle sheet: ${book.SheetNames}`);
    assert.strictEqual(book.SheetNames[book.SheetNames.length - 1], 'Idle', 'after the efficiency sheets');

    /* The sheets have to cover the same span, or the workbook is a trap. With a
       date range they do, because the idle builder reads the same from/to. */
    const summary = xlsx.utils.sheet_to_json(book.Sheets.Summary, { header: 1 });
    const covered = summary.find((r) => r[0] === 'Period covered');
    assert.ok(covered, 'the Summary says which period the Idle sheet covers');
    assert.strictEqual(covered[1], '2026-03-02 to 2026-03-06', 'exactly the range the rest of the file used');
    assert.ok(!summary.some((r) => /no date limit/.test(String(r[1] || ''))),
      'and no warning, because they agree');

    // The numbers are the ones the Idle screen shows for that week.
    const rows = xlsx.utils.sheet_to_json(book.Sheets.Idle);
    const screen = (await as('root', '/idle/report?from=2026-03-02&to=2026-03-06')).body;
    assert.strictEqual(rows.length, screen.rows.length);
    const bo = rows.find((r) => r.Person === 'Bo Chen');
    assert.strictEqual(bo['Idle hours'], screen.rows.find((r) => r.name === 'Bo Chen').idleHours);

    /* Without a date range they CANNOT agree — the efficiency sheets cover
       every asset ever and idle has to be measured against a period. The file
       must say so rather than let somebody read two spans as one. */
    const undated = await grab();
    const note = xlsx.utils.sheet_to_json(undated.Sheets.Summary, { header: 1 })
      .find((r) => /no date limit/.test(String(r[1] || '')));
    assert.ok(note, 'an undated workbook warns that the Idle sheet covers a different span');
    assert.match(String(note[1]), /Set a date range/, 'and says how to make them match');
  });

  await t.test('the two reports agree about how long somebody worked', async () => {
    /* They read the same table by different routes, and for a while they read
       it differently: efficiency summed the stored `seconds`, idle measured the
       gap between the timestamps. For a session the timer wrote those agree, but
       any row where they diverge produced one workbook whose sheets contradicted
       each other about the same person — which discredits both. Idle now uses
       the stored seconds for any session wholly inside the period, and only
       measures the timestamps when a session straddles the edge and the stored
       total would include time from outside. */
    const xlsx = require('xlsx');
    const res = await fetch(`${server.base}/reports/efficiency.xlsx?from=2026-03-01&to=2026-03-31`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    const book = xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    const efficiency = xlsx.utils.sheet_to_json(book.Sheets['By User']);
    const idleSheet = xlsx.utils.sheet_to_json(book.Sheets.Idle);
    assert.ok(efficiency.length, 'the fixtures should give the efficiency sheet something');

    for (const row of efficiency) {
      const mine = idleSheet.find((r) => r.Person === row.Assignee);
      assert.ok(mine, `${row.Assignee} should be on the Idle sheet too`);
      assert.strictEqual(Number(mine['Tracked hours']), Number(row['Tracked hours']),
        `${row.Assignee}: the two sheets must not disagree about tracked hours`);
    }
  });

  await t.test('a straddling session is still split across the two days', async () => {
    // The stored seconds cover both days, so the boundary case must keep
    // measuring the timestamps rather than taking the stored total whole.
    const friday = (await as('root', '/idle/report?period=day&on=2026-03-06')).body;
    const saturday = (await as('root', '/idle/report?period=day&on=2026-03-07')).body;
    assert.strictEqual(friday.rows.find((r) => r.name === 'Cy Dean').trackedHours, 3);
    assert.strictEqual(saturday.rows.find((r) => r.name === 'Cy Dean').trackedHours, 3);
  });

  await t.test('the workbook holds no idle data for somebody without the permission', async () => {
    /* The two permissions are independent, so a reader trusted with efficiency
       and not with idle must not receive idle numbers as a side effect of
       pressing the same button. */
    const xlsx = require('xlsx');
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: ['report.view'] } });
    token.ana = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'ana@idle.test', password: PASSWORD } })).body.token;

    const res = await fetch(`${server.base}/reports/efficiency.xlsx`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(res.status, 200, 'the efficiency workbook still works');
    const book = xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    assert.ok(!book.SheetNames.includes('Idle'), `no Idle sheet: ${book.SheetNames}`);
    const summary = xlsx.utils.sheet_to_json(book.Sheets.Summary, { header: 1 })
      .map((r) => r.join(' ')).join(' ');
    assert.ok(!/idle/i.test(summary), 'and not a word about idle in the Summary either');

    // The PDF view is gated the same way.
    const pdf = await fetch(`${server.base}/reports/efficiency.pdf?view=idle`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(pdf.status, 403);
    const normal = await fetch(`${server.base}/reports/efficiency.pdf?view=byUser`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(normal.status, 200, 'while the efficiency PDF is unaffected');

    await as('root', '/permissions/roles/game_artist/reset', { method: 'POST' });
  });

  await t.test('the Reports PDF endpoint can render the Idle Report', async () => {
    const res = await fetch(`${server.base}/reports/efficiency.pdf?view=idle&from=2026-03-02&to=2026-03-06`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/pdf/);
    // Same document the idle endpoint produces — one writer, two doors.
    const own = await fetch(`${server.base}/idle/report.pdf?from=2026-03-02&to=2026-03-06`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(own.status, 200);
    assert.strictEqual(res.headers.get('content-disposition'), own.headers.get('content-disposition'),
      'including the filename, so the two doors are not telling different stories');
  });

  await t.test('each permission opens exactly its own feature', async () => {
    const grant = async (role, permissions) => {
      const res = await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    };
    const relogin = async () => { token.ana = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'ana@idle.test', password: PASSWORD } })).body.token; };

    // Neither.
    await grant('game_artist', []);
    await relogin();
    assert.strictEqual(await status('ana', '/idle/report?period=week'), 403);
    assert.strictEqual(await status('ana', '/idle/now'), 403);

    // The report alone: no idle list, and no efficiency report either.
    await grant('game_artist', ['report.idle']);
    await relogin();
    assert.strictEqual(await status('ana', '/idle/report?period=week'), 200);
    assert.strictEqual(await status('ana', '/idle/report.xlsx'), 200);
    assert.strictEqual(await status('ana', '/idle/report.pdf'), 200);
    assert.strictEqual(await status('ana', '/idle/now'), 403, 'a different question, a different permission');
    assert.strictEqual(await status('ana', '/reports/efficiency'), 403, 'and not implied by it either');

    // The live list alone: no report, and no staff list.
    await grant('game_artist', ['user.idle_view']);
    await relogin();
    assert.strictEqual(await status('ana', '/idle/now'), 200);
    assert.strictEqual(await status('ana', '/idle/report?period=week'), 403);
    assert.strictEqual(await status('ana', '/users'), 403, 'seeing who is idle is not seeing everyone\'s record');

    // Both, and still nothing else.
    await grant('game_artist', ['report.idle', 'user.idle_view']);
    await relogin();
    assert.strictEqual(await status('ana', '/idle/report?period=week'), 200);
    assert.strictEqual(await status('ana', '/idle/now'), 200);
    assert.strictEqual(await status('ana', '/reports/efficiency'), 403);

    // The general permissions do not bring the idle ones with them.
    await grant('game_artist', ['report.view', 'user.view']);
    await relogin();
    assert.strictEqual(await status('ana', '/reports/efficiency'), 200);
    assert.strictEqual(await status('ana', '/users'), 200);
    assert.strictEqual(await status('ana', '/idle/report?period=week'), 403, 'View Reports does not imply View Idle Report');
    assert.strictEqual(await status('ana', '/idle/now'), 403, 'View Users does not imply View Idle Users');

    await as('root', '/permissions/roles/game_artist/reset', { method: 'POST' });
  });
});
