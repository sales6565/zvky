/* THE LAST-ACTIVITY MARKER, AND THE REMIND BUTTON.
 *
 * ===========================================================================
 * WHAT THIS FILE IS GUARDING, and it is two different things.
 *
 * THE MARKER is a question about a DATE. Every number on it — when somebody was
 * last active, how long the silence has run — has to be read as at the end of
 * the day being viewed and not as at now, because the section can be asked
 * about last Tuesday. A marker that leaked today's data into a past date's row
 * would look right every time somebody tested it on Today, which is the only
 * day anybody tests by hand. So the first group below asks about a past date
 * and asserts that nothing from after it can reach the answer.
 *
 * THE BUTTON is a question about a RACE. One lead clicking twice, two leads
 * clicking at once, and a browser holding a list drawn ten minutes ago all have
 * to end with one message sent — and no amount of checking before the insert can
 * guarantee that, because the gap between the check and the insert is where the
 * second one lives. The unique key is the guarantee, and the test that matters
 * is the one that fires two requests at the same instant.
 *
 * ===========================================================================
 * WHY THE LIVE HALF USES THE TIMESHEET KIND AND NOT THE START KIND.
 *
 * A start reminder is about TODAY and is held while the studio is shut or on a
 * break — so a live test of one would read the real clock, pass all morning and
 * fail at lunch, on a Sunday, and in any container whose clock is in another
 * hour. That is exactly the test this codebase keeps deleting.
 *
 * A timesheet reminder is about a day that is OVER, and the brief allows one on
 * any working day, so nothing about it depends on the hour. The live half
 * therefore drives the whole send path — the cap, the race, the history, the
 * audit, the email queue — through the timesheet kind, and the start kind's
 * extra gate (weekends, holidays, the lunch blackout, the closed clock) is
 * tested exhaustively in arithmetic below with an explicit `now`, where it is
 * decided. One live case pins the start kind's own refusal, which needs no
 * clock: a start reminder for a past date.
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

const followUp = require('../src/follow-up');
const lastActivity = require('../src/last-activity');
const reminders = require('../src/reminders');
const reminderSettings = require('../src/reminder-settings');
const integrationOutbox = require('../src/integration-outbox');
const emailOutbox = require('../src/email-outbox');
const notifications = require('../src/notifications');
const catalog = require('../src/permission-catalog');
const holidays = require('../src/holidays');
const gate = require('../src/timesheet-gate');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const cfg = config('nudges');
const PASSWORD = 'Follow-Up-1!';

/* 2026 March: 16th Mon, 17th Tue, 18th Wed, 19th Thu, 20th Fri, 21st Sat, 22nd Sun. */
const MON = '2026-03-16';
const TUE = '2026-03-17';
const WED = '2026-03-18';
const THU = '2026-03-19';
const FRI = '2026-03-20';
const SAT = '2026-03-21';
const SUN = '2026-03-22';

const ist = (text) => Date.parse(`${text}+05:30`);

/* The studio's own working-day rule, asked of the gate with an empty holiday
   calendar unless a case says otherwise — the same way src/follow-up.js asks. */
const isWorkingDay = (d) => gate.isWorkingDay(d, { loggableDays: [1, 2, 3, 4, 5], isHoliday: () => false });
const shiftDays = gate.shiftDays;

// ===========================================================================
// 1. THE STREAK. Arithmetic over a set, which is what it is.
// ===========================================================================

const person = (over = {}) => ({ id: 'u-1', createdAtMs: ist('2026-01-01T09:00:00'), ...over });
const startedOn = (...days) => new Set(days.map((d) => `u-1|${d}`));

test('the streak counts working days in a row and stops at the first start', () => {
  /* Started on Monday, nothing since. Counted back from Thursday: Thu, Wed, Tue
     are three misses and Monday ends the run. */
  const out = lastActivity.streakFor(person(), {
    endDay: THU, startedSet: startedOn(MON), isWorkingDay, shiftDays,
  });
  assert.strictEqual(out.days, 3);
  assert.strictEqual(out.stopped, 'started');
  assert.strictEqual(out.since, TUE, 'and it names the working day the silence began on');
  assert.strictEqual(out.capped, false);
});

test('MUTATION 2 — weekends and holidays are skipped, never counted', () => {
  /* Started on Friday the 13th and nothing since. Counted back from Monday the
     23rd, the run is Mon 23, Fri 20, Thu 19, Wed 18, Tue 17, Mon 16 — SIX
     working days, with Saturday the 21st and Sunday the 22nd sitting in the
     middle of the walk. A rule that counted them would say eight; six is "a
     working week and a day", which is the number a lead would act on. */
  const out = lastActivity.streakFor(person(), {
    endDay: '2026-03-23', startedSet: startedOn('2026-03-13'), isWorkingDay, shiftDays,
  });
  assert.strictEqual(out.days, 6, 'Mon 23, Fri 20, Thu 19, Wed 18, Tue 17, Mon 16 — six working days');
  assert.ok(!out.since.startsWith('2026-03-21') && !out.since.startsWith('2026-03-22'),
    'and the run never begins on a weekend');

  /* AND A DECLARED HOLIDAY IS SKIPPED THE SAME WAY, through the same rule —
     this asks the gate with Wednesday declared rather than reaching past it. */
  const shut = (d) => gate.isWorkingDay(d, {
    loggableDays: [1, 2, 3, 4, 5], isHoliday: (day) => day === WED,
  });
  const withHoliday = lastActivity.streakFor(person(), {
    endDay: THU, startedSet: startedOn(TUE), isWorkingDay: shut, shiftDays,
  });
  assert.strictEqual(withHoliday.days, 1,
    'Thursday alone: Wednesday was a holiday and Tuesday ends the run');
});

test('MUTATION 2b — a day before they joined ends the walk and is not counted', () => {
  /* Joined on Wednesday morning. Counted back from Friday, Friday and Thursday
     are misses; Wednesday is their first day and Tuesday is before them. A walk
     that ignored the joining date would report a fortnight of absence for
     somebody who started on Wednesday. */
  const joined = person({ createdAtMs: ist(`${WED}T10:00:00`) });
  const out = lastActivity.streakFor(joined, {
    endDay: FRI, startedSet: new Set(), isWorkingDay, shiftDays,
  });
  assert.strictEqual(out.days, 3, 'Fri, Thu and the Wednesday they joined on');
  assert.strictEqual(out.stopped, 'joined');
  assert.strictEqual(out.since, WED);

  /* SOMEBODY WHO JOINED THIS AFTERNOON has no streak at all, not a streak of
     one: the comparison is against the END of the day, which is the same
     comparison src/follow-up.js's onBooksOn makes. */
  const today = lastActivity.streakFor(person({ createdAtMs: ist(`${FRI}T16:00:00`) }), {
    endDay: FRI, startedSet: new Set(), isWorkingDay, shiftDays,
  });
  assert.strictEqual(today.days, 1, 'their own first day counts; nothing before it does');
});

test('the look-back is bounded, and a run that hits it says so', () => {
  const out = lastActivity.streakFor(person({ createdAtMs: ist('2020-01-01T09:00:00') }), {
    endDay: FRI, startedSet: new Set(), isWorkingDay, shiftDays, lookBack: 5,
  });
  assert.strictEqual(out.days, 5);
  assert.strictEqual(out.capped, true, 'a walk that did not finish reports a floor, not a figure');
  assert.strictEqual(out.stopped, 'cap');

  /* THE DEFAULT IS THIRTY WORKING DAYS, and the calendar walk behind it is
     bounded too — a studio with a long declared shutdown must not turn the cap
     into a long loop. */
  assert.strictEqual(lastActivity.LOOKBACK_WORKING_DAYS, 30);
  assert.ok(lastActivity.LOOKBACK_CALENDAR_DAYS >= lastActivity.LOOKBACK_WORKING_DAYS);
});

test('the threshold decides the stronger marker, and it comes from Settings', () => {
  const marker = (streak, threshold) => lastActivity.markerFor(person(), {
    timer: ist(`${MON}T11:00:00`), seen: null,
    streak: { days: streak, capped: false, since: TUE, stopped: 'started' },
    asOfDay: FRI, seenAvailable: true, threshold,
  });
  assert.strictEqual(marker(2, 3).streakStrong, false, 'two is a marker but not the strong one');
  assert.strictEqual(marker(3, 3).streakStrong, true, 'three is, at the default');
  /* AND A STUDIO THAT MOVED THE THRESHOLD MOVES THE MARKER WITH IT. The number
     is a Settings value; the page never compares to a constant of its own. */
  assert.strictEqual(marker(3, 5).streakStrong, false);
  assert.strictEqual(marker(5, 5).streakStrong, true);
  assert.strictEqual(reminderSettings.DEFAULTS.streakThreshold, 3);
});

// ===========================================================================
// 2. THE TWO FACTS, AS OF A DATE. The queries, by their shape and parameters.
// ===========================================================================

function stubDb(answers = []) {
  const calls = [];
  return {
    calls,
    sqlFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).sql || ''; },
    paramsFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).params || []; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of answers) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows, result: {} };
      }
      return { rows: [], result: {} };
    },
  };
}

test('MUTATION 1 — no activity from after the date being viewed can reach the row', async () => {
  const db = stubDb();
  await lastActivity.markersFor(db, [person()], {
    asOfDay: TUE, endDay: TUE, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });

  /* 17 March in IST ends at 17 March 18:30 UTC. BOTH queries carry that bound,
     and it is the whole of the as-of rule: a row written on Wednesday cannot be
     read by a question about Tuesday. A mutant that dropped either bound — or
     used NOW() — would report Wednesday's activity on Tuesday's row. */
  const timer = db.paramsFor(/FROM work_sessions w/);
  assert.strictEqual(timer[1], '2026-03-17 18:30:00', 'the timer half is bounded by the day');
  assert.match(db.sqlFor(/FROM work_sessions w/), /w\.started_at < \$2/);
  assert.ok(!/NOW\(\)|CURRENT_TIMESTAMP/.test(db.sqlFor(/FROM work_sessions w/)),
    'and never asks the database what time it is');

  const seen = db.paramsFor(/FROM activity_log a/);
  assert.strictEqual(seen[1], '2026-03-17 18:30:00', 'and so is the last-seen half');
  assert.match(db.sqlFor(/FROM activity_log a/), /a\.created_at < \$2/);
  assert.ok(!/NOW\(\)|CURRENT_TIMESTAMP/.test(db.sqlFor(/FROM activity_log a/)));

  /* AND A CLOSE THAT FALLS AFTER THE DATE IS NOT THE ANSWER EITHER. A session
     opened on Tuesday and stopped on Thursday contributes its OPEN to Tuesday's
     row — the only one of its two moments that had happened by then. */
  assert.match(db.sqlFor(/FROM work_sessions w/),
    /CASE WHEN w\.ended_at IS NOT NULL AND w\.ended_at < \$2/);
});

test('both facts are read, separately, and neither is invented', async () => {
  const db = stubDb([
    [/FROM work_sessions w/, [{ userId: 'u-1', at: '2026-03-16 12:10:00' }]],
    [/FROM activity_log a/, [{ userId: 'u-1', at: '2026-03-17 04:00:00' }]],
  ]);
  const { markers } = await lastActivity.markersFor(db, [person()], {
    asOfDay: TUE, endDay: TUE, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });
  const m = markers.get('u-1');
  /* 16 March 12:10 UTC is 17:40 IST on the 16th, which from Tuesday is
     yesterday — the brief's own example, "yesterday 5:40 PM". */
  assert.strictEqual(m.timer.relative, 'yesterday 5:40 PM');
  assert.strictEqual(m.timer.exact, '16 Mar 2026, 5:40 PM IST');
  // 17 March 04:00 UTC is 09:30 IST the same day.
  assert.strictEqual(m.seen.relative, 'today 9:30 AM');
  assert.strictEqual(m.seen.exact, '17 Mar 2026, 9:30 AM IST');
  assert.strictEqual(m.everActive, true);
  assert.strictEqual(m.quietDays, 1, 'one calendar day of silence, which is what the sort reads');
});

test('a new user reads "no activity yet" rather than a date in 1970', async () => {
  const db = stubDb();
  const { markers } = await lastActivity.markersFor(db, [person()], {
    asOfDay: TUE, endDay: TUE, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });
  const m = markers.get('u-1');
  assert.strictEqual(m.timer, null, 'null, not zero — a missing stamp must not become an epoch');
  assert.strictEqual(m.seen, null);
  assert.strictEqual(m.everActive, false);
  assert.strictEqual(m.quietDays, -1, 'and it sorts first: no activity is the longest silence there is');
  assert.match(PAGE, /No activity yet/, 'which the page says in words');
});

test('an unreadable Activity Log is "not recorded", not "never"', async () => {
  const db = {
    async query(sql) {
      if (/activity_log/.test(sql)) { const e = new Error('nope'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
      return { rows: [], result: {} };
    },
  };
  const out = await lastActivity.markersFor(db, [person()], {
    asOfDay: TUE, endDay: TUE, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });
  assert.strictEqual(out.seenAvailable, false);
  assert.strictEqual(out.markers.get('u-1').seenAvailable, false);
  assert.match(PAGE, /last seen not recorded/, 'and the row says so');
});

test('what counts as activity is stated, and last-seen is not overstated', () => {
  /* THE EXPLAINER IS THE SERVER'S, and it is the tooltip. A second description
     living in the browser would go on saying "every authenticated request" long
     after somebody changed what is logged.
     
     AND IT DOES NOT CLAIM A HEARTBEAT. activity_log excludes GET and HEAD by
     design (see src/middleware/activity.js), so "last seen" is the last ACTION
     plus the sign-in — never "the last time they had the app open". The sentence
     says so, because a marker that overstated it would have a lead chasing
     somebody who had been reading boards all afternoon. */
  assert.match(lastActivity.EXPLAINER, /work session was started, paused, resumed or stopped/);
  assert.match(lastActivity.EXPLAINER, /includes signing in but not/);
  assert.match(lastActivity.EXPLAINER, /no per-request heartbeat/);
  assert.match(lastActivity.EXPLAINER, /end of the day being viewed/);

  /* AND THERE IS NO last_seen COLUMN ON users, which is the premise the above
     rests on. Pinned so that adding one has to come past this line and decide
     what the marker should then say. */
  assert.ok(!/last_seen/.test(SRC('user-fields.js')),
    'no last-seen column was invented on the user record');
  assert.match(SRC('last-activity.js'), /WHY NO THROTTLED last_seen COLUMN WAS ADDED/,
    'and the decision not to add one is recorded with its reasoning');
});

// ===========================================================================
// 3. THE DECISION. Twelve refusals, in arithmetic, in one order.
// ===========================================================================

const ON = { manualEnabled: true, emailEnabled: false, dailyCap: 1, streakThreshold: 3 };
const ANA = { id: 'u-1', name: 'Ana' };

/* Everything decide() needs for a timesheet reminder that should go. Each case
   below changes one fact, which is the only way to be sure the order is the
   order. */
const facts = (over = {}) => ({
  kind: reminders.KINDS.timesheet,
  settings: ON,
  person: ANA,
  inScope: true,
  listed: true,
  subjectDate: TUE,
  today: THU,
  workingDay: true,
  window: null,
  manualCount: 0,
  backdateClosed: null,
  actorId: 'lead-1',
  ...over,
});

test('a timesheet reminder about a past working day is allowed', () => {
  const out = reminders.decide(facts());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.slot, 0, 'and it claims the first slot of the day');
});

test('MUTATION 4 — the condition is re-checked, and a cleared person is refused', () => {
  const started = reminders.decide(facts({ kind: reminders.KINDS.start, subjectDate: THU, listed: false }));
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.code, 'already_started');
  assert.strictEqual(started.message, 'Ana has started work since this list loaded.',
    'the brief\'s own sentence, with the person named');

  const filled = reminders.decide(facts({ listed: false }));
  assert.strictEqual(filled.code, 'already_filled');
  assert.match(filled.message, /has filled their timesheet for 2026-03-17 since this list loaded/);
});

test('MUTATION 7 — scope is decided before the condition, and before the clock', () => {
  /* THE ORDER IS THE DISCLOSURE. "Ana has started work since this list loaded"
     about somebody outside your projects would answer the question the scope
     rule exists to withhold, so scope refuses first and the refusal says
     nothing about their morning. */
  const out = reminders.decide(facts({ inScope: false, listed: false }));
  assert.strictEqual(out.code, 'out_of_scope');
  assert.match(out.message, /not in the projects you can see/);
  assert.ok(!/started|timesheet/.test(out.message), 'and it discloses nothing about them');
});

test('MUTATION 5 — the cap is the server\'s, and it is the configured one', () => {
  const one = reminders.decide(facts({ manualCount: 1 }));
  assert.strictEqual(one.code, 'capped');
  assert.strictEqual(one.message, 'Ana has already been reminded today.');

  /* A STUDIO THAT RAISED THE CAP gets the slots it asked for, and the sentence
     counts. A mutant that compared to a literal 1 would refuse the second of
     three. */
  const three = { ...ON, dailyCap: 3 };
  assert.strictEqual(reminders.decide(facts({ settings: three, manualCount: 1 })).ok, true);
  assert.strictEqual(reminders.decide(facts({ settings: three, manualCount: 2 })).slot, 2);
  const spent = reminders.decide(facts({ settings: three, manualCount: 3 }));
  assert.strictEqual(spent.code, 'capped');
  assert.match(spent.message, /3 reminders today, which is the cap of 3/);
});

test('manual reminders switched off refuse everything, first', () => {
  const out = reminders.decide(facts({ settings: { ...ON, manualEnabled: false }, inScope: false }));
  assert.strictEqual(out.code, 'manual_off', 'the studio-wide answer outranks the personal one');
  assert.match(out.message, /Settings → Start-of-day nudges/);
});

test('a start reminder is about today, and says so about any other day', () => {
  const out = reminders.decide(facts({ kind: reminders.KINDS.start, subjectDate: TUE, today: THU }));
  assert.strictEqual(out.code, 'start_not_today');
  assert.match(out.message, /use the timesheet reminder for a past day/);
});

test('MUTATION 3 — a start reminder is held on a non-working day and through a break', () => {
  /* THE STUDIO'S OWN SCHEDULE SHAPE — named windows, as Settings -> Recording
     Hours stores them and as src/working-time.js reads them. Written out here
     rather than taken from the live mirror so the case does not move when
     somebody edits the studio's hours: 09:30 to 19:00, with an hour's lunch and
     a quarter of an hour for tea. */
  const schedule = {
    workingDays: [1, 2, 3, 4, 5],
    entries: [
      { daysOfWeek: [1, 2, 3, 4, 5], start: 570, end: 1140, type: 'recording' },
      { daysOfWeek: [1, 2, 3, 4, 5], start: 780, end: 840, type: 'non_recording' },
      { daysOfWeek: [1, 2, 3, 4, 5], start: 660, end: 675, type: 'non_recording' },
    ],
    holidays: [],
  };

  // Mid-morning on a working day: nothing is in the way.
  const working = reminders.windowState(ist(`${WED}T10:30:00`), { schedule });
  assert.strictEqual(working.ok, true);

  /* LUNCH. The hour is not written anywhere here: it is the gap between the
     studio's own recording windows, so a studio that moves lunch moves the
     blackout with it. */
  const lunch = reminders.windowState(ist(`${WED}T13:30:00`), { schedule });
  assert.strictEqual(lunch.code, 'blackout');
  assert.match(lunch.message, /on a break until 2:00pm/);
  assert.match(lunch.message, /nudging somebody through their lunch/);

  /* THE FIFTEEN-MINUTE TEA BREAK IS NOT A BLACKOUT, which is the other half of
     deriving it: a gap shorter than the named minimum is not what anybody means
     by one. */
  const tea = reminders.windowState(ist(`${WED}T11:05:00`), { schedule });
  assert.strictEqual(tea.ok, true, 'a quarter of an hour is not a blackout');
  assert.strictEqual(reminders.BLACKOUT_MIN_BREAK_MINUTES, 30);

  // Before the studio opens, and after it closes.
  assert.strictEqual(reminders.windowState(ist(`${WED}T08:00:00`), { schedule }).code, 'clock_shut');
  assert.match(reminders.windowState(ist(`${WED}T08:00:00`), { schedule }).message, /opens at 9:30am/);
  assert.match(reminders.windowState(ist(`${WED}T20:00:00`), { schedule }).message, /closed at 7:00pm/);

  // A Sunday has no recording windows at all.
  assert.strictEqual(reminders.windowState(ist(`${SUN}T11:00:00`), { schedule }).code, 'clock_shut');

  /* AND decide() REFUSES ON THE WINDOW'S OWN ANSWER rather than forming a
     second opinion about the clock. */
  const held = reminders.decide(facts({
    kind: reminders.KINDS.start, subjectDate: THU, today: THU, window: lunch,
  }));
  assert.strictEqual(held.code, 'blackout');
  assert.strictEqual(held.message, lunch.message);

  // A holiday or a weekly off is the day's own answer, not the clock's.
  const shut = reminders.decide(facts({
    kind: reminders.KINDS.start, subjectDate: SAT, today: SAT, workingDay: false,
  }));
  assert.strictEqual(shut.code, 'not_working_day');
  assert.match(shut.message, /a weekly off or a holiday/);

  /* AND NONE OF IT APPLIES TO A TIMESHEET REMINDER. Paperwork about a day that
     is over can be asked for at any hour — the brief says so, and the window is
     never even consulted. */
  assert.strictEqual(reminders.decide(facts({ window: lunch })).ok, true);
});

test('a day nobody can still file for is refused, with the limit named', () => {
  /* THE BRIEF ASKS THAT THIS BE SAID "rather than asking them to do something
     they cannot" — and a reminder IS the asking, so the refusal is the whole of
     saying it. A notice with a caveat attached would be a message whose second
     sentence withdraws its first. */
  const closed = reminders.backdateState(MON, { today: FRI, policy: { backdateDays: 2 } });
  assert.deepStrictEqual(closed, { days: 2, behind: 4 });
  const out = reminders.decide(facts({ subjectDate: MON, backdateClosed: closed }));
  assert.strictEqual(out.code, 'backdate_closed');
  assert.match(out.message, /limited to 2 day\(s\)/);
  assert.match(out.message, /nothing Ana can do about it/);

  // No limit configured is what this application shipped with, and it is null.
  assert.strictEqual(reminders.backdateState(MON, { today: FRI, policy: { backdateDays: null } }), null);
  assert.strictEqual(reminders.backdateState(THU, { today: FRI, policy: { backdateDays: 2 } }), null);
});

test('nobody reminds themselves', () => {
  const out = reminders.decide(facts({ actorId: 'u-1' }));
  assert.strictEqual(out.code, 'self');
  /* AND THE NOTIFICATION LAYER WOULD HAVE DROPPED IT ANYWAY — raise() returns
     null when the recipient is the actor — so this refusal is what turns a
     silent nothing into a sentence. */
  assert.match(SRC('notifications.js'), /if \(!recipientId \|\| recipientId === actorId\) return null;/);
});

test('the two sentences are the brief\'s, and they are composed once', () => {
  const start = reminders.sentenceFor({
    kind: reminders.KINDS.start,
    actor: { name: 'Priya', role: 'team_lead' },
    person: ANA, subjectDate: THU, waiting: 4,
  });
  assert.strictEqual(start, 'Priya (Team Lead) is checking in: you haven’t started work today.'
    + ' You have 4 tasks waiting.');
  // One task is one task, not "1 tasks".
  assert.match(reminders.sentenceFor({
    kind: reminders.KINDS.start, actor: { name: 'Priya', role: 'team_lead' },
    person: ANA, subjectDate: THU, waiting: 1,
  }), /You have 1 task waiting\.$/);

  const sheet = reminders.sentenceFor({
    kind: reminders.KINDS.timesheet, actor: { name: 'Priya' }, person: ANA, subjectDate: TUE,
  });
  assert.strictEqual(sheet, 'Please fill your timesheet for 17 Mar 2026.');

  /* ONE PLACE. The in-app notice, the email and the history row all read this
     function — three copies of a sentence is three places for the date in it to
     be formatted differently. */
  assert.match(SRC('reminders.js'), /THE WORDS, in one place, for all three consumers/);
  assert.ok(!/is checking in/.test(SRC('email-notifications.js')),
    'the email does not write its own version of the sentence');
});

test('the retry policy is the studio\'s existing one, not a second copy', () => {
  /* PROMPT 17'S QUEUE, UNCHANGED. A reminder email goes on the same outbox, with
     the same backoff and the same permanent-failure behaviour as every other
     message — which is what "inherit the existing retry behaviour" has to mean
     when there is exactly one queue. Asserted by identity, so a second schedule
     typed out anywhere would fail here. */
  assert.strictEqual(emailOutbox.BACKOFF_SECONDS, integrationOutbox.BACKOFF_SECONDS);
  assert.deepStrictEqual(emailOutbox.BACKOFF_SECONDS, [60, 300, 1800, 7200, 21600, 86400]);
  assert.strictEqual(emailOutbox.MAX_ATTEMPTS, 7);
  assert.match(SRC('email-notifications.js'), /emailOutbox\.enqueue\(db, \{ to: to\.email, \.\.\.message \}\)/);
});

test('MUTATION 8 — an email is sent only when the studio has switched it on', () => {
  /* THE GATE IS IN THE SEND PATH, not in the message builder: deliver() asks
     the settings mirror and only then calls the email side at all. A mutant that
     dropped the condition would mail the floor from a studio that had never
     switched it on. */
  const src = SRC('reminders.js');
  assert.match(src, /if \(settings\.emailEnabled\) \{/);
  assert.match(src, /email = await emailNotifications\.reminder\(db, \{/);
  /* AND OFF IS THE DEFAULT, which is the decision this change made where the
     brief was silent. */
  assert.strictEqual(reminderSettings.DEFAULTS.emailEnabled, false);
  assert.strictEqual(reminderSettings.DEFAULTS.manualEnabled, true);
  /* The opt-out and the missing address are the SAME gate, recipient(), where
     every other email in that file is gated. */
  assert.match(SRC('email-notifications.js'), /const to = await recipient\(db, recipientId\);\n    if \(!to\) return \{ queued: false, reason: 'no_mailable_address' \};/);
});

test('the notice travels on the existing notification path, with two new kinds', () => {
  assert.strictEqual(notifications.KINDS.start_reminder, 'start_reminder');
  assert.strictEqual(notifications.KINDS.timesheet_reminder, 'timesheet_reminder');
  /* ONE PATH. notifications.raise is the choke point the bell, the desktop
     notification and the phone push all hang off, so a reminder reaches all
     three without src/reminders.js knowing any of them exist. */
  assert.match(SRC('reminders.js'), /notified = await notifications\.raise\(db, \{/);
  assert.ok(!/INSERT INTO notifications/.test(SRC('reminders.js')),
    'and it never writes that table itself');
  // And the page has a title for each, so a row in the bell is not "Something".
  assert.match(PAGE, /start_reminder: *'[^']+'/);
  assert.match(PAGE, /timesheet_reminder: *'[^']+'/);
});

test('the daily cap is enforced by a key, and the key spans the slot', () => {
  /* WHY A KEY AND NOT A COUNT: two leads clicking in the same instant both read
     "nobody has been reminded" and both send. The gap between the check and the
     insert is where the second one lives, so the database decides instead. */
  const migrate = SRC('migrate.js');
  assert.match(migrate, /UNIQUE KEY uq_reminder_slot \(recipient_id, kind, source, sent_on, slot\)/);
  assert.match(SRC('reminders.js'), /err\.code === 'ER_DUP_ENTRY'/);
  /* THE ROW IS CLAIMED BEFORE ANYTHING IS SENT. A notice delivered and then
     recorded could be delivered twice; a row recorded and then not delivered is
     visible on the screen and can be resent tomorrow. */
  assert.match(SRC('reminders.js'), /THE ROW IS CLAIMED BEFORE ANYTHING IS SENT/);
  const claimAt = SRC('reminders.js').indexOf('const claimed = await claim(db,');
  const raiseAt = SRC('reminders.js').indexOf('notified = await notifications.raise(');
  assert.ok(claimAt > 0 && raiseAt > claimAt, 'and the claim really is first');
});

// ===========================================================================
// 4. THE PAGE. Rendered and clicked, not read.
// ===========================================================================

/* The section lifted out of the page and run against a stub DOM, the same way
 * tests/follow-up.test.js lifts it — with the three things the reminder half
 * reaches for added to the stubs: a toast, the page's own modal, and a fetch.
 *
 * DRIVEN RATHER THAN GREPPED, because the four risks on this side of the wire —
 * a double submit, a disabled button with no reason on it, a confirmation
 * stating the wrong count, and a gate asking the tier — all look fine in the
 * source and only show up when the thing is used.
 */
function pageHarness({ permissions = ['report.follow_up', 'report.remind', 'user.view'],
  payload = null, responses = {} } = {}) {
  const from = PAGE.indexOf('let FOLLOW_UP = null;');
  const to = PAGE.indexOf('let THEME_VERSION = null;');
  assert.ok(from !== -1 && to > from, 'the follow-up section is in the page');
  const section = PAGE.slice(from, to);

  const calls = { api: [], toasts: [], asks: [] };
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
        tagName: tag.toUpperCase(),
        attrs, dataset,
        /* The disabled ATTRIBUTE, as the browser would see it: present means out
           of the tab order and deaf to a click. Matched as a bare word in the
           tag's attributes, because that is how a conditional template writes
           it — on a line of its own, with no value and no quotes. */
        disabled: /(^|\s)disabled(\s|$)/.test(attrsText),
        classes: (attrs.class || '').split(/\s+/).filter(Boolean),
        value: attrs.value || '',
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        fire(type) {
          const ev = { stopPropagation() { this.stopped = true; }, stopped: false };
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
    const key = opts && opts.method === 'POST' ? url.split('/').pop() : 'get';
    const answer = responses[key];
    if (answer === undefined) return payload;
    if (typeof answer === 'function') return answer(opts);
    if (answer instanceof Error) throw answer;
    return answer;
  };

  /* THE PAGE'S OWN MODAL, recorded rather than drawn. askConfirm is the only way
     this application asks a question — see the note above openAsk — and the
     stub runs `run` exactly as the real one does so a failure inside it lands
     where the real one would put it. */
  const askConfirm = async (opts) => {
    calls.asks.push(opts);
    if (opts.run) {
      try { await opts.run(true); } catch (err) { calls.asks[calls.asks.length - 1].failed = err; return false; }
    }
    return true;
  };

  const built = new Function(
    'document', 'escapeHTML', 'can', 'caps', 'api', 'openUserDetail', 'showToast', 'askConfirm',
    `${section}
     return {
       renderFollowUp, wireFollowUp, loadFollowUp, paintFollowUp,
       sendReminder, remindEveryone, fuSkipLabel,
       set: (d) => { FOLLOW_UP = d; }, get: () => FOLLOW_UP,
       setAsk: (a) => { FOLLOW_UP_ASK = a; FOLLOW_UP_SHOWN = a; },
       sending: () => FU_SENDING, msgs: () => FU_ROW_MSG,
     };`
  )(
    document,
    (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    (...keys) => keys.some((k) => permissions.includes(k)),
    /* caps() answers the TIER, and the section must never ask it. Given a
       generous answer on purpose: a gate that read it would PASS rather than
       fail, which is exactly the shape of the bug. */
    () => ({ projectScope: 'all', manageUsers: true }),
    api,
    () => {},
    (t) => calls.toasts.push(t),
    askConfirm,
  );

  if (payload) built.set(payload);
  return { ...built, calls, captured, nodes: () => nodes, slot };
}

/* A payload of the shape src/follow-up.js now builds, with the marker and the
   reminder state on each row. */
function remindRow(over = {}) {
  return {
    id: 'u-1', name: 'Ana', role: 'game_artist', roleLabel: 'Game Artist',
    held: 3, missed: 1, both: false, days: [TUE],
    activity: {
      timer: { at: '2026-03-16T12:10:00.000Z', relative: 'yesterday 5:40 PM', exact: '16 Mar 2026, 5:40 PM IST' },
      seen: { at: '2026-03-17T04:00:00.000Z', relative: 'today 9:30 AM', exact: '17 Mar 2026, 9:30 AM IST' },
      seenAvailable: true, streak: 3, streakCapped: false, streakSince: MON,
      streakStrong: true, quietDays: 1, everActive: true,
    },
    remind: {
      kind: 'timesheet', subjectDate: TUE, permitted: true, may: true,
      code: 'ok', reason: null, sent: 0, cap: 1, last: null, auto: null,
    },
    ...over,
  };
}

function remindPayload(rows, over = {}) {
  return {
    ok: true, unavailable: null, mode: 'day', date: TUE, from: TUE, to: TUE,
    today: WED, previousWorkingDay: TUE,
    startedFor: { from: TUE, to: TUE, days: [TUE] },
    filledFor: { from: TUE, to: TUE, days: [TUE] },
    workingDay: true,
    grace: { minutes: 60, holds: false, until: null, opensAt: null, clockShut: false },
    notStarted: { rows: [], total: 0, more: 0 },
    notFilled: { rows, total: rows.length, more: 0 },
    overlap: 0, expected: rows.length, heldLabel: 'held that day',
    earliest: '2026-01-02', cap: 25, maxRangeDays: 31, notes: [],
    scope: { projects: 1, studioWide: true, roles: 8 },
    activityExplainer: lastActivity.EXPLAINER,
    streakThreshold: 3, streakLookBack: 30, lastSeenRecorded: true, sort: 'urgency',
    cached: false,
    reminders: { permitted: true, manualEnabled: true, emailEnabled: false, cap: 1,
      logged: true, window: { ok: true, code: 'ok', message: null } },
    ...over,
  };
}

test('the marker and the streak are drawn, with the exact time on hover', () => {
  const h = pageHarness({ payload: remindPayload([remindRow()]) });
  h.paintFollowUp();
  const html = h.captured.html;
  assert.match(html, /timer yesterday 5:40 PM/, 'the relative words the server sent');
  assert.match(html, /seen today 9:30 AM/);
  assert.match(html, /16 Mar 2026, 5:40 PM IST/, 'and the exact IST stamp, in the tooltip');
  assert.match(html, /3 working days · repeated/, 'the streak, in words');
  assert.match(html, /fu-streak is-strong/, 'and the stronger marker at the threshold');
  /* NEVER COLOUR ALONE: the strong badge carries "!" and the word "repeated", so
     it reads the same in greyscale and to a screen reader. */
  assert.match(html, /! 3\+?\s?working days/);
  assert.match(html, /The run starts on 2026-03-16/, 'and the tooltip says where it began');
});

test('the marker and the streak come from the server, not from the browser', () => {
  /* A payload whose streak is two, with a threshold of two: the page must draw
     the strong form because the SERVER said so, and never because it compared
     the number to a three of its own. */
  const row = remindRow();
  row.activity = { ...row.activity, streak: 2, streakStrong: true };
  const h = pageHarness({ payload: remindPayload([row], { streakThreshold: 2 }) });
  h.paintFollowUp();
  assert.match(h.captured.html, /fu-streak is-strong/);

  // And one under the marker's own floor is not drawn at all.
  const quiet = remindRow();
  quiet.activity = { ...quiet.activity, streak: 1, streakStrong: false };
  const h2 = pageHarness({ payload: remindPayload([quiet]) });
  h2.paintFollowUp();
  assert.ok(!/fu-streak/.test(h2.captured.html), 'one miss is not a streak');
});

test('MUTATION 11 — the remind gate is the permission, never the tier', () => {
  const rows = [remindRow()];
  const without = pageHarness({ permissions: ['report.follow_up', 'user.view'],
    payload: remindPayload(rows) });
  without.paintFollowUp();
  assert.ok(!/data-fu-remind/.test(without.captured.html),
    'no button at all without report.remind — and caps() says the tier would pass');
  assert.ok(!/Remind all/.test(without.captured.html));

  const with_ = pageHarness({ payload: remindPayload(rows) });
  with_.paintFollowUp();
  assert.match(with_.captured.html, /data-fu-remind="u-1"/);
  assert.match(with_.captured.html, /Remind all \(1\)/);

  /* AND THE SERVER'S OWN ANSWER IS THE OTHER HALF. A page that held the key but
     a server that did not resolve it draws nothing either, so the two cannot
     disagree about who may send. */
  const serverSaysNo = pageHarness({
    payload: remindPayload(rows, { reminders: { permitted: false, manualEnabled: true,
      emailEnabled: false, cap: 1, logged: true, window: { ok: true } } }),
  });
  const noRows = [remindRow({ remind: { ...remindRow().remind, permitted: false } })];
  serverSaysNo.set(remindPayload(noRows, { reminders: { permitted: false, manualEnabled: true,
    emailEnabled: false, cap: 1, logged: true, window: { ok: true } } }));
  serverSaysNo.paintFollowUp();
  assert.ok(!/data-fu-remind="u-1"/.test(serverSaysNo.captured.html));

  /* THE SECTION NEVER ASKS THE TIER, which the grep pins as evidence of intent
     beside the behaviour above. */
  const slice = PAGE.slice(PAGE.indexOf('let FOLLOW_UP = null;'), PAGE.indexOf('let THEME_VERSION = null;'));
  assert.ok(!/caps\(\)/.test(slice), 'caps() is never consulted in this section');
});

test('a refused reminder is disabled WITH the server\'s reason, reachable by keyboard', () => {
  const row = remindRow({ remind: {
    kind: 'timesheet', subjectDate: TUE, permitted: true, may: false,
    code: 'capped', reason: 'Ana has already been reminded today.',
    sent: 1, cap: 1,
    last: { at: '2026-03-18T05:35:00.000Z', by: 'Priya', channels: ['in_app'] },
    auto: { at: '2026-03-18T05:00:00.000Z', channels: ['in_app'] },
  } });
  const h = pageHarness({ payload: remindPayload([row]) });
  h.paintFollowUp();
  const html = h.captured.html;

  const button = h.nodes().find((n) => 'fuRemind' in n.dataset);
  assert.ok(button.disabled, 'the button is out of the tab order');
  /* THE REASON IS IN THREE PLACES and that is deliberate: the title for a
     mouse, a real element for a screen reader through aria-describedby, and
     visible text for everybody else. A tooltip alone is not reachable by
     keyboard. */
  assert.strictEqual(button.attrs.title, 'Ana has already been reminded today.');
  assert.match(html, /aria-describedby="fu_rd_timesheet_u-1"/);
  assert.match(html, /<span class="fu-reason" id="fu_rd_timesheet_u-1">Ana has already been reminded today\./);

  /* WHO SENT IT AND WHEN, visible to every lead who can see the list — which is
     the whole reason it is on the row rather than in the clicker's own session. */
  assert.match(html, /Reminded today 11:05am by Priya/);
  /* AND WHETHER THE STUDIO'S OWN REMINDER HAS ALREADY GONE OUT TODAY. */
  assert.match(html, /Auto reminder sent 10:30am/);
});

test('MUTATION 6b — one click, one request: the button cannot be submitted twice', async () => {
  let resolve;
  const held = new Promise((r) => { resolve = r; });
  const h = pageHarness({
    payload: remindPayload([remindRow()]),
    responses: { remind: () => held },
  });
  h.paintFollowUp();

  const button = () => h.nodes().find((n) => 'fuRemind' in n.dataset);
  const first = h.sendReminder('timesheet', 'u-1');
  /* The key goes in before the request leaves, so the repaint that follows
     draws the button disabled and reading "Sending…". */
  assert.ok(h.sending().has('timesheet|u-1'));
  assert.ok(button().disabled);
  assert.match(h.captured.html, /Sending…/);

  // A second click inside the same window is dropped, not queued.
  await h.sendReminder('timesheet', 'u-1');
  resolve({ ok: true, channels: ['in_app'], row: remindRow({ remind: {
    ...remindRow().remind, may: false, code: 'capped', sent: 1,
    reason: 'Ana has already been reminded today.',
    last: { at: '2026-03-18T05:35:00.000Z', by: 'Priya', channels: ['in_app'] },
  } }) });
  await first;

  const posts = h.calls.api.filter((c) => c.opts && c.opts.method === 'POST');
  assert.strictEqual(posts.length, 1, 'one request, however many clicks');
  assert.deepStrictEqual(posts[0].opts.body, { userId: 'u-1', kind: 'timesheet', date: TUE });
});

test('after a send the row carries what the server returned, and survives a redraw', async () => {
  const after = remindRow({ remind: {
    ...remindRow().remind, may: false, code: 'capped', sent: 1,
    reason: 'Ana has already been reminded today.',
    last: { at: '2026-03-18T05:35:00.000Z', by: 'Priya', channels: ['in_app', 'email'] },
  } });
  const h = pageHarness({
    payload: remindPayload([remindRow()]),
    responses: { remind: { ok: true, channels: ['in_app', 'email'], row: after } },
  });
  h.paintFollowUp();
  await h.sendReminder('timesheet', 'u-1');

  assert.match(h.captured.html, /Reminded · emailed/, 'the result is said on the row');
  assert.match(h.captured.html, /Reminded today 11:05am by Priya/);
  const button = h.nodes().find((n) => 'fuRemind' in n.dataset);
  assert.ok(button.disabled, 'and the button is disabled with the reason on it');

  /* IT SURVIVES THE TIMED REFRESH because it is not a guess: the row in module
     state IS the server's row, so the next draw — from the cache or from a new
     payload — says the same thing. Painted again here with nothing else
     touched. */
  h.paintFollowUp();
  assert.match(h.captured.html, /Reminded today 11:05am by Priya/);
  assert.strictEqual(h.get().notFilled.rows[0].remind.code, 'capped');
});

test('a refusal from the server is shown on the row, in the server\'s words', async () => {
  const err = new Error('Ana has started work since this list loaded.');
  const h = pageHarness({
    payload: remindPayload([remindRow()]),
    responses: { remind: err },
  });
  h.paintFollowUp();
  await h.sendReminder('timesheet', 'u-1');
  assert.match(h.captured.html, /Ana has started work since this list loaded\./);
  assert.match(h.captured.html, /fu-sent is-err/);
  /* AND THE ROW IS NOT STUCK: the key is released in a finally, so the button
     is live again for somebody to try once they have reloaded. */
  assert.ok(!h.sending().has('timesheet|u-1'));
});

test('the bulk confirmation states the exact counts and the reasons for the skips', async () => {
  const rows = [
    remindRow(),
    remindRow({ id: 'u-2', name: 'Bo', remind: { ...remindRow().remind, id: 'u-2' } }),
    remindRow({ id: 'u-3', name: 'Cy', remind: { ...remindRow().remind, may: false, code: 'capped',
      reason: 'Cy has already been reminded today.' } }),
    remindRow({ id: 'u-4', name: 'Di', remind: { ...remindRow().remind, may: false,
      code: 'already_filled', reason: 'Di has filled their timesheet since this list loaded.' } }),
    remindRow({ id: 'u-5', name: 'Ed', remind: { ...remindRow().remind, may: false, code: 'capped',
      reason: 'Ed has already been reminded today.' } }),
  ];
  const h = pageHarness({
    payload: remindPayload(rows),
    responses: { 'remind-all': { ok: true,
      sent: [{ id: 'u-1', name: 'Ana' }, { id: 'u-2', name: 'Bo' }],
      skipped: [{ id: 'u-3' }, { id: 'u-4' }, { id: 'u-5' }],
      section: remindPayload(rows) } },
  });
  h.paintFollowUp();
  /* The header says the number that will go, before anything is clicked. */
  assert.match(h.captured.html, /Remind all \(2\)/);
  assert.match(h.captured.html, /3 will be skipped/);

  await h.remindEveryone('timesheet');
  const ask = h.calls.asks[0];
  assert.ok(ask, 'the page asked, in the page');
  assert.strictEqual(ask.title, 'Remind 2 people?');
  assert.match(ask.message, /2 people have not filled their timesheet and will be reminded/);
  assert.match(ask.message, /3 will be skipped: 2 already reminded today, 1 have filled it since\./);
  assert.match(ask.message, /At most 1 per person per kind per day/);
  assert.match(ask.confirmLabel, /Remind 2/);
  assert.deepStrictEqual(h.calls.toasts, ['Reminded 2 people, skipped 3']);
});

test('the bulk confirmation says whether an email goes too', async () => {
  const rows = [remindRow()];
  const off = pageHarness({ payload: remindPayload(rows),
    responses: { 'remind-all': { ok: true, sent: [], skipped: [], section: remindPayload(rows) } } });
  off.paintFollowUp();
  await off.remindEveryone('timesheet');
  assert.match(off.calls.asks[0].message, /an in-app notice each, with your name on it/);
  assert.ok(!/and an email/.test(off.calls.asks[0].message));

  const on = pageHarness({
    payload: remindPayload(rows, { reminders: { permitted: true, manualEnabled: true,
      emailEnabled: true, cap: 1, logged: true, window: { ok: true } } }),
    responses: { 'remind-all': { ok: true, sent: [], skipped: [], section: remindPayload(rows) } },
  });
  on.paintFollowUp();
  await on.remindEveryone('timesheet');
  assert.match(on.calls.asks[0].message, /an in-app notice and an email each/);
});

test('MUTATION 12 — the section asks its questions in the page, never natively', () => {
  const slice = PAGE.slice(PAGE.indexOf('let FOLLOW_UP = null;'), PAGE.indexOf('let THEME_VERSION = null;'));
  for (const native of ['confirm(', 'alert(', 'prompt(']) {
    assert.ok(!slice.includes(native), `${native} must not appear in this section`);
  }
  assert.match(slice, /await askConfirm\(\{/, 'the page\'s own modal is what asks');
  /* AND THE WHOLE SERVED PAGE IS PINNED ELSEWHERE: tests/no-native-dialogs.test.js
     fails the build if one reappears anywhere, which is the latch that does not
     depend on this file being updated. */
  assert.ok(fs.existsSync(path.join(__dirname, 'no-native-dialogs.test.js')));
});

test('Remind all is not offered when it would do nothing', () => {
  const none = [remindRow({ remind: { ...remindRow().remind, may: false, code: 'capped',
    reason: 'Ana has already been reminded today.' } })];
  const h = pageHarness({ payload: remindPayload(none) });
  h.paintFollowUp();
  /* The button is drawn disabled rather than hidden — a lead who has already
     reminded everybody should see that that is why — and it does not promise a
     count it cannot send. */
  const all = h.nodes().find((n) => 'fuRemindAll' in n.dataset);
  assert.ok(all && all.disabled);
  assert.ok(!/Remind all \(/.test(h.captured.html), 'and no number beside it');

  // With nobody on the list at all there is nothing to offer.
  const empty = pageHarness({ payload: remindPayload([]) });
  empty.paintFollowUp();
  assert.ok(!/fu-remind-all/.test(empty.captured.html));
});

test('the order control asks the server, and keeps the date', () => {
  const h = pageHarness({ payload: remindPayload([remindRow()]) });
  h.setAsk({ mode: 'day', date: TUE });
  h.paintFollowUp();
  const sortButtons = h.nodes().filter((n) => 'fuSort' in n.dataset);
  assert.strictEqual(sortButtons.length, 2, 'two orders, as two buttons');
  sortButtons.find((b) => b.dataset.fuSort === 'inactive').click();
  const asked = h.calls.api[h.calls.api.length - 1].url;
  assert.match(asked, /date=2026-03-17/, 'the date somebody picked is kept');
  assert.match(asked, /sort=inactive/, 'and the order is the server\'s to apply');
});

// ===========================================================================
// 5. THE QUERY BUDGET. Fixed, whatever the size of the list.
// ===========================================================================

test('MUTATION 3b — the marker costs two queries for one person and for forty', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({
    id: `u-${i}`, createdAtMs: ist('2026-01-01T09:00:00'),
  }));
  const one = stubDb();
  await lastActivity.markersFor(one, many(1), {
    asOfDay: TUE, endDay: TUE, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });
  assert.strictEqual(one.calls.length, 2, 'one timer query and one last-seen query');

  const forty = stubDb();
  await lastActivity.markersFor(forty, many(40), {
    asOfDay: TUE, endDay: TUE, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });
  assert.strictEqual(forty.calls.length, 2, 'and the same two for forty people');
  /* BOTH ARE GROUPED, which is what makes that true — a mutant that moved either
     inside the loop would read forty here and pass every other assertion in
     this file. */
  assert.match(forty.sqlFor(/work_sessions/), /GROUP BY w\.user_id/);
  assert.match(forty.sqlFor(/activity_log/), /GROUP BY a\.actor_id/);
  assert.strictEqual(forty.paramsFor(/work_sessions/)[0].length, 40, 'one IN list, not forty asks');

  /* AND THE STREAK COSTS NOTHING AT ALL: it walks the started-days set the
     lists already fetched. Forty streaks, no third query. */
  const streaks = stubDb();
  const out = await lastActivity.markersFor(streaks, many(40), {
    asOfDay: FRI, endDay: FRI, startedSet: new Set(), isWorkingDay, shiftDays, threshold: 3,
  });
  assert.strictEqual(streaks.calls.length, 2);
  assert.ok(out.markers.get('u-39').streak > 0, 'and every one of the forty got a streak');

  /* THE WHOLE DRAW'S BUDGET is pinned in tests/follow-up.test.js, which counts
     every query the section issues and asserts it does not move with the number
     of people or days. Named here so the two cannot be changed apart. */
  const budget = fs.readFileSync(path.join(__dirname, 'follow-up.test.js'), 'utf8');
  assert.match(budget, /const QUERIES_SCOPED = 11;/);
  assert.match(budget, /the query count does not grow with people or days/);
});

test('the reminder state is one query for the whole list', async () => {
  const db = stubDb([[/FROM reminder_log/, [
    { userId: 'u-1', kind: 'timesheet', source: 'manual', slot: 0, senderName: 'Priya',
      subjectDate: TUE, at: '2026-03-18 05:35:00', channels: 'in_app', result: 'sent' },
    { userId: 'u-2', kind: 'timesheet', source: 'auto', slot: 0, senderName: null,
      subjectDate: TUE, at: '2026-03-18 05:00:00', channels: 'in_app', result: 'sent' },
  ]]]);
  const out = await reminders.sentOnDay(db, ['u-1', 'u-2', 'u-3'], { day: WED });
  assert.strictEqual(db.calls.length, 1, 'one grouped read, never one per row');
  assert.strictEqual(out.byUser.get('u-1').timesheet.manual.length, 1);
  assert.strictEqual(out.byUser.get('u-1').timesheet.manual[0].by, undefined);
  assert.strictEqual(out.byUser.get('u-1').timesheet.manual[0].senderName, 'Priya');
  /* MANUAL AND AUTOMATIC ARE KEPT APART, because the cap counts one of them and
     the screen shows both. */
  assert.strictEqual(out.byUser.get('u-2').timesheet.auto.length, 1);
  assert.strictEqual(out.byUser.get('u-2').timesheet.manual.length, 0);
});

// ===========================================================================
// 6. END TO END.
//
// See the file header on why the live half drives the TIMESHEET kind: a start
// reminder is about today and is held through lunch, so a live one would read
// the real clock. Every rule it adds is decided in section 3 above, with an
// explicit `now`.
// ===========================================================================

test('the marker, the button and the cap, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let root;
  const token = {};
  const id = {};

  const as = (who, path, opts = {}) => api(server.base, path, { token: token[who], ...opts });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'nudge-token',
      WORK_HOURS_SWEEP_MINUTES: '0',
      /* THE OUTBOX SWEEP IS OFF, so a queued reminder email STAYS queued and the
         assertions below are about what was enqueued rather than about a race
         with a sender. The sending half is tests/email-notifications.test.js's
         and tests/gmail-email.test.js's subject. */
      EMAIL_SWEEP_MS: '0',
      EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'nudge-token', name: 'Root', email: 'root@nu.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@nu.test');
    root = token.root;
    await openStudio(server.base, root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@nu.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@nu.test', 'game_artist');
    await make('cy', 'Cy Artist', 'cy@nu.test', 'game_artist');
    await make('lead', 'Lee Lead', 'lee@nu.test', 'team_lead');
    /* AN ADMIN WHO OWNS NOTHING. projectScope 'owned' with no projects of their
       own, which is the scope case: everybody is out of their reach. */
    await make('solo', 'Sol Admin', 'sol@nu.test', 'admin');

    /* EVERY FIXTURE ACCOUNT IS BACK-DATED: created_at is where the obligation
       starts, so an account made this morning is expected on no day in March. */
    await sql(cfg, "UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@nu.test'");

    const client = await systemClientId(server.base, root);
    const project = await as('root', '/projects', { method: 'POST',
      body: { name: 'Nudges', clientId: client } });
    id.project = project.body.project.id;
    for (const key of ['ana', 'bo', 'cy', 'lead']) {
      await as('root', `/users/${id[key]}`, { method: 'PATCH', body: { projectId: id.project } });
    }

    const asset = await as('root', `/assets/project/${id.project}`, {
      method: 'POST', body: { name: 'Night Work', type: 'character' } });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    id.asset = asset.body.asset.id;

    const session = (key, who, from, to) => sql(cfg,
      'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds) '
      + 'VALUES (?, ?, ?, 1, ?, ?, 3600)', [key, id.asset, who, from, to]);

    /* ANA'S LAST TIMER EVENT IS MONDAY EVENING. The marker is the LATEST of the
       two stamps — a stop is as much a timer event as a start — so the session
       is written to CLOSE at 16 March 12:10 UTC, which is 17:40 IST: the brief's
       "yesterday 5:40 PM" as seen from Tuesday. */
    await session('ws-ana-mon', id.ana, '2026-03-16 11:10:00', '2026-03-16 12:10:00');
    /* AND ONE ON WEDNESDAY, which is the as-of case: a question about Tuesday
       must not see it. It closes at 05:00 UTC — 10:30 IST. */
    await session('ws-ana-wed', id.ana, '2026-03-18 04:00:00', '2026-03-18 05:00:00');
    await session('ws-bo-tue', id.bo, '2026-03-17 05:00:00', '2026-03-17 06:00:00');

    /* BO FILLED TUESDAY. Ana and Cy did not, so both are on the list. */
    await sql(cfg, 'INSERT INTO timesheet_entries (id, user_id, entry_date, non_project, hours, notes) '
      + "VALUES ('te-bo', ?, ?, 'idle', 8, 'fixture')", [id.bo, TUE]);

    /* ANA'S LAST RECORDED ACTION, in the log every state change already writes
       to. 17 March 04:00 UTC is 09:30 IST the same day. */
    await sql(cfg, 'INSERT INTO activity_log (id, actor_id, module, action, summary, created_at) '
      + "VALUES ('al-ana', ?, 'assets', 'asset.update', 'fixture', '2026-03-17 04:00:00')", [id.ana]);
    /* AND ONE ON WEDNESDAY, for the same as-of reason as the session above. */
    await sql(cfg, 'INSERT INTO activity_log (id, actor_id, module, action, summary, created_at) '
      + "VALUES ('al-ana-wed', ?, 'assets', 'asset.update', 'fixture', '2026-03-18 05:00:00')", [id.ana]);
  });

  t.after(() => stopServer(server));

  const ask = (query, who = 'root') => as(who, `/admin-dashboard/follow-up${query ? `?${query}` : ''}`);
  const rowFor = (body, userId) => (body.notFilled.rows || []).find((r) => r.id === userId);
  const clearLog = () => sql(cfg, 'DELETE FROM reminder_log');

  await t.test('MUTATION 1 (live) — a past date shows nothing from after it', async () => {
    const r = await ask(`date=${TUE}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ana = rowFor(r.body, id.ana);
    assert.ok(ana, 'Ana did not fill Tuesday');

    /* THE BOUNDARY, MEASURED THROUGH THE QUERY. Ana has a session and a log row
       on WEDNESDAY as well; a question about Tuesday must see neither. */
    assert.strictEqual(ana.activity.timer.relative, 'yesterday 5:40 PM');
    assert.strictEqual(ana.activity.timer.exact, '16 Mar 2026, 5:40 PM IST');
    assert.strictEqual(ana.activity.seen.exact, '17 Mar 2026, 9:30 AM IST');

    // And asked about Wednesday, both of Wednesday's rows are in reach.
    const wed = await ask(`date=${WED}`);
    const anaWed = rowFor(wed.body, id.ana);
    assert.strictEqual(anaWed.activity.timer.exact, '18 Mar 2026, 10:30 AM IST');
    assert.strictEqual(anaWed.activity.seen.exact, '18 Mar 2026, 10:30 AM IST');
  });

  await t.test('a new account reads "no activity yet", and the streak skips its own past', async () => {
    const r = await ask(`date=${TUE}`);
    const cy = rowFor(r.body, id.cy);
    assert.ok(cy, 'Cy did not fill Tuesday either');
    assert.strictEqual(cy.activity.timer, null, 'Cy has never started a timer');
    assert.strictEqual(cy.activity.everActive, false);
    assert.strictEqual(cy.activity.quietDays, -1);
    assert.strictEqual(r.body.lastSeenRecorded, true, 'the Activity Log is readable');
  });

  await t.test('the streak is the walk, and sorting by it is the server\'s', async () => {
    const r = await ask(`date=${TUE}&sort=inactive`);
    assert.strictEqual(r.body.sort, 'inactive');
    const rows = r.body.notFilled.rows;
    /* Cy has never started anything, Ana started on Monday. Counted back from
       Tuesday, Ana's run is one day and Cy's is the whole look-back — so Cy
       leads under this order and the badge each carries agrees with it. */
    assert.ok(rows.length >= 2);
    const streaks = rows.map((x) => x.activity.streak);
    for (let i = 1; i < streaks.length; i += 1) {
      assert.ok(streaks[i - 1] >= streaks[i], `longest inactive first: ${streaks.join(',')}`);
    }
    const cy = rowFor(r.body, id.cy);
    assert.ok(cy.activity.streak >= 2);
    assert.strictEqual(cy.activity.streakStrong, true, 'past the default threshold of three');

    // And the default order is unchanged — urgency, as it was.
    const plain = await ask(`date=${TUE}`);
    assert.strictEqual(plain.body.sort, 'urgency');
  });

  await t.test('the index the marker needs is in place after a migration', async () => {
    const keys = await sql(cfg, 'SHOW INDEX FROM activity_log');
    const names = new Set(keys.map((k) => k.Key_name));
    assert.ok(names.has('idx_activity_actor_when'),
      'activity_log is indexed on (actor_id, created_at) — see ensureFollowUpIndexes');
    const reminderKeys = await sql(cfg, 'SHOW INDEX FROM reminder_log');
    assert.ok(reminderKeys.some((k) => k.Key_name === 'uq_reminder_slot' && Number(k.Non_unique) === 0),
      'and the once-a-day rule is a UNIQUE key, not a check');
  });

  await t.test('one reminder sends once, and says what went out', async () => {
    await clearLog();
    const r = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.sentence, 'Please fill your timesheet for 17 Mar 2026.');
    assert.deepStrictEqual(r.body.channels, ['in_app'], 'email is off by default');

    /* THE NOTICE IS IN THE BELL, through the existing mechanism, with the
       sentence stored on it rather than rebuilt later. */
    const bell = await as('ana', '/notifications');
    const notice = bell.body.notifications.find((n) => n.kind === 'timesheet_reminder');
    assert.ok(notice, 'the reminder is in Ana\'s bell');
    assert.strictEqual(notice.message, 'Please fill your timesheet for 17 Mar 2026.');
    assert.strictEqual(notice.otherName, 'Root', 'and it says who sent it');

    /* THE HISTORY, kept for reporting: who, to whom, which kind, which day, by
       which channels, and how it ended. */
    const log = await sql(cfg, 'SELECT * FROM reminder_log');
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].recipient_id, id.ana);
    assert.strictEqual(log[0].sender_name, 'Root');
    assert.strictEqual(log[0].kind, 'timesheet');
    assert.strictEqual(log[0].source, 'manual');
    assert.strictEqual(reminders.isoDay(log[0].subject_date), TUE);
    assert.strictEqual(log[0].slot, 0);
    assert.strictEqual(log[0].channels, 'in_app');
    assert.strictEqual(log[0].result, 'sent');

    /* AND THE AUDIT ENTRY, through the mechanism every other action uses. */
    const audit = await as('root', '/activity?module=users');
    const entry = audit.body.entries.find((e) => e.action === 'reminder.timesheet');
    assert.ok(entry, 'the send is in the Activity Log');
    assert.match(entry.summary, /Reminded Ana Artist/);
    assert.match(entry.summary, /timesheet for 2026-03-17 not filled/);
    assert.strictEqual(entry.actor.name, 'Root');
  });

  await t.test('MUTATION 5 (live) — a second attempt the same day is refused, with the limit', async () => {
    const again = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body.code, 'capped');
    assert.strictEqual(again.body.error, 'Ana Artist has already been reminded today.');
    assert.strictEqual((await sql(cfg, 'SELECT * FROM reminder_log')).length, 1,
      'and nothing else was written');
  });

  await t.test('the row shows who sent it and when — to a DIFFERENT lead', async () => {
    /* THE POINT OF PUTTING IT ON THE ROW rather than in the sender's session:
       two leads must not both nudge one person. Lee is granted both keys and
       reads the list fresh. */
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.admin_dashboard', 'report.follow_up', 'report.remind'])] } });

    const r = await ask(`date=${TUE}`, 'lead');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ana = rowFor(r.body, id.ana);
    assert.ok(ana.remind.last, 'Lee can see that somebody has already been');
    assert.strictEqual(ana.remind.last.by, 'Root');
    assert.strictEqual(ana.remind.may, false);
    assert.strictEqual(ana.remind.code, 'capped');
    assert.match(ana.remind.reason, /already been reminded today/);

    /* AND LEE'S OWN ATTEMPT IS REFUSED BY THE SAME RULE: the cap is per person
       per kind per day, not per sender. */
    const lees = await as('lead', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(lees.status, 409);
    assert.strictEqual(lees.body.code, 'capped');
  });

  await t.test('MUTATION 6 — two requests at the same instant send one reminder', async () => {
    await clearLog();
    /* FIRED TOGETHER, not one after the other: both read "nobody has been
       reminded" and both try to claim slot 0. The unique key decides, and the
       loser is told the cap rather than sending a second notice.
       
       THIS IS THE TEST A CHECK-THEN-INSERT CANNOT PASS. Removing the key from
       the migration leaves everything else in this file green. */
    const both = await Promise.all([
      as('root', '/admin-dashboard/follow-up/remind',
        { method: 'POST', body: { userId: id.cy, kind: 'timesheet', date: TUE } }),
      as('lead', '/admin-dashboard/follow-up/remind',
        { method: 'POST', body: { userId: id.cy, kind: 'timesheet', date: TUE } }),
    ]);
    const codes = both.map((x) => x.status).sort();
    assert.deepStrictEqual(codes, [200, 409], `one sent, one refused: ${JSON.stringify(both.map((x) => x.body))}`);
    const log = await sql(cfg, 'SELECT * FROM reminder_log WHERE recipient_id = ?', [id.cy]);
    assert.strictEqual(log.length, 1, 'one row, whichever request won');
    const notices = await sql(cfg,
      "SELECT * FROM notifications WHERE recipient_id = ? AND kind = 'timesheet_reminder'", [id.cy]);
    assert.strictEqual(notices.length, 1, 'and one notice in Cy\'s bell');
  });

  await t.test('MUTATION 4 (live) — a timesheet filled since the list loaded is refused', async () => {
    await clearLog();
    /* Bo filled Tuesday in the fixture, so Bo is not on the list at all — which
       is the state the browser's copy would be stale about. */
    const r = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.bo, kind: 'timesheet', date: TUE } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'already_filled');
    assert.match(r.body.error, /Bo Artist has filled their timesheet since this list loaded/);
    assert.strictEqual((await sql(cfg, 'SELECT * FROM reminder_log')).length, 0, 'and nothing was sent');
  });

  await t.test('MUTATION 7 (live) — somebody out of scope is refused, and not described', async () => {
    await clearLog();
    /* SOL HOLDS BOTH KEYS AND STILL CANNOT REACH ANA, which is the case worth
       testing: a refusal that came from the missing permission would prove
       nothing about scope. Sol is an Admin — projectScope 'owned' — who owns no
       project, so everybody is outside their reach. */
    const held = (await as('root', '/permissions/roles/admin')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/admin', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.admin_dashboard', 'report.follow_up', 'report.remind'])] } });

    const list = await ask(`date=${TUE}`, 'solo');
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.strictEqual(list.body.notFilled.total, 0, 'Sol sees nobody at all');

    const r = await as('solo', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    /* 403 rather than 409: waiting will not change it. */
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'out_of_scope');
    assert.ok(!/timesheet|started|filled/.test(r.body.error),
      'and the refusal says nothing about Ana\'s day');
    assert.strictEqual((await sql(cfg, 'SELECT * FROM reminder_log')).length, 0);

    await as('root', '/permissions/roles/admin', { method: 'PUT', body: { permissions: held } });
  });

  await t.test('a start reminder about a day that is over is refused', async () => {
    const r = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'start', date: TUE } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    /* Either refusal is correct and both are honest: Ana started nothing on
       Tuesday, so the row exists and its own gate says "a start reminder is
       about today"; if she had started, the list would not hold her. The clock
       is never consulted for this, which is why it is a live case at all. */
    assert.ok(['start_not_today', 'already_started'].includes(r.body.code), r.body.code);
    if (r.body.code === 'start_not_today') {
      assert.match(r.body.error, /use the timesheet reminder for a past day/);
    }
  });

  await t.test('MUTATION 10 — the endpoints demand the key, and a grant lands on the same token', async () => {
    /* WITHOUT IT: 403, with the list still readable. The two keys are separate
       powers and this is the whole of why. */
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: held.filter((k) => k !== 'report.remind') } });

    assert.strictEqual((await ask(`date=${TUE}`, 'lead')).status, 200,
      'the list is still readable without the sending key');
    for (const path of ['/admin-dashboard/follow-up/remind', '/admin-dashboard/follow-up/remind-all']) {
      const res = await as('lead', path, { method: 'POST', body: { userId: id.ana, kind: 'timesheet' } });
      assert.strictEqual(res.status, 403, path);
    }
    // And the settings section behind the same key.
    assert.strictEqual((await as('lead', '/admin/settings/nudges')).status, 403);

    /* THE PAYLOAD SAYS SO TOO, so the page draws no button it cannot use. */
    const list = await ask(`date=${TUE}`, 'lead');
    assert.strictEqual(list.body.reminders.permitted, false);
    assert.strictEqual(rowFor(list.body, id.ana).remind.permitted, false);

    /* NOW GRANT IT — ON THE SAME TOKEN, with no sign-out. authenticate()
       resolves permissions per request, so the next call is allowed. */
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.remind'])] } });
    assert.strictEqual((await as('lead', '/admin/settings/nudges')).status, 200,
      'the same token now passes');
    const after = await ask(`date=${TUE}`, 'lead');
    assert.strictEqual(after.body.reminders.permitted, true);

    /* AND WITHOUT THE LIST'S OWN KEY there is nothing to send from, whatever
       else is held — which is why both endpoints demand the pair. */
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.remind'])].filter((k) => k !== 'report.follow_up') } });
    assert.strictEqual((await as('lead', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet' } })).status, 403);
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.remind'])] } });
  });

  await t.test('the automatic reminder\'s status is shown beside the button', async () => {
    await clearLog();
    /* NOTHING WRITES THESE YET — there is no automatic reminder in this
       application (see src/reminders.js). The row is inserted here to pin the
       SHAPE the screen reads, so the automatic sender, when it is built, lights
       this line up by writing to the same table with the same key. */
    const today = gate.istDate(Date.now());
    await sql(cfg,
      'INSERT INTO reminder_log (id, recipient_id, sender_id, sender_name, kind, source, '
      + "subject_date, sent_on, slot, channels, `result`) "
      + "VALUES ('rl-auto', ?, NULL, NULL, 'timesheet', 'auto', ?, ?, 0, 'in_app', 'sent')",
      [id.ana, TUE, today]);

    const r = await ask(`date=${TUE}`);
    const ana = rowFor(r.body, id.ana);
    assert.ok(ana.remind.auto, 'the automatic one is reported');
    assert.strictEqual(ana.remind.last, null, 'and it is NOT counted as a manual one');
    /* WHICH MEANS IT DOES NOT SPEND THE CAP: the studio's own nudge at half past
       nine must not stop a lead adding a word at eleven, and the lead can see
       the first one went out before deciding. */
    assert.strictEqual(ana.remind.may, true);
    assert.strictEqual(ana.remind.sent, 0);

    const sent = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.row.remind.sent, 1);
    assert.ok(sent.body.row.remind.auto, 'and both are still visible afterwards');
  });

  await t.test('MUTATION 9 — a bulk send reports every person, and one refusal stops nothing', async () => {
    await clearLog();
    /* ANA IS CAPPED FIRST, which is the point of the order: under the list's own
       urgency she sorts ahead of Cy — she holds the asset — so a loop that gave
       up on the first refusal would never reach Cy at all. */
    const today = gate.istDate(Date.now());
    await sql(cfg,
      'INSERT INTO reminder_log (id, recipient_id, sender_name, kind, source, subject_date, '
      + "sent_on, slot, channels, `result`) "
      + "VALUES ('rl-ana-cap', ?, 'Root', 'timesheet', 'manual', ?, ?, 0, 'in_app', 'sent')",
      [id.ana, TUE, today]);

    const before = await ask(`date=${TUE}`);
    const order = before.body.notFilled.rows.map((x) => x.id);
    assert.strictEqual(order[0], id.ana, 'the capped person is first in the list');

    const r = await as('root', '/admin-dashboard/follow-up/remind-all', {
      method: 'POST', body: { kind: 'timesheet', date: TUE } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const sentIds = r.body.sent.map((x) => x.id);
    const skippedIds = r.body.skipped.map((x) => x.id);
    assert.ok(sentIds.includes(id.cy), 'Cy was reached despite the refusal before them');
    assert.ok(skippedIds.includes(id.ana), 'and Ana is reported as skipped');
    const anaSkip = r.body.skipped.find((x) => x.id === id.ana);
    assert.strictEqual(anaSkip.code, 'capped');
    assert.match(anaSkip.reason, /already been reminded today/);
    assert.strictEqual(anaSkip.name, 'Ana Artist', 'by name, so a lead can read the result');

    /* AND THE WHOLE SECTION COMES BACK, so the page redraws from the server
       rather than guessing at forty rows. */
    assert.ok(r.body.section && r.body.section.notFilled, 'the section is returned');
    const anaAfter = (r.body.section.notFilled.rows || []).find((x) => x.id === id.ana);
    assert.strictEqual(anaAfter.remind.may, false);

    /* ONE ROW PER PERSON REMINDED, and none for the one that was skipped twice. */
    const log = await sql(cfg, 'SELECT recipient_id, COUNT(*) AS n FROM reminder_log GROUP BY recipient_id');
    for (const row of log) assert.strictEqual(Number(row.n), 1, 'nobody got two');

    /* THE PER-PERSON CATCH is what makes a thrown error behave the same way as a
       refusal, and it is structural rather than reachable from here — pinned so
       a mutant that hoisted the loop body out of its try/catch fails. */
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin-dashboard.js'), 'utf8');
    assert.match(route, /for \(const row of list\.rows \|\| \[\]\) \{[\s\S]*?try \{[\s\S]*?\} catch \(err\) \{[\s\S]*?skipped\.push\(/);
    assert.match(route, /CAUGHT PER PERSON/);
  });

  await t.test('Remind all does not stop at the screen\'s first twenty-five', async () => {
    /* The row cap is a drawing decision. "Remind all" means the list, so the
       endpoint asks for every row — a mutant that reused the capped page would
       nudge twenty-five of forty and report success. */
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin-dashboard.js'), 'utf8');
    assert.match(route, /EVERY ROW, NOT THE CAPPED PAGE OF THEM/);
    assert.match(route, /all: '1'/);
    /* And the lookup for ONE person asks for all of them too, so somebody at
       number thirty is not refused with "not in the projects you can see". */
    assert.match(route, /EVERY ROW, NOT THE SCREEN'S FIRST TWENTY-FIVE/);
  });

  await t.test('MUTATION 8 (live) — the email goes only when the studio switched it on', async () => {
    await clearLog();
    await sql(cfg, 'DELETE FROM email_outbox');

    /* A MAIL SERVER THAT IS CONFIGURED AND ENABLED, so emailConfig.isUsable()
       is true and the only thing left deciding is the nudge setting. Nothing
       listens on that port and nothing needs to: the sweep is off, so the
       assertion is about what was ENQUEUED. */
    await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: 2599, encryption: 'none',
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvky.test',
    } });

    // Email reminders OFF, which is the default.
    const off = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.deepStrictEqual(off.body.channels, ['in_app']);
    assert.strictEqual((await sql(cfg, 'SELECT * FROM email_outbox')).length, 0,
      'nothing was queued while the switch was off');

    // Switch it on, and the next one is queued as well as belled.
    const saved = await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: true, emailEnabled: true, dailyCap: 1, streakThreshold: 3 } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    await clearLog();
    const on = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    assert.deepStrictEqual(on.body.channels, ['in_app', 'email']);

    /* ON THE STUDIO'S EXISTING QUEUE, with the counters the retry policy reads —
       pending, zero attempts, due now. The schedule itself is the webhook
       outbox's, asserted by identity above. */
    const queued = await sql(cfg, 'SELECT * FROM email_outbox');
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].recipient, 'ana@nu.test');
    assert.strictEqual(queued[0].status, 'pending');
    assert.strictEqual(Number(queued[0].attempts), 0);
    assert.match(queued[0].subject, /your timesheet for 2026-03-17 is missing/);
    assert.match(queued[0].body_text, /Please fill your timesheet for 17 Mar 2026\./);
    assert.ok(queued[0].body_html, 'both parts, as every other message in this queue has');

    /* AND THE HISTORY RECORDS BOTH CHANNELS. */
    const log = await sql(cfg, 'SELECT * FROM reminder_log');
    assert.strictEqual(log[0].channels, 'in_app,email');

    /* SOMEBODY WITH NO ADDRESS IS BELLED AND NOT MAILED, through the same
       opt-out lookup every other email in this file uses. */
    await sql(cfg, 'DELETE FROM email_outbox');
    await clearLog();
    await sql(cfg, 'UPDATE users SET email_opt_out = 1 WHERE id = ?', [id.cy]);
    const opted = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.cy, kind: 'timesheet', date: TUE } });
    assert.strictEqual(opted.status, 200, JSON.stringify(opted.body));
    assert.deepStrictEqual(opted.body.channels, ['in_app']);
    assert.strictEqual(opted.body.emailReason, 'no_mailable_address');
    assert.strictEqual((await sql(cfg, 'SELECT * FROM email_outbox')).length, 0);
    await sql(cfg, 'UPDATE users SET email_opt_out = 0 WHERE id = ?', [id.cy]);

    // Put the switch back where it started.
    await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: true, emailEnabled: false, dailyCap: 1, streakThreshold: 3 } });
  });

  await t.test('the settings are validated on the server, and apply without a redeploy', async () => {
    const bad = await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: true, emailEnabled: false, dailyCap: 0, streakThreshold: 1 } });
    assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
    const fields = bad.body.errors.map((e) => e.field).sort();
    assert.deepStrictEqual(fields, ['dailyCap', 'streakThreshold'],
      'both mistakes are reported, not the first one');
    assert.match(bad.body.errors.find((e) => e.field === 'dailyCap').message, /between 1 and 10/);
    /* A THRESHOLD OF ONE IS REFUSED rather than accepted: the marker is only
       drawn from two upwards, so one would mean "mark every row", which is no
       marker at all. */
    assert.match(bad.body.errors.find((e) => e.field === 'streakThreshold').message, /between 2 and 30/);

    const ceiling = await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: true, emailEnabled: false, dailyCap: 11, streakThreshold: 3 } });
    assert.strictEqual(ceiling.status, 422);

    /* NO REDEPLOY. Raise the cap and the NEXT request on the SAME process lets a
       second reminder through — the mirror is reloaded by save(), which is the
       whole of it. */
    await clearLog();
    const first = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual((await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } })).status, 409);

    const raised = await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: true, emailEnabled: false, dailyCap: 2, streakThreshold: 4 } });
    assert.strictEqual(raised.status, 200, JSON.stringify(raised.body));
    assert.strictEqual(raised.body.settings.dailyCap, 2);

    const second = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body), 'the new cap applied at once');
    const log = await sql(cfg, 'SELECT slot FROM reminder_log WHERE recipient_id = ? ORDER BY slot', [id.ana]);
    assert.deepStrictEqual(log.map((x) => Number(x.slot)), [0, 1], 'two slots, taken in order');
    assert.strictEqual((await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.ana, kind: 'timesheet', date: TUE } })).status, 409,
    'and the third is refused at the new cap');

    /* THE NEW THRESHOLD REACHES THE LIST WITHOUT A RESTART TOO. */
    const list = await ask(`date=${TUE}`);
    assert.strictEqual(list.body.streakThreshold, 4);

    /* AND THE CHANGE IS AUDITED, with the policy as a sentence on both sides. */
    const audit = await as('root', '/activity?module=settings');
    const entry = audit.body.entries.find((e) => e.action === 'nudges_updated');
    assert.ok(entry, 'the save is in the Activity Log');
    assert.match(entry.summary, /Changed the Start-of-day nudges/);
    assert.match(entry.summary, /at most 1 per person per kind per day.*→.*at most 2 per person/,
      'the policy as a sentence on both sides of the change');
    assert.match(entry.summary, /inactivity marker at 3 working days.*→.*inactivity marker at 4/);

    // And switching manual reminders off refuses everything, on the next request.
    await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: false, emailEnabled: false, dailyCap: 2, streakThreshold: 4 } });
    await clearLog();
    const refused = await as('root', '/admin-dashboard/follow-up/remind', {
      method: 'POST', body: { userId: id.cy, kind: 'timesheet', date: TUE } });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'manual_off');
    await as('root', '/admin/settings/nudges', { method: 'PUT',
      body: { manualEnabled: true, emailEnabled: false, dailyCap: 1, streakThreshold: 3 } });
  });

  await t.test('the status endpoint returns no secret, and says the automatic half is absent', async () => {
    const r = await as('root', '/admin/settings/nudges');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.automatic, false,
      'nothing sends on its own, and the screen is told so rather than implying otherwise');
    assert.match(r.body.activityExplainer, /no per-request heartbeat/);
    assert.strictEqual(r.body.lookBack, lastActivity.LOOKBACK_WORKING_DAYS);
    assert.strictEqual(r.body.blackoutMinutes, reminders.BLACKOUT_MIN_BREAK_MINUTES);
    const text = JSON.stringify(r.body);
    for (const leak of ['password', 'PASSWORD', 'secret', 'token']) {
      assert.ok(!text.includes(leak), `${leak} must not appear in the settings payload`);
    }
  });
});
