/* PEOPLE TO FOLLOW UP: who did not start, and who did not fill a timesheet.
 *
 * WHAT THIS FILE IS REALLY GUARDING, and it is not the two queries.
 *
 * The section answers four questions that were all already answered elsewhere
 * in this application — is D a working day, what is the previous working day,
 * is a day "filled", and which days is the studio shut — and the only way it
 * can be wrong in a way nobody notices is by answering one of them AGAIN,
 * slightly differently. The two readings then agree for months and part company
 * the first time a studio moves its weekly off or declares a holiday, and what
 * the floor sees is a screen demanding a timesheet for a day another screen
 * calls a holiday.
 *
 * So the first group of tests below does not check the lists at all. It mutates
 * the SHARED definition — the settings mirror, the holiday calendar, the gate's
 * own walk — and asserts this section moves with it. A second copy of any of
 * those rules fails here.
 *
 * THE ONE DEFINITION THIS SECTION OWNS is "started on D": a work session whose
 * started_at falls on D read in IST. It is tested against a live database, not
 * in arithmetic, because the IST boundary is drawn by the QUERY (+330 minutes
 * on a UTC column) and an assertion on JavaScript would pass over a query that
 * had lost it.
 *
 * FIXED PAST DATES THROUGHOUT, in March 2026, and every case that depends on
 * the hour passes an explicit `now`. Nothing here reads the real clock except
 * where it says it does — for a screen whose whole subject is "which day is it",
 * a fixture computed from the clock is a test that passes in the morning.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, raw, sql, openStudio,
  SKIP_REASON } = require('./helpers');

const followUp = require('../src/follow-up');
const gate = require('../src/timesheet-gate');
const timesheets = require('../src/timesheets');
const timesheetSettings = require('../src/timesheet-settings');
const holidays = require('../src/holidays');
const lastActivity = require('../src/last-activity');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const cfg = config('followup');
const PASSWORD = 'Follow-Up-1!';

/* 2026 March: 16th Mon, 17th Tue, 18th Wed, 19th Thu, 20th Fri, 21st Sat,
   22nd Sun, 23rd Mon. Every date below is one of those, written out. */
const MON = '2026-03-16';
const TUE = '2026-03-17';
const WED = '2026-03-18';
const THU = '2026-03-19';
const FRI = '2026-03-20';
const SAT = '2026-03-21';
const SUN = '2026-03-22';
// The Friday BEFORE that Monday, which is what Monday's previous working day is.
const PREV_FRI = '2026-03-13';

// An instant inside a fixed IST day, so a `now` is readable as a wall clock.
const ist = (text) => Date.parse(`${text}+05:30`);

// ---------------------------------------------------------------------------
// A recording stub database. Every call is kept, so the tests below can assert
// on the SHAPE of the SQL and on HOW MANY queries were issued — neither of
// which a canned-row fake could answer and both of which are the point.
// ---------------------------------------------------------------------------

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

const PROJECT = 'p-one';
const viewer = (role = 'admin') => ({ id: 'v-1', name: 'Vee', role });

/* The default answers: one person, in scope, who started nothing and filled
   nothing. Overridden per test by prepending a more specific matcher. */
function answersFor({ people = null, scope = null, started = [], filled = [], held = [] } = {}) {
  return [
    [/FROM users u\s+WHERE u\.`role` IN/, people || [{
      id: 'u-1', name: 'Ana', email: 'ana@example.com', role: 'game_artist',
      isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00',
    }]],
    [/FROM project_members pm/, scope || [{ userId: 'u-1' }]],
    [/FROM work_sessions w/, started],
    [/FROM timesheet_entries/, filled],
    [/FROM asset_assignments aa/, held],
    [/MIN\(started_at\)/, [{ day: '2026-01-02' }]],
    [/MIN\(entry_date\)/, [{ day: '2026-01-03' }]],
  ];
}

async function build(opts = {}) {
  const db = stubDb(opts.answers || answersFor(opts.fixture || {}));
  /* THE PROJECT LIST COUNTS TOWARD THE QUERY BUDGET, so the stub issues one
     query exactly as permissions.visibleProjects() does — otherwise the count
     asserted below would be a query short of what a real draw costs. */
  const ids = opts.projectIds || [PROJECT];
  const projects = opts.visibleProjects || (async () => {
    await db.query('SELECT * FROM projects WHERE is_active = 1 -- visibleProjects');
    return ids.map((id) => ({ id, name: id }));
  });
  const out = await followUp.build(db, opts.user || viewer(), {
    now: opts.now === undefined ? ist(`${WED}T11:00:00`) : opts.now,
    query: opts.query || {},
    visibleProjects: projects,
  });
  return { out, db };
}

// Loaded once: build() refuses to draw without the holiday calendar, by design.
test.before(async () => {
  await holidays.load({ query: async () => ({ rows: [] }) });
});
test.beforeEach(() => followUp.forget());

// ===========================================================================
// 1. THE SHARED DEFINITIONS. Nothing here checks a list; each case mutates a
//    definition that lives somewhere else and asserts this section followed.
// ===========================================================================

test('the section restates none of the four definitions it depends on', () => {
  const src = SRC('follow-up.js');

  /* IT ASKS, IT DOES NOT DECIDE. The three shared answers, each reached through
     the module that owns it. If one of these calls disappears, something here
     has started deciding for itself. */
  assert.match(src, /gate\.isWorkingDay\(/, 'working day comes from src/timesheet-gate.js');
  assert.match(src, /gate\.previousWorkingDay\(/, 'the previous working day comes from the same place');
  assert.match(src, /timesheets\.filledDays\(/, '"filled" comes from src/timesheets.js');

  /* AND IT DOES NOT TOUCH THE TABLE. tests/timesheet-options.test.js already
     greps the whole tree for readers of timesheet_entries and this module is
     not on its allowed list — asserted here as well, where somebody adding a
     query to this file will be reading. */
  assert.ok(!src.includes('timesheet_entries'),
    'the timesheet table is read through src/timesheets.js and nowhere else');

  /* NO SECOND WEEKDAY ARITHMETIC. A `getDay()`, a day-name array or a literal
     list of weekday numbers in this file would be a second reading of the
     studio's week. The one place a number of days appears is the range cap. */
  assert.ok(!/getDay\(\)|getUTCDay\(\)/.test(src), 'no weekday is derived here');
  assert.ok(!/\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]/.test(src),
    'the weekly-off list is the studio\'s setting, not a literal here');
});

test('MUTATION 4 — weekends and holidays are skipped, because the gate says so', async () => {
  /* The studio's own weekly off. Saturday and Sunday are not loggable by
     default, so neither list has anything to ask about. */
  const sat = await build({ query: { date: SAT }, now: ist(`${SAT}T11:00:00`) });
  assert.strictEqual(sat.out.workingDay, false, 'Saturday is not a working day');
  assert.deepStrictEqual(sat.out.startedFor.days, [], 'and nothing is expected on it');

  const wed = await build({ query: { date: WED } });
  assert.strictEqual(wed.out.workingDay, true);
  assert.deepStrictEqual(wed.out.startedFor.days, [WED]);

  /* A HOLIDAY DECLARED IN THE CALENDAR TAKES THE DAY OUT, with no change here:
     this section asks src/holidays.js through the gate. Declared and withdrawn
     inside the test so no other suite sees it. */
  await holidays.load({ query: async () => ({ rows: [{ id: 'h1', holiday_date: WED, name: 'Holi' }] }) });
  try {
    const onHoliday = await build({ query: { date: WED } });
    assert.strictEqual(onHoliday.out.workingDay, false,
      'a declared holiday is not a working day for this section either');
    assert.deepStrictEqual(onHoliday.out.startedFor.days, []);
  } finally {
    await holidays.load({ query: async () => ({ rows: [] }) });
  }
});

test('MUTATION 10 — the previous working day is the gate\'s answer, not a subtraction', async () => {
  /* MONDAY ASKS FOR FRIDAY. Today's list 2 is about the previous working day,
     and the only correct answer on a Monday is the Friday before — which is
     what a page or a module computing "yesterday" would get wrong by two days,
     every week. */
  const monday = await build({ query: {}, now: ist(`${MON}T11:00:00`) });
  assert.strictEqual(monday.out.today, MON);
  assert.strictEqual(monday.out.previousWorkingDay, PREV_FRI,
    'Monday asks for the Friday before it, not for Sunday and not for the Friday after');
  assert.strictEqual(monday.out.filledFor.to, PREV_FRI, 'and list 2 is about that Friday');

  // Exactly the gate's own answer, asked directly.
  assert.strictEqual(
    gate.previousWorkingDay(MON, {
      loggableDays: timesheetSettings.current().loggableDays,
      isHoliday: (d) => Boolean(holidays.on(d)),
    }),
    monday.out.previousWorkingDay
  );

  /* AND THE PAGE USES THE SERVER'S. The only thing the browser does with the
     previous working day is compare it; a second computation there would drift
     from this one the moment a studio changed either setting. */
  const wire = PAGE.slice(PAGE.indexOf('function fuPreset('), PAGE.indexOf('function renderFollowUp('));
  assert.match(wire, /d\.previousWorkingDay/, 'the page reads the server\'s answer');
  const presets = PAGE.slice(PAGE.indexOf('function wireFollowUp('));
  assert.match(presets.slice(0, presets.indexOf('\n}\n')), /d\.previousWorkingDay/,
    'and the preset button sends it back rather than working one out');
});

test('MUTATION 11 — an Idle line counts as filled, through the one definition', () => {
  /* ASSERTED AT THE SOURCE because that is where the decision is: filledDays()
     counts LINES and filters on nothing — no category, no hours floor, no
     draft/submitted test. A WHERE on non_project, or a SUM(hours) > 0, is the
     mutation, and either would turn a quiet day honestly reported as Idle into
     a day somebody gets chased for. The live half of this is asserted against
     a real Idle line further down. */
  const src = SRC('timesheets.js');
  const fn = src.slice(src.indexOf('async function filledDays('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /FROM timesheet_entries/);
  assert.ok(!/non_project|hours|status/.test(body),
    'filled is "a line exists" — no category, no hours floor, no submitted test');
});

// ===========================================================================
// 2. VALIDATION, which is the server's and not the picker's.
// ===========================================================================

test('the server refuses what the picker merely declines to offer', () => {
  const now = ist(`${WED}T11:00:00`);
  const bad = (query) => followUp.validate(query, { now });

  assert.strictEqual(bad({ date: 'yesterday' }).ok, false, 'not a date at all');
  assert.strictEqual(bad({ date: '2026-3-1' }).ok, false, 'not the ISO shape');
  /* A DATE THAT PARSES AND IS NOT A DAY. Date.parse accepts 2026-02-30 as an
     instant — 2 March — so a regex plus a parse is not enough and the check
     reads the day back. */
  assert.strictEqual(bad({ date: '2026-02-30' }).ok, false, '30 February is not a day');
  assert.strictEqual(bad({ date: '2026-13-40' }).ok, false);

  assert.strictEqual(bad({ date: THU }).ok, false, 'tomorrow is in the future');
  assert.match(bad({ date: THU }).error, /future/);
  assert.strictEqual(bad({ date: THU }).status, 400);

  assert.strictEqual(bad({}).asked.date, WED, 'nothing asked for means today');
  assert.strictEqual(bad({ date: '' }).asked.date, WED, 'and so does an empty box');
  assert.strictEqual(bad({ date: WED }).asked.mode, 'day');
});

test('MUTATION 12 — the range cap holds, and a backwards range is refused', () => {
  const now = ist(`${WED}T11:00:00`);
  const r = (from, to) => followUp.validate({ from, to }, { now });

  assert.strictEqual(r('2026-03-01', WED).ok, true, '18 days is inside the cap');
  assert.strictEqual(r('2026-02-16', WED).ok, true, `${followUp.MAX_RANGE_DAYS} days exactly`);
  assert.strictEqual(r('2026-02-15', WED).ok, false, 'one more than the cap');
  assert.match(r('2026-02-15', WED).error, new RegExp(String(followUp.MAX_RANGE_DAYS)));

  assert.strictEqual(r(WED, TUE).ok, false, 'a range that ends before it begins');
  assert.strictEqual(r(TUE, THU).ok, false, 'a range running into the future');
  assert.strictEqual(r(TUE, '').ok, false, 'half a range');

  // Thirty-one days is the cap the page quotes, from the same constant.
  assert.strictEqual(followUp.MAX_RANGE_DAYS, 31);
  assert.match(PAGE, /at most \$\{Number\(d\.maxRangeDays\)\|\|31\} days/,
    'the page quotes the server\'s cap rather than its own number');
});

// ===========================================================================
// 3. WHO THE STUDIO EXPECTED, on a day that has already happened.
// ===========================================================================

test('MUTATION 5 — a past date uses the recorded dates, never today\'s flag', () => {
  const on = (person, day) => followUp.onBooksOn(person, day);
  const at = (text) => ist(text);

  const stayed = { isActive: true, createdAtMs: at('2026-01-05T10:00:00'), deactivatedAtMs: null };
  assert.strictEqual(on(stayed, WED), true);

  /* JOINED AFTER D. Somebody who started on Thursday owes nothing for Wednesday
     — the same rule the start gate already applies, and the reason created_at
     is compared as an IST day rather than as an instant. */
  const newStarter = { isActive: true, createdAtMs: at(`${THU}T09:30:00`), deactivatedAtMs: null };
  assert.strictEqual(on(newStarter, WED), false, 'not expected before they existed');
  assert.strictEqual(on(newStarter, THU), true, 'expected from their first day');
  // 23:50 IST on Wednesday is still Wednesday, and 00:10 on Thursday is not.
  assert.strictEqual(on({ ...newStarter, createdAtMs: at(`${WED}T23:50:00`) }, WED), true);
  assert.strictEqual(on({ ...newStarter, createdAtMs: at(`${THU}T00:10:00`) }, WED), false);

  /* LEFT AFTER D IS STILL EXPECTED ON D, and this is the case today's is_active
     flag gets wrong. Deactivated on Friday, asked about Wednesday: they were
     here, and a list that dropped them would quietly lose the days before
     somebody left — which is exactly when a studio wants to chase a timesheet. */
  const left = { isActive: false, createdAtMs: at('2026-01-05T10:00:00'), deactivatedAtMs: at(`${FRI}T18:00:00`) };
  assert.strictEqual(on(left, WED), true, 'still on the books on Wednesday');
  assert.strictEqual(on(left, FRI), true, 'and on their last day');
  assert.strictEqual(on(left, SUN), false, 'not after it');

  /* AND THE ONE CASE THAT CANNOT BE RECONSTRUCTED is left out rather than
     guessed: deactivated before the column existed, so there is no date. */
  const lost = { isActive: false, createdAtMs: at('2025-01-05T10:00:00'), deactivatedAtMs: null };
  assert.strictEqual(on(lost, WED), false);
  assert.deepStrictEqual(followUp.unreconstructable([stayed, left, lost]), [lost]);
});

test('somebody who left after the day asked about is still on the list', async () => {
  const people = [
    { id: 'u-stay', name: 'Ana', email: 'a@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
    { id: 'u-left', name: 'Bo', email: 'b@x', role: 'game_artist', isActive: 0, deactivatedAt: `${FRI} 12:30:00`, createdAt: '2026-01-01 04:00:00' },
    { id: 'u-lost', name: 'Cy', email: 'c@x', role: 'game_artist', isActive: 0, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
  ];
  const scope = people.map((p) => ({ userId: p.id }));
  const { out } = await build({
    fixture: { people, scope }, query: { date: WED }, now: ist(`${SUN}T11:00:00`),
  });

  assert.deepStrictEqual(out.notStarted.rows.map((r) => r.name), ['Ana', 'Bo'],
    'the person who left on Friday was here on Wednesday; the one with no date is left out');
  assert.strictEqual(out.expected, 3, 'all three are in view');
  assert.ok(out.notes.some((n) => /no deactivation date/.test(n)),
    'and the gap is stated rather than hidden');
});

test('MUTATION 8 — freelancers are excluded by the schema, not by a filter', async () => {
  /* THE PREMISE, ASSERTED. A freelancer has no login and no users row —
     `freelancers` is its own table (src/migrate.js) and src/asset-workflow.js
     says so in as many words. So there is nothing for this section to filter
     out, and the test exists so that a future freelancer login does not quietly
     acquire a nagging list. */
  const migrate = SRC('migrate.js');
  assert.match(migrate, /CREATE TABLE IF NOT EXISTS freelancers/);
  assert.match(SRC('asset-workflow.js'), /A freelancer has no login/);

  /* AND THE LIST IS DRAWN FROM DESIGNATIONS THE STUDIO GIVES WORK TO, which is
     assignableRoles() and not a list of names. An Admin or a member of Finance
     holds no assignable designation and is never expected to clock in against
     an asset, so neither appears. */
  const { db } = await build({ query: { date: WED } });
  const roles = db.paramsFor(/FROM users u\s+WHERE u\.`role` IN/)[0];
  assert.ok(Array.isArray(roles) && roles.includes('game_artist'), 'artists are expected');
  assert.ok(roles.includes('team_lead'), 'and leads, which are assignable too');
  assert.ok(!roles.includes('admin') && !roles.includes('super_admin'),
    'administrators are not people the studio hands assets to');
  assert.ok(!roles.includes('managing_director_ceo'));
  assert.match(SRC('follow-up.js'), /assignableRoles\(\)/);
});

// ===========================================================================
// 4. THE QUERIES: their shape, their boundaries, and how many there are.
// ===========================================================================

/* WHAT A DRAW COSTS, and it is a number rather than "a few".
 *
 *   1 the viewer's projects        2 who is in scope
 *   3 who was expected            4 who started
 *   5 who filled                  6 how much work they held
 *   7 the oldest session          8 the oldest timesheet line
 *
 * AND THREE MORE SINCE THE LAST-ACTIVITY MARKER AND THE REMINDER BUTTON:
 *
 *   9 the last timer event per person  (src/last-activity.js)
 *  10 the last recorded action         (the same, from activity_log)
 *  11 what has been reminded today     (src/reminders.js)
 *
 * AND TWO MORE SINCE LEAVE AND IDLE:
 *
 *  12 what kind of day each person was having, over every day in view
 *                                      (src/day-status.js's statusesFor)
 *  13 and who is away RIGHT NOW, which is a different question from 12 and is
 *     about today whatever date is being read
 *                                      (the same, for the Remind button)
 *
 * THIRTEEN, for a narrower viewer; twelve for a studio-wide one, which needs no
 * scope narrowing. THE NUMBER IS NOT THE PROPERTY — it is fixed, which is —
 * and the streak is the case worth naming: it costs NO query at all, because
 * src/last-activity.js walks the started-days set query 4 already fetched
 * rather than asking again per person. Forty people over a month still cost
 * thirteen, and so does a studio where everybody is on leave: 12 and 13 are set
 * reads over the whole list, never a lookup per row. */
const QUERIES_SCOPED = 13;

test('MUTATION 13 — the query count does not grow with people or days', async () => {
  const one = await build({ query: { date: WED } });
  assert.strictEqual(one.db.calls.length, QUERIES_SCOPED,
    'one person, one day: the fixed budget');

  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `u-${i}`, name: `P${i}`, email: `p${i}@x`, role: 'game_artist',
    isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00',
  }));
  const wide = await build({
    fixture: { people: many, scope: many.map((p) => ({ userId: p.id })) },
    query: { from: '2026-02-20', to: FRI },
    now: ist(`${SUN}T11:00:00`),
  });
  assert.strictEqual(wide.db.calls.length, QUERIES_SCOPED,
    'forty people over a month: the same fixed budget');
  assert.strictEqual(wide.out.notStarted.total, 40, 'and all forty are answered for');

  // A studio-wide viewer needs no narrowing, so it is one fewer and not one more.
  const all = await build({ query: { date: WED }, user: viewer('super_admin') });
  assert.strictEqual(all.db.calls.length, QUERIES_SCOPED - 1);
  assert.ok(!all.db.calls.some((c) => /project_members/.test(c.sql)),
    'nothing is narrowed for somebody who sees the studio');
});

test('MUTATION 1 — the date asked for is the date queried', async () => {
  const { db } = await build({ query: { date: TUE }, now: ist(`${FRI}T11:00:00`) });

  const sessions = db.paramsFor(/FROM work_sessions w/);
  /* THE FAR END IS THE PROPERTY, and it is the one that guards the date: 17
     March in IST ends at 17 March 18:30 UTC, so a handler that ignored the date
     would be asking about Friday — and, more to the point, a row written after
     the date being viewed can never reach the answer.
     
     THE NEAR END DELIBERATELY REACHES FURTHER BACK, and that moved in this
     change. The inactivity streak walks the same set of started days rather than
     issuing a query of its own (see src/last-activity.js), so the window opens
     at the look-back floor — which is what keeps the streak free of charge.
     Pinned to the constant rather than to a date, so the two cannot drift. */
  assert.strictEqual(sessions[2], '2026-03-17 18:30:00', 'the window ends when the day does');
  const floor = new Date(Date.parse(`${TUE}T00:00:00Z`)
    - lastActivity.LOOKBACK_CALENDAR_DAYS * 86400000 - 330 * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');
  assert.strictEqual(sessions[1], floor,
    'and opens at the streak look-back floor, in the column\'s own UTC frame');

  const lines = db.paramsFor(/FROM timesheet_entries/);
  assert.strictEqual(lines[1], TUE, 'and the timesheet half asks about the same day');
  assert.strictEqual(lines[2], TUE);
});

test('MUTATION 2 — the day boundary is IST, drawn by the query', async () => {
  // A past date, so both lists are about the same day and the window is its own.
  const { db } = await build({ query: { date: TUE }, now: ist(`${FRI}T11:00:00`) });
  const sql = db.sqlFor(/FROM work_sessions w/);

  /* THE COLUMN IS UTC — NOW() is UTC_TIMESTAMP() on this schema — so the day a
     session belongs to is its stamp shifted by the studio's offset. Without the
     shift, everything between midnight and 05:30 IST lands on the previous day
     and the whole Indian working evening after 18:30 lands on the next one. */
  assert.match(sql, /INTERVAL 330 MINUTE/, 'the IST offset is applied in the query');
  assert.match(sql, /DATE_FORMAT\(DATE_ADD\(w\.started_at, INTERVAL 330 MINUTE\)/);

  /* And the window handed to it is in the column's own frame, not the day's: 17
     March in IST ENDS at 17 March 18:30 UTC. Only the far end is pinned here —
     the near end is the streak's look-back floor, which MUTATION 1 above pins
     to the constant it comes from. */
  const params = db.paramsFor(/FROM work_sessions w/);
  assert.strictEqual(params[2], '2026-03-17 18:30:00');
  assert.match(String(params[1]), /18:30:00$/, 'both ends are IST midnights read in UTC');
});

test('MUTATION 6 — the work-held marker is measured over the day asked about', async () => {
  const past = await build({ query: { date: TUE }, now: ist(`${FRI}T11:00:00`) });
  // The narrowing query names this table too; the count is the marker's own.
  const HELD = /COUNT\(DISTINCT aa\.asset_id\)/;
  const sql = past.db.sqlFor(HELD);

  /* AN OVERLAP TEST AGAINST D'S OWN BOUNDS, which is what makes this honest.
     `ended_at IS NULL` alone — what is on their desk right now — would print
     this afternoon's figure beside Tuesday's list, and it would look like
     evidence. */
  assert.match(sql, /aa\.assigned_at < \$2/);
  assert.match(sql, /aa\.ended_at IS NULL OR aa\.ended_at > \$3/);
  const params = past.db.paramsFor(HELD);
  assert.strictEqual(params[1], '2026-03-17 18:30:00', 'the far end is the end of Tuesday');
  assert.strictEqual(params[2], '2026-03-16 18:30:00', 'the near end is the start of Tuesday');

  // And the word the page prints beside it says which question it answered.
  assert.strictEqual(past.out.heldLabel, 'held that day');
  const today = await build({ query: {}, now: ist(`${WED}T11:00:00`) });
  assert.strictEqual(today.out.heldLabel, 'waiting on them');
  /* THE PAGE PRINTS THE SERVER'S WORD, and that is the property. It was pinned
     to one spelling of the template literal, which moved when the figure became
     a button: the number and the label are now composed in fuHeld() so that the
     same text is used for the button and for the plain span. Pinned to the
     property instead — heldLabel is read and no word of its own is written. */
  assert.match(PAGE, /const text = `\$\{Number\(r\.held\)\} \$\{heldLabel\|\|''\}`;/,
    'the number and the server\'s word are composed once, from heldLabel');
  /* AND THE ONLY FALL-BACK IS THE EMPTY STRING. A default of either word here
     would be the page deciding which question the figure answered — which, on
     the one draw where the server had not said, is exactly when it would be
     wrong. Asserted as a count so a second reader of heldLabel has to come
     past this line. */
  const reads = PAGE.match(/heldLabel\s*\|\|\s*''/g) || [];
  assert.strictEqual(reads.length, 1, 'heldLabel is read in one place, with no word of its own');
  assert.ok(!/heldLabel\s*\|\|\s*['"][a-z]/i.test(PAGE),
    'and never defaulted to a word the page chose');
});

test('MUTATION 9 — the lists are scoped to the projects the viewer can see', async () => {
  const people = [
    { id: 'u-in', name: 'Ana', email: 'a@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
    { id: 'u-out', name: 'Bo', email: 'b@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
  ];
  const narrow = await build({
    fixture: { people, scope: [{ userId: 'u-in' }] },
    query: { date: WED },
  });
  assert.deepStrictEqual(narrow.out.notStarted.rows.map((r) => r.name), ['Ana'],
    'somebody with no connection to a visible project is not named');
  assert.strictEqual(narrow.out.scope.studioWide, false);
  assert.ok(narrow.out.notes.some((n) => /Scoped to the projects you can see/.test(n)));

  /* THE NARROWING ASKS BOTH WAYS THIS SCHEMA RECORDS A CONNECTION: named on the
     project, or holding — or having held — an asset in it. Somebody whose last
     task there finished a month ago is still this viewer's business. */
  const sql = narrow.db.sqlFor(/SELECT DISTINCT s\.user_id/);
  assert.match(sql, /FROM project_members pm/);
  assert.match(sql, /FROM asset_assignments aa/);
  assert.match(sql, /a\.assignee_id/);

  // A viewer who can see no project at all gets no names, not the studio's.
  const blind = await build({
    fixture: { people, scope: [] },
    query: { date: WED },
    visibleProjects: async () => [],   // sees no project at all
  });
  assert.strictEqual(blind.out.notStarted.total, 0);
  assert.strictEqual(blind.out.expected, 0);

  /* AND "STARTED" IS WHOLE-PERSON, deliberately. Scope decides who is listed;
     once somebody is listed, clipping their sessions to visible projects would
     print "has not started" beside a person who spent the day on a project this
     viewer cannot open — a confident wrong answer. src/routes/idle.js made the
     same call for the same reason. */
  const started = narrow.db.sqlFor(/FROM work_sessions w/);
  assert.ok(!/project_id/.test(started), 'the start question is about the person, not the project');
  assert.ok(!/project_id/.test(narrow.db.sqlFor(/FROM timesheet_entries/)),
    'and so is the timesheet question');
});

// ===========================================================================
// 5. THE GRACE PERIOD, and the two dates one control is about.
// ===========================================================================

test('MUTATION 3 — the grace period is today\'s alone', async () => {
  assert.strictEqual(followUp.GRACE_MINUTES, 60);

  /* The studio's clock opens at 09:30 by default, so 10:00 is inside the hour
     and 10:45 is past it. Nothing is listed inside it: a list drawn at 09:31 is
     the whole studio, and "has not started" would mean "has not arrived". */
  const inside = await build({ query: {}, now: ist(`${WED}T10:00:00`) });
  assert.strictEqual(inside.out.grace.holds, true);
  assert.deepStrictEqual(inside.out.notStarted.rows, [], 'nobody is named inside the hour');

  const after = await build({ query: {}, now: ist(`${WED}T10:45:00`) });
  assert.strictEqual(after.out.grace.holds, false);
  assert.strictEqual(after.out.notStarted.total, 1, 'and named once it has passed');

  /* NOT APPLIED TO A PAST DATE. Yesterday is over; somebody who started at
     18:00 started, and holding yesterday's list open for an hour after this
     morning's opening would be meaningless. Asked at 10:00 — inside today's
     grace — about Tuesday, and the list is drawn. */
  const past = await build({ query: { date: TUE }, now: ist(`${WED}T10:00:00`) });
  assert.strictEqual(past.out.grace.holds, false, 'a past date has no grace period');
  assert.strictEqual(past.out.notStarted.total, 1);

  // Before the studio opens at all there is likewise nothing to be late for.
  const early = await build({ query: {}, now: ist(`${WED}T07:00:00`) });
  assert.strictEqual(early.out.grace.holds, true);
});

test('MUTATION 3b — today and a later reading of the same day give the same answer', async () => {
  /* THE PROPERTY THAT MAKES THE SECTION TRUSTWORTHY: a name on today's list is
     a name on that date's list when somebody looks again next week. Only two
     things could break it — a grace period that outlived the day, and a rule
     that read a session's membership of a day differently at the time from
     afterwards — and both are the same fixture read twice. */
  const started = [{ userId: 'u-1', day: WED }];
  const liveAt = ist(`${WED}T17:00:00`);
  const live = await build({ fixture: { started }, query: {}, now: liveAt });
  const later = await build({ fixture: { started }, query: { date: WED }, now: ist(`${SUN}T11:00:00`) });

  assert.strictEqual(live.out.startedFor.to, WED);
  assert.strictEqual(later.out.startedFor.to, WED);
  assert.deepStrictEqual(
    live.out.notStarted.rows.map((r) => r.id),
    later.out.notStarted.rows.map((r) => r.id),
    'the same day, read live and read back, names the same people'
  );
});

test('today\'s timesheet is not due yet, so list 2 moves to the previous working day', async () => {
  const today = await build({ query: {}, now: ist(`${WED}T15:00:00`) });
  assert.strictEqual(today.out.startedFor.to, WED, 'list 1 is about today');
  assert.strictEqual(today.out.filledFor.to, TUE, 'list 2 is about the previous working day');

  /* AND BOTH DATES TRAVEL, because two lists about two days under one date
     control is something a reader has to be told. */
  assert.ok(today.out.startedFor && today.out.filledFor);
  const list = PAGE.slice(PAGE.indexOf('function fuList('));
  assert.match(list.slice(0, list.indexOf('\n}\n')), /for \$\{escapeHTML\(fuSpan\(span\)\)\}/,
    'each list prints the exact date it is about');

  // A past date is the same date in both, because it is over.
  const past = await build({ query: { date: TUE }, now: ist(`${FRI}T15:00:00`) });
  assert.strictEqual(past.out.startedFor.to, TUE);
  assert.strictEqual(past.out.filledFor.to, TUE);
});

test('the "both" marker and the overlap count agree with the two lists', async () => {
  const people = [
    { id: 'u-a', name: 'Ana', email: 'a@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
    { id: 'u-b', name: 'Bo', email: 'b@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
    { id: 'u-c', name: 'Cy', email: 'c@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
  ];
  const { out } = await build({
    fixture: {
      people,
      scope: people.map((p) => ({ userId: p.id })),
      // Bo started; Cy filled. So Ana is on both lists and nobody else is.
      started: [{ userId: 'u-b', day: TUE }],
      filled: [{ userId: 'u-c', day: TUE }],
    },
    query: { date: TUE },
    now: ist(`${FRI}T11:00:00`),
  });

  assert.deepStrictEqual(out.notStarted.rows.map((r) => r.name), ['Ana', 'Cy']);
  assert.deepStrictEqual(out.notFilled.rows.map((r) => r.name), ['Ana', 'Bo']);
  assert.strictEqual(out.overlap, 1);
  assert.deepStrictEqual(out.notStarted.rows.filter((r) => r.both).map((r) => r.name), ['Ana']);
  assert.deepStrictEqual(out.notFilled.rows.filter((r) => r.both).map((r) => r.name), ['Ana']);
  // On both lists first, then alphabetical — a stable order between draws.
  assert.strictEqual(out.notStarted.rows[0].name, 'Ana');
});

test('urgency decides the order, and the cap says what it is hiding', async () => {
  const people = Array.from({ length: 30 }, (_, i) => ({
    id: `u-${i}`, name: `P${String(i).padStart(2, '0')}`, email: `p${i}@x`, role: 'game_artist',
    isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00',
  }));
  const held = [{ userId: 'u-29', n: 4 }, { userId: 'u-28', n: 1 }];
  const fixture = { people, scope: people.map((p) => ({ userId: p.id })), held };

  const capped = await build({ fixture, query: { date: TUE }, now: ist(`${FRI}T11:00:00`) });
  assert.strictEqual(capped.out.notStarted.total, 30, 'the total is honest');
  assert.strictEqual(capped.out.notStarted.rows.length, followUp.ROW_CAP);
  assert.strictEqual(capped.out.notStarted.more, 30 - followUp.ROW_CAP);
  /* MOST WORK HELD FIRST, among people equally behind: somebody with four
     assets waiting outranks somebody with none. "Not started and nothing to
     start" is a scheduling problem, not a person to chase. */
  assert.deepStrictEqual(capped.out.notStarted.rows.slice(0, 2).map((r) => r.id), ['u-29', 'u-28']);

  const all = await build({ fixture, query: { date: TUE, all: '1' }, now: ist(`${FRI}T11:00:00`) });
  assert.strictEqual(all.out.notStarted.rows.length, 30, 'show all lifts the cap');
  assert.strictEqual(all.out.notStarted.more, 0);
});

test('range mode is one row per person, with the days they missed', async () => {
  const people = [
    { id: 'u-a', name: 'Ana', email: 'a@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
    { id: 'u-b', name: 'Bo', email: 'b@x', role: 'game_artist', isActive: 1, deactivatedAt: null, createdAt: '2026-01-01 04:00:00' },
  ];
  const { out } = await build({
    fixture: {
      people,
      scope: people.map((p) => ({ userId: p.id })),
      // Ana worked Monday and Tuesday of that week; Bo worked none of it.
      started: [{ userId: 'u-a', day: MON }, { userId: 'u-a', day: TUE }],
    },
    query: { from: MON, to: FRI },
    now: ist(`${SUN}T11:00:00`),
  });

  assert.strictEqual(out.mode, 'range');
  assert.deepStrictEqual(out.startedFor.days, [MON, TUE, WED, THU, FRI],
    'five working days; the weekend either side is not in it');
  const by = new Map(out.notStarted.rows.map((r) => [r.name, r]));
  assert.strictEqual(by.get('Ana').missed, 3, 'Ana missed Wednesday to Friday');
  assert.deepStrictEqual(by.get('Ana').days, [WED, THU, FRI]);
  assert.strictEqual(by.get('Bo').missed, 5, 'Bo missed all five');
  assert.strictEqual(out.notStarted.rows[0].name, 'Bo', 'more days missed sorts first');
  assert.match(PAGE, /\$\{Number\(r\.missed\)\} days/, 'and the page prints the count');
});

// ===========================================================================
// 6. CACHING, and the one date that is never cached.
// ===========================================================================

test('a past date may be reused for a moment; today never is', async () => {
  const past = { query: { date: TUE }, now: ist(`${FRI}T11:00:00`) };
  const first = await build(past);
  assert.strictEqual(first.out.cached, false);
  const second = await build(past);
  assert.strictEqual(second.out.cached, true, 'the same past day comes back from the cache');
  /* TWO QUERIES, AND BOTH OF THEM ARE ABOUT TODAY — which is the property, and
     it is the same property it was when there was one.
     
     The lists, the markers and the streaks are a day that is over and come back
     free. What is asked again is exactly what a minute-old answer would get
     wrong: "has this person been reminded today", which changes every time
     somebody clicks and whose stale answer is the "two leads both nudge the
     same person" the button exists to prevent — and "is this person away right
     now", which decides whether the button may be pressed at all and turns over
     at the half-day split. Caching either would be caching today. */
  assert.strictEqual(second.db.calls.length, 2, 'and costs only what is about today');
  assert.match(second.db.calls.map((c) => c.sql).join('\n'), /FROM reminder_log/);
  assert.match(second.db.calls.map((c) => c.sql).join('\n'), /FROM user_day_status/);

  /* TODAY IS THE ONE DATE THAT MUST NOT BE CACHED: it changes every second, and
     that is the entire point of the list. A cached Today keeps naming somebody
     who started work two minutes ago, which is how a studio stops trusting it. */
  const t1 = await build({ query: {}, now: ist(`${WED}T15:00:00`) });
  const t2 = await build({ query: {}, now: ist(`${WED}T15:00:30`) });
  assert.strictEqual(t1.out.cached, false);
  assert.strictEqual(t2.out.cached, false, 'today is asked again every time');
  assert.strictEqual(t2.db.calls.length, QUERIES_SCOPED);

  // A RANGE ENDING TODAY is today, for this purpose.
  const r1 = await build({ query: { from: MON, to: WED }, now: ist(`${WED}T15:00:00`) });
  const r2 = await build({ query: { from: MON, to: WED }, now: ist(`${WED}T15:00:10`) });
  assert.strictEqual(r2.out.cached, false);
  assert.ok(r1.db.calls.length > 0 && r2.db.calls.length > 0);

  // And two viewers with different scopes do not share an answer.
  followUp.forget();
  const a = await build({ ...past, user: viewer('admin') });
  const b = await build({ ...past, user: viewer('super_admin') });
  assert.strictEqual(a.out.cached, false);
  assert.strictEqual(b.out.cached, false, 'the key carries the viewer');
});

test('the holiday calendar and an empty week are refusals, not guesses', async () => {
  /* THE GATE FAILS OPEN — a paperwork rule must never stop the floor — and this
     section fails SAFE, in the opposite direction. Drawing without the holiday
     calendar would nag the whole studio for Diwali, so it says it cannot tell. */
  const loaded = holidays.isLoaded();
  await holidays.load({ query: async () => { throw new Error('gone'); } });
  assert.ok(loaded);

  // load() sets loaded even on failure, so the no-calendar case is forced
  // through the predicate the module publishes.
  const original = holidays.isLoaded;
  holidays.isLoaded = () => false;
  try {
    const { out } = await build({ query: { date: WED } });
    assert.match(out.unavailable, /holiday calendar/);
    assert.ok(!out.notStarted, 'and no list is drawn beside the explanation');
  } finally {
    holidays.isLoaded = original;
    await holidays.load({ query: async () => ({ rows: [] }) });
  }
});

// ===========================================================================
// 7. THE PAGE. Lifted out and run on its own, as the other dashboard tests do.
// ===========================================================================

// ---------------------------------------------------------------------------
// The page section, lifted out and run against a stub DOM.
//
// RENDERED AND CLICKED, NOT READ. The three risks on this side of the wire —
// a response for a date nobody is looking at any more, a redraw that quietly
// snaps back to Today, and a gate asking the wrong question — all look fine in
// the source and only show up when the thing is used. The grep assertions below
// stay as evidence of intent; these drive it.
// ---------------------------------------------------------------------------

function pageHarness({ permissions = ['report.follow_up', 'user.view'], payloads = {} } = {}) {
  /* THE WHOLE SECTION IN ONE SLICE rather than function by function, so a
     mutation that adds a line anywhere in it is carried into the harness
     instead of being skipped by a narrower grab. */
  const from = PAGE.indexOf('let FOLLOW_UP = null;');
  /* ENDS WHERE THE NEXT SECTION BEGINS, which used to be the email settings and
     is now the theme runtime that was added in front of them. Taking everything
     up to the email comment would hand this harness a second section it has no
     stubs for — the theme block reads window and showToast — and the failure
     would look like a bug in this one. tests/theme.test.js lifts that block
     with the stubs it needs. */
  const to = PAGE.indexOf('let THEME_VERSION = null;');
  assert.ok(from !== -1 && to > from, 'the follow-up section is in the page');
  const section = PAGE.slice(from, to);

  /* AND THE RESET renderAdminDashboard DOES ON EVERY DRAW, taken the same way:
     whatever it does to this section's module state is what a redraw does. */
  const resetFrom = PAGE.indexOf('  FOLLOW_UP = d.followUp || null;');
  const resetTo = PAGE.indexOf('  /* THE CHIPS ARE DECIDED AGAINST A CURRENT PROJECT LIST');
  assert.ok(resetFrom !== -1 && resetTo > resetFrom);
  const reset = PAGE.slice(resetFrom, resetTo);

  const calls = { api: [], users: [] };
  const captured = { html: '' };
  let nodes = [];
  let byId = {};

  /* Only what the wiring looks for. A <button> is focusable, takes Enter and
     Space for free and is announced as a button; an <input type=date> fires
     change. Both are modelled with their dataset and their listeners. */
  function parse(html) {
    const out = [];
    const ids = {};
    const re = /<(button|input|span)\b([^>]*)>/g;
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

  const api = async (url) => {
    calls.api.push(url);
    const q = url.split('?')[1] || '';
    const params = new URLSearchParams(q);
    const key = params.get('from') ? `${params.get('from')}..${params.get('to')}` : (params.get('date') || 'today');
    if (payloads[key] === 'fail') throw new Error('the server said no');
    return payloads[key] || payloadFor(key === 'today' ? WED : key);
  };

  const built = new Function(
    'document', 'escapeHTML', 'can', 'caps', 'api', 'openUserDetail',
    `${section}
     ${'function __redraw(d){\n' + reset + '\n}'}
     return {
       renderFollowUp, wireFollowUp, loadFollowUp, paintFollowUp, fuAskKey,
       redraw: __redraw,
       ask: () => FOLLOW_UP_ASK, shown: () => FOLLOW_UP_SHOWN,
       err: () => FOLLOW_UP_ERR, busy: () => FOLLOW_UP_BUSY,
       setAsk: (a) => { FOLLOW_UP_ASK = a; },
     };`
  )(
    document,
    (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    (...keys) => keys.some((k) => permissions.includes(k)),
    /* caps() answers the TIER, and the section must never ask it. Given a
       generous answer on purpose: a gate that reads it would pass rather than
       fail, which is exactly the shape of the bug. */
    () => ({ projectScope: 'all', manageUsers: true }),
    api,
    (id) => calls.users.push(id),
  );

  return { ...built, calls, captured, document, nodes: () => nodes, byId: () => byId, slot };
}

/* A payload of the shape src/follow-up.js builds, for one past date. */
function payloadFor(date) {
  return {
    ok: true, unavailable: null, mode: 'day', date, from: date, to: date,
    today: WED, previousWorkingDay: TUE,
    startedFor: { from: date, to: date, days: [date] },
    filledFor: { from: date, to: date, days: [date] },
    workingDay: true,
    grace: { minutes: 60, holds: false, until: null, opensAt: null, clockShut: false },
    notStarted: { rows: [{ id: 'u-1', name: 'Ana', role: 'game_artist', roleLabel: 'Game Artist', held: 2, missed: 1, both: false }], total: 1, more: 0 },
    notFilled: { rows: [], total: 0, more: 0 },
    overlap: 0, expected: 3, heldLabel: 'held that day',
    earliest: '2026-01-05', cap: 25, maxRangeDays: 31,
    notes: [], scope: { projects: 1, studioWide: false, roles: 9 }, cached: false,
  };
}

test('MUTATION 15 — a date somebody picked survives a redraw of the screen', async () => {
  const h = pageHarness();
  h.redraw({ followUp: payloadFor(WED) });
  h.paintFollowUp();
  assert.strictEqual(h.calls.api.length, 0, 'the first draw needs no request of its own');

  // Somebody picks the day before.
  await h.loadFollowUp({ mode: 'day', date: TUE });
  assert.deepStrictEqual(h.calls.api, [`/admin-dashboard/follow-up?date=${TUE}`]);
  assert.strictEqual(h.ask().date, TUE);

  /* THE SCREEN IS REDRAWN. renderAdminDashboard refetches /admin-dashboard,
     whose followUp is always the DEFAULT date, and rebuilds the panel. The
     chosen date must still be the one on show — not silently Today. */
  h.redraw({ followUp: payloadFor(WED) });
  h.paintFollowUp();
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(h.calls.api, [
    `/admin-dashboard/follow-up?date=${TUE}`,
    `/admin-dashboard/follow-up?date=${TUE}`,
  ], 'the redraw asked again for the day somebody chose');
  assert.strictEqual(h.ask().date, TUE);
  assert.ok(h.captured.html.includes(`value="${TUE}"`), 'and the picker still shows it');

  /* AND A RELOAD STARTS AT TODAY, because the ask is module state and nothing
     persists it. A date somebody looked at one morning is not a preference. */
  const fresh = pageHarness();
  fresh.redraw({ followUp: payloadFor(WED) });
  fresh.paintFollowUp();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fresh.ask(), null);
  assert.strictEqual(fresh.calls.api.length, 0, 'a fresh page is already on Today');

  const section = PAGE.slice(PAGE.indexOf('let FOLLOW_UP = null;'),
    PAGE.indexOf("/* ---------- settings: where the studio's email goes out from"));
  assert.ok(!/localStorage|sessionStorage|saveContext/.test(section),
    'the chosen date is not persisted anywhere');
});

test('MUTATION 14 — a stale response never overwrites a newer one', async () => {
  /* TWO ASKS IN FLIGHT, answered in the wrong order. The first request is held
     open until the second has answered; without the ticket, the panel ends up
     showing Tuesday's names under Wednesday's date. */
  let releaseFirst;
  const slow = new Promise((r) => { releaseFirst = r; });
  const h = pageHarness({
    payloads: {
      [TUE]: slow.then(() => payloadFor(TUE)),
      [MON]: payloadFor(MON),
    },
  });
  h.redraw({ followUp: payloadFor(WED) });

  const first = h.loadFollowUp({ mode: 'day', date: TUE });
  const second = h.loadFollowUp({ mode: 'day', date: MON });
  await second;
  assert.strictEqual(h.shown().date, MON, 'the newer ask is on screen');

  releaseFirst();
  await first;
  assert.strictEqual(h.shown().date, MON,
    'and the older response, arriving late, did not take it back');

  const load = PAGE.slice(PAGE.indexOf('async function loadFollowUp('));
  const body = load.slice(0, load.indexOf('\nfunction wireFollowUp('));
  const guards = body.match(/if\(mine !== FOLLOW_UP_TICKET\) return;/g) || [];
  assert.strictEqual(guards.length, 2,
    'checked on both the success and the failure path — an error from an '
    + 'abandoned request must not blank a good panel either');
});

test('MUTATION 17 — the page gate is the permission, never the tier', () => {
  /* caps() in the harness answers generously, so a gate reading the TIER would
     draw the section for somebody who does not hold the key — which is the bug
     that has shipped three times in this application. */
  const without = pageHarness({ permissions: [] });
  without.redraw({ followUp: payloadFor(WED) });
  assert.strictEqual(without.renderFollowUp(), '',
    'nothing is drawn without report.follow_up, whatever the tier says');

  const with_ = pageHarness({ permissions: ['report.follow_up'] });
  with_.redraw({ followUp: payloadFor(WED) });
  assert.ok(with_.renderFollowUp().includes('People to follow up'));

  /* AND THE SECTION IS ABSENT, NOT EMPTY, when the server omitted the key —
     which is what it does for anybody without the permission. */
  const absent = pageHarness();
  absent.redraw({});
  assert.strictEqual(absent.renderFollowUp(), '');

  // The same key the endpoint checks, matched against the catalogue.
  const keys = catalog.GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
  assert.ok(keys.includes('report.follow_up'));
  assert.match(SRC('routes/admin-dashboard.js'), /requirePermission\('report\.follow_up'\)/);
});

test('a row opens the person where the Users tab already opens them', async () => {
  const h = pageHarness();
  h.redraw({ followUp: payloadFor(TUE) });
  h.paintFollowUp();
  const name = h.nodes().find((n) => 'fuUser' in n.dataset);
  assert.ok(name, 'the name is a control');
  assert.strictEqual(name.tagName, 'BUTTON', 'a button, so Enter and Space work');
  const ev = name.click();
  assert.deepStrictEqual(h.calls.users, ['u-1']);
  assert.ok(ev.stopped, 'and the row around it is not also clicked');

  /* WITHOUT user.view THERE IS NOTHING TO OPEN — GET /users/:id refuses it — so
     the name is plain text rather than a control that would fail. A <span>
     cannot be tabbed to, so nobody meets a dead button. */
  const narrow = pageHarness({ permissions: ['report.follow_up'] });
  narrow.redraw({ followUp: payloadFor(TUE) });
  narrow.paintFollowUp();
  assert.ok(!narrow.nodes().some((n) => 'fuUser' in n.dataset));
  assert.ok(narrow.captured.html.includes('fu-name-plain'));
});

test('the presets ask for the day they name, and the server supplies the previous one', async () => {
  const h = pageHarness();
  h.redraw({ followUp: payloadFor(WED) });
  h.paintFollowUp();

  const preset = (which) => h.nodes().find((n) => n.dataset.fuPreset === which);
  preset('prev').click();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.calls.api, [`/admin-dashboard/follow-up?date=${TUE}`],
    'the previous working day is the server\'s answer, carried back unchanged');

  preset('today').click();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.calls.api[1], '/admin-dashboard/follow-up',
    'Today asks for the default rather than naming a date');
  assert.strictEqual(h.ask(), null);

  // A range preset stays inside the cap the server quoted.
  preset('range').click();
  await new Promise((r) => setImmediate(r));
  const ranged = h.calls.api[2];
  assert.match(ranged, /from=\d{4}-\d{2}-\d{2}&to=2026-03-18/);
});

test('a failed read says so, and does not leave the old lists under the new date', async () => {
  const h = pageHarness({ payloads: { [TUE]: 'fail' } });
  h.redraw({ followUp: payloadFor(WED) });
  h.paintFollowUp();
  await h.loadFollowUp({ mode: 'day', date: TUE });

  assert.match(h.err(), /could not be read/);
  assert.ok(h.captured.html.includes('fu-err'));
  assert.ok(!h.captured.html.includes('fu-row'),
    'a stale pair of lists under a new date reads as an answer, which is worse than none');
});

test('the page draws the states that are not a pair of lists', () => {
  const render = PAGE.slice(PAGE.indexOf('function renderFollowUp('));
  const body = render.slice(0, render.indexOf('\nfunction fuList('));

  assert.match(body, /if\(!d\) return '';/, 'absent, not empty, without the key');
  assert.match(body, /FOLLOW_UP_ERR/, 'a failed read says so');
  assert.match(body, /d\.unavailable/, 'and so does a server that could not tell');
  assert.match(body, /const shut = !d\.workingDay;/, 'a non-working day is stated, not drawn blank');
  assert.match(body, /FOLLOW_UP_BUSY \? '<span class="fu-loading">reading…<\/span>' : ''/);
  // The picker cannot offer a future date, and its floor is the earliest data.
  assert.match(body, /max="\$\{escapeHTML\(max\)\}"/);
  assert.match(body, /const max = d\.today;/);
  assert.match(body, /const min = d\.earliest \|\| d\.today;/);
});

test('every control is a real one, reachable by keyboard', () => {
  /* The same rule the Attention chips follow: a <button> is focusable in order,
     takes Enter and Space for free, is announced as a button, and its label
     says where it goes. A <div> with a click handler is none of those. */
  for (const re of [
    /<button type="button" class="fu-preset/,
    /<button type="button" class="fu-name"/,
    /<button type="button" class="fu-more"/,
  ]) assert.match(PAGE, re);

  // Pressed state on the presets, so a screen reader knows which day is on.
  assert.match(PAGE, /aria-pressed="\$\{preset==='today'\}"/);
  assert.match(PAGE, /aria-label="Open \$\{escapeHTML\(r\.name\)\} in Users"/);

  // And the focus ring the rest of the page uses, on each of them.
  for (const sel of ['.fu-preset:focus-visible', '.fu-name:focus-visible', '.fu-more:focus-visible']) {
    assert.ok(PAGE.includes(sel), `${sel} has a focus ring`);
  }
  // The name a viewer cannot open is a <span>, so it is not in the tab order.
  assert.match(PAGE, /<span class="fu-name-plain">/);

  // Narrow screens stack the two lists rather than squeezing them.
  const phone = PAGE.slice(PAGE.indexOf('@media (max-width:560px){\n  .ad-cards{grid-template-columns:1fr;}'));
  assert.match(phone.slice(0, phone.indexOf('\n}')), /\.fu-lists\{grid-template-columns:1fr/);
});

// ===========================================================================
// 8. AGAINST A LIVE SERVER: the IST boundary the query draws, the permission
//    gates, and "filled" meaning what src/timesheets.js says it means.
// ===========================================================================


/* ONE PREPARED DATABASE, READ MANY WAYS — and the structure is forced by a real
 * feature rather than by taste: a PAST date's answer is cached for a minute
 * (never Today's), so a subtest that inserted a row and then asked about the
 * same past day it had already asked about would be handed the answer from
 * before its own insert. Every fixture is therefore written once, up front, and
 * the subtests only read.
 */
test('the lists, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let root;
  const token = {};
  const id = {};

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'fu-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'fu-token', name: 'Root', email: 'root@fu.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    root = await login('root@fu.test');
    await openStudio(server.base, root);

    const make = async (key, name, email, role) => {
      const r = await api(server.base, '/users', {
        method: 'POST', token: root, body: { name, email, password: PASSWORD, role },
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@fu.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@fu.test', 'game_artist');
    await make('lead', 'Lee Lead', 'lee@fu.test', 'team_lead');

    /* EVERY FIXTURE ACCOUNT IS BACK-DATED. created_at is the obligation's start
       — somebody who joined this morning owes nothing for March — so accounts
       made by this test would be expected on no past day at all. */
    await sql(cfg, "UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@fu.test'");

    const client = await api(server.base, '/clients', { method: 'POST', token: root, body: { name: 'Client' } });
    const project = await api(server.base, '/projects', {
      method: 'POST', token: root,
      body: { name: 'Follow Up', clientId: client.body.client.id },
    });
    id.project = project.body.project.id;
    /* In project_members, which is one of the two ways this schema records that
       somebody is this project's business. */
    for (const key of ['ana', 'bo', 'lead']) {
      await api(server.base, `/users/${id[key]}`, {
        method: 'PATCH', token: root, body: { projectId: id.project },
      });
    }

    const asset = await api(server.base, `/assets/project/${id.project}`, {
      method: 'POST', token: root, body: { name: 'Night Work', type: 'character' },
    });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    id.asset = asset.body.asset.id;

    const session = (key, who, from, to, seconds) => sql(cfg,
      'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds) '
      + 'VALUES (?, ?, ?, 1, ?, ?, ?)',
      [key, id.asset, who, from, to, seconds]);

    /* ANA WORKED AT HALF PAST MIDNIGHT IST ON THE 18th. 17 March 19:00 UTC is
       18 March 00:30 IST — the case the whole IST boundary exists for. */
    await session('ws-night', id.ana, '2026-03-17 19:00:00', '2026-03-17 21:00:00', 7200);
    // And an older one, so the picker's floor has two candidates to choose from.
    await session('ws-old', id.lead, '2026-02-10 05:00:00', '2026-02-10 06:00:00', 3600);

    const line = (key, who, date, category, hours) => sql(cfg,
      'INSERT INTO timesheet_entries (id, user_id, entry_date, non_project, hours, notes) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
      [key, who, date, category, hours, 'fixture']);

    /* BO FILLED WEDNESDAY WITH AN IDLE LINE, which is the honest answer for a
       day with nothing to report and counts as filled. Written straight into
       the table at a date the form's own back-dating window may no longer
       accept: the question is what "filled" READS, not what the form allows
       today — which is also the whole of the back-filled case. */
    await line('te-idle', id.bo, WED, 'idle', 8);
    // Older than every session, so the floor has to come from this half.
    await line('te-old', id.lead, '2026-02-01', 'admin', 4);
  });

  t.after(() => stopServer(server));

  const ask = (query, as = root) => api(server.base,
    `/admin-dashboard/follow-up${query ? `?${query}` : ''}`, { token: as });

  await t.test('a past working day names who did neither thing', async () => {
    const r = await ask(`date=${WED}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.workingDay, true);
    assert.strictEqual(r.body.startedFor.to, WED);
    assert.strictEqual(r.body.filledFor.to, WED, 'a past date is the same day in both lists');

    assert.strictEqual(r.body.expected, 3,
      'artists and leads are assignable; the Super Admin who runs the studio is not');

    /* MUTATION 2 (live) — ANA'S SESSION IS PLACED ON ITS IST DAY. A boundary
       drawn on the raw UTC column puts 17 March 19:00 on the 17th; the studio's
       own clock puts it half an hour into the 18th, and the studio is who the
       list is for. */
    assert.ok(!r.body.notStarted.rows.some((x) => x.id === id.ana),
      'Ana started at half past midnight IST on the 18th');

    /* MUTATION 11 and 7 (live) — AN IDLE LINE COUNTS, AND A BACK-FILLED ONE
       COUNTS. Bo's only line for that Wednesday is Idle, and it was typed
       today: entry_date is the day the line is ABOUT and created_at is never
       read. */
    assert.ok(!r.body.notFilled.rows.some((x) => x.id === id.bo),
      'Bo filled Wednesday with an Idle line, and that is filled');

    assert.deepStrictEqual(r.body.notStarted.rows.map((x) => x.name).sort(),
      ['Bo Artist', 'Lee Lead']);
    assert.deepStrictEqual(r.body.notFilled.rows.map((x) => x.name).sort(),
      ['Ana Artist', 'Lee Lead']);
    assert.strictEqual(r.body.overlap, 1, 'only the lead did neither');
    assert.deepStrictEqual(r.body.notStarted.rows.filter((x) => x.both).map((x) => x.name),
      ['Lee Lead']);
  });

  await t.test('MUTATION 2 (live) — the day before holds none of it', async () => {
    /* The other half of the boundary, and a different cache key. Ana did
       nothing at all on the 17th in IST, which a UTC boundary would reverse. */
    const r = await ask(`date=${TUE}`);
    assert.ok(r.body.notStarted.rows.some((x) => x.id === id.ana),
      'Ana’s session belongs to the 18th, so the 17th is empty for her');
    assert.strictEqual(r.body.notStarted.total, 3, 'nobody started on the 17th');
  });

  await t.test('MUTATION 7 (live) — when a line was typed is not part of the question', async () => {
    const when = await sql(cfg, "SELECT created_at FROM timesheet_entries WHERE id = 'te-idle'");
    assert.ok(when.length && when[0].created_at, 'the fixture line was typed now, not in March');
    const src = SRC('timesheets.js');
    const fn = src.slice(src.indexOf('async function filledDays('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(!/created_at/.test(body), 'filledDays reads entry_date and nothing else');
  });

  await t.test('MUTATION 16 — the server refuses without the permission, and omits the key', async () => {
    /* report.follow_up is Super Admin only by default, through
       managePermissions — pinned against the catalogue in the defaults test. An
       artist's designation holds neither, so start by giving it the dashboard
       alone and show that it is not enough. */
    const grant = async (role, keys) => {
      const r = await api(server.base, `/permissions/roles/${role}`, {
        method: 'PUT', token: root, body: { permissions: keys },
      });
      assert.ok(r.status < 400, JSON.stringify(r.body));
    };
    const reset = (role) => api(server.base, `/permissions/roles/${role}/reset`,
      { method: 'POST', token: root });

    try {
      await grant('game_artist', ['report.admin_dashboard']);
      const refused = await ask(`date=${WED}`, token.ana);
      assert.strictEqual(refused.status, 403, 'the endpoint is its own gate');

      /* AND THE KEY IS ABSENT FROM THE GENERAL PAYLOAD, not present and empty.
         These two gates have diverged in this application before, which is why
         both are asserted — the endpoint above and the dashboard here. */
      const dash = await api(server.base, '/admin-dashboard', { token: token.ana });
      assert.strictEqual(dash.status, 200);
      assert.ok(!('followUp' in dash.body),
        'an empty block would tell them nobody in the studio is behind');

      await grant('game_artist', ['report.admin_dashboard', 'report.follow_up']);
      const allowed = await ask(`date=${WED}`, token.ana);
      assert.strictEqual(allowed.status, 200, 'the grant is what opens it');
      const withKey = await api(server.base, '/admin-dashboard', { token: token.ana });
      assert.ok('followUp' in withKey.body, 'and the key arrives with the rest of the screen');
      assert.strictEqual(withKey.body.followUp.startedFor.to, withKey.body.followUp.today,
        'the first draw is today, like the page\'s own default');

      /* AND IT IS SCOPED, NOT WIDENED. An artist's projectScope is 'own_work',
         so holding the key opens the section without showing them the studio. */
      assert.strictEqual(withKey.body.followUp.scope.studioWide, false);

      // The screen's own gate still applies on top of it.
      await grant('game_artist', ['report.follow_up']);
      const noDash = await ask(`date=${WED}`, token.ana);
      assert.strictEqual(noDash.status, 403, 'the Admin Dashboard gate is still required');
    } finally {
      await reset('game_artist');
    }
  });

  await t.test('the validation is the server\'s', async () => {
    const tomorrow = gate.istDate(Date.now() + 86400000);
    for (const [query, why] of [
      [`date=${tomorrow}`, 'a future date'],
      ['date=2026-02-30', 'a day that is not a day'],
      ['date=nonsense', 'not a date'],
      [`from=${FRI}&to=${MON}`, 'a backwards range'],
      ['from=2026-01-01&to=2026-03-18', 'a range past the cap'],
    ]) {
      const r = await ask(query);
      assert.strictEqual(r.status, 400, `${why} is refused: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.error, 'and says why');
    }
    const ok = await ask(`from=${MON}&to=${FRI}`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.mode, 'range');
    assert.deepStrictEqual(ok.body.startedFor.days, [MON, TUE, WED, THU, FRI]);
  });

  await t.test('a weekend is a stated empty, and the earliest day is reported', async () => {
    const sat = await ask(`date=${SAT}`);
    assert.strictEqual(sat.body.workingDay, false);
    assert.deepStrictEqual(sat.body.startedFor.days, []);
    assert.strictEqual(sat.body.notStarted.total, 0, 'nobody owes work for a Saturday');

    /* THE PICKER'S FLOOR is the earlier of the first session and the first
       timesheet line. The oldest session here is 10 February and the oldest
       line is 1 February, so the line wins — which is the half a floor taken
       from work_sessions alone would lose. */
    const r = await ask(`date=${THU}`);
    assert.strictEqual(r.body.earliest, '2026-02-01');
  });

  await t.test('the index the lists need is in place after a migration', async () => {
    const rows = await sql(cfg,
      'SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq '
      + 'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() '
      + "AND TABLE_NAME = 'work_sessions' AND INDEX_NAME = 'idx_ws_user_started' "
      + 'ORDER BY SEQ_IN_INDEX');
    assert.deepStrictEqual(rows.map((x) => x.col), ['user_id', 'started_at'],
      'user_id is the equality and started_at the range, in that order');

    // The timesheet half needs nothing new: its own DDL already carries it.
    const tse = await sql(cfg,
      'SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS '
      + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_entries' "
      + "AND INDEX_NAME = 'idx_tse_user_day' ORDER BY SEQ_IN_INDEX");
    assert.deepStrictEqual(tse.map((x) => x.col), ['user_id', 'entry_date']);
  });

  await t.test('the gate and this section ask the same question of the same rows', async () => {
    /* ONE QUERY SHAPE, TWO CALLERS. hasLineOn — the previous-working-day gate's
       whole notion of "filled" — is filledDays with a range of one, so the
       start gate and this list cannot disagree about a day. Asserted on the
       source because the two are the same call; asserted on the DATA by Bo's
       Idle line above, which both read as filled. */
    const src = SRC('timesheets.js');
    const fn = src.slice(src.indexOf('async function hasLineOn('));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')),
      /await filledDays\(db, \[userId\], date, date\)/);

    const r = await ask(`date=${WED}`);
    assert.ok(!r.body.notFilled.rows.some((x) => x.id === id.bo));
  });
});
