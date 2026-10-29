/* LEAVE AND IDLE.
 *
 * ===========================================================================
 * WHAT THIS FILE IS GUARDING, and it is one thing above all others:
 *
 *   MARKING SOMEBODY ON LEAVE CHANGES WHAT THEIR HOURS ADD UP TO.
 *
 * Everything else in this feature is a button. That one sentence is why the
 * tests below are mostly arithmetic over a frozen clock rather than clicks: a
 * figure that is wrong by an afternoon looks exactly like a figure that is
 * right, on every screen, until somebody reconciles a month and cannot.
 *
 * So the properties asserted are the ones a reader has to be able to rely on:
 *
 *   the window is read from the ROW, never from the live setting — so moving
 *   the half-day split cannot change what a past half-day meant;
 *
 *   the hours are COUNTED ONCE, by one function, and every consumer that sums
 *   time goes through it — asserted structurally as well as behaviourally,
 *   because a second summation would agree on the day it was written;
 *
 *   NOTHING IS DELETED — undo restores the exact figures, and it restores them
 *   by deriving them again rather than by remembering them;
 *
 *   the switch governs CREATION and nothing else, so flipping it can never
 *   change a past or current total in either direction.
 *
 * ===========================================================================
 * THE TWO WORDS THAT ALREADY MEANT SOMETHING ELSE.
 *
 * "Idle" is src/idle.js, a REPORT: measured coverage, never recorded. This
 * module's idle is a MARK a lead makes. Nothing here touches that report and a
 * test below pins the separation, because the one bug nobody would notice is a
 * report quietly reading a lead's opinion as a measurement.
 *
 * FIXED DATES THROUGHOUT, in March 2026. Nothing here reads the real clock
 * except where it says it does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const dayStatus = require('../src/day-status');
const leaveSettings = require('../src/leave-settings');
const workflow = require('../src/asset-workflow');
const workingTime = require('../src/working-time');
const catalog = require('../src/permission-catalog');
const reminders = require('../src/reminders');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const cfg = config('leave');
const PASSWORD = 'Leave-Idle-1!';

/* 2026 March: 16th Mon, 17th Tue, 18th Wed, 19th Thu, 20th Fri, 21st Sat, 22nd Sun. */
const MON = '2026-03-16';
const TUE = '2026-03-17';
const WED = '2026-03-18';
const THU = '2026-03-19';
const SAT = '2026-03-21';

const ist = (text) => Date.parse(`${text}+05:30`);

/* The studio's own day, as the fixtures use it: 09:30 to 19:00 with an hour of
   lunch at one o'clock — which is what src/work-schedule.js ships with, and
   therefore what the half-day split prefills from. */
const SCHEDULE = {
  entries: [
    { type: 'recording', start: 9 * 60 + 30, end: 13 * 60, daysOfWeek: [1, 2, 3, 4, 5] },
    { type: 'recording', start: 14 * 60, end: 19 * 60, daysOfWeek: [1, 2, 3, 4, 5] },
  ],
};
const SPLIT = { firstHalfEndMinutes: 13 * 60, secondHalfStartMinutes: 14 * 60 };

/* A row of the shape src/day-status.js reads, built the way the module builds
   it: through leaveSettings.windowFor, so a test can never snapshot a window
   the application would not have written. */
function markRow({ userId = 'u-1', date = WED, kind = 'leave', portion = 'full',
  split = SPLIT, ...rest } = {}) {
  const win = kind === 'leave' ? leaveSettings.windowFor(portion, split) : null;
  return {
    id: 'm-1', userId, date, kind,
    portion: kind === 'leave' ? portion : null,
    windowStart: win ? win.start : null,
    windowEnd: win ? win.end : null,
    note: null, setBy: 'u-boss', setByName: 'Priya', setAt: null,
    source: 'manual', planned: false, ...rest,
  };
}

function stubDb(answers = []) {
  const calls = [];
  return {
    calls,
    sqlFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).sql || ''; },
    paramsFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).params || []; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of answers) {
        if (re.test(sql)) {
          const value = typeof rows === 'function' ? rows(params) : rows;
          return { rows: value, result: { affectedRows: value.length } };
        }
      }
      return { rows: [], result: { affectedRows: 0 } };
    },
  };
}

// ===========================================================================
// 1. THE WINDOWS. What a portion covers, and where the answer comes from.
// ===========================================================================

test('a portion covers one interval, and a full day covers the calendar date', () => {
  const base = dayStatus.startOfDay(WED);

  const full = dayStatus.windowsFromRow(markRow({ portion: 'full' }));
  assert.strictEqual(full.length, 1);
  assert.strictEqual(full[0].from, base);
  assert.strictEqual(full[0].to, base + dayStatus.MS_PER_DAY);

  /* THE HALVES ARE WIDE ON PURPOSE: midnight to the split, and the split to
     midnight. Narrowing them to the studio's opening hours would be a second,
     weaker copy of the working-time rule — and the first thing it would do is
     disagree with it the day somebody moves the schedule. The time outside
     working hours is removed by countedMsByDay, once, below. */
  const first = dayStatus.windowsFromRow(markRow({ portion: 'first_half' }));
  assert.strictEqual(first[0].from, base, 'the first half begins at midnight');
  assert.strictEqual(first[0].to, base + 13 * 60 * 60000);

  const second = dayStatus.windowsFromRow(markRow({ portion: 'second_half' }));
  assert.strictEqual(second[0].from, base + 14 * 60 * 60000);
  assert.strictEqual(second[0].to, base + dayStatus.MS_PER_DAY, 'and the second ends at midnight');

  /* IDLE EXCLUDES NO TIME AT ALL. It says "there is nothing to do", not "do not
     count what was done" — somebody marked idle who then works an hour has
     worked an hour, and a module that decided otherwise would be ranking a
     lead's guess above a recorded session. */
  assert.deepStrictEqual(dayStatus.windowsFromRow(markRow({ kind: 'idle' })), []);
  assert.deepStrictEqual(dayStatus.windowsFromRow(null), []);
});

test('MUTATION 5 — first and second half are not interchangeable', () => {
  const first = dayStatus.windowsFromRow(markRow({ portion: 'first_half' }))[0];
  const second = dayStatus.windowsFromRow(markRow({ portion: 'second_half' }))[0];
  assert.ok(first.to <= second.from, 'the first half ends before the second begins');
  assert.notStrictEqual(first.from, second.from);
  /* AND THEY ARE NOT THE SAME LENGTH IN WORKING TIME EITHER, which is what a
     swap would show up as: 09:30-13:00 is three and a half hours, 14:00-19:00
     is five. A mutant that swapped them changes both figures. */
  const asWorking = (w) => workingTime.workingMsByDay(w.from, w.to, SCHEDULE).total / 3600000;
  assert.strictEqual(asWorking(first), 3.5);
  assert.strictEqual(asWorking(second), 5);
});

test('MUTATION 17 — the window comes from the row, never from the live setting', () => {
  /* A half-day recorded when the split was at one o'clock, read after somebody
     moved the split to eleven. The row still means one o'clock. */
  const row = markRow({ portion: 'first_half', split: SPLIT });
  const moved = { firstHalfEndMinutes: 11 * 60, secondHalfStartMinutes: 12 * 60 };
  const before = dayStatus.windowsFromRow(row)[0].to;
  const after = dayStatus.windowsFromRow(row)[0].to;
  assert.strictEqual(before, after);
  assert.strictEqual(before, dayStatus.startOfDay(WED) + 13 * 60 * 60000,
    'the snapshot, not the setting that has since moved');

  /* AND A ROW MADE UNDER THE NEW SPLIT MEANS THE NEW ONE — so the snapshot is
     a snapshot and not a frozen constant. */
  const later = markRow({ portion: 'first_half', split: moved });
  assert.strictEqual(dayStatus.windowsFromRow(later)[0].to,
    dayStatus.startOfDay(WED) + 11 * 60 * 60000);

  /* STRUCTURALLY TOO: nothing in the window arithmetic reads the settings
     module. A mutant that asked leaveSettings.split() here would pass every
     behavioural assertion above on the day it was written and fail the first
     time a studio moved its lunch. */
  const src = SRC('day-status.js');
  const body = src.slice(src.indexOf('function windowsFromRow'), src.indexOf('async function leaveWindows'));
  assert.ok(!/leaveSettings/.test(body), 'windowsFromRow never reads the settings');
});

// ===========================================================================
// 2. THE HOURS. One function, and leave is a thing subtracted from its answer.
// ===========================================================================

/* The working milliseconds of a span, as hours, with and without leave. */
const hours = (from, to, windows = []) =>
  dayStatus.countedMsByDay(from, to, { schedule: SCHEDULE, windows }).total / 3600000;

test('counted time is the working-time intersection minus the leave windows', () => {
  const base = dayStatus.startOfDay(WED);
  const wholeDay = [base, base + dayStatus.MS_PER_DAY];

  /* The studio's day: 09:30-13:00 and 14:00-19:00 — eight and a half hours. */
  assert.strictEqual(hours(...wholeDay), 8.5);

  assert.strictEqual(hours(...wholeDay, dayStatus.windowsFromRow(markRow({ portion: 'full' }))), 0,
    'a full day counts nothing');
  assert.strictEqual(hours(...wholeDay, dayStatus.windowsFromRow(markRow({ portion: 'first_half' }))), 5,
    'a first-half leave leaves the afternoon');
  assert.strictEqual(hours(...wholeDay, dayStatus.windowsFromRow(markRow({ portion: 'second_half' }))), 3.5,
    'and a second-half leave leaves the morning');

  /* IDLE REMOVES NOTHING. */
  assert.strictEqual(hours(...wholeDay, dayStatus.windowsFromRow(markRow({ kind: 'idle' }))), 8.5);
});

test('MUTATION 7 — a half day is not a full day', () => {
  const base = dayStatus.startOfDay(WED);
  const half = hours(base, base + dayStatus.MS_PER_DAY,
    dayStatus.windowsFromRow(markRow({ portion: 'first_half' })));
  assert.ok(half > 0, 'a half day still counts the half they worked');
  assert.strictEqual(half, 5);
});

test('MUTATION 15 — the sessions are excluded, never deleted', () => {
  /* The arithmetic is a SUBTRACTION over a span, so a session inside the window
     contributes nothing and a session straddling it contributes its outside
     part. Nothing here can remove a row, and nothing in the module can: the
     word DELETE does not appear in it. */
  const base = dayStatus.startOfDay(WED);
  const windows = dayStatus.windowsFromRow(markRow({ portion: 'first_half' }));
  // 11:00 to 15:00: an hour of leave (11:00-13:00 is two, less nothing), then
  // the lunch gap, then 14:00-15:00 outside the window.
  const straddling = hours(base + 11 * 3600000, base + 15 * 3600000, windows);
  assert.strictEqual(straddling, 1, 'only the part outside the window survives');
  assert.strictEqual(hours(base + 10 * 3600000, base + 12 * 3600000, windows), 0,
    'and a session wholly inside it counts nothing');

  const src = SRC('day-status.js');
  assert.ok(!/DELETE\s+FROM/i.test(src), 'nothing in this module deletes a row');
  assert.ok(/UPDATE work_sessions SET seconds/.test(src),
    'the only write to a session is the derived seconds column');
});

test('a day that is not a working day counts nothing, with or without leave', () => {
  const base = dayStatus.startOfDay(SAT);
  assert.strictEqual(hours(base, base + dayStatus.MS_PER_DAY), 0);
  assert.strictEqual(hours(base, base + dayStatus.MS_PER_DAY,
    dayStatus.windowsFromRow(markRow({ date: SAT, portion: 'full' }))), 0);
});

test('MUTATION 3 — leave applies to the marked person and to nobody else', () => {
  /* Two people, one asset, one afternoon. The windows are fetched PER USER, so
     a mutant that applied one person's leave to every session on the asset
     would have to read a different user's row — which is why the fetch takes a
     userId and the subtraction takes the windows it returned. */
  const db = stubDb([[/FROM user_day_status/, (params) => ((params[0] || []).includes('u-1')
    ? [{ userId: 'u-1', date: WED, kind: 'leave', portion: 'second_half',
      windowStart: 14 * 60, windowEnd: 24 * 60 }]
    : [])]]);
  const base = dayStatus.startOfDay(WED);
  return Promise.all([
    dayStatus.countedMs(db, { userId: 'u-1', from: base, to: base + dayStatus.MS_PER_DAY, schedule: SCHEDULE }),
    dayStatus.countedMs(db, { userId: 'u-2', from: base, to: base + dayStatus.MS_PER_DAY, schedule: SCHEDULE }),
  ]).then(([mine, theirs]) => {
    assert.strictEqual(mine.total / 3600000, 3.5, 'the person on leave loses the afternoon');
    assert.strictEqual(theirs.total / 3600000, 8.5, 'and the other person keeps their whole day');
  });
});

// ===========================================================================
// 3. THE THREE JUDGEMENTS, and that there is one of each.
// ===========================================================================

test('MUTATION 8 — a half day still owes a timesheet, and so does an idle day', () => {
  const required = dayStatus.timesheetRequiredFromRow;
  assert.strictEqual(required(null), true, 'an ordinary day');
  assert.strictEqual(required(markRow({ portion: 'full' })), false,
    'a full day away has nothing to write down');
  assert.strictEqual(required(markRow({ portion: 'first_half' })), true,
    'a half day worked the other half, and that half is what the timesheet is for');
  assert.strictEqual(required(markRow({ portion: 'second_half' })), true);
  assert.strictEqual(required(markRow({ kind: 'idle' })), true,
    'idle is a day at the desk with nothing to pick up, not an absence');
});

test('MUTATION 12 — nobody inside a leave window is judged, nudged or reminded', () => {
  const at = (hhmm) => ist(`${WED}T${hhmm}:00`);
  const inWindow = (row, t) => !dayStatus.expectedToWorkFromRow(row, t);

  const first = markRow({ portion: 'first_half' });
  assert.strictEqual(inWindow(first, at('10:00')), true, 'inside, before the split');
  assert.strictEqual(inWindow(first, at('14:30')), false, 'and out of it after');

  const second = markRow({ portion: 'second_half' });
  assert.strictEqual(inWindow(second, at('10:00')), false, 'a second-half person works the morning');
  assert.strictEqual(inWindow(second, at('15:00')), true, 'and is away after the split');

  const full = markRow({ portion: 'full' });
  assert.strictEqual(inWindow(full, at('10:00')), true);
  assert.strictEqual(inWindow(full, at('18:00')), true);

  /* IDLE IS NOT ABSENCE. expectedToWorkFromRow says nothing about it — which
     is the distinction that keeps idle out of the timesheet exemption. */
  assert.strictEqual(inWindow(markRow({ kind: 'idle' }), at('10:00')), false);
  assert.strictEqual(dayStatus.nothingToStart(markRow({ kind: 'idle' })), true);
  assert.strictEqual(dayStatus.nothingToStart(markRow({ portion: 'full' })), false,
    'a full day away is not "nothing to start" — it is "not here"');
  assert.strictEqual(dayStatus.nothingToStart(null), false);
});

test('the per-person judgements and the per-list ones are one rule, not two', () => {
  /* The async functions take a userId and fetch; the sync ones take a row. The
     async ones CALL the sync ones, which is what makes the follow-up section's
     set-based application of them the same rule rather than a copy. Asserted
     structurally, because a copy would agree on the day it was written. */
  const src = SRC('day-status.js');
  const expected = src.slice(src.indexOf('async function isExpectedToWorkAt'),
    src.indexOf('function expectedToWorkFromRow'));
  assert.match(expected, /return expectedToWorkFromRow\(status, now\);/);
  const required = src.slice(src.indexOf('async function isTimesheetRequired'),
    src.indexOf('async function isExpectedToWorkAt'));
  assert.match(required, /return timesheetRequiredFromRow\(/);

  /* AND THE SECTION CALLS THEM RATHER THAN RESTATING THEM. */
  const followUp = SRC('follow-up.js');
  assert.match(followUp, /dayStatus\.timesheetRequiredFromRow\(/);
  assert.match(followUp, /dayStatus\.expectedToWorkFromRow\(/);
  assert.match(followUp, /dayStatus\.nothingToStart\(/);
});

test('the actionable list is derived from the workflow, not written out again', () => {
  const union = [...new Set([...workflow.ASSIGNEE_STATUSES, ...workflow.WORKING_STATUSES])];
  assert.deepStrictEqual([...dayStatus.ACTIONABLE_STATUSES].sort(), union.sort());
  /* IT CONTAINS not_started, which only ASSIGNEE_STATUSES has, and the three
     rework stages, which only WORKING_STATUSES has — so a mutant that used
     either list alone is caught by one of these two. */
  assert.ok(dayStatus.ACTIONABLE_STATUSES.includes('not_started'));
  assert.ok(dayStatus.ACTIONABLE_STATUSES.includes('cd_changes_requested'));
  /* AND NOTHING THAT IS SOMEBODY ELSE'S DESK. */
  for (const s of ['pending_tl_review', 'tl_approved', 'pending_cd_review',
    'approved_for_client', 'awaiting_client_feedback', 'delivered']) {
    assert.ok(!dayStatus.ACTIONABLE_STATUSES.includes(s), `${s} is not the assignee's to act on`);
  }
  /* THE PAGE AND THE SERVER AGREE, because the page is given the list rather
     than holding one. */
  assert.match(SRC('follow-up.js'), /actionableStatuses: dayStatus\.ACTIONABLE_STATUSES/);
  assert.match(SRC('routes/leave-settings.js'), /actionableStatuses: dayStatus\.ACTIONABLE_STATUSES/);
  assert.ok(!/'not_started',\s*'assigned',\s*'in_progress'/.test(PAGE.slice(PAGE.indexOf('function fuDayButtons'),
    PAGE.indexOf('function fuLeaveMenu'))), 'the page holds no copy of the list');
});

// ===========================================================================
// 4. THE SETTINGS: the switch, the split, and the snapshot that follows it.
// ===========================================================================

test('the split prefills from the lunch break, and from the midpoint without one', () => {
  const withLunch = leaveSettings.prefill({
    schedule: { dayStart: 9 * 60 + 30, dayEnd: 19 * 60 },
    breaks: [{ key: 'lunch', start: 13 * 60, end: 14 * 60 }],
  });
  assert.deepStrictEqual(withLunch,
    { firstHalfEndMinutes: 780, secondHalfStartMinutes: 840, from: 'lunch' });

  const without = leaveSettings.prefill({
    schedule: { dayStart: 9 * 60, dayEnd: 17 * 60 }, breaks: [],
  });
  assert.strictEqual(without.from, 'midpoint');
  assert.strictEqual(without.firstHalfEndMinutes, 13 * 60, 'the middle of a nine-to-five');
  assert.strictEqual(without.secondHalfStartMinutes, 13 * 60, 'both ends, so the halves meet');

  /* THE TEA BREAKS ARE NOT SPLIT POINTS. A fifteen-minute morning break is not
     the middle of anything, and picking it would halve somebody's day at a
     quarter past eleven. */
  const threeBreaks = leaveSettings.prefill({
    schedule: { dayStart: 9 * 60 + 30, dayEnd: 19 * 60 },
    breaks: [{ key: 'morning', start: 11 * 60, end: 11 * 60 + 15 },
      { key: 'lunch', start: 13 * 60, end: 14 * 60 },
      { key: 'evening', start: 17 * 60, end: 17 * 60 + 15 }],
  });
  assert.strictEqual(threeBreaks.firstHalfEndMinutes, 13 * 60);
});

test('MUTATION 19 — the split must be ordered and inside working hours', () => {
  const schedule = { dayStart: 9 * 60 + 30, dayEnd: 19 * 60, lunchStart: 13 * 60, lunchEnd: 14 * 60 };
  const existing = { enabled: true, firstHalfEndMinutes: 780, secondHalfStartMinutes: 840 };
  const check = (input) => leaveSettings.validate(input, { existing, schedule });

  assert.strictEqual(check({ firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00' }).ok, true);
  assert.strictEqual(check({ firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '13:00' }).ok, true,
    'they may meet — a studio with no break at the split');

  const backwards = check({ firstHalfEndMinutes: '14:00', secondHalfStartMinutes: '13:00' });
  assert.strictEqual(backwards.ok, false);
  assert.match(backwards.errors[0].message, /before First Half ends/);

  const early = check({ firstHalfEndMinutes: '07:00' });
  assert.strictEqual(early.ok, false);
  assert.match(early.errors[0].message, /inside working hours/);

  const late = check({ secondHalfStartMinutes: '23:00' });
  assert.strictEqual(late.ok, false);

  assert.strictEqual(check({ firstHalfEndMinutes: 'noon' }).ok, false, 'and it is a time of day');
});

test('a gap of ordinary working time is a warning, not a refusal', () => {
  const schedule = { dayStart: 9 * 60 + 30, dayEnd: 19 * 60, lunchStart: 13 * 60, lunchEnd: 14 * 60 };
  const existing = { enabled: true, firstHalfEndMinutes: 780, secondHalfStartMinutes: 840 };

  /* Lunch between the halves is the normal case and says nothing. */
  const normal = leaveSettings.validate(
    { firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00' }, { existing, schedule });
  assert.strictEqual(normal.ok, true);
  assert.deepStrictEqual(normal.warnings, []);

  /* An hour of WORK between them is legitimate and surprising, so it is said
     and the save proceeds. Blocking it would be this code deciding a studio's
     hours for it. */
  const gap = leaveSettings.validate(
    { firstHalfEndMinutes: '12:00', secondHalfStartMinutes: '15:00' }, { existing, schedule });
  assert.strictEqual(gap.ok, true, 'not refused');
  assert.strictEqual(gap.warnings.length, 1);
  assert.match(gap.warnings[0].message, /counts as normal working time on half-day leave/);
});

test('MUTATION 20 and 21 — the switch governs creation and nothing else', () => {
  /* THE SERVER ASKS IT, which is what makes hiding the buttons a rule rather
     than a decoration. */
  const route = SRC('routes/admin-dashboard.js');
  const create = route.slice(route.indexOf("router.post('/follow-up/day-status',"),
    route.indexOf('/* UNDO.'));
  assert.match(create, /leaveSettings\.leaveIdleEnabled\(\)/);
  assert.match(create, /feature_disabled/);

  /* AND UNDO DOES NOT. A mark that could be made and not undone is a mark that
     is stuck, which is the one outcome the brief rules out by name. */
  const undo = route.slice(route.indexOf('/* UNDO.'), route.indexOf("router.post('/follow-up/remind',"));
  assert.ok(!/leaveIdleEnabled/.test(undo), 'undo is never gated on the switch');

  /* AND NOTHING THAT READS A ROW ASKS IT. This is the assertion that stops
     "disabled" from meaning "ignore the rows" — a switch whose effect is to
     change last month's totals is not a switch, it is a time machine. */
  const code = (f) => SRC(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/leaveIdleEnabled/.test(code('day-status.js')),
    'src/day-status.js never asks whether the feature is on');
  assert.ok(!/leaveIdleEnabled/.test(code('work-log.js')), 'nor does the hour arithmetic');
  assert.ok(!/leaveIdleEnabled/.test(code('timesheet-gate.js')));
  assert.ok(!/leaveIdleEnabled/.test(code('reminders.js')));
  assert.ok(!/leaveIdleEnabled/.test(code('start-reminders.js')));
});

test('the feature ships off', () => {
  assert.strictEqual(leaveSettings.DEFAULTS.enabled, false);
  assert.strictEqual(leaveSettings.DEFAULTS.firstHalfEndMinutes, null,
    'and the split is unset rather than defaulted, so the prefill is a suggestion');
  /* THE MIGRATION AGREES WITH THE MODULE. */
  assert.match(SRC('migrate.js'), /enabled\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/);
});

// ===========================================================================
// 5. WRITING: replace, undo, and the race.
// ===========================================================================

test('marking replaces, and the old row is kept as history', async () => {
  let stored = [];
  const db = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (/FROM user_day_status/.test(sql) && /SELECT/.test(sql)) {
        return { rows: stored.filter((r) => !r.cleared), result: {} };
      }
      if (/^\s*UPDATE user_day_status/.test(sql)) {
        let n = 0;
        for (const r of stored) if (!r.cleared) { r.cleared = true; n += 1; }
        return { rows: [], result: { affectedRows: n } };
      }
      if (/INSERT INTO user_day_status/.test(sql)) {
        stored.push({ id: params[0], userId: params[1], date: params[2], kind: params[3],
          portion: params[4], windowStart: params[5], windowEnd: params[6], cleared: false });
        return { rows: [], result: { affectedRows: 1 } };
      }
      return { rows: [], result: {} };
    },
  };

  await dayStatus.mark(db, { userId: 'u-1', date: WED, kind: 'leave', portion: 'first_half', setBy: 'u-b' });
  await dayStatus.mark(db, { userId: 'u-1', date: WED, kind: 'leave', portion: 'full', setBy: 'u-b' });
  assert.strictEqual(stored.length, 2, 'two rows');
  assert.strictEqual(stored.filter((r) => !r.cleared).length, 1, 'one of them active');
  assert.strictEqual(stored.find((r) => !r.cleared).portion, 'full');
  assert.strictEqual(stored[0].cleared, true, 'and the first is kept, cleared');

  /* MARKING THE SAME THING TWICE IS A NO-OP, so a double click does not turn
     one decision into two history rows that say the same thing. */
  const again = await dayStatus.mark(db, { userId: 'u-1', date: WED, kind: 'leave', portion: 'full' });
  assert.strictEqual(again.unchanged, true);
  assert.strictEqual(stored.length, 2);
});

test('the unique key is the guarantee, and a duplicate is answered rather than thrown', async () => {
  const db = {
    async query(sql) {
      if (/INSERT INTO user_day_status/.test(sql)) {
        const err = new Error('Duplicate entry');
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      return { rows: [], result: { affectedRows: 0 } };
    },
  };
  const out = await dayStatus.mark(db, { userId: 'u-1', date: WED, kind: 'leave', portion: 'full' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'race');

  /* THE KEY IS IN THE SCHEMA, over a generated column that is NULL once a row
     is cleared — so cleared rows fall out of the index and stay as history. */
  const migrate = SRC('migrate.js');
  assert.match(migrate, /UNIQUE KEY uq_day_status_active \(user_id, active_date\)/);
  assert.match(migrate, /active_date\s+DATE AS \(CASE WHEN cleared_at IS NULL THEN/);
});

// ===========================================================================
// 6. THE IDLE AUTO-CLEAR, and that no assign path can skip it.
// ===========================================================================

test('MUTATION 10 — every assign path clears the idle mark, because one function does', () => {
  /* THE PROOF IS STRUCTURAL, and it has to be: a test that drove the five
     routes would pass while a sixth was added without it. onAssigned is called
     from assignments.open(), and assignments.open() is the only writer of
     asset_assignments in the application. */
  const assignments = SRC('assignments.js');
  assert.match(assignments, /require\('\.\/day-status'\)\.onAssigned\(db, userId, assetId\)/);

  /* src/migrate.js is the one exception and it is not an assign path: it
     BACKFILLS history rows for assets that already had an assignee before this
     table existed. It assigns nobody — there is no moment at which somebody is
     handed work — so there is no idle mark to clear. Named rather than excluded
     silently, so a second exception has to argue for itself here. */
  const files = fs.readdirSync(path.join(__dirname, '..', 'src', 'routes'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, text: SRC(path.join('routes', f)) }))
    .concat(fs.readdirSync(path.join(__dirname, '..', 'src'))
      .filter((f) => f.endsWith('.js') && f !== 'assignments.js' && f !== 'migrate.js')
      .map((f) => ({ f, text: SRC(f) })));
  for (const { f, text } of files) {
    assert.ok(!/INSERT INTO asset_assignments/i.test(text),
      `${f} writes asset_assignments directly — it must go through assignments.open()`);
  }

  /* AND IT IS IN THE SAME TRANSACTION as the assignment: `db` there is the
     caller's connection, so a rollback puts the mark back. */
  const open = assignments.slice(assignments.indexOf('async function open('),
    assignments.indexOf('async function notify('));
  assert.ok(open.indexOf('onAssigned(db') !== -1
    && open.indexOf('onAssigned(db') < open.lastIndexOf('await notify('),
    'the clear happens inside the transaction, before the notification');
});

test('MUTATION 11 — idle blocks nothing', async () => {
  const db = stubDb();
  await dayStatus.onAssigned(db, 'u-1', 'a-1');
  assert.match(db.calls[0].sql, /UPDATE user_day_status/);
  assert.match(db.calls[0].sql, /kind = 'idle'/);

  /* IT NEVER THROWS AND NEVER REFUSES. An assignment that failed because a
     cosmetic mark could not be cleared would be far worse than a stale mark. */
  const broken = { async query() { throw new Error('boom'); } };
  assert.strictEqual(await dayStatus.onAssigned(broken, 'u-1', 'a-1'), false);

  /* AND NOTHING CONSULTS IT BEFORE ASSIGNING OR STARTING. */
  assert.ok(!/nothingToStart|KINDS\.idle/.test(SRC('assignments.js').replace(/\/\*[\s\S]*?\*\//g, '')),
    'assignments.open never asks whether somebody is idle');
  const start = SRC('routes/assets.js');
  const gate = start.slice(start.indexOf("router.post('/:id/start'"), start.indexOf("router.get('/:id/hold-explain'"));
  assert.ok(!/nothingToStart|'idle'/.test(gate), 'and neither does the start gate');
});

test('MUTATION 9 — idle needs an empty desk, and the server says so', () => {
  /* THE PAGE DISABLES IT, which is a courtesy. */
  const buttons = PAGE.slice(PAGE.indexOf('function fuDayButtons'), PAGE.indexOf('function fuLeaveMenu'));
  assert.match(buttons, /Number\(r\.held\) > 0/);
  assert.match(buttons, /asset\$\{Number\(r\.held\) === 1 \? '' : 's'\} assigned/);
  assert.match(buttons, /Idle can only be marked for today/);

  /* AND THE SERVER RE-CHECKS IT, which is the rule. */
  const route = SRC('routes/admin-dashboard.js');
  const create = route.slice(route.indexOf("router.post('/follow-up/day-status',"), route.indexOf('/* UNDO.'));
  assert.match(create, /dayStatus\.actionableCount\(db, userId\)/);
  assert.match(create, /code: 'has_assets'/);
  assert.match(create, /code: 'idle_not_today'/);
});

// ===========================================================================
// 7. THE TIMERS.
// ===========================================================================

test('MUTATION 1 — a running timer is stopped, at the moment the window opened', async () => {
  const closed = [];
  const now = ist(`${WED}T15:30:00`);
  const db = stubDb([
    [/FROM user_day_status/, [{ id: 'm-1', userId: 'u-1', date: WED, kind: 'leave',
      portion: 'second_half', windowStart: 14 * 60, windowEnd: 24 * 60,
      note: null, setBy: null, setByName: null, setAt: null, source: 'manual' }]],
    [/FROM work_sessions w/, [{ id: 's-1', assetId: 'a-1', userId: 'u-1',
      age_seconds: 6 * 3600, code: 'CH-1', name: 'Hero' }]],
  ]);
  const workLog = require('../src/work-log');
  const realClose = workLog.close;
  workLog.close = async (_db, assetId, reason, note, opts) => {
    closed.push({ assetId, reason, at: opts && opts.at });
    return { ok: true };
  };
  try {
    const stopped = await dayStatus.sweepLeave(db, { now });
    assert.strictEqual(stopped.length, 1);
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].reason, 'on_leave');
    /* AT THE WINDOW'S START, NOT AT NOW. This is what makes the figure right
       however late the sweep is — the same mechanism pauseOverdue() uses for
       the seven o'clock cutoff. A sweep ninety minutes late would otherwise
       record ninety minutes of a window that records nothing. */
    assert.strictEqual(closed[0].at, dayStatus.startOfDay(WED) + 14 * 3600000);
  } finally {
    workLog.close = realClose;
  }
});

test('MUTATION 1b — a leave pause is never auto-resumed', () => {
  const workLog = require('../src/work-log');
  /* IT IS A PAUSE: the round stays open, the slot is freed, Resume works. */
  assert.ok(workLog.PAUSE_REASONS.includes('on_leave'));
  /* AND IT IS NOT off_hours, which is the only reason resumeOverdue picks up —
     so a leave pause falls out of that sweep by being a different word rather
     than by a special case somebody could delete. */
  const src = SRC('work-log.js');
  const resume = src.slice(src.indexOf('async function resumeOverdue'), src.indexOf('function scheduleAutoPause'));
  assert.match(resume, /ended_reason = '\$\{REASONS\.off_hours\}'/);
  assert.ok(!/on_leave/.test(resume), 'resumeOverdue knows nothing about leave');
});

test('the sweep runs inside the existing one, and leave goes first', () => {
  const src = SRC('work-log.js');
  const run = src.slice(src.indexOf('const run = async () => {'), src.indexOf('const tick = () =>'));
  assert.match(run, /sweepLeave/);
  assert.ok(run.indexOf('sweepLeave') < run.indexOf('pauseOverdue'),
    'leave is settled before anything else is decided about the same session');
  /* NO SECOND SCHEDULER. The brief says to use the existing one, and there is
     one — WORK_HOURS_SWEEP_MINUTES. */
  assert.ok(!/setInterval/.test(SRC('day-status.js')), 'day-status schedules nothing of its own');
});

test('MUTATION 2 — starting work inside a leave window is refused', () => {
  const src = SRC('routes/assets.js');
  const gate = src.slice(src.indexOf("router.post('/:id/start'"), src.indexOf("router.get('/:id/hold-explain'"));
  assert.match(gate, /dayStatus\.leaveEndsAt\(leaveRow, Date\.now\(\)\)/);
  assert.match(gate, /code: 'on_leave'/);
  assert.match(gate, /You are on leave until/);

  /* AND EVERY EXISTING GATE IS STILL THERE, unchanged and beside it — this is
     one more independent refusal, not a replacement for any of them. */
  assert.match(gate, /mayStartWork\(req, asset\)/);
  assert.match(gate, /STARTABLE\.includes\(asset\.status\)/);
  assert.match(gate, /holidayRefusal\('started'\)/);
  assert.match(gate, /await timesheetRefusal\(req\)/);
});

// ===========================================================================
// 8. THE CONSUMERS: every place that sums time goes through one function.
// ===========================================================================

test('MUTATION 2b — nothing sums raw working time behind the counter\'s back', () => {
  const src = SRC('work-log.js');
  /* THE THREE PLACES A FIGURE IS PRODUCED, and each one is the shared counter:
     close() writes it, dayTotalFor() reads it per day, liveSeconds() extends it
     for a session still running. */
  assert.match(src, /\.countedSeconds\(startedAt, endedAt, \{ schedule: schedule\(\), windows \}\)/);
  assert.match(src, /\.countedMsByDay\(from, to, \{ schedule: schedule\(\), windows: leaveWindows \}\)/);
  assert.match(src, /countedSeconds\(from, now, \{ schedule: schedule\(\), windows \}\)/);

  /* AND THE FOUR READERS THAT ADD A LIVE SESSION'S SECONDS ALL PASS THE
     WINDOWS. A mutant that dropped the argument from any one of them would
     over-count exactly one screen, which is the shape of bug this asserts
     against. */
  for (const fn of ['recordedFor', 'summary', 'totalsFor', 'roundsFor']) {
    const body = src.slice(src.indexOf(`async function ${fn}`));
    const end = body.indexOf('\n}\n');
    assert.match(body.slice(0, end), /liveLeaveIndex|liveIdx|live\.get/,
      `${fn} reads the leave index`);
  }
  /* EVERY CALL CARRIES ITS WINDOWS — asserted over every line that invokes the
     function, with the definition itself excluded by its parameter list. A
     mutant that dropped the third argument from any one of them would
     over-count exactly one screen, which is the shape of bug this guards. */
  const live = src.split('\n')
    .filter((line) => /liveSeconds\(/.test(line) && !/function liveSeconds/.test(line));
  assert.ok(live.length >= 6, `found ${live.length} live-figure calls to check`);
  for (const call of live) {
    assert.match(call, /(liveIdx|live)\.get\(/, `a live figure without its windows: ${call.trim()}`);
  }
});

test('the per-day figure is the one the timesheet compares against', () => {
  /* The Time Sheet's suggested hours come from dayTotalFor, which is now the
     counter — so a leave marked after a line was filed changes the suggestion
     and the figure the save recalculates, together, with no second rule. */
  assert.match(SRC('routes/timesheets.js'), /workLog\.dayTotalFor\(db, \{ assetId, userId, day \}\)/);
  assert.match(SRC('work-log.js'), /const leaveWindows = await require\('\.\/day-status'\)/);
});

// ===========================================================================
// 9. THE PAGE.
// ===========================================================================

function pageHarness({ permissions = ['report.follow_up', 'report.remind', 'user.view',
  'followup.mark_leave', 'followup.mark_idle'], payload = null, responses = {} } = {}) {
  const from = PAGE.indexOf('let FOLLOW_UP = null;');
  const to = PAGE.indexOf('let THEME_VERSION = null;');
  assert.ok(from !== -1 && to > from, 'the follow-up section is in the page');
  const section = PAGE.slice(from, to);

  const calls = { api: [], asks: [], toasts: [] };
  const captured = { html: '' };
  let nodes = [];
  let byId = {};

  function parse(html) {
    const out = [];
    const ids = {};
    const re = /<(button|input|span|div)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const [, tag, attrsText] = m;
      const attrs = {};
      const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
      let a;
      while ((a = attrRe.exec(attrsText))) attrs[a[1]] = a[2];
      const dataset = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (!k.startsWith('data-')) continue;
        dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
      const node = {
        tagName: tag.toUpperCase(), attrs, dataset,
        disabled: /(^|\s)disabled(\s|$)/.test(attrsText),
        classes: (attrs.class || '').split(/\s+/).filter(Boolean),
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        fire(type) {
          const ev = { stopPropagation() {}, stopped: false };
          for (const fn of this.listeners[type] || []) fn(ev);
          return ev;
        },
        click() { return this.fire('click'); },
      };
      out.push(node);
      if (attrs.id) ids[attrs.id] = node;
    }
    nodes = out;
    byId = ids;
    return out;
  }

  const slot = {
    set innerHTML(v) { captured.html = v; parse(v); },
    get innerHTML() { return captured.html; },
  };
  const document = {
    getElementById: (id) => (id === 'followUpSlot' ? slot : (byId[id] || null)),
    querySelectorAll: (sel) => {
      const m = sel.match(/\[([a-z-]+)\]/);
      if (!m) return [];
      const key = m[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return nodes.filter((n) => key in n.dataset);
    },
  };

  const api = async (url, opts) => {
    calls.api.push({ url, opts });
    const key = opts && opts.method === 'POST'
      ? url.split('/').pop()
      : (/preview/.test(url) ? 'preview'
        : (/reassign-options/.test(url) ? 'reassign-options' : 'get'));
    const answer = responses[key];
    if (answer === undefined) return payload;
    if (typeof answer === 'function') return answer(opts);
    if (answer instanceof Error) throw answer;
    return answer;
  };

  /* THE PAGE'S OWN MODAL, recorded rather than drawn. There is no confirm() in
     this application — see tests/no-native-dialogs.test.js — and openAsk is the
     only way it asks anything. The stub runs `run` exactly as the real one
     does, with the typed value, so a failure inside it lands where the real one
     would put it. */
  const openAsk = async (opts) => {
    calls.asks.push(opts);
    if (opts.run) {
      try { await opts.run(opts.input ? 'a note' : true); }
      catch (err) { calls.asks[calls.asks.length - 1].failed = err; return false; }
    }
    return true;
  };

  const built = new Function(
    'document', 'escapeHTML', 'can', 'caps', 'api', 'openUserDetail', 'showToast', 'askConfirm', 'openAsk',
    `${section}
     return { renderFollowUp, wireFollowUp, paintFollowUp, markDay, undoDay,
              set: (d) => { FOLLOW_UP = d; }, get: () => FOLLOW_UP,
              setAsk: (a) => { FOLLOW_UP_ASK = a; FOLLOW_UP_SHOWN = a; },
              menu: () => FU_LEAVE_MENU, openMenu: (id) => { FU_LEAVE_MENU = id; },
              strip: (v) => { FU_STRIP_OPEN = v; } };`
  )(
    document,
    (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    (...keys) => keys.some((k) => permissions.includes(k)),
    () => ({ projectScope: 'all', reviewStage: null, deleteAsset: true, assignable: [] }),
    api,
    () => {},
    (t) => calls.toasts.push(t),
    openAsk,
    openAsk
  );
  if (payload) { built.set(payload); built.setAsk({ mode: 'day', date: payload.date }); }
  return { ...built, calls, captured, nodes: () => nodes };
}

const fuRow = (over = {}) => ({
  id: 'u-1', name: 'Ana', role: 'game_artist', roleLabel: 'Game Artist',
  held: 0, missed: 1, both: false, days: [WED], expandable: false, dayStatus: null,
  activity: { timer: null, seen: null, seenAvailable: true, streak: 0, streakCapped: false,
    streakSince: null, streakStrong: false, quietDays: 0, everActive: false },
  remind: { kind: 'start', subjectDate: WED, permitted: true, may: true,
    code: 'ok', reason: null, sent: 0, cap: 1, last: null, auto: null },
  ...over,
});

const fuPayload = (over = {}) => ({
  ok: true, unavailable: null, mode: 'day', date: WED, from: WED, to: WED,
  today: WED, previousWorkingDay: TUE,
  startedFor: { from: WED, to: WED, days: [WED] },
  filledFor: { from: TUE, to: TUE, days: [TUE] },
  workingDay: true,
  grace: { minutes: 60, holds: false, until: null, opensAt: null, clockShut: false },
  notStarted: { rows: [fuRow()], total: 1, more: 0 },
  notFilled: { rows: [], total: 0, more: 0 },
  overlap: 0, expected: 1, heldLabel: 'waiting on them',
  earliest: '2026-01-02', cap: 25, maxRangeDays: 31, notes: [],
  scope: { projects: 1, studioWide: true, roles: 8 },
  activityExplainer: 'x', streakThreshold: 3, streakLookBack: 30,
  lastSeenRecorded: true, sort: 'urgency', cached: false,
  reminders: { permitted: true, manualEnabled: true, emailEnabled: false, cap: 1,
    logged: true, window: { ok: true } },
  leave: { enabled: true, date: WED, today: true, rows: [], onLeave: 0, idle: 0,
    firstHalfEnd: '13:00', secondHalfStart: '14:00',
    actionableStatuses: dayStatus.ACTIONABLE_STATUSES },
  ...over,
});

test('the buttons appear and disappear with the server\'s switch', () => {
  const on = pageHarness({ payload: fuPayload() });
  on.paintFollowUp();
  assert.match(on.captured.html, /data-fu-leave="u-1"/);
  assert.match(on.captured.html, /data-fu-idle="u-1"/);

  const off = pageHarness({ payload: fuPayload({
    leave: { ...fuPayload().leave, enabled: false } }) });
  off.paintFollowUp();
  assert.ok(!/data-fu-leave=/.test(off.captured.html), 'no Leave button');
  assert.ok(!/data-fu-idle=/.test(off.captured.html), 'no Idle button');
  /* AND THE REST OF THE ROW IS UNTOUCHED — the switch hides two controls, not
     the section. */
  assert.match(off.captured.html, /data-fu-remind="u-1"/);

  /* THE PAGE NEVER DECIDES IT. The only reads of the flag are of the payload. */
  const section = PAGE.slice(PAGE.indexOf('let FOLLOW_UP = null;'), PAGE.indexOf('let THEME_VERSION = null;'));
  assert.ok(!/leaveIdleEnabled/.test(section), 'the page holds no copy of the rule');
});

test('MUTATION 14 — the permission gates the button, and it is a permission and not a tier', () => {
  const neither = pageHarness({ payload: fuPayload(), permissions: ['report.follow_up'] });
  neither.paintFollowUp();
  assert.ok(!/data-fu-leave=/.test(neither.captured.html));
  assert.ok(!/data-fu-idle=/.test(neither.captured.html));

  const leaveOnly = pageHarness({ payload: fuPayload(),
    permissions: ['report.follow_up', 'followup.mark_leave'] });
  leaveOnly.paintFollowUp();
  assert.match(leaveOnly.captured.html, /data-fu-leave="u-1"/);
  assert.ok(!/data-fu-idle=/.test(leaveOnly.captured.html), 'the two keys are separate');

  /* AND EVERY ENDPOINT DEMANDS ONE. */
  const route = SRC('routes/admin-dashboard.js');
  for (const path of ["router.post('/follow-up/day-status',",
    "router.post('/follow-up/day-status/clear',",
    "router.get('/follow-up/day-status/preview',"]) {
    const at = route.indexOf(path);
    assert.ok(at !== -1, `${path} exists`);
    const head = route.slice(at, at + 2000);
    assert.match(head, /requirePermission\('report\.follow_up'\)/);
    assert.match(head, /permissions\.holds\(req\.user, key\)/);
  }
  assert.match(SRC('routes/leave-settings.js'), /requirePermission\(PERMISSION\)/);
  assert.match(SRC('routes/leave-settings.js'), /const PERMISSION = 'settings\.leave\.manage'/);
  /* NEVER THE TIER. */
  const section = PAGE.slice(PAGE.indexOf('function fuDayButtons'), PAGE.indexOf('function fuLeaveStrip'));
  assert.ok(!/caps\(\)/.test(section), 'the buttons never ask the tier');
});

test('the Leave menu offers three portions with the server\'s times', () => {
  const h = pageHarness({ payload: fuPayload() });
  h.paintFollowUp();
  h.nodes().find((n) => 'fuLeave' in n.dataset).click();
  const html = h.captured.html;
  assert.match(html, /data-fu-portion="first_half"/);
  assert.match(html, /data-fu-portion="second_half"/);
  assert.match(html, /data-fu-portion="full"/);
  assert.match(html, /until 13:00/);
  assert.match(html, /from 14:00/);

  /* MUTATION 6 — THE TIMES ARE THE SERVER'S. A page that formatted the split
     itself would be a second copy of a Settings value, and the first thing it
     would do is disagree with the window actually snapshotted on the row. */
  const moved = pageHarness({ payload: fuPayload({
    leave: { ...fuPayload().leave, firstHalfEnd: '11:30', secondHalfStart: '12:30' } }) });
  moved.paintFollowUp();
  moved.openMenu('u-1');
  moved.paintFollowUp();
  assert.match(moved.captured.html, /until 11:30/);
  assert.match(moved.captured.html, /from 12:30/);
});

test('MUTATION 9b — Idle is dead with assets and alive without, and never on a past date', () => {
  const busy = pageHarness({ payload: fuPayload({
    notStarted: { rows: [fuRow({ held: 3 })], total: 1, more: 0 } }) });
  busy.paintFollowUp();
  const idle = () => busy.nodes().find((n) => 'fuIdle' in n.dataset);
  assert.ok(idle().disabled);
  assert.match(idle().attrs.title, /Has 3 assets assigned/);

  const free = pageHarness({ payload: fuPayload() });
  free.paintFollowUp();
  assert.ok(!free.nodes().find((n) => 'fuIdle' in n.dataset).disabled);

  const past = pageHarness({ payload: fuPayload({
    date: TUE, from: TUE, to: TUE,
    leave: { ...fuPayload().leave, date: TUE, today: false } }) });
  past.paintFollowUp();
  const b = past.nodes().find((n) => 'fuIdle' in n.dataset);
  assert.ok(b.disabled);
  assert.match(b.attrs.title, /only be marked for today/);
});

test('marking asks in the page, with a note, and never with a native dialog', async () => {
  const after = fuPayload({ notStarted: { rows: [], total: 0, more: 0 },
    leave: { ...fuPayload().leave, onLeave: 1, idle: 0,
      rows: [{ userId: 'u-1', name: 'Ana', kind: 'leave', portion: 'full',
        portionLabel: 'Full day', label: 'Leave — Full Day', note: null,
        setByName: 'Priya', setAt: null, planned: false, inWindow: true }] } });
  const h = pageHarness({
    payload: fuPayload(),
    responses: {
      preview: { seconds: 5400, recordedLabel: '1 h 30 m', warning: null },
      'day-status': { ok: true, status: {}, label: 'Leave — Full Day',
        leave: after.leave, notStarted: after.notStarted, notFilled: after.notFilled,
        overlap: 0, expected: 1 },
    },
  });
  h.paintFollowUp();
  await h.markDay('u-1', 'leave', 'full');

  const ask = h.calls.asks[0];
  assert.ok(ask, 'the page asked');
  assert.match(ask.title, /Mark Ana — Full Day\?/);
  assert.match(ask.message, /No hours inside that window will count/);
  assert.match(ask.message, /1 h 30 m already recorded in this period will not be counted/);
  assert.match(ask.message, /Nothing is deleted/);
  assert.ok(ask.input, 'with an optional note');

  const post = h.calls.api.find((c) => c.opts && c.opts.method === 'POST');
  assert.deepStrictEqual(post.opts.body,
    { userId: 'u-1', kind: 'leave', portion: 'full', date: WED, note: 'a note' });

  /* THE SERVER'S ANSWER IS WHAT IS DRAWN, not an optimistic guess the next
     refresh would contradict. */
  assert.strictEqual(h.get().leave.onLeave, 1);
  assert.strictEqual(h.get().notStarted.rows.length, 0, 'and they have left the list');
});

test('the strip names everybody marked, and offers Undo', async () => {
  const marked = fuPayload({
    notStarted: { rows: [], total: 0, more: 0 },
    leave: { ...fuPayload().leave, onLeave: 1, idle: 1, rows: [
      { userId: 'u-1', name: 'Ana', kind: 'leave', portion: 'first_half',
        portionLabel: 'First half', label: 'Leave — First Half (until 13:00)',
        note: 'dentist', setByName: 'Priya', setAt: '2026-03-18T04:00:00.000Z',
        planned: false, inWindow: true },
      { userId: 'u-2', name: 'Bala', kind: 'idle', portion: null,
        portionLabel: 'Idle', label: 'Idle', note: null, setByName: 'Priya',
        setAt: null, planned: true, inWindow: false },
    ] } });
  const h = pageHarness({ payload: marked });
  h.paintFollowUp();
  assert.match(h.captured.html, /On leave \(1\) · Idle \(1\)/);

  h.nodes().find((n) => 'fuStrip' in n.dataset).click();
  const html = h.captured.html;
  assert.match(html, /Ana/);
  assert.match(html, /First half/);
  assert.match(html, /dentist/);
  assert.match(html, /by Priya/);
  assert.match(html, /Planned/, 'a source other than manual is tagged');
  assert.strictEqual(h.nodes().filter((n) => 'fuUndo' in n.dataset).length, 2);
});

test('MUTATION 20b — the strip and Undo survive the switch being turned off', () => {
  const off = fuPayload({
    notStarted: { rows: [], total: 0, more: 0 },
    leave: { ...fuPayload().leave, enabled: false, onLeave: 1, idle: 0, rows: [
      { userId: 'u-1', name: 'Ana', kind: 'leave', portion: 'full', portionLabel: 'Full day',
        label: 'Leave — Full Day', note: null, setByName: 'Priya', setAt: null,
        planned: false, inWindow: true }] } });
  const h = pageHarness({ payload: off });
  h.paintFollowUp();
  assert.match(h.captured.html, /Leave &amp; Idle is disabled — existing marks still count/);
  h.nodes().find((n) => 'fuStrip' in n.dataset).click();
  assert.strictEqual(h.nodes().filter((n) => 'fuUndo' in n.dataset).length, 1,
    'nothing is ever stuck');
});

test('a half-day person who is back stays on the list, with a chip', () => {
  const h = pageHarness({ payload: fuPayload({
    notStarted: { rows: [fuRow({ dayStatus: {
      kind: 'leave', portion: 'first_half', label: 'Leave — First Half (until 13:00)',
      chip: 'Leave: first half', inWindow: false, planned: false,
      setByName: 'Priya', setAt: null, note: null } })], total: 1, more: 0 } }) });
  h.paintFollowUp();
  assert.match(h.captured.html, /Leave: first half/);
  /* AND THE ROW STILL CARRIES ITS CONTROLS — they are back, and still have not
     started, which is precisely what a lead needs to see. */
  assert.match(h.captured.html, /data-fu-remind="u-1"/);
  assert.match(h.captured.html, /data-fu-undo="u-1"/, 'with Undo in place of a second mark');
});

test('a full day for today offers the handover, and it can be skipped', async () => {
  const offer = {
    name: 'Ana', assets: [
      { id: 'a-1', code: 'CH-1', name: 'Hero', status: 'assigned', statusLabel: 'Assigned',
        projectId: 'p-1', projectName: 'Alpha' },
    ],
  };
  const h = pageHarness({
    payload: fuPayload(),
    responses: {
      preview: { seconds: 0, recordedLabel: null, warning: null },
      'day-status': { ok: true, status: {}, label: 'Leave — Full Day',
        reassign: offer, leave: fuPayload().leave,
        notStarted: { rows: [], total: 0, more: 0 }, notFilled: { rows: [], total: 0, more: 0 },
        overlap: 0, expected: 1 },
      'reassign-options': { options: [{ id: 'u-2', name: 'Bala', roleLabel: 'Game Artist' }] },
    },
  });
  h.paintFollowUp();
  await h.markDay('u-1', 'leave', 'full');

  assert.match(h.captured.html, /Ana is on leave for the whole day/);
  assert.match(h.captured.html, /CH-1 · Hero/);
  assert.match(h.captured.html, /data-fu-reassign-skip="1"/, 'and it can be skipped');

  /* IT IS A PANEL AND NOT A MODAL. The mark is already recorded and the hours
     are already excluded; a convenience that blocked the screen would not be
     one. So the lists are drawn beside it, not behind it. */
  assert.match(h.captured.html, /fu-overlap/);

  h.nodes().find((n) => 'fuReassignSkip' in n.dataset).click();
  assert.ok(!/fu-reassign/.test(h.captured.html), 'skipping closes it');
});

test('the handover is the existing flow, not a second one', () => {
  const section = PAGE.slice(PAGE.indexOf('function fuReassignOffer'), PAGE.indexOf('function fuLeaveStrip'));
  /* THE SAME TWO ENDPOINTS THE ASSET PANEL'S OWN PICKER USES — so the
     candidates cannot include somebody the server would refuse, and the move
     carries the same permissions, the same exclusivity rule and the same
     history sentence. */
  assert.match(section, /\/reassign-options/);
  assert.match(section, /\/reassign`, \{ method:'POST'/);
  assert.match(section, /is on leave/, 'and the note says why');
  /* AND IT IS NOT OFFERED FOR A HALF-DAY, which the SERVER decides. */
  const route = SRC('routes/admin-dashboard.js');
  assert.match(route, /portion === dayStatus\.PORTIONS\.full && day === today/);
});

test('no native dialog is used anywhere in this feature', () => {
  /* COMMENTS ARE STRIPPED FIRST. The prose in this feature says, more than
     once, that there is no confirm() in this application — and a scan that read
     it would be failing on its own explanation. The same correction
     tests/follow-up-reminders.test.js already carries. */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const section = strip(PAGE.slice(PAGE.indexOf('function fuDayButtons'), PAGE.indexOf('function fuShownDate')));
  for (const bad of [/\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/]) {
    assert.ok(!bad.test(section), `a native dialog appears: ${bad}`);
  }
  const settings = strip(PAGE.slice(PAGE.indexOf('async function renderLeaveSettings'),
    PAGE.indexOf('async function renderNudgeSettings')));
  for (const bad of [/\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/]) {
    assert.ok(!bad.test(settings), `a native dialog appears in Settings: ${bad}`);
  }
  /* AND THE WHOLE PAGE IS ALREADY HELD TO THIS by its own test — named here so
     the two cannot be changed apart. */
  assert.ok(fs.existsSync(path.join(__dirname, 'no-native-dialogs.test.js')));
});

// ===========================================================================
// 10. THE SEPARATION FROM THE IDLE REPORT.
// ===========================================================================

test('the Idle REPORT is untouched by the idle MARK', () => {
  /* Two different ideas with one word between them. src/idle.js measures
     coverage and records nothing; this module records a lead's statement. A
     report quietly reading a lead's opinion as a measurement is the one bug
     nobody would notice, so the separation is asserted rather than assumed. */
  const report = SRC('idle.js');
  assert.ok(!/user_day_status|day-status/.test(report),
    'the Idle Report never reads the marks');
  assert.ok(!/require\('\.\/idle'\)/.test(SRC('day-status.js')),
    'and the marks never read the report');
});

// ===========================================================================
// 11. END TO END.
//
// Driven through the real server, the real routes and a real database. The
// studio is opened 24/7 by openStudio() — which is what lets a case about
// leave assert on arithmetic rather than on what time the container thinks it
// is — and every case that depends on the hour supplies its own `now`.
// ===========================================================================

test('leave, idle and the settings, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let root;
  const token = {};
  const id = {};
  const as = (who, path, opts = {}) => api(server.base, path, { ...opts, token: token[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'leave-token',
      /* THE WORK-HOURS SWEEP IS OFF, so the leave sweep is driven explicitly by
         the cases that are about it rather than racing a timer — the same
         reason tests/follow-up-reminders.test.js switches it off. */
      WORK_HOURS_SWEEP_MINUTES: '0',
      EMAIL_SWEEP_MS: '0',
      EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'leave-token', name: 'Root', email: 'root@lv.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@lv.test');
    root = token.root;
    id.root = (await api(server.base, '/auth/me', { token: root })).body.user.id;
    await openStudio(server.base, root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@lv.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@lv.test', 'game_artist');
    /* AN ADMIN WHO OWNS NOTHING: projectScope 'owned' with no projects, which
       is the scope case — everybody is out of their reach. */
    await make('solo', 'Sol Admin', 'sol@lv.test', 'admin');
    await sql(cfg, "UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@lv.test'");

    const client = await systemClientId(server.base, root);
    const project = await as('root', '/projects', { method: 'POST', body: { name: 'Leave', clientId: client } });
    id.project = project.body.project.id;
    for (const key of ['ana', 'bo']) {
      await as('root', `/users/${id[key]}`, { method: 'PATCH', body: { projectId: id.project } });
    }
    const asset = await as('root', `/assets/project/${id.project}`, {
      method: 'POST', body: { name: 'Hero', type: 'character' } });
    id.asset = asset.body.asset.id;
  });

  t.after(() => stopServer(server));

  const today = () => require('../src/timesheet-gate').istDate(Date.now());

  /* ---------------------------------------------------------------------
   * A DATABASE HANDLE FOR THE TWO SWEEPS THIS SUITE DRIVES ITSELF, over the
   * helper's own connection rather than over src/db.
   *
   * NEVER require('../src/db') AND QUERY IT IN A TEST PROCESS. Requiring is
   * harmless; querying builds a connection pool that outlives the test, and
   * node:test then sits with a live handle and never exits — which is exactly
   * what happened here, after every assertion in this file had already passed.
   * It also points at TEST_DB_NAME rather than at this suite's own database,
   * so what it reads is the wrong schema.
   *
   * So: the same $n -> ? translation src/db.js does, over sql(cfg, …), and the
   * same { rows, result } shape the modules expect back. */
  const handle = {
    async query(text, params = []) {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
        values.push(params[Number(n) - 1]);
        return '?';
      });
      const rows = await sql(cfg, translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };
  const mark = (body, who = 'root') => as(who, '/admin-dashboard/follow-up/day-status',
    { method: 'POST', body });
  const undo = (body, who = 'root') => as(who, '/admin-dashboard/follow-up/day-status/clear',
    { method: 'POST', body });
  const settings = (body) => as('root', '/admin/settings/leave', { method: 'PUT', body });
  const rowsOf = async () => sql(cfg,
    'SELECT * FROM user_day_status WHERE user_id = ? ORDER BY seq', [id.ana]);

  /* GRANT AND RESET A ROLE'S KEYS, through the endpoint a Super Admin uses —
     never by writing to role_permissions, so the tests exercise the same
     resolution the requests do. */
  const grant = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
      body: { permissions: [...new Set([...held, ...keys])] } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
  };
  const resetRole = (role) => as('root', `/permissions/roles/${role}/reset`, { method: 'POST', body: {} });

  await t.test('MUTATION 21 (live) — the switch is off, and the server says so', async () => {
    const r = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'feature_disabled');
    assert.strictEqual((await rowsOf()).length, 0, 'and nothing was written');

    /* THE DEFAULT IS OFF, read back from the endpoint rather than from the
       module — so a migration that defaulted it on would be caught here. */
    const read = await as('root', '/admin/settings/leave');
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.settings.enabled, false);
    /* AND THE SPLIT IS A PREFILL, not a saved value — which is the state that
       makes "Reset to lunch times" able to restore anything.
       NOT ASSERTED AS 13:00 HERE: openStudio() opens the studio 24/7 with no
       breaks, so this fixture has no lunch and the prefill falls to the
       midpoint. Which source a given schedule produces is pinned in the pure
       test above, where the schedule is an argument rather than whatever the
       suite needed its clock to be. */
    assert.ok(['lunch', 'midpoint', 'noon'].includes(read.body.split.source),
      `a prefill, not a saved value: ${read.body.split.source}`);
    assert.match(read.body.split.firstHalfEnd, /^\d{2}:\d{2}$/);
    assert.strictEqual(read.body.prefill.from, read.body.split.source,
      'and the Reset link would restore exactly it');
  });

  await t.test('switching it on takes effect with no restart, and is audited', async () => {
    const on = await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00' });
    assert.strictEqual(on.status, 200, `${JSON.stringify(on.body)}\n${server.output().slice(-3000)}`);
    assert.strictEqual(on.body.settings.enabled, true);
    assert.strictEqual(on.body.split.source, 'saved', 'and the split is now a value somebody chose');

    const [log] = await sql(cfg,
      "SELECT summary, changes FROM activity_log WHERE action = 'leave_updated' ORDER BY created_at DESC LIMIT 1");
    assert.ok(log, 'a line was written');
    /* THE LABEL NOW NAMES ONSIGHT TOO, because the switch governs three kinds of
       mark rather than two (Prompt 55). The audit line is the same clause in the
       same position — summarise() diffs them positionally — so this pin moves
       with the wording and nothing else about it changed. */
    assert.match(log.summary, /Leave, Idle & Onsight OFF → Leave, Idle & Onsight on/);
    assert.ok(log.summary.length <= 500, 'and it fits the column');

    /* NO RESTART: the very next request through the same process sees it. */
    const r = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.label, 'Leave — Full Day');
  });

  await t.test('a full day takes them off both lists, and the strip names them', async () => {
    const r = await as('root', '/admin-dashboard/follow-up');
    assert.strictEqual(r.status, 200);
    const onStart = (r.body.notStarted.rows || []).some((x) => x.id === id.ana);
    assert.strictEqual(onStart, false, 'nothing to start, so nothing to chase');
    assert.strictEqual(r.body.leave.onLeave, 1);
    assert.strictEqual(r.body.leave.rows[0].name, 'Ana Artist');
    assert.strictEqual(r.body.leave.rows[0].portionLabel, 'Full day');
    assert.strictEqual(r.body.leave.enabled, true, 'the switch travels in the payload');
  });

  await t.test('the person is told, through the existing mechanism', async () => {
    const [n] = await sql(cfg,
      "SELECT kind, detail FROM notifications WHERE recipient_id = ? AND kind = 'day_status' ORDER BY created_at DESC LIMIT 1",
      [id.ana]);
    assert.ok(n, 'a notification was raised');
    assert.match(n.detail, /You were marked leave — full day for /i);
  });

  await t.test('MUTATION 2 (live) — they cannot start work inside the window', async () => {
    /* THE ASSET HAS TO BE THEIRS FIRST, or the refusal would be the ordinary
       "that is not yours" and would prove nothing about leave. */
    await as('root', `/assets/${id.asset}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    const r = await as('ana', `/assets/${id.asset}/start`, { method: 'POST', body: {} });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'on_leave');
    assert.match(r.body.error, /on leave until/i);
  });

  await t.test('MUTATION 1 (live) — a running timer is stopped, and records nothing inside', async () => {
    await undo({ userId: id.ana, date: today() });
    /* Assign the asset to Ana and start her clock, through the ordinary route. */
    await as('root', `/assets/${id.asset}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    const started = await as('ana', `/assets/${id.asset}/start`, { method: 'POST', body: {} });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const [open] = await sql(cfg, 'SELECT id FROM work_sessions WHERE user_id = ? AND ended_at IS NULL', [id.ana]);
    assert.ok(open, 'the clock is running');

    const r = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.stoppedTimers, 1, 'the timer was stopped by the mark itself');

    const [closed] = await sql(cfg, 'SELECT ended_reason, seconds FROM work_sessions WHERE id = ?', [open.id]);
    assert.strictEqual(closed.ended_reason, 'on_leave');
    assert.strictEqual(Number(closed.seconds), 0, 'and it recorded nothing inside the window');

    /* AND IT IS NOT AUTO-RESUMED. resumeOverdue picks up off_hours and only
       off_hours, so a leave pause is invisible to it. */
    const workLog = require('../src/work-log');
    const resumed = await workLog.resumeOverdue(handle).catch(() => []);
    assert.strictEqual(resumed.length, 0);
  });

  await t.test('undo restores the exact figures, by deriving them again', async () => {
    const before = await sql(cfg,
      'SELECT id, seconds FROM work_sessions WHERE user_id = ? ORDER BY started_at', [id.ana]);
    await undo({ userId: id.ana, date: today() });
    const after = await sql(cfg,
      'SELECT id, seconds FROM work_sessions WHERE user_id = ? ORDER BY started_at', [id.ana]);
    assert.strictEqual(after.length, before.length, 'nothing was deleted');
    /* The session was open for a moment, so its figure is small but real. What
       matters is that it is no longer zeroed by a window that is gone. */
    assert.ok(after.every((r) => r.seconds !== null));

    /* AND THE ROW IS KEPT AS HISTORY rather than removed. */
    const rows = await rowsOf();
    assert.ok(rows.length >= 2);
    assert.strictEqual(rows.filter((r) => r.cleared_at === null).length, 0, 'none active');
    assert.ok(rows.some((r) => r.clear_reason === 'undone'));
  });

  await t.test('MUTATION 4 — the leave does not travel with a reassigned asset', async () => {
    /* ITS OWN ASSET, WITH AN EXPLICIT HISTORY.
     *
     * This used to reuse the suite's one asset and passed under a mutation that
     * a clean run of the same sequence caught — it was passing on whatever the
     * subtests before it had left behind rather than on its own premise. So the
     * history is built here, in order, and asserted: Ana works on it, Ana goes
     * on leave for the whole day, Bo picks it up. */
    const made = await as('root', `/assets/project/${id.project}`, {
      method: 'POST', body: { name: 'Handover', type: 'character' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const asset = made.body.asset.id;

    await undo({ userId: id.ana, date: today() }).catch(() => {});
    await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    const anaStart = await as('ana', `/assets/${asset}/start`, { method: 'POST', body: {} });
    assert.strictEqual(anaStart.status, 200, JSON.stringify(anaStart.body));

    const away = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' });
    assert.strictEqual(away.status, 200, JSON.stringify(away.body));
    assert.strictEqual(away.body.stoppedTimers, 1, 'Ana\'s clock was stopped by the mark');

    /* BO PICKS IT UP AND WORKS. Their clock starts normally — the leave is
       Ana's, and it is not a property of the asset. */
    const moved = await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    assert.ok(moved.status < 400, JSON.stringify(moved.body));
    const started = await as('bo', `/assets/${asset}/start`, { method: 'POST', body: {} });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));

    const [open] = await sql(cfg,
      'SELECT id FROM work_sessions WHERE user_id = ? AND asset_id = ? AND ended_at IS NULL',
      [id.bo, asset]);
    assert.ok(open, 'Bo\'s clock runs normally');

    /* AND THE SWEEP LEAVES IT ALONE: it is Ana who is away. */
    const stopped = await dayStatus.sweepLeave(handle);
    assert.ok(!stopped.some((s) => s.userId === id.bo), 'Bo is not stopped');

    /* AND BO'S HOURS ARE BO'S.
     *
     * THE ASSERTION THAT MATTERS, and the one a "Bo can start" check does not
     * make: close() must look the windows up by the SESSION'S OWN USER. Keying
     * them on the asset instead — on whoever else has held it, which here is
     * Ana — would zero an hour Bo actually worked, and every other assertion in
     * this file would still pass.
     *
     * The session is back-dated an hour through the table so there is a
     * measurable span to lose; the studio is open 24/7 in this fixture, so that
     * hour is an hour of working time. It is then closed BY THE SERVER, through
     * an ordinary reassignment — which is the move this test is named for, and
     * which is also the only way to get the real arithmetic: close() reads the
     * work-schedule mirror, and that mirror is loaded in the server's process
     * and not in this one. */
    await sql(cfg, 'UPDATE work_sessions SET started_at = NOW() - INTERVAL 1 HOUR WHERE id = ?',
      [open.id]);
    const others = await sql(cfg,
      'SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = ? AND user_id = ?', [asset, id.ana]);
    assert.ok(Number(others[0].n) > 0, 'Ana held this asset before Bo did');

    const handed = await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: null } });
    assert.ok(handed.status < 400, JSON.stringify(handed.body));
    const [closed] = await sql(cfg, 'SELECT seconds FROM work_sessions WHERE id = ?', [open.id]);
    assert.strictEqual(Number(closed.seconds), 3600,
      'Bo\'s hour is Bo\'s — Ana\'s leave does not travel with the asset');
  });

  await t.test('MUTATION 16 — a past date needs its own permission', async () => {
    const past = '2026-03-17';
    /* The Super Admin holds every key, so this one is checked by taking the key
       away from a role and asking as that role — which is also what proves the
       gate is a PERMISSION and not a tier. */
    await grant('game_artist', ['report.admin_dashboard', 'report.follow_up', 'followup.mark_leave']);
    const r = await mark({ userId: id.bo, date: past, kind: 'leave', portion: 'full' }, 'ana');
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'past_date', JSON.stringify(r.body));
    /* AND TODAY IS ALLOWED WITH THE SAME KEYS, which is what makes the refusal
       above about the DATE and not about the permission they do hold. */
    const now = await mark({ userId: id.bo, date: today(), kind: 'leave', portion: 'full' }, 'ana');
    assert.strictEqual(now.status, 200, JSON.stringify(now.body));
    await undo({ userId: id.bo, date: today() });
    await resetRole('game_artist');
  });

  await t.test('MUTATION 13 — the scope rule is the section\'s own', async () => {
    await grant('admin', ['report.admin_dashboard', 'report.follow_up', 'followup.mark_leave', 'followup.mark_idle']);
    const r = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' }, 'solo');
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    /* AND THE REFUSAL DISCLOSES NOTHING about whether that id is a person. */
    assert.ok(!/Ana/.test(r.body.error || ''), r.body.error);
    await resetRole('admin');
  });

  await t.test('only a Super Admin may mark themselves', async () => {
    await grant('game_artist', ['report.admin_dashboard', 'report.follow_up', 'followup.mark_leave']);
    const own = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' }, 'ana');
    assert.strictEqual(own.status, 403, JSON.stringify(own.body));
    assert.strictEqual(own.body.code, 'self', JSON.stringify(own.body));
    /* AND THE SUPER ADMIN MAY: the exception is the tier that can grant every
       permission anyway, so refusing it would be a rule with no teeth. */
    const root = await mark({ userId: id.root, date: today(), kind: 'leave', portion: 'full' });
    assert.strictEqual(root.status, 200, JSON.stringify(root.body));
    await undo({ userId: id.root, date: today() });
    await resetRole('game_artist');
  });

  await t.test('a weekend is refused as already a non-working day', async () => {
    const r = await mark({ userId: id.bo, date: '2026-03-21', kind: 'leave', portion: 'full' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'non_working_day');
  });

  await t.test('MUTATION 9 (live) — idle is refused while anything is assigned', async () => {
    await undo({ userId: id.ana, date: today() }).catch(() => {});
    await as('root', `/assets/${id.asset}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    const busy = await mark({ userId: id.ana, date: today(), kind: 'idle' });
    assert.strictEqual(busy.status, 409, JSON.stringify(busy.body));
    assert.strictEqual(busy.body.code, 'has_assets');

    const past = await mark({ userId: id.bo, date: '2026-03-17', kind: 'idle' });
    assert.strictEqual(past.status, 409);
    assert.strictEqual(past.body.code, 'idle_not_today');
  });

  await t.test('MUTATION 10 (live) — assigning clears the idle mark, and nothing is blocked', async () => {
    /* Bo holds nothing, so Bo can be marked idle. */
    const idle = await mark({ userId: id.bo, date: today(), kind: 'idle' });
    assert.strictEqual(idle.status, 200, JSON.stringify(idle.body));
    const [active] = await sql(cfg,
      'SELECT kind FROM user_day_status WHERE user_id = ? AND cleared_at IS NULL', [id.bo]);
    assert.strictEqual(active.kind, 'idle');

    /* ASSIGN THROUGH THE ORDINARY ROUTE — nothing about idle is consulted. */
    const moved = await as('root', `/assets/${id.asset}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    assert.ok(moved.status < 400, JSON.stringify(moved.body));

    const after = await sql(cfg,
      'SELECT cleared_at, clear_reason FROM user_day_status WHERE user_id = ? ORDER BY seq DESC LIMIT 1', [id.bo]);
    assert.ok(after[0].cleared_at, 'the mark cleared itself');
    assert.match(after[0].clear_reason, /^assigned /);

    /* AND THEY CAN START WORK STRAIGHT AWAY. */
    const started = await as('bo', `/assets/${id.asset}/start`, { method: 'POST', body: {} });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    await as('bo', `/assets/${id.asset}/hold`, { method: 'POST', body: { note: 'done' } }).catch(() => {});
  });

  await t.test('MUTATION 18 — moving the split re-snapshots the future and nothing else', async () => {
    const past = '2026-03-17';
    const future = '2099-03-18';
    await sql(cfg, 'DELETE FROM user_day_status');
    /* One half-day on a past date and one on a future date, both written by the
       application so both carry a real snapshot. */
    const pastMark = await mark({ userId: id.ana, date: past, kind: 'leave', portion: 'first_half' });
    assert.strictEqual(pastMark.status, 200, JSON.stringify(pastMark.body));
    /* THE FUTURE ROW IS WRITTEN THE WAY PROMPT 49 WILL WRITE IT — a planned
       leave, with a snapshot taken from the split in force. The endpoint
       refuses a future date on purpose (marking something that has not happened
       is that prompt's job, not this one's), so this goes in through the module
       rather than pretending the route does something it does not. */
    await sql(cfg,
      'INSERT INTO user_day_status (id, user_id, `date`, kind, `portion`, '
      + 'window_start_time, window_end_time, source) '
      + "VALUES ('ds-planned', ?, ?, 'leave', 'first_half', 0, ?, 'planned')",
      [id.bo, future, 13 * 60]);
    const before = await sql(cfg,
      "SELECT user_id, DATE_FORMAT(`date`, '%Y-%m-%d') AS day, window_end_time "
      + 'FROM user_day_status WHERE cleared_at IS NULL');
    assert.strictEqual(before.length, 2);
    assert.ok(before.every((r) => Number(r.window_end_time) === 13 * 60));

    const moved = await settings({ enabled: true, firstHalfEndMinutes: '11:00', secondHalfStartMinutes: '12:00' });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.resnapshotted, 1, 'exactly the future row moved');

    /* FORMATTED IN SQL, not by String()ing a Date: the driver hands back a Date
       object for a DATE column and String()ing one gives "Tue Mar 17 2026 …",
       whose first ten characters are "Tue Mar 17". */
    const after = await sql(cfg,
      "SELECT DATE_FORMAT(`date`, '%Y-%m-%d') AS day, window_end_time "
      + 'FROM user_day_status WHERE cleared_at IS NULL ORDER BY `date`');
    const byDate = new Map(after.map((r) => [r.day, Number(r.window_end_time)]));
    assert.strictEqual(byDate.get(past), 13 * 60, 'the past date keeps its snapshot');
    assert.strictEqual(byDate.get(future), 11 * 60, 'and the future one moved with the split');

    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00' });
  });

  await t.test('MUTATION 20 (live) — switching off changes no total, and Undo still works', async () => {
    await sql(cfg, 'DELETE FROM user_day_status');
    await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' });
    const withLeave = await sql(cfg,
      'SELECT COALESCE(SUM(seconds), 0) AS total FROM work_sessions WHERE user_id = ?', [id.ana]);

    await settings({ enabled: false });
    const afterOff = await sql(cfg,
      'SELECT COALESCE(SUM(seconds), 0) AS total FROM work_sessions WHERE user_id = ?', [id.ana]);
    assert.strictEqual(Number(afterOff[0].total), Number(withLeave[0].total),
      'switching the feature off changed no recorded total');

    /* THE MARK STILL BLOCKS A START, because the row is what the gate reads. */
    await as('root', `/assets/${id.asset}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    const blocked = await as('ana', `/assets/${id.asset}/start`, { method: 'POST', body: {} });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));

    /* AND IT CAN STILL BE UNDONE — nothing is ever stuck. */
    const cleared = await undo({ userId: id.ana, date: today() });
    assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));

    /* AND NO NEW MARK MAY BE MADE. */
    const refused = await mark({ userId: id.ana, date: today(), kind: 'leave', portion: 'full' });
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.code, 'feature_disabled');
    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00' });
  });

  await t.test('the four permissions default to Super Admin alone', async () => {
    for (const key of ['followup.mark_leave', 'followup.mark_idle', 'followup.mark_past_dates',
      'settings.leave.manage']) {
      assert.ok(catalog.isPermission(key), `${key} is in the catalogue`);
      assert.ok(catalog.grantableKeys().includes(key), `${key} can be granted`);
    }
    /* AND A ROLE WITHOUT settings.leave.manage CANNOT REACH THE SETTINGS. */
    const r = await as('ana', '/admin/settings/leave');
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
  });
});
