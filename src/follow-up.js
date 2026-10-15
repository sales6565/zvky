/* PEOPLE TO FOLLOW UP: who did not start, and who did not fill a timesheet.
 *
 * An Admin Dashboard section, and a read model like everything else on that
 * screen: two lists of names for a day somebody picked, and not one control
 * that changes anything.
 *
 * ----------------------------------------------------------------------------
 * THIS FILE INVENTS NO DEFINITIONS. That is the whole of its design, and the
 * reason it exists as a module rather than as a query inside the route.
 *
 * Four questions have to be answered to draw these lists, and every one of them
 * was already answered somewhere in this application:
 *
 *   is D a working day            src/timesheet-gate.js  isWorkingDay()
 *   what is the previous one      src/timesheet-gate.js  previousWorkingDay()
 *   is a day "filled"             src/timesheets.js      filledDays()
 *   which days is the studio shut src/holidays.js        via the gate's isHoliday
 *
 * All four are ASKED, never restated. A second reading of "working day" would
 * agree with the first until a studio moved its weekly off, and then the
 * previous-working-day gate would demand a timesheet for a day this screen said
 * was shut — which is precisely the class of bug this codebase keeps finding.
 * tests/follow-up.test.js mutates each shared helper and asserts this section
 * moves with it.
 *
 * The ONE definition that is new is "started on D", because nothing needed it
 * before; it is written out below and nothing else in the app computes it.
 *
 * ----------------------------------------------------------------------------
 * WHAT CAN AND CANNOT BE RECONSTRUCTED FOR A PAST DATE, stated here because the
 * section's honesty rests on it and the page repeats it to the reader.
 *
 *   joined when            users.created_at            RECONSTRUCTABLE
 *   left when              users.deactivated_at        RECONSTRUCTABLE, except
 *                                                      for accounts deactivated
 *                                                      before that column
 *                                                      existed (NULL) and for
 *                                                      anyone reactivated since
 *                                                      (reactivate NULLs it).
 *   which designation      users.role                  NOT RECONSTRUCTABLE —
 *                                                      there is no role history
 *                                                      table in this schema.
 *   which assets they held asset_assignments           RECONSTRUCTABLE, by the
 *                                                      assigned_at / ended_at
 *                                                      stamps.
 *   what status those were asset_events                not read here; "status at
 *                                                      an instant" is a replay
 *                                                      this section does not do.
 *
 * So the designation is the one place today's answer is used for a past day, and
 * the page SAYS SO rather than letting somebody discover it. Everything else
 * uses the recorded dates, and where a date is missing the person is left out
 * and counted in a visible note instead of being guessed either way.
 *
 * ----------------------------------------------------------------------------
 * FREELANCERS ARE NOT EXCLUDED BY A FILTER. They have no users row at all —
 * `freelancers` is its own table and a freelancer has no login (see the header
 * of src/asset-workflow.js) — so there is nothing to exclude. The brief asked
 * for it; the schema already answers it, and the test asserts the premise so a
 * future freelancer login does not quietly acquire a nagging list.
 */

const gate = require('./timesheet-gate');
const timesheets = require('./timesheets');
const timesheetSettings = require('./timesheet-settings');
const holidays = require('./holidays');
const workSchedule = require('./work-schedule');
const workingTime = require('./working-time');
const { assignableRoles, roleDef } = require('./roles');
const permissions = require('./permissions');
/* THE MARKER AND THE BUTTON, both of which hang off the rows this file builds.
 *
 * src/last-activity.js owns "when was this person last active" and the streak;
 * src/reminders.js owns whether a reminder may be sent and why not. Neither
 * knows how a list is drawn and this file knows nothing about either's rules —
 * the division is the same one the four shared definitions above have, and for
 * the same reason. */
/* WHAT IS WAITING ON ONE PERSON, which is the figure this section's rows have
 * always printed and — until this change — not quite been. src/waiting-work.js
 * owns the predicate; heldCounts() below keeps the reconstruction a past date
 * needs. See the header of that file for the difference and why there are two. */
const waitingWork = require('./waiting-work');
const dayStatus = require('./day-status');
const leaveSettings = require('./leave-settings');
const lastActivity = require('./last-activity');
const reminders = require('./reminders');
const reminderSettings = require('./reminder-settings');

/* HOW LONG AFTER THE STUDIO OPENS BEFORE SOMEBODY IS "NOT STARTED".
 *
 * Sixty minutes, named, and applied to TODAY ONLY.
 *
 * The list exists to be acted on — somebody reads a name and sends a message —
 * and a list drawn at 09:31 is the whole studio. An hour is the shortest window
 * in which "has not started" means anything other than "has not arrived yet",
 * and the screen states it rather than leaving a reader to wonder why the list
 * was empty when they looked.
 *
 * IT IS NOT APPLIED TO A PAST DATE, and that is not a detail. Yesterday is
 * over: somebody who started at 18:00 started, and holding yesterday's list
 * open for an hour after the studio opened would be meaningless. It also has to
 * be this way for the section to be self-consistent — see agreesLater() in the
 * test: Today's answer and the same date read back next week must match, and a
 * grace period applied to a past date would make them differ.
 *
 * Measured from the studio's OPENING, not from midnight: the clock's own
 * window (src/working-time.js), which a Super Admin can move in Settings.
 */
const GRACE_MINUTES = 60;

/* AND IT IS NOW A SETTING, with the constant above as its default.
 *
 * The start-of-day banner and the two automatic reminders are measured from the
 * same grace period this section is, so a studio that moves it has to move all
 * three — which means there can only be one number. It lives in
 * reminder_settings (Settings -> Start-of-day Nudges) and is read through here
 * so that every reader of "the grace period" reads this function.
 *
 * Falls back to the constant on a database that has not migrated, which is the
 * behaviour this section had before the setting existed. */
const graceMinutes = () => {
  const n = Number((reminderSettings.current() || {}).graceMinutes);
  return Number.isFinite(n) && n > 0 ? n : GRACE_MINUTES;
};

/* How many names each list hands over before the page has to ask for the rest.
 *
 * Twenty-five is about a screenful. The payload says the total, so the heading
 * is honest about what it is showing, and "show all" lifts the cap on the next
 * request rather than sending a studio's worth of names to a panel that will
 * draw a quarter of them. */
const ROW_CAP = 25;

/* The widest range the section will answer for, in days. The point of the range
   is "who has been missing this fortnight"; a year of it is a report, not a
   dashboard section, and it is the exports' job. */
const MAX_RANGE_DAYS = 31;

/* HOW LONG A PAST DATE'S ANSWER MAY BE REUSED, and why Today is never cached.
 *
 * A past day's rows cannot change except by somebody back-filling a timesheet,
 * so a minute of staleness costs nothing and the section is on a screen people
 * leave open. TODAY'S CAN CHANGE AT ANY SECOND — that is the entire point of
 * the list — and a cached Today would keep naming somebody who started work
 * two minutes ago, which is the one thing that would make the studio stop
 * trusting it. */
const CACHE_MS = 60 * 1000;
const CACHE_CAP = 64;
const cache = new Map();

const MS_PER_DAY = 86400000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/* The UTC instant an IST calendar day begins at. Every boundary in this file
   goes through this one function — the same arithmetic as gate.istDate read
   backwards — so there is one place for an off-by-one to live and one place to
   test it. */
const startOfDayMs = (date) => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
const endOfDayMs = (date) => startOfDayMs(date) + MS_PER_DAY;

/* A UTC instant as MySQL writes a DATETIME. The stamps in this schema are UTC
   — NOW() is UTC_TIMESTAMP() here — so a boundary handed to a query has to be
   in the same frame as the column, and that is not the IST date it came from. */
function sqlStamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/* THE STUDIO'S WORKING-DAY RULE, asked of src/timesheet-gate.js with the live
 * settings and holiday mirrors filled in.
 *
 * Not a copy of it: this supplies the two inputs and the gate decides. The
 * mirrors are read at the moment of the call rather than captured, because a
 * Super Admin can change the weekly off or declare a holiday while the server
 * is up and the next draw of this panel must obey the new answer.
 *
 * AN UNLOADED HOLIDAY MIRROR IS "WE DO NOT KNOW", and it is reported rather
 * than guessed. The gate fails open — nobody is blocked from working — but a
 * follow-up list cannot fail open in the same direction: guessing no holidays
 * would nag the whole studio for Diwali. So the section refuses to draw and
 * says why, which is the honest version of failing safe for a read model.
 */
function workingDayRule() {
  const policy = timesheetSettings.current() || {};
  return {
    loggableDays: policy.loggableDays,
    isHoliday: (d) => Boolean(holidays.on(d)),
  };
}

const isWorkingDay = (date) => gate.isWorkingDay(date, workingDayRule());
const previousWorkingDay = (date) => gate.previousWorkingDay(date, workingDayRule());

/* Every working day in a range, oldest first. Built by walking and asking, so a
   holiday declared in the middle of a fortnight drops out of both lists at
   once. */
function workingDaysIn(from, to) {
  const days = [];
  for (let d = from; d <= to; d = gate.shiftDays(d, 1)) {
    if (isWorkingDay(d)) days.push(d);
    if (days.length > MAX_RANGE_DAYS) break;
  }
  return days;
}

/* THE LATEST WORKING DAY AT OR BEFORE A DATE.
 *
 * The streak's starting point. Usually the date itself — the section's lists are
 * empty on a day the studio was shut — but a holiday declared after the fact
 * leaves a past date that was a working day when somebody looked at it and is
 * not one now, and a walk that started on a day the gate calls shut would count
 * it as a miss. Bounded, so a studio with a very long declared shutdown cannot
 * turn this into a loop. */
function lastWorkingDayTo(date) {
  let day = date;
  for (let i = 0; i <= MAX_RANGE_DAYS; i += 1) {
    if (isWorkingDay(day)) return day;
    day = gate.shiftDays(day, -1);
  }
  return null;
}

/* WHEN THE STUDIO'S CLOCK OPENS ON AN IST DAY, or null if it does not.
 *
 * The first recordable minute of the day, from the recording schedule — the
 * same spansOn() the timer itself is measured against, so the grace period
 * starts when somebody could actually have clicked Accept and Start rather than
 * at midnight.
 *
 * Null means the clock is shut that day. That is a different thing from the day
 * not being loggable (see the gate's header on why the two lists differ), and
 * the caller treats it as "there is nothing to be late for". */
function opensAtMs(date, schedule = workSchedule.trackingWindow()) {
  if (!isDate(date)) return null;
  /* startOfDayMs(date) is dayNumber * MS_PER_DAY - IST_OFFSET_MS, so the day
     number src/working-time.js counts in comes back by undoing exactly that —
     rather than being re-derived from a Date, which would be the offset applied
     a second time and a second place to get it wrong. */
  const dayNumber = (startOfDayMs(date) + IST_OFFSET_MS) / MS_PER_DAY;
  const spans = workingTime.spansOn(dayNumber, schedule);
  if (!spans.length) return null;
  return workingTime.instantAt(dayNumber, spans[0][0]);
}

/* ---------------------------------------------------------------------------
 * WHO THE STUDIO EXPECTED, ON A GIVEN DAY.
 *
 * One query for the whole range, and the per-day decision made in JavaScript
 * from the stamps it returns — because the answer differs per day (somebody who
 * joined on Wednesday was not expected on Tuesday) and a query per day is
 * exactly what the section's query-count test forbids.
 *
 * A DESIGNATION THE STUDIO GIVES WORK TO. assignableRoles() — the convention
 * this codebase already uses for "people the studio hands work to" (the
 * Assignee dropdown, the Idle Report, Team Capacity). Administrators,
 * directors, production and staff are not assignable and are not expected to
 * clock in against an asset, so a list containing them would be all of them,
 * every day, and nobody would read it twice.
 *
 * THE WHOLE CATALOGUE, NOT ONLY THE ACTIVE PART, and this is a deliberate
 * divergence from the Idle Report's trackingRoleKeys(), which filters to
 * activeRoles(). A designation retired in Settings still had people doing work
 * under it last month, and they keep working under it until somebody moves them
 * (see src/roles.js on activeRoles). For a question about a PAST day, dropping
 * a retired designation would erase the people who were doing the work.
 */
async function expectedPeople(db, { to }) {
  const roles = assignableRoles();
  if (!roles.length) return { people: [], roles };
  const { rows } = await db.query(
    `SELECT u.id, u.\`name\`, u.email, u.\`role\`, u.is_active AS isActive,
            u.deactivated_at AS deactivatedAt, u.created_at AS createdAt
       FROM users u
      WHERE u.\`role\` IN ($1)
        AND u.created_at < $2
      ORDER BY u.\`name\``,
    [roles, sqlStamp(endOfDayMs(to))]
  );
  return {
    roles,
    people: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleLabel: (roleDef(r.role) || {}).label || r.role,
      isActive: Number(r.isActive) !== 0,
      createdAtMs: stampMs(r.createdAt),
      deactivatedAtMs: r.deactivatedAt === null || r.deactivatedAt === undefined
        ? null : stampMs(r.deactivatedAt),
    })),
  };
}

/* A DATETIME column, as an instant.
 *
 * The driver hands these back as Date objects built in the server's local zone
 * from values that are UTC, which is a whole hour of error wherever the server
 * is not on UTC — and these comparisons decide whether somebody existed on a
 * day. Read through the string form so the frame is explicit. */
function stampMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds());
  }
  const text = String(value).trim().replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/* WAS THIS PERSON ON THE BOOKS ON THIS DAY?
 *
 *   joined            created_at must fall on or before D. Somebody who joined
 *                     on Wednesday owes nothing for Tuesday — the same rule
 *                     src/timesheet-gate.js already applies to the start gate.
 *   still here        deactivated_at, when it is recorded, must fall after D
 *                     BEGAN. "Active at any point during D" rather than "at the
 *                     end of D": somebody whose last day was D worked D, and a
 *                     list that dropped them would quietly lose their final
 *                     timesheet. The more inclusive reading is the right error
 *                     for a list whose purpose is to surface people.
 *   unknowable        is_active = 0 with deactivated_at NULL is an account
 *                     deactivated before that column existed. There is no date
 *                     to compare, so they are LEFT OUT and counted in a visible
 *                     note. Guessing them in would nag about somebody who left
 *                     two years ago; guessing them in for today and out for
 *                     yesterday would be worse.
 *
 * NEVER TODAY'S FLAG FOR A PAST DATE. is_active alone is consulted only when
 * deactivated_at is NULL and the account is active — where the two agree.
 */
function onBooksOn(person, day) {
  if (person.createdAtMs === null) return person.isActive;
  if (person.createdAtMs >= endOfDayMs(day)) return false;
  if (person.deactivatedAtMs !== null) return person.deactivatedAtMs > startOfDayMs(day);
  return person.isActive;
}

/* Accounts whose past cannot be reconstructed — the note's subject. */
const unreconstructable = (people) =>
  people.filter((p) => !p.isActive && p.deactivatedAtMs === null);

/* ---------------------------------------------------------------------------
 * WHICH PEOPLE THIS VIEWER MAY BE SHOWN.
 *
 * Scoped by permissions.visibleProjects(), the same rule every other number on
 * the Admin Dashboard is scoped by: an Admin (projectScope 'owned') sees the
 * projects they created, and a studio-wide list of names on their screen would
 * be people they cannot otherwise reach.
 *
 * IN SCOPE MEANS CONNECTED TO A VISIBLE PROJECT, by either of the two ways this
 * schema records that: named in project_members (the Edit User screen's Project
 * field), or holding — or having held — an asset in one. The second is read from
 * asset_assignments as well as assets.assignee_id, so somebody who finished
 * their last task in the project a month ago is still a person this viewer is
 * responsible for.
 *
 * SOMEBODY ATTACHED TO NO PROJECT AT ALL is visible ONLY to a viewer whose
 * projectScope is 'all'. There is no visible project to connect them through,
 * so for anybody narrower they are not in scope — and the alternative, showing
 * them to everyone, would make a scoped screen the one place in the app that
 * discloses the whole staff list. A studio-wide viewer sees them, because they
 * see the studio, and the page says that a new starter with no project yet
 * appears only there.
 *
 * THE "STARTED" AND "FILLED" ANSWERS ARE WHOLE-PERSON, not scoped. Scope decides
 * WHO is listed; once somebody is listed, the question is whether they started
 * work at all, and clipping their sessions to visible projects would print
 * "has not started" beside somebody who spent the day on a project this viewer
 * cannot see. That is a confident wrong answer, and src/routes/idle.js made the
 * same call for the same reason — see its note on coverage being whole-person.
 */
async function inScope(db, { projectIds, studioWide }) {
  if (studioWide) return null;            // null = no narrowing
  if (!projectIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT s.user_id AS userId FROM (
        SELECT pm.user_id FROM project_members pm WHERE pm.project_id IN ($1)
        UNION
        SELECT aa.user_id FROM asset_assignments aa
          JOIN assets a ON a.id = aa.asset_id WHERE a.project_id IN ($1)
        UNION
        SELECT a.assignee_id AS user_id FROM assets a WHERE a.project_id IN ($1)
      ) s
      WHERE s.user_id IS NOT NULL`,
    [projectIds]
  );
  return new Set(rows.map((r) => r.userId).filter(Boolean));
}

/* ---------------------------------------------------------------------------
 * STARTED ON D — the one definition this file owns.
 *
 * A work session whose started_at falls on D, read in IST. One row in
 * work_sessions per stretch of work (see src/work-log.js): opened by Accept and
 * Start or by Resume, and never moved afterwards.
 *
 * IST, NOT UTC, and the +330 minutes is why. The column is UTC — NOW() is
 * UTC_TIMESTAMP() on this schema — so a day boundary taken straight off the
 * column would put everything between midnight and half past five in the
 * morning IST on the previous day, and everything the studio did after half
 * past five on a Friday evening... nowhere a reader would look. The whole
 * five and a half hours is the studio's working evening.
 *
 * NOT "ENDED ON D", AND NOT "OVERLAPPED D". A session opened on Monday evening
 * and closed on Tuesday morning is a Monday start, and this list is about
 * whether somebody picked work up — not about whether a timer happened to be
 * running. Overlap would credit Tuesday to a timer nobody touched.
 *
 * THE OVERNIGHT AUTO-RESUME COUNTS AS A START, and this is the decision worth
 * reading twice. src/work-log.js's resumeOverdue() opens a NEW session, stamped
 * at the studio's opening time, for every timer the studio's own seven o'clock
 * sweep paused the night before — provided the work is still assigned, still
 * unsubmitted and the person has not started something else. Nobody clicks
 * anything. So somebody whose Monday timer was paused at seven has a session
 * starting Tuesday at half past nine without touching a key.
 *
 * It counts, for two reasons:
 *
 *   IT IS TRUE. The clock is running and the hours are accruing against that
 *   asset. A follow-up list that named them anyway would be telling a lead to
 *   chase somebody the application is already crediting with a working morning,
 *   and the lead would check and find time logged.
 *
 *   IT IS STABLE. The row is written once and never rewritten, so Today's
 *   answer and the same date read back next week are the same answer. A rule
 *   that excluded sweep-written sessions would have to tell them apart, and
 *   work_sessions records no author — so it would have to guess from the stamp,
 *   which is exactly the kind of rule that reads one way this morning and
 *   another way in a month.
 *
 * The cost is stated on the page rather than hidden: a timer picked up by the
 * studio's own sweep reads as a start, so somebody on unrecorded leave whose
 * task was still open can be absent from this list. This application records
 * leave nowhere (see idle.caveats), so no list drawn from it can fix that.
 */
async function startedDays(db, userIds, { from, to }) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Set();
  const { rows } = await db.query(
    `SELECT w.user_id AS userId,
            DATE_FORMAT(DATE_ADD(w.started_at, INTERVAL ${workingTime.IST_OFFSET_MINUTES} MINUTE),
                        '%Y-%m-%d') AS day
       FROM work_sessions w
      WHERE w.user_id IN ($1)
        AND w.started_at >= $2
        AND w.started_at < $3
      GROUP BY w.user_id, day`,
    [ids, sqlStamp(startOfDayMs(from)), sqlStamp(endOfDayMs(to))]
  );
  return new Set(rows.map((r) => `${r.userId}|${r.day}`));
}

/* ---------------------------------------------------------------------------
 * HOW MUCH WORK WAS ON THIS PERSON'S DESK, over the days in question.
 *
 * The marker that turns a name into a priority: somebody with four assets
 * waiting who has not started is a different message from somebody with none.
 *
 * MEASURED OVER D'S OWN BOUNDS, WHICH IS WHY IT IS NEVER THE CURRENT COUNT.
 * asset_assignments carries assigned_at and ended_at, so "held at some point on
 * D" is an overlap test against D — and for a past date that is what it
 * reports, not what is on their desk this afternoon. Printing today's figure
 * beside yesterday's list would be the worst kind of wrong: it looks like
 * evidence.
 *
 * Scoped to the viewer's visible projects, unlike "started" and "filled" above,
 * and the difference is deliberate. Those two are facts about a person's day and
 * clipping them would make them false. This is a count of WORK, and work belongs
 * to a project — a viewer who cannot open the project has no business being told
 * how much of it there is.
 *
 * DISTINCT assets, because an asset reassigned away and back is one asset.
 */
async function heldCounts(db, userIds, { from, to, projectIds, studioWide }) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  if (!studioWide && !projectIds.length) return new Map();
  const params = [ids, sqlStamp(endOfDayMs(to)), sqlStamp(startOfDayMs(from))];
  let scope = '';
  if (!studioWide) {
    params.push(projectIds);
    scope = `AND a.project_id IN ($${params.length})`;
  }
  const { rows } = await db.query(
    `SELECT aa.user_id AS userId, COUNT(DISTINCT aa.asset_id) AS n
       FROM asset_assignments aa
       JOIN assets a ON a.id = aa.asset_id
      WHERE aa.user_id IN ($1)
        AND aa.assigned_at < $2
        AND (aa.ended_at IS NULL OR aa.ended_at > $3)
        ${scope}
      GROUP BY aa.user_id`,
    params
  );
  return new Map(rows.map((r) => [r.userId, Number(r.n) || 0]));
}

/* THE OLDEST DAY THIS SECTION CAN HONESTLY ANSWER FOR.
 *
 * The earlier of the first work session and the first timesheet line. Before
 * that there is no data, so every name in the studio would appear in both lists
 * and the screen would read as a catastrophe rather than as an empty database.
 * The page uses it as the date picker's floor and says what it is.
 *
 * Null means neither table holds anything, and the page then offers today only.
 */
async function earliestDay(db) {
  const { rows } = await db.query(
    `SELECT DATE_FORMAT(DATE_ADD(MIN(started_at), INTERVAL ${workingTime.IST_OFFSET_MINUTES} MINUTE),
                        '%Y-%m-%d') AS day
       FROM work_sessions`
  ).catch(() => ({ rows: [{ day: null }] }));
  const session = (rows[0] && rows[0].day) || null;
  const entry = await timesheets.earliestEntryDate(db).catch(() => null);
  const both = [session, entry].filter(isDate);
  return both.length ? both.sort()[0] : null;
}

/* ---------------------------------------------------------------------------
 * WHAT HAS ALREADY BEEN SENT, AND WHAT MAY STILL BE — laid over the rows.
 *
 * SEPARATE FROM THE REST OF THE DRAW, AND DELIBERATELY SO: the cache above
 * keeps a past date's lists for a minute, and reminder state is about TODAY. A
 * row cached at 11:04 saying nobody has been nudged, served at 11:05 after
 * somebody was, is exactly the "two leads both nudge the same person" this is
 * meant to prevent. So the lists are cached and this is not — one query on a
 * cache hit, which is the price of the screen being right about it.
 *
 * ONE QUERY FOR BOTH LISTS AND EVERY ROW. Grouped in src/reminders.js; a query
 * per row is the N+1 the section's own budget test forbids.
 *
 * THE DECISION IS THE SERVER'S, per row, through the same decide() the send
 * endpoint runs. The button is drawn disabled with the server's own sentence
 * rather than the page working out for itself what is allowed — which is the
 * other half of "the page never recomputes a permission".
 */
async function applyReminderState(db, payload, { now, today, user }) {
  if (!payload || payload.ok === false || payload.unavailable) return payload;

  const nudges = reminderSettings.current();
  const policy = timesheetSettings.current() || {};
  const schedule = workSchedule.trackingWindow();
  /* THE PERMISSION, FROM THE SERVER'S OWN RESOLVED LIST, not from a tier and not
     from the browser. The page gates the button on can('report.remind') as well;
     both read the same key off the same list. */
  const mayRemind = Boolean(user && permissions.holds(user, 'report.remind'));

  const ids = [...new Set([
    ...payload.notStarted.rows.map((r) => r.id),
    ...payload.notFilled.rows.map((r) => r.id),
  ])];
  /* SENT TODAY, whatever date is being viewed. The cap is "per person per kind
     per day" and the day in question is the day somebody is clicking on, not
     the day they are reading about. */
  const sent = await reminders.sentOnDay(db, ids, { day: today });

  /* The window is asked once for the whole draw rather than per row: it is a
     fact about the studio's clock at this instant, identical for everybody. */
  const win = reminders.windowState(now, { schedule });

  /* WHO IS AWAY RIGHT NOW, for every row in both lists, in ONE query. A
     reminder may not land on somebody inside a leave window — see decide() —
     and asking that per row would be 116 round trips for a fact about today. */
  const todayMarks = await dayStatus.statusesFor(db, ids, today);

  const decorate = (rows, kind) => rows.map((row) => {
    /* WHICH DAY THE REMINDER IS ABOUT.
       A start reminder is about today and only today — see decide(). A timesheet
       reminder is about the MOST RECENT day this person missed, which in day mode
       is the one day on the list and over a range is the one they are most likely
       to still be able to file for. */
    const subjectDate = kind === reminders.KINDS.start
      ? payload.to
      : row.days[row.days.length - 1];
    const forKind = (sent.byUser.get(row.id) || {})[kind] || { manual: [], auto: [] };
    const verdict = reminders.decide({
      kind,
      settings: nudges,
      person: { id: row.id, name: row.name },
      inScope: true,          // they are on a list this viewer was served
      listed: true,           // and they are on it because the condition holds
      subjectDate,
      today,
      workingDay: isWorkingDay(subjectDate),
      window: kind === reminders.KINDS.start ? win : null,
      manualCount: forKind.manual.length,
      backdateClosed: kind === reminders.KINDS.timesheet
        ? reminders.backdateState(subjectDate, { today, policy }) : null,
      actorId: user ? user.id : null,
      /* TODAY'S MARK — whether this person is away at this moment, which is
         where the message would land. One query for the whole payload. */
      dayStatus: todayMarks.get(`${row.id}|${today}`) || null,
      now,
    });
    const last = forKind.manual[forKind.manual.length - 1] || null;
    const auto = forKind.auto[forKind.auto.length - 1] || null;
    return {
      ...row,
      remind: {
        kind,
        subjectDate,
        /* BOTH HALVES, SEPARATELY. The page needs to know the difference between
           "you may not send reminders" (no button at all) and "this one cannot
           be sent" (a disabled button with the reason on it). */
        permitted: mayRemind,
        may: mayRemind && verdict.ok,
        code: verdict.code,
        reason: verdict.message,
        sent: forKind.manual.length,
        cap: Number(nudges.dailyCap) || 1,
        /* "Reminded today 11:05 by Priya", for every lead who can see the list
           and not only for the one who clicked. */
        last: last ? { at: last.at, by: last.senderName, channels: last.channels } : null,
        /* "Auto reminder sent 10:30" — absent until something writes an 'auto'
           row, which nothing does yet. See src/reminders.js. */
        auto: auto ? { at: auto.at, channels: auto.channels } : null,
      },
    };
  });

  return {
    ...payload,
    notStarted: { ...payload.notStarted, rows: decorate(payload.notStarted.rows, reminders.KINDS.start) },
    notFilled: { ...payload.notFilled, rows: decorate(payload.notFilled.rows, reminders.KINDS.timesheet) },
    reminders: {
      permitted: mayRemind,
      manualEnabled: Boolean(nudges.manualEnabled),
      emailEnabled: Boolean(nudges.emailEnabled),
      cap: Number(nudges.dailyCap) || 1,
      logged: sent.available,
      window: win,
    },
  };
}

/* ---------------------------------------------------------------------------
 * VALIDATION, which is the server's and not the page's.
 *
 * The picker disables a future date; this refuses one. A date control is a
 * convenience and the URL is not, so every rule the page draws is also checked
 * here — a malformed date, a date that is not a date (2026-13-40 parses as an
 * instant and is not a calendar day), a future date, and a range wider than the
 * cap or running backwards.
 */
function validate(query = {}, { now = Date.now() } = {}) {
  const today = gate.istDate(now);
  const asked = {};

  const real = (v) => isDate(v) && gate.istDate(Date.parse(`${v}T00:00:00Z`) - IST_OFFSET_MS) === v;

  if (query.from || query.to) {
    const from = String(query.from || '');
    const to = String(query.to || '');
    if (!real(from) || !real(to)) {
      return { ok: false, status: 400, error: 'A range needs a from and a to, each as YYYY-MM-DD.' };
    }
    if (to < from) return { ok: false, status: 400, error: 'The range ends before it begins.' };
    if (to > today) return { ok: false, status: 400, error: `The range runs past today (${today}).` };
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY) + 1;
    if (span > MAX_RANGE_DAYS) {
      return { ok: false, status: 400, error: `A range may cover at most ${MAX_RANGE_DAYS} days; that one covers ${span}.` };
    }
    asked.mode = 'range';
    asked.from = from;
    asked.to = to;
  } else {
    const date = query.date === undefined || query.date === null || query.date === ''
      ? today : String(query.date);
    if (!real(date)) {
      return { ok: false, status: 400, error: 'A date must be a real calendar day, as YYYY-MM-DD.' };
    }
    if (date > today) return { ok: false, status: 400, error: `${date} is in the future.` };
    asked.mode = 'day';
    asked.date = date;
    asked.from = date;
    asked.to = date;
  }
  asked.all = query.all === '1' || query.all === true || query.all === 'true';
  /* HOW THE LISTS ARE ORDERED. Urgency by default — see the note on urgency()
     below — and "longest inactive" when somebody asks for it, which is the one
     other order the rows carry a number for. Anything else is the default
     rather than a 400: a sort is a view preference, and refusing to draw a
     screen because a query string had a typo in it is a worse answer than
     drawing it the usual way round. */
  asked.sort = query.sort === 'inactive' ? 'inactive' : 'urgency';
  return { ok: true, asked, today };
}

/* ---------------------------------------------------------------------------
 * THE SECTION.
 */
async function build(db, user, options = {}) {
  const {
    now = Date.now(),
    query = {},
    visibleProjects = permissions.visibleProjects,
    /* FRESH SKIPS THE CACHE, both reading it and writing it.
     *
     * One caller asks for it: the reminder endpoints, which call this builder to
     * RE-CHECK that the person is still on the list before sending. A minute of
     * staleness is nothing on a screen and everything on a send — "Priya has
     * started work since this list loaded" is the whole point of the re-check,
     * and a cached answer could not tell. */
    fresh = false,
    /* WHO IS IN VIEW AND *NOT* ON THE LIST, asked for only by the reminder
     * endpoints and never by the browser.
     *
     * It is what lets a refusal say "Priya has started work since this list
     * loaded" rather than the vaguer truth. Without it the server cannot tell
     * "in scope, and has since started" from "not in your projects at all", and
     * those two must not share a sentence: naming somebody outside your scope,
     * even to say they have started, answers the question the scope rule exists
     * to withhold.
     *
     * It costs no query — these are rows gather() has already walked past — and
     * it is off by default so the names cannot reach a page that did not ask. */
    withCleared = false,
  } = options;

  const checked = validate(query, { now });
  if (!checked.ok) return checked;
  const { asked, today } = checked;

  /* THE HOLIDAY CALENDAR IS NOT OPTIONAL HERE, unlike in the start gate. See
     workingDayRule() above: the gate fails open because a paperwork rule must
     never stop the floor, and this one refuses to draw because a list drawn
     without the holidays would nag the whole studio for a day the studio was
     shut. Failing safe points in opposite directions for a rule and for a
     report, and that is not an inconsistency. */
  if (!holidays.isLoaded()) {
    return { ok: true, unavailable: 'The holiday calendar could not be read, so working days cannot be worked out.' };
  }
  const policy = timesheetSettings.current() || {};
  if (!Array.isArray(policy.loggableDays) || !policy.loggableDays.length) {
    return { ok: true, unavailable: 'The studio has no days on which a timesheet can be filed, so there is nothing to follow up.' };
  }


  /* WHICH DAYS EACH LIST IS ABOUT, and they are not always the same day.
   *
   * TODAY'S TIMESHEET IS NOT DUE YET. Asking at eleven in the morning who has
   * not filled today would name everybody, every day, and the one answer the
   * studio actually wants — who still owes yesterday — would be buried. So when
   * D is today, list 2 moves to the PREVIOUS WORKING DAY, which is exactly the
   * day the start gate (Prompt 29) demands, from the same helper. The two
   * screens then name the same day by construction.
   *
   * Both dates travel in the payload and the page prints both, because two
   * lists about two days under one date control is a thing a reader must be
   * told rather than left to infer. */
  const startWindow = { from: asked.from, to: asked.to };
  const fillTo = asked.to >= today ? previousWorkingDay(today) : asked.to;
  /* AND LIST 2'S WINDOW CAN REACH BACK PAST LIST 1'S. Asked about today in day
     mode, list 2 is about YESTERDAY, which is before the date somebody picked —
     so the window is the previous working day on its own, not an empty range.
     Over a range ending today it is the range with today's tail trimmed off.
     Null only when there is no previous working day at all, which a studio with
     a holiday run longer than the gate's lookback really does have. */
  const fillWindow = fillTo
    ? { from: asked.from <= fillTo ? asked.from : fillTo, to: fillTo }
    : null;

  const startDays = workingDaysIn(startWindow.from, startWindow.to);
  const fillDays = fillWindow ? workingDaysIn(fillWindow.from, fillWindow.to) : [];

  /* THE CACHE, FOR PAST DATES ONLY, and checked BEFORE the first query so that
     a hit really costs nothing — the project list included.
     
     KEYED ON THE VIEWER as well as on the dates. Two viewers with different
     project scopes get different names for the same day, and a cache that
     forgot that would be a disclosure rather than a saving.
     
     THE COST OF CHECKING IT THIS EARLY is that a project created in the last
     minute is not reflected for a past date. A minute, on a date that is over:
     the alternative is spending a query to discover that nothing changed. */
  const pastOnly = asked.to < today && !fresh;
  /* THE NUDGE SETTINGS ARE READ BEFORE THE CACHE because one of them is baked
     into the cached half: the streak threshold decides the stronger marker on
     every row, so a cached payload keyed without it would go on marking at
     three for a minute after a Super Admin moved it to four. The cap and the two
     switches are NOT here — they live in the reminder overlay, which is never
     cached. */
  const nudges = reminderSettings.current();
  const key = `${user.id}|${user.role}|${asked.mode}|${asked.from}|${asked.to}`
    + `|${asked.all ? 'all' : 'cap'}|${asked.sort}|${nudges.streakThreshold}`;
  if (pastOnly) {
    const hit = cache.get(key);
    if (hit && hit.at + CACHE_MS > now) {
      /* THE LISTS FROM THE CACHE, THE REMINDER STATE FRESH. See
         applyReminderState: a cached "nobody has been nudged" is the one thing
         this section must not say. */
      return applyReminderState(db, { ...hit.value, cached: true }, { now, today, user });
    }
  }

  let projects;
  try {
    projects = await visibleProjects(user);
  } catch (err) {
    return { ok: true, unavailable: `The project list could not be read (${err.code || 'error'}).` };
  }
  const projectIds = projects.map((p) => p.id);
  const def = roleDef(user.role) || {};
  const studioWide = def.projectScope === 'all';

  const { people, roles } = await expectedPeople(db, { from: asked.from, to: asked.to });
  const scope = await inScope(db, { projectIds, studioWide });
  const visible = people.filter((p) => (scope === null ? true : scope.has(p.id)));

  const ids = visible.map((p) => p.id);
  /* ONE WINDOW WIDE ENOUGH FOR BOTH LISTS, so each of the three set-based reads
     below is one query however far apart the two dates are. */
  const widest = {
    from: fillWindow && fillWindow.from < asked.from ? fillWindow.from : asked.from,
    to: fillWindow && fillWindow.to > asked.to ? fillWindow.to : asked.to,
  };
  /* THE DAY THE INACTIVITY STREAK IS COUNTED BACK FROM: the most recent working
     day that is OVER. For a past date that is the date itself; for today it is
     the previous working day, because today is not finished and a streak that
     counted it would print "two working days" at half past nine about somebody
     who is about to start — which is also the row they are already on. See the
     header of src/last-activity.js. */
  const streakEnd = asked.to < today ? lastWorkingDayTo(asked.to) : previousWorkingDay(today);

  /* AND THE STARTED WINDOW IS WIDENED TO COVER THE WALK, which is what keeps
     the streak free. src/last-activity.js walks a set of started days rather
     than issuing a query of its own, so one query answers both the lists and
     every row's streak — and there is still exactly one definition of
     "started", in startedDays() above, however far back the walk goes. */
  const lookFrom = streakEnd
    ? gate.shiftDays(streakEnd, -lastActivity.LOOKBACK_CALENDAR_DAYS) : widest.from;
  const started = await startedDays(db, ids, {
    from: lookFrom < widest.from ? lookFrom : widest.from,
    to: widest.to,
  });
  const filled = fillDays.length
    ? await timesheets.filledDays(db, ids, fillDays[0], fillDays[fillDays.length - 1])
    : new Set();
  /* TWO FIGURES, ONE SLOT, AND THE LABEL ALREADY SAID WHICH.
   *
   * For TODAY the row prints what is WAITING on this person — assigned and not
   * started, or sent back to them — from src/waiting-work.js, which is the
   * predicate the panel behind the button lists. The two cannot disagree.
   *
   * For a PAST DATE that question cannot be answered: "waiting" is a statement
   * about an asset's status and its routing NOW, and this schema records no
   * status-at-an-instant to replay (see the header of this file). So a past
   * date keeps heldCounts() — assets whose assignment episode overlapped the
   * day, which IS reconstructible from assigned_at and ended_at — and the row
   * says "held that day" rather than "waiting on them", exactly as it always
   * has. The button is not offered there, because there is no list to open.
   *
   * ONE QUERY EITHER WAY, so the budget does not move. */
  const nowFigure = asked.to >= today;
  const held = nowFigure
    ? await waitingWork.countsFor(db, ids, { projectIds, studioWide })
    : await heldCounts(db, ids, { ...widest, projectIds, studioWide });
  /* WHAT KIND OF DAY EACH OF THESE PEOPLE WAS HAVING, for every day in view,
     in ONE query. 116 people and a fortnight of days is one round trip, which
     is the budget this section has always kept — see MUTATION 13. */
  const marks = await dayStatus.statusesFor(db, ids, widest.from, widest.to);

  const earliest = await earliestDay(db);

  /* THE LAST-ACTIVITY MARKER, for every person in view, in two more queries —
     not two per person. See MUTATION 13's budget in tests/follow-up.test.js and
     the one this change adds beside it. */
  const activity = await lastActivity.markersFor(db, visible, {
    asOfDay: asked.to,
    endDay: streakEnd,
    startedSet: started,
    isWorkingDay,
    shiftDays: gate.shiftDays,
    threshold: Number(nudges.streakThreshold) || 3,
  });

  /* THE GRACE PERIOD, applied to list 1 and to Today alone. */
  const schedule = workSchedule.trackingWindow();
  const opensAt = startDays.includes(today) ? opensAtMs(today, schedule) : null;
  const graceUntil = opensAt === null ? null : opensAt + graceMinutes() * 60000;
  const graceHolds = startDays.includes(today) && (graceUntil === null || now < graceUntil);

  /* LEAVE AND IDLE, APPLIED TO THE TWO LISTS — and applied differently,
   * because the two lists ask different questions.
   *
   * LIST 1 asks "should they have started?". Full-day leave and idle answer no
   * outright; a half day answers no WHILE THE WINDOW COVERS THE MOMENT BEING
   * JUDGED and yes otherwise. So somebody on first-half leave is off the list
   * all morning and back on it at two o'clock if they still have not started —
   * which is the behaviour the brief asks for, and it falls out of the window
   * rather than being written as three cases.
   *
   * A PAST DATE'S HALF DAY IS NOT AN EXCUSE. They worked the other half; a day
   * on which they started nothing at all is a day to ask about. Only a full day
   * clears a past date.
   *
   * LIST 2 asks "do they owe a timesheet?". Only a full day excuses that:
   * src/day-status.js's timesheetRequiredFromRow is the rule, and it is the
   * same function isTimesheetRequired() calls for one person.
   *
   * THE JUDGEMENTS ARE THE SHARED ONES, called with rows already in hand rather
   * than restated here. A test asserts the pair agree with the per-person
   * versions on every portion. */
  const markOf = (person, day) => marks.get(`${person.id}|${day}`) || null;
  const excusedFromStart = (person, day) => {
    const row = markOf(person, day);
    if (!row) return false;
    if (dayStatus.nothingToStart(row)) return true;
    if (row.portion === dayStatus.PORTIONS.full) return true;
    return day >= today && !dayStatus.expectedToWorkFromRow(row, now);
  };
  const excusedFromFill = (person, day) => !dayStatus.timesheetRequiredFromRow(markOf(person, day));

  const missedStart = (person, day) => !started.has(`${person.id}|${day}`) && !excusedFromStart(person, day);
  const missedFill = (person, day) => !filled.has(`${person.id}|${day}`) && !excusedFromFill(person, day);

  const gather = (days, missed) => {
    const out = [];
    for (const person of visible) {
      const owed = days.filter((d) => onBooksOn(person, d));
      if (!owed.length) continue;
      const bad = owed.filter((d) => missed(person, d));
      if (!bad.length) continue;
      out.push({
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        roleLabel: person.roleLabel,
        /* The marker, and what it is a count OF depends on which day this is
           about — the page is given the word as well as the number so it cannot
           print "waiting" over a past date's figure. */
        held: held.get(person.id) || 0,
        /* MAY THE FIGURE BE OPENED? Only when it is the "waiting" one — see
           nowFigure above. The page draws plain text otherwise rather than a
           control the server would refuse, which is the same rule the row's
           name follows for user.view. */
        expandable: nowFigure && (held.get(person.id) || 0) > 0,
        days: bad,
        missed: bad.length,
        expectedDays: owed.length,
        /* WHEN THEY WERE LAST ACTIVE, and how long the silence has run. Both
           facts and the streak, computed as of the date in view — never from
           after it. src/last-activity.js owns the whole of it. */
        activity: activity.markers.get(person.id) || null,
        /* THE MARK FOR THE DAY IN VIEW, so the row can carry a "Leave: first
           half" chip and the Remind button can be disabled while the window
           covers now. The page never works out which window it is in. */
        dayStatus: (() => {
          const row = markOf(person, asked.to);
          if (!row) return null;
          return {
            kind: row.kind,
            portion: row.portion,
            label: dayStatus.describe(row, { schedule: workSchedule.current() }),
            chip: row.kind === dayStatus.KINDS.idle ? 'Idle'
              : `Leave: ${(dayStatus.PORTION_LABELS[row.portion] || 'full day').toLowerCase()}`,
            inWindow: !dayStatus.expectedToWorkFromRow(row, now),
            planned: row.planned,
            setByName: row.setByName,
            setAt: row.setAt,
            note: row.note,
          };
        })(),
      });
    }
    return out;
  };

  const notStartedRows = graceHolds ? [] : gather(startDays, missedStart);
  const notFilledRows = gather(fillDays, missedFill);

  /* The same walk, inverted: expected on at least one of the days, and on none
     of them missing. Only built when a caller asks. */
  const clearedFor = (days, missed) => visible
    .filter((p) => days.some((d) => onBooksOn(p, d)) && !days.some((d) => onBooksOn(p, d) && missed(p, d)))
    .map((p) => ({ id: p.id, name: p.name }));

  const bothIds = new Set(
    notStartedRows.map((r) => r.id).filter((id) => notFilledRows.some((r) => r.id === id))
  );
  const mark = (rows) => rows.map((r) => ({ ...r, both: bothIds.has(r.id) }));

  /* URGENCY ORDER, and it is the same order in both lists.
   *
   *   on both lists first   two misses on one person is the message
   *   then most days missed a fortnight of silence outranks one morning
   *   then most work held   somebody with four assets waiting outranks
   *                         somebody with none; "not started and nothing to
   *                         start" is a scheduling problem, not a person to
   *                         chase
   *   then by name          so the list is stable between draws and two people
   *                         with the same urgency do not swap places under
   *                         somebody's cursor
   */
  const urgency = (a, b) => (Number(b.both) - Number(a.both))
    || (b.missed - a.missed)
    || (b.held - a.held)
    || String(a.name).localeCompare(String(b.name));

  /* LONGEST INACTIVE FIRST, which is the other order worth offering.
   *
   *   the streak first      the number the marker is drawn from, and the one a
   *                         reader asked for when they chose this order
   *   then the quiet days   calendar days since the last timer event, which
   *                         separates two people on the same streak; -1 is
   *                         "nothing ever recorded", which sorts first because
   *                         it is the longest silence there is
   *   then urgency          so the tie-break is the list's own order rather than
   *                         an arbitrary one, and the rows are still stable
   *                         between draws
   *
   * COMPUTED ON THE SERVER from the same numbers the marker is drawn from, so
   * the order and the badge can never disagree. */
  const inactivity = (a, b) => {
    const sa = (a.activity && a.activity.streak) || 0;
    const sb = (b.activity && b.activity.streak) || 0;
    if (sb !== sa) return sb - sa;
    const qa = a.activity ? a.activity.quietDays : 0;
    const qb = b.activity ? b.activity.quietDays : 0;
    /* -1 means never active. It is the longest inactivity, so it leads. */
    if (qa === -1 || qb === -1) {
      if (qa !== qb) return (qa === -1 ? 1 : 0) - (qb === -1 ? 1 : 0) > 0 ? -1 : 1;
    } else if (qb !== qa) return qb - qa;
    return urgency(a, b);
  };

  const order = asked.sort === 'inactive' ? inactivity : urgency;

  const capped = (rows) => {
    const sorted = mark(rows).sort(order);
    const shown = asked.all ? sorted : sorted.slice(0, ROW_CAP);
    return { rows: shown, total: sorted.length, more: sorted.length - shown.length };
  };

  /* WHAT THE READER HAS TO BE TOLD, carried as data rather than written into
     the page, so the server and the screen cannot say different things. */
  const notes = [];
  /* Counted over the people this viewer can see, not over the studio: the note
     explains a gap in THIS list, and a count from outside its scope would be a
     headcount leak dressed as a caveat. */
  const lost = unreconstructable(visible);
  if (lost.length && asked.to < today) {
    notes.push(`${lost.length} deactivated account${lost.length === 1 ? '' : 's'} `
      + 'carry no deactivation date — they predate the column — so they are left out of a past '
      + 'date rather than guessed either way.');
  }
  notes.push('Designations are read as they stand now. This schema keeps no role history, '
    + 'so somebody who changed designation is judged by the one they hold today.');
  if (fillDays.length) {
    notes.push('Timesheet lines are read as they stand now, back-filled ones included: a day '
      + 'filled in late is filled.');
  }
  /* A DAY NOBODY COULD HAVE FILLED is worth saying out loud. backdateDays is a
     Super Admin setting and a day outside it cannot be filed for at all, so a
     "not filled" list for it is a list of people who were refused. */
  if (fillDays.length && policy.backdateDays !== null && policy.backdateDays !== undefined) {
    const behind = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${fillDays[0]}T00:00:00Z`)) / MS_PER_DAY);
    if (behind > Number(policy.backdateDays) && !gate.exemptBackdate(policy)) {
      notes.push(`Back-dating is limited to ${policy.backdateDays} day(s), so `
        + `${fillDays[0]} can no longer be filled — nobody on that list can clear it themselves.`);
    }
  }
  if (!studioWide) {
    notes.push('Scoped to the projects you can see. Somebody attached to no project at all '
      + 'appears only for a studio-wide viewer.');
  }

  const value = {
    ok: true,
    unavailable: null,
    mode: asked.mode,
    date: asked.mode === 'day' ? asked.date : null,
    from: asked.from,
    to: asked.to,
    today,
    /* The exact dates each list is about, always both, always printed. */
    startedFor: { from: startWindow.from, to: startWindow.to, days: startDays },
    filledFor: fillWindow ? { from: fillWindow.from, to: fillWindow.to, days: fillDays } : null,
    previousWorkingDay: previousWorkingDay(today),
    workingDay: asked.mode === 'day' ? isWorkingDay(asked.date) : startDays.length > 0,
    grace: {
      minutes: graceMinutes(),
      holds: graceHolds,
      until: graceUntil === null ? null : new Date(graceUntil).toISOString(),
      opensAt: opensAt === null ? null : new Date(opensAt).toISOString(),
      clockShut: startDays.includes(today) && opensAt === null,
    },
    /* THE STRIP UNDER THE LISTS: everybody marked on the date in view, scoped
       to the people this viewer can see — a count drawn from outside the scope
       would be a headcount leak dressed as a summary, which is the same rule
       the deactivated-accounts note above follows.
       SHOWN WHATEVER THE SWITCH SAYS, because an existing mark keeps its effect
       when the feature is switched off and a mark nobody can see is a mark
       nobody can undo. */
    leave: (() => {
      const inView = new Map(visible.map((p) => [p.id, p]));
      const rows = [];
      for (const [key, row] of marks) {
        if (!key.endsWith(`|${asked.to}`)) continue;
        const person = inView.get(row.userId);
        if (!person) continue;
        rows.push({
          userId: row.userId,
          name: person.name,
          kind: row.kind,
          portion: row.portion,
          portionLabel: row.kind === dayStatus.KINDS.idle
            ? 'Idle' : (dayStatus.PORTION_LABELS[row.portion] || 'Full day'),
          label: dayStatus.describe(row, { schedule: workSchedule.current() }),
          note: row.note,
          setByName: row.setByName,
          setAt: row.setAt,
          planned: row.planned,
          inWindow: !dayStatus.expectedToWorkFromRow(row, now),
        });
      }
      rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const split = leaveSettings.split({ schedule: workSchedule.current() });
      return {
        /* THE SWITCH, DELIVERED BY THE SERVER. The page never decides this and
           never caches it: it arrives on every draw, so an admin flipping it in
           Settings makes the buttons appear or vanish on the next refresh with
           no redeploy and no sign-out. */
        enabled: leaveSettings.leaveIdleEnabled(),
        date: asked.to,
        today: asked.to === today,
        rows,
        onLeave: rows.filter((r) => r.kind === dayStatus.KINDS.leave).length,
        idle: rows.filter((r) => r.kind === dayStatus.KINDS.idle).length,
        firstHalfEnd: leaveSettings.clock(split.firstHalfEndMinutes),
        secondHalfStart: leaveSettings.clock(split.secondHalfStartMinutes),
        actionableStatuses: dayStatus.ACTIONABLE_STATUSES,
      };
    })(),
    notStarted: capped(notStartedRows),
    notFilled: capped(notFilledRows),
    overlap: bothIds.size,
    expected: visible.length,
    heldLabel: asked.to < today ? 'held that day' : 'waiting on them',
    earliest,
    cap: ROW_CAP,
    maxRangeDays: MAX_RANGE_DAYS,
    notes,
    scope: { projects: projectIds.length, studioWide, roles: roles.length },
    /* THE MARKER'S OWN TERMS, so the screen's tooltip and its threshold come
       from the server rather than from a constant in the browser that would go
       on saying three after somebody changed it. */
    activityExplainer: lastActivity.EXPLAINER,
    /* WHAT "WAITING" MEANS, in one sentence, from the module that decides it —
       so the panel's help line and the predicate cannot drift apart. */
    waitingExplainer: waitingWork.EXPLAINER,
    /* Whether the figure on these rows is the "waiting now" one at all. The
       page reads this rather than comparing dates a second time. */
    waitingFigure: nowFigure,
    streakThreshold: Number(nudges.streakThreshold) || 3,
    streakLookBack: lastActivity.LOOKBACK_WORKING_DAYS,
    /* Whether the Activity Log could be read at all — so "not recorded" and
       "never" are different words on the screen. */
    lastSeenRecorded: activity.seenAvailable,
    sort: asked.sort,
    cached: false,
    ...(withCleared ? {
      cleared: {
        start: clearedFor(startDays, missedStart),
        timesheet: clearedFor(fillDays, missedFill),
      },
    } : {}),
  };

  if (pastOnly) {
    if (cache.size >= CACHE_CAP) cache.clear();
    /* CACHED WITHOUT THE REMINDER STATE, which is applied after. The cached
       value is the expensive half — the lists, the markers, the streaks — and
       all of it is about a day that is over. */
    cache.set(key, { at: now, value });
  }
  return applyReminderState(db, value, { now, today, user });
}

// Tests and a Super Admin changing the schedule both need the cache gone.
const forget = () => cache.clear();

module.exports = {
  build, validate, forget, applyReminderState, lastWorkingDayTo,
  isWorkingDay, previousWorkingDay, workingDaysIn, opensAtMs,
  expectedPeople, onBooksOn, unreconstructable, inScope,
  startedDays, heldCounts, earliestDay, stampMs,
  GRACE_MINUTES, graceMinutes, ROW_CAP, MAX_RANGE_DAYS, CACHE_MS,
};
