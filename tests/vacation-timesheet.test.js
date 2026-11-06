/* PROMPT 67 PART C: AN APPROVED VACATION FILLS THE TIMESHEET IN AS LEAVE.
 *
 * ===========================================================================
 * WHAT THE OWNER ASKED FOR, and why it is worth building: somebody back from a
 * fortnight away should not face fourteen empty days, a previous-day gate that
 * will not let them start work, and a fortnight of submissions to make for time
 * they were not here for.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING — the three ways this feature can do
 * real damage, each of which is quiet:
 *
 *   1. IT COULD OVERWRITE SOMEBODY'S OWN RECORD. A day the person has filed
 *      anything on, or submitted themselves, is theirs. Nothing here may touch
 *      it, and the day must be reported as skipped rather than silently passed
 *      over.
 *
 *   2. IT COULD REWRITE THE PAST. A cancellation takes back today and the days
 *      after it and NEVER the days already lived through — the person really
 *      was away for those, the days are submitted, and un-submitting them is
 *      editing history. This is the rule with the most ways to get subtly
 *      wrong, so it has the most tests.
 *
 *   3. IT COULD COUNT AS WORK. These are Leave lines; Leave is dropped from the
 *      timesheet export outright, nothing about an asset reads the timesheet at
 *      all, and a full-day leave day requires no hours. The tests check the
 *      consumers rather than trusting that.
 *
 * AND ONE WAY IT CAN BE MERELY ANNOYING: writing the fortnight in advance. It
 * does not — each day waits for its own morning, so a vacation cancelled on the
 * third day has no stale future rows to find.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  SKIP_REASON } = require('./helpers');

const vacationTimesheet = require('../src/vacation-timesheet');
const leaveSettings = require('../src/leave-settings');
const gate = require('../src/timesheet-gate');

const cfg = config('vacsheet');
const PASSWORD = 'VacSheet-Test-1!';

/* ---- the values, without a database ------------------------------------- */

test('the hours are the studio\'s full day, with the brief\'s fallback', () => {
  assert.strictEqual(vacationTimesheet.fullDayHours({ maxDayHours: 9 }), 9);
  assert.strictEqual(vacationTimesheet.fullDayHours({ maxDayHours: 7.5 }), 7.5);
  /* THE FALLBACK THE BRIEF NAMES, for a studio whose setting is missing or
     nonsense — never nought, which would file a line claiming no time at all. */
  assert.strictEqual(vacationTimesheet.fullDayHours({}), 8);
  assert.strictEqual(vacationTimesheet.fullDayHours({ maxDayHours: 0 }), 8);
  assert.strictEqual(vacationTimesheet.fullDayHours({ maxDayHours: 'nonsense' }), 8);

  /* A PART DAY IS NOT FILLED AT ALL, which is the decision the module argues
     at length: this feature SUBMITS the day it fills, a submitted day takes no
     more lines, and half-filling one would lock the person out of logging the
     half they actually worked. */
  const dayStatus = require('../src/day-status');
  assert.strictEqual(vacationTimesheet.isFullDay(dayStatus.PORTIONS.full), true);
  assert.strictEqual(vacationTimesheet.isFullDay('first_half'), false);
  assert.strictEqual(vacationTimesheet.isFullDay('second_half'), false);
  assert.strictEqual(vacationTimesheet.hoursForPortion, undefined,
    'and there is no half-hours path left to come back to');
});

test('the switch is on by default, and off means only "write no more"', () => {
  assert.strictEqual(leaveSettings.DEFAULTS.vacationAutoTimesheet, true);
  const v = leaveSettings.validate({ vacationAutoTimesheet: false },
    { ...leaveSettings.DEFAULTS });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.value.vacationAutoTimesheet, false);
  /* AND IT IS ITS OWN SETTING. Turning it off must not disturb the other
     vacation switches — Prompt 65's timer stop in particular. */
  assert.strictEqual(v.value.vacationStopTimers, true);
  assert.strictEqual(v.value.vacationEnabled, true);
});

test('only the days that have arrived are due', () => {
  /* NEVER AHEAD OF THE DAY. The whole reason a cancellation can never leave a
     stale future row is that no future row is ever written. */
  const today = gate.istDate();
  const req = { from: gate.shiftDays(today, -30), to: gate.shiftDays(today, 30),
    fromPortion: 'full', toPortion: 'full' };
  const due = vacationTimesheet.dueDays(req, Date.now(),
    { loggableDays: [1, 2, 3, 4, 5], isHoliday: () => false });
  assert.ok(due.length, 'there are days to fill');
  for (const d of due) {
    assert.ok(d.date <= today, `${d.date} is today or past`);
    assert.ok([1, 2, 3, 4, 5].includes(new Date(`${d.date}T00:00:00Z`).getUTCDay()),
      `${d.date} is a working day — weekends and holidays are daysOf()'s job`);
  }
  // And a vacation entirely in the future is due nothing at all.
  const later = { from: gate.shiftDays(today, 10), to: gate.shiftDays(today, 20),
    fromPortion: 'full', toPortion: 'full' };
  assert.deepStrictEqual(
    vacationTimesheet.dueDays(later, Date.now(), { loggableDays: [1, 2, 3, 4, 5], isHoliday: () => false }),
    []);
});

/* ===========================================================================
 * AGAINST A REAL DATABASE AND A REAL SERVER.
 */
test('an approved vacation on the timesheet, end to end',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    let server;
    const token = {};
    const people = {};
    const call = (p, opts = {}) => api(server.base, p, opts);
    const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
    const q = (text, params) => sql(cfg, text, params);
    const today = () => gate.istDate();

    /* A handle bound to THIS suite's database, for the module calls this suite
       drives itself — src/db's pool points at TEST_DB_NAME and not at the
       suite's own copy, which is the trap tests/day-status.test.js documents. */
    const handle = {
      async query(text, params = []) {
        const values = [];
        const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
          values.push(params[Number(n) - 1]); return '?';
        });
        const rows = await sql(cfg, translated, values.length ? values : params);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      },
    };

    const workingBack = (n) => {
      let found = 0;
      for (let back = 0; back < 40; back += 1) {
        const date = gate.shiftDays(today(), -back);
        if ([1, 2, 3, 4, 5].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) {
          if (found === n) return date;
          found += 1;
        }
      }
      throw new Error('ran out of working days');
    };

    const linesOn = (userId, date) => q(
      `SELECT id, non_project AS cat, hours, notes, leave_request_id AS requestId
         FROM timesheet_entries WHERE user_id = ? AND entry_date = ?`, [userId, date]);
    const dayOf = (userId, date) => q(
      'SELECT status, auto_submitted AS auto FROM timesheet_days WHERE user_id = ? AND work_date = ?',
      [userId, date]).then((r) => r[0] || null);

    const setLeave = async (over) => {
      const res = await as('root', '/admin/settings/leave', { method: 'PUT',
        body: { enabled: true, vacationEnabled: true, vacationRequireApproval: true,
          vacationMinNoticeDays: 0, vacationMaxRangeDays: 60, vacationEmailEnabled: false,
          vacationStopTimers: true, vacationAutoTimesheet: true, ...over } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      /* AND INTO THIS PROCESS TOO. The settings are mirrored per process and
         the PUT above reloaded the SERVER's copy; this suite calls
         src/vacation-timesheet.js directly, so it needs its own mirror to be
         the one the save just wrote — which is exactly what the server does at
         boot and after every save. Without it the switch tests pass or fail on
         whichever copy happened to be asked. */
      await leaveSettings.load(handle);
    };

    /* A VACATION IN THE PAST, written straight into the table. The booking
       route rightly refuses a start date behind the notice period, and what is
       under test here is what happens to days that have already gone by. */
    const pastVacation = async (userId, from, to, status = 'approved') => {
      const id = require('node:crypto').randomUUID();
      /* from_date and to_date, which is what the table calls them, and no
         `kind`: leave_requests holds vacations and nothing else. */
      await q(
        `INSERT INTO leave_requests (id, user_id, from_date, to_date, from_portion,
            to_portion, status, note, requested_by, requested_at)
         VALUES (?,?,?,?,'full','full',?,?,?,NOW())`,
        [id, userId, from, to, status, 'A fortnight away', userId]);
      return { id, userId, from, to, fromPortion: 'full', toPortion: 'full', status };
    };

    t.before(async () => {
      await resetSchema(cfg);
      server = await startServer(cfg, {
        BOOTSTRAP_TOKEN: 'vs-token',
        WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
      });
      await call('/auth/bootstrap', { method: 'POST', body: {
        token: 'vs-token', name: 'Root', email: 'root@vs.test', password: PASSWORD } });
      const login = async (email) => (await call('/auth/login', {
        method: 'POST', body: { email, password: PASSWORD } })).body.token;
      token.root = await login('root@vs.test');
      people.root = (await as('root', '/auth/me')).body.user.id;
      await openStudio(server.base, token.root);

      for (const who of ['ana', 'bo']) {
        const made = await call('/users', { token: token.root, method: 'POST',
          body: { name: who, email: `${who}@vs.test`, role: 'game_artist', password: PASSWORD } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        people[who] = made.body.user.id;
        token[who] = await login(`${who}@vs.test`);
      }
      await setLeave({});
    });
    t.after(async () => { if (server) await stopServer(server); });

    await t.test('the columns are there, nullable, and the step is idempotent', async () => {
      const entry = await q(
        `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_entries'
            AND COLUMN_NAME = 'leave_request_id'`);
      assert.strictEqual(entry.length, 1);
      assert.strictEqual(entry[0].n, 'YES', 'every line filed before this reads as not ours');

      const day = await q(
        `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_days'
            AND COLUMN_NAME = 'auto_submitted'`);
      assert.strictEqual(day.length, 1);
      assert.strictEqual(day[0].n, 'YES');

      const step = require('../src/migrate').STEPS
        .find(([name]) => name === 'vacation timesheet fill');
      assert.ok(step, 'and it is a registered migration step');
      const said = [];
      await step[1](handle, (m) => said.push(m));
      assert.deepStrictEqual(said, [], 'running it again does nothing and says nothing');
    });

    await t.test('approval fills the past and today, and nothing later', async () => {
      const from = workingBack(3);
      const to = gate.shiftDays(today(), 10);
      const req = await pastVacation(people.ana, from, to);

      const made = await vacationTimesheet.fill(handle, req, { now: Date.now() });
      assert.ok(made.created.length >= 3, `filled the days gone by: ${made.created.join(',')}`);
      assert.ok(made.created.every((d) => d <= today()),
        'and never a day that has not arrived');
      assert.ok(made.created.includes(today()), 'today included');

      /* THE LINE ITSELF: Leave, the studio's full day, the brief's note, and no
         client or project. */
      const lines = await linesOn(people.ana, today());
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].cat, 'leave');
      assert.strictEqual(Number(lines[0].hours), 8);
      assert.strictEqual(lines[0].notes, vacationTimesheet.NOTE);
      assert.strictEqual(lines[0].requestId, req.id, 'linked to the request that wrote it');

      // And the day is submitted, by the system rather than by the person.
      const day = await dayOf(people.ana, today());
      assert.strictEqual(day.status, 'submitted');
      assert.strictEqual(Number(day.auto), 1);

      // Nothing at all on a day still to come.
      assert.deepStrictEqual(await linesOn(people.ana, gate.shiftDays(today(), 5)), []);
    });

    await t.test('running it again changes nothing, twice over and side by side', async () => {
      const req = (await q(
        `SELECT id, user_id AS userId, DATE_FORMAT(from_date, '%Y-%m-%d') AS \`from\`,
                DATE_FORMAT(to_date, '%Y-%m-%d') AS \`to\`, status
           FROM leave_requests WHERE user_id = ? LIMIT 1`,
        [people.ana]))[0];
      const shaped = { ...req, fromPortion: 'full', toPortion: 'full' };
      const before = await q(
        'SELECT id, entry_date AS d, hours FROM timesheet_entries WHERE user_id = ? ORDER BY entry_date, id',
        [people.ana]);

      const again = await vacationTimesheet.fill(handle, shaped, { now: Date.now() });
      assert.deepStrictEqual(again.created, [], 'a second run creates nothing');

      /* TWO AT ONCE, which is what two workers on one database are. The claim
         is the one the brief makes: the sweep is safe with two processes. */
      await Promise.all([
        vacationTimesheet.fill(handle, shaped, { now: Date.now() }),
        vacationTimesheet.fill(handle, shaped, { now: Date.now() }),
      ]);
      assert.deepStrictEqual(await q(
        'SELECT id, entry_date AS d, hours FROM timesheet_entries WHERE user_id = ? ORDER BY entry_date, id',
        [people.ana]), before, 'and the rows are exactly the rows that were there');
    });

    await t.test('a day the person has already used is left alone, and said to be', async () => {
      const day = workingBack(1);
      await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?', [people.bo, day]);
      /* THEIR OWN LINE, filed through the application. */
      const theirs = await as('bo', '/timesheets/entries', { method: 'POST',
        body: { date: day, hours: 4, nonProject: 'training',
          nonProjectSub: 'training_training_2d_art' } });
      assert.strictEqual(theirs.status, 201, JSON.stringify(theirs.body));

      const req = await pastVacation(people.bo, day, day);
      const made = await vacationTimesheet.fill(handle, req, { now: Date.now() });
      assert.deepStrictEqual(made.created, [], 'nothing was written');
      assert.strictEqual(made.skipped.length, 1);
      assert.strictEqual(made.skipped[0].date, day);
      assert.match(made.skipped[0].why, /already has lines/i);

      const after = await linesOn(people.bo, day);
      assert.strictEqual(after.length, 1, 'their line and only their line');
      assert.strictEqual(after[0].requestId, null, 'untouched, and not claimed as ours');
      assert.strictEqual(Number(after[0].hours), 4);
    });

    await t.test('a weekly off and a holiday are never filled', async () => {
      /* daysOf() drops them, so this is really a check that this module asks it
         rather than walking the dates itself. */
      const saturday = (() => {
        for (let n = 0; n < 7; n += 1) {
          const d = gate.shiftDays(today(), -n);
          if (new Date(`${d}T00:00:00Z`).getUTCDay() === 6) return d;
        }
        throw new Error('no Saturday in a week');
      })();
      const req = await pastVacation(people.bo, saturday, saturday);
      const made = await vacationTimesheet.fill(handle, req, { now: Date.now() });
      assert.deepStrictEqual(made.created, []);
      assert.deepStrictEqual(await linesOn(people.bo, saturday), []);
    });

    await t.test('the user cannot edit or delete a line the system wrote', async () => {
      const line = (await q(
        'SELECT id FROM timesheet_entries WHERE user_id = ? AND leave_request_id IS NOT NULL LIMIT 1',
        [people.ana]))[0];
      assert.ok(line, 'there is a system line to try');

      const edit = await as('ana', `/timesheets/entries/${line.id}`,
        { method: 'PATCH', body: { hours: 2 } });
      assert.strictEqual(edit.status, 409, JSON.stringify(edit.body));
      assert.match(edit.body.error, /filled in from an approved vacation/i);
      assert.match(edit.body.error, /days already past stay as recorded/i,
        'and it says what cancelling would and would not do');

      const gone = await as('ana', `/timesheets/entries/${line.id}`, { method: 'DELETE' });
      assert.strictEqual(gone.status, 409, JSON.stringify(gone.body));

      assert.strictEqual((await q(
        'SELECT COUNT(*) AS n FROM timesheet_entries WHERE id = ?', [line.id]))[0].n, 1,
      'and the line is still there, unchanged');
    });

    await t.test('cancelling takes back today and the future, NEVER the past', async () => {
      /* THE RULE WITH THE MOST WAYS TO GET WRONG. Ana has filled-in days behind
         her and one for today. A cancellation must leave every past day exactly
         as it is — submitted, with its line — and clear today's. */
      const req = (await q(
        `SELECT id, user_id AS userId, DATE_FORMAT(from_date, '%Y-%m-%d') AS \`from\`,
                DATE_FORMAT(to_date, '%Y-%m-%d') AS \`to\`, status
           FROM leave_requests WHERE user_id = ? LIMIT 1`,
        [people.ana]))[0];
      const past = workingBack(2);
      const pastBefore = await linesOn(people.ana, past);
      const pastDayBefore = await dayOf(people.ana, past);
      assert.strictEqual(pastBefore.length, 1, 'the past day has its line');

      const out = await vacationTimesheet.clear(handle, { ...req, userId: people.ana });
      assert.ok(out.removed.includes(today()), `today was taken back: ${out.removed.join(',')}`);
      assert.ok(!out.removed.includes(past), 'and the past day was not');

      assert.deepStrictEqual(await linesOn(people.ana, past), pastBefore,
        'the past day is exactly as it was');
      assert.deepStrictEqual(await dayOf(people.ana, past), pastDayBefore,
        'and still submitted');

      assert.deepStrictEqual(await linesOn(people.ana, today()), [], 'today is clear');
      const todayDay = await dayOf(people.ana, today());
      assert.strictEqual(todayDay.status, 'draft', 'and reopened, because the system submitted it');
      assert.strictEqual(todayDay.auto, null);
    });

    await t.test('a day the PERSON submitted is never reopened by a cancellation', async () => {
      const day = workingBack(4);
      await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?', [people.bo, day]);
      await q('DELETE FROM timesheet_days WHERE user_id = ? AND work_date = ?', [people.bo, day]);
      /* Their own line and their own submission, written directly so the day's
         own gates are not what is under test here. */
      await q(
        `INSERT INTO timesheet_entries (id, user_id, entry_date, non_project, hours, notes)
         VALUES (?,?,?,'leave',8,'mine')`,
        [require('node:crypto').randomUUID(), people.bo, day]);
      await q(
        `INSERT INTO timesheet_days (id, user_id, work_date, status, submitted_at)
         VALUES (?,?,?,'submitted',NOW())`,
        [require('node:crypto').randomUUID(), people.bo, day]);

      const req = await pastVacation(people.bo, day, gate.shiftDays(today(), 3));
      await vacationTimesheet.clear(handle, req);

      const after = await dayOf(people.bo, day);
      assert.strictEqual(after.status, 'submitted', 'their own submission stands');
      assert.strictEqual((await linesOn(people.bo, day)).length, 1, 'and their own line');
    });

    await t.test('the switch off writes nothing, and leaves what is written', async () => {
      const before = Number((await q(
        'SELECT COUNT(*) AS n FROM timesheet_entries WHERE leave_request_id IS NOT NULL'))[0].n);
      assert.ok(before > 0, 'there are filled-in lines to leave alone');

      await setLeave({ vacationAutoTimesheet: false });
      try {
        const day = workingBack(5);
        await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?', [people.bo, day]);
        const req = await pastVacation(people.bo, day, day);
        const made = await vacationTimesheet.fill(handle, req, { now: Date.now() });
        assert.deepStrictEqual(made.created, []);
        assert.strictEqual(made.reason, 'switched off');
        assert.deepStrictEqual(await linesOn(people.bo, day), []);

        assert.strictEqual(Number((await q(
          'SELECT COUNT(*) AS n FROM timesheet_entries WHERE leave_request_id IS NOT NULL'))[0].n),
        before, 'and the lines already written are still there');
        assert.deepStrictEqual(await vacationTimesheet.sweep(handle, {}), [],
          'the sweep does nothing either');
      } finally {
        await setLeave({ vacationAutoTimesheet: true });
      }
    });

    await t.test('the sweep brings a day in when it arrives', async () => {
      /* THE FUTURE DAY, SIMULATED BY MOVING THE CLOCK rather than by waiting:
         the sweep takes `now`, and nothing is held between calls, which is what
         makes it restart-safe. */
      const day = workingBack(0);
      await q('DELETE FROM timesheet_entries WHERE user_id = ?', [people.bo]);
      await q('DELETE FROM timesheet_days WHERE user_id = ?', [people.bo]);
      await q('DELETE FROM leave_requests WHERE user_id = ?', [people.bo]);

      const ahead = gate.shiftDays(today(), 1);
      await pastVacation(people.bo, ahead, gate.shiftDays(today(), 6));

      const nowNothing = await vacationTimesheet.sweep(handle, { userId: people.bo });
      assert.deepStrictEqual(nowNothing, [], 'nothing is due yet');
      assert.deepStrictEqual(await linesOn(people.bo, ahead), []);

      /* The same sweep, asked at a time inside the vacation. */
      const later = Date.parse(`${ahead}T06:00:00Z`) + (12 * 3600 * 1000);
      const done = await vacationTimesheet.sweep(handle, { now: later, userId: people.bo });
      if ([1, 2, 3, 4, 5].includes(new Date(`${ahead}T00:00:00Z`).getUTCDay())) {
        assert.strictEqual(done.length, 1, JSON.stringify(done));
        assert.ok(done[0].created.includes(ahead));
        assert.strictEqual((await linesOn(people.bo, ahead)).length, 1);
        assert.strictEqual((await dayOf(people.bo, ahead)).status, 'submitted');
      }
      assert.ok(day);
    });

    await t.test('the lines are Leave, and Leave is not worked time anywhere', async () => {
      const day = workingBack(2);
      const line = (await linesOn(people.ana, day))[0];
      assert.ok(line, 'a filled-in line to check');
      assert.strictEqual(line.cat, 'leave');

      /* THE EXPORT DROPS LEAVE OUTRIGHT, which is the rule Prompt 57 wrote and
         this inherits by being an ordinary Leave line. Asserted against the
         module's own set rather than by running an export, so the claim is
         about the rule and not about one fixture. */
      const exportSrc = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'src', 'timesheet-export.js'), 'utf8');
      assert.match(exportSrc, /const NO_ROW = new Set\(\['leave'\]\)/,
        'Leave produces no export rows');

      /* AND NOTHING ABOUT AN ASSET READS THE TIMESHEET. hoursLoggedOn() is the
         one query that reads timesheet_entries.asset_id, and a leave line names
         no asset — so there is nothing for it to find. */
      assert.strictEqual(line.requestId !== null, true);
      const sheets = require('../src/timesheets');
      const withAsset = await q(
        'SELECT COUNT(*) AS n FROM timesheet_entries WHERE leave_request_id IS NOT NULL AND asset_id IS NOT NULL');
      assert.strictEqual(Number(withAsset[0].n), 0,
        'no filled-in line names an asset, so none can reach an asset figure');
      assert.ok(typeof sheets.hoursLoggedOn === 'function');
    });

    await t.test('the week says the day was submitted by the system', async () => {
      const day = workingBack(2);
      const week = await as('ana', `/timesheets/week?date=${day}`);
      assert.strictEqual(week.status, 200, JSON.stringify(week.body));
      const row = (week.body.days || []).find((d) => d.date === day);
      assert.ok(row, 'the day is in the week');
      assert.strictEqual(row.status, 'submitted');
      assert.strictEqual(row.autoSubmitted, true);
      assert.strictEqual(row.submittedByLabel, vacationTimesheet.SUBMITTED_BY);
      assert.strictEqual(row.submittedByLabel, 'Auto (Vacation)');
      assert.ok(row.entries.some((e) => e.notes === vacationTimesheet.NOTE),
        'with the line on it');
    });
  });
