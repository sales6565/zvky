/* WHEN SOMEBODY WAS LAST ACTIVE, and how long they have been absent.
 *
 * The marker on every row of the two follow-up lists. Two facts and a streak,
 * all three computed for the WHOLE LIST in a fixed number of queries, and all
 * three computed AS OF the date being viewed rather than as of now.
 *
 * ===========================================================================
 * WHAT COUNTS AS ACTIVITY. Two separate facts, deliberately not merged, because
 * they answer two different questions and a single "last active" column would
 * be the larger of the two — which is the one a reader would trust least.
 *
 *   LAST TIMER ACTIVITY   the most recent moment a work session STARTED or
 *                         ENDED. In this schema that is the whole of "start,
 *                         stop, pause and resume": work_sessions has exactly
 *                         two stamps, started_at and ended_at, and every one of
 *                         those four actions writes one of them — Accept and
 *                         Start and Resume open a row, Pause and Stop close
 *                         one (see src/work-log.js). So there is no third
 *                         event to look for and no new definition here.
 *
 *                         This is the fact the lists are really about: it is
 *                         the clock the studio bills from.
 *
 *   LAST SEEN             the most recent row this person wrote in
 *                         activity_log, which is every successful
 *                         state-changing request plus their sign-in
 *                         (auth.login is recorded there — see
 *                         src/middleware/activity.js and src/routes/auth.js).
 *
 * WHAT "LAST SEEN" IS NOT, SAID PLAINLY BECAUSE THE SCREEN SAYS IT TOO:
 * this application records no per-request heartbeat. activity_log deliberately
 * excludes GET and HEAD — "reads. Point 1 of the brief, and the reason the log
 * stays legible" — so somebody who signs in at nine and spends the day reading
 * boards shows nine o'clock, not five. There IS no last-authenticated-request
 * stamp in this schema, and this file does not invent one.
 *
 * WHY NO THROTTLED last_seen COLUMN WAS ADDED, which the brief asked to be
 * considered. It was considered and declined, and the reasoning is short:
 *
 *   - a sign-in is already recorded, so the marker is never emptier than
 *     "signed in today"; the gap it would close is "signed in but idle since",
 *     which is precisely the question the TIMER fact already answers better,
 *     because a clock running is activity and a page open is not;
 *   - it would put a write on the authentication path — the one path every
 *     request in the application goes through — to improve one column on one
 *     dashboard section, and "throttled to once every few minutes per user"
 *     still means a write for every active person every few minutes forever;
 *   - and it would be a new definition of "active" sitting beside two that are
 *     already recorded, which is the exact failure src/follow-up.js exists to
 *     avoid.
 *
 * If the studio wants presence, presence is a feature, not a column.
 *
 * ===========================================================================
 * AS OF THE DATE BEING VIEWED, which is the rule that makes this honest.
 *
 * The section can be asked about a past day. Every value here is therefore
 * bounded ABOVE by the end of that day: both queries carry `created_at < $end`
 * / `started_at < $end`, and the streak walks back from that day rather than
 * from today. A past date's row can never show an activity stamp from after
 * the date, and never show a streak that today's data would have broken.
 *
 * ===========================================================================
 * THE STREAK: HOW MANY WORKING DAYS IN A ROW WITHOUT A START.
 *
 * Counted from the most recent working day that is OVER, walking backwards:
 *
 *   a non-working day        SKIPPED, and does not break the run. Weekends and
 *                            holidays come from the shared working-day rule
 *                            passed in — src/timesheet-gate.js by way of
 *                            src/follow-up.js — never from a second reading of
 *                            the calendar here.
 *   a day they started       STOPS the walk. That is the end of the run.
 *   a day before they joined STOPS the walk, and is not counted. Somebody who
 *                            joined on Wednesday has no streak reaching into
 *                            Tuesday.
 *   the look-back cap        STOPS the walk, and says so: the row reads "30+"
 *                            rather than a number the walk did not finish
 *                            earning.
 *
 * WHY IT ENDS AT THE LAST COMPLETED DAY. For a past date D, D is over and the
 * walk starts there. For today, the walk starts at the PREVIOUS working day,
 * because today is not finished: counting today would print "not started for 2
 * working days" at half past nine about somebody who is about to start, and the
 * fact that they have not started today is already the list they are on. The
 * streak is the history behind that row, not a restatement of it.
 *
 * ONE NEW DEFINITION AND NO MORE: "in a row". "Started" is
 * src/follow-up.js's own definition, handed in as the set it already queried —
 * this file never asks the database what a start is.
 */

const workingTime = require('./working-time');

/* HOW FAR BACK THE WALK WILL GO, in working days.
 *
 * Thirty is about six weeks of calendar. Past that the question has stopped
 * being "who has been missing" and become "who has left", which is a different
 * screen; and an unbounded walk is a loop whose length is decided by the
 * emptiest row in the database. The cap is reported rather than hidden, so a
 * run that hits it reads as "30+" and not as "exactly 30". */
const LOOKBACK_WORKING_DAYS = 30;

/* And the hard stop on the calendar walk behind those working days, so a studio
   with a fortnight of declared holidays cannot turn the cap into a long loop.
   Three calendar days per working day is generous for any real week. */
const LOOKBACK_CALENDAR_DAYS = LOOKBACK_WORKING_DAYS * 3;

const MS_PER_DAY = 86400000;
const IST_OFFSET_MS = workingTime.IST_OFFSET_MINUTES * 60 * 1000;

const startOfDayMs = (date) => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
const endOfDayMs = (date) => startOfDayMs(date) + MS_PER_DAY;

/* A UTC instant as MySQL writes a DATETIME — the same frame the columns are in.
   Duplicated from src/follow-up.js deliberately rather than imported: that
   module requires this one, and a cycle between them would be a far worse
   thing to own than four lines of arithmetic. */
function sqlStamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/* ---------------------------------------------------------------------------
 * THE TWO QUERIES. One row per person each, whatever the size of the list.
 */

/* The latest timer event, per person, bounded by the end of the day in view.
 *
 * GREATEST OF THE TWO STAMPS, with the close only counted when the close
 * itself falls inside the window: a session that opened on the day in view and
 * is still running — or was closed the following week — contributes its OPEN,
 * which is the only one of its two moments that had happened by then.
 *
 * A LEFT-OVER NULL user_id is excluded. work_sessions.user_id is ON DELETE SET
 * NULL, so a deleted account leaves its sessions behind with no owner; the IN
 * list cannot match NULL anyway, and saying so here is cheaper than wondering.
 */
async function lastTimerAt(db, ids, { before }) {
  if (!ids.length) return new Map();
  const end = sqlStamp(before);
  const { rows } = await db.query(
    `SELECT w.user_id AS userId,
            MAX(GREATEST(w.started_at,
                 CASE WHEN w.ended_at IS NOT NULL AND w.ended_at < $2
                      THEN w.ended_at ELSE w.started_at END)) AS at
       FROM work_sessions w
      WHERE w.user_id IN ($1)
        AND w.started_at < $2
      GROUP BY w.user_id`,
    [ids, end]
  );
  return new Map(rows.map((r) => [r.userId, r.at]));
}

/* The latest recorded action, per person, from the Activity Log.
 *
 * MISSING TABLE IS "WE DO NOT KNOW", not "never". activity_log is created by a
 * migration step like everything else, and a deployment part-way through it
 * must still draw the lists — so the absence is caught and the whole fact is
 * reported as unknown rather than as an empty column that reads like a fact.
 */
async function lastSeenAt(db, ids, { before }) {
  if (!ids.length) return { map: new Map(), available: true };
  try {
    const { rows } = await db.query(
      `SELECT a.actor_id AS userId, MAX(a.created_at) AS at
         FROM activity_log a
        WHERE a.actor_id IN ($1)
          AND a.created_at < $2
        GROUP BY a.actor_id`,
      [ids, sqlStamp(before)]
    );
    return { map: new Map(rows.map((r) => [r.userId, r.at])), available: true };
  } catch (err) {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) {
      return { map: new Map(), available: false };
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * THE STREAK, in arithmetic, from a set somebody else queried.
 */
function streakFor(person, {
  endDay, startedSet, isWorkingDay, shiftDays, lookBack = LOOKBACK_WORKING_DAYS,
}) {
  if (!endDay) return { days: 0, capped: false, since: null, stopped: 'no-day' };
  const joined = person.createdAtMs === null || person.createdAtMs === undefined
    ? null : person.createdAtMs;

  let days = 0;
  let since = null;
  let examined = 0;
  let walked = 0;
  let day = endDay;

  while (walked < LOOKBACK_CALENDAR_DAYS) {
    if (isWorkingDay(day)) {
      /* BEFORE THEY JOINED: the run ends here and this day is not counted.
         Compared against the END of the day, which is the same comparison
         src/follow-up.js's onBooksOn makes — somebody who joined at four in the
         afternoon was on the books that day. */
      if (joined !== null && joined >= endOfDayMs(day)) {
        return { days, capped: false, since, stopped: 'joined' };
      }
      if (startedSet.has(`${person.id}|${day}`)) {
        return { days, capped: false, since, stopped: 'started' };
      }
      days += 1;
      since = day;
      examined += 1;
      if (examined >= lookBack) return { days, capped: true, since, stopped: 'cap' };
    }
    day = shiftDays(day, -1);
    walked += 1;
  }
  /* The calendar stop. Reported as capped for the same reason: the walk did not
     finish, so the number is a floor and the screen must say so. */
  return { days, capped: true, since, stopped: 'calendar-cap' };
}

/* ---------------------------------------------------------------------------
 * HOW A PERSON READS AN INSTANT.
 *
 * BOTH LABELS COME FROM THE SERVER, and that is a decision rather than an
 * accident of where the code sits. The relative one ("3 days ago") is relative
 * to THE DATE BEING VIEWED, not to the reader's clock — a past date's row must
 * not say "3 days ago" because the browser was opened on Friday — and the exact
 * one is in IST, because IST is the frame every other date in this application
 * is drawn in and a browser in another zone would render the studio's evening
 * as somebody else's afternoon.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* The exact IST wall clock, which is what a tooltip shows. Read off the shifted
   instant in UTC rather than through a locale, so it cannot depend on the
   server's own zone or on which locale data Node was built with. */
function istLabel(ms) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms + IST_OFFSET_MS);
  const hours = d.getUTCHours();
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = hours < 12 ? 'AM' : 'PM';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, `
    + `${twelve}:${minutes} ${ampm} IST`;
}

/* The IST calendar day an instant falls on. */
const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/* The relative words.
 *
 * Counted in CALENDAR DAYS between the two IST dates, not in elapsed hours:
 * "yesterday" is a date, and an event eighteen hours ago can be either today or
 * two days ago depending on the hour, which is not what anybody means by it.
 * The time of day rides along for today and yesterday, where it is the useful
 * part, and is dropped past that, where it is noise. */
function relativeLabel(ms, { asOfDay }) {
  if (ms === null || ms === undefined) return null;
  const then = istDay(ms);
  const gap = Math.round(
    (Date.parse(`${asOfDay}T00:00:00Z`) - Date.parse(`${then}T00:00:00Z`)) / MS_PER_DAY
  );
  const exact = istLabel(ms);
  const clock = exact ? exact.slice(exact.indexOf(', ') + 2).replace(' IST', '') : '';
  if (gap <= 0) return `today ${clock}`;
  if (gap === 1) return `yesterday ${clock}`;
  if (gap < 7) return `${gap} days ago`;
  if (gap < 14) return 'last week';
  if (gap < 60) return `${Math.floor(gap / 7)} weeks ago`;
  return `${then}`;
}

/* One row's marker, ready to draw. */
function markerFor(person, {
  timer, seen, streak, asOfDay, seenAvailable, threshold,
}) {
  const t = timer === null || timer === undefined ? null : timer;
  const s = seen === null || seen === undefined ? null : seen;
  return {
    /* THE TWO FACTS, each with its own three forms: the instant for anything
       that wants to sort or compare, the relative words, and the exact IST
       stamp for the tooltip. Null throughout for somebody with no history —
       never a zero and never "1 Jan 1970", which is what a missing stamp turns
       into the moment anybody does arithmetic on it. */
    timer: t === null ? null : {
      at: new Date(t).toISOString(), relative: relativeLabel(t, { asOfDay }), exact: istLabel(t),
    },
    seen: s === null ? null : {
      at: new Date(s).toISOString(), relative: relativeLabel(s, { asOfDay }), exact: istLabel(s),
    },
    /* Whether the Activity Log could be read at all, so the screen can say "not
       recorded" rather than "never" for a deployment mid-migration. */
    seenAvailable,
    streak: streak.days,
    streakCapped: streak.capped,
    /* The oldest working day in the run, so the tooltip can name where the
       silence started instead of only how long it has been. */
    streakSince: streak.since,
    /* THE STRONGER MARKER, decided on the server from the configured threshold.
       The page does not compare the number to a constant of its own: the
       threshold is a Settings value and a second copy of it in the browser is a
       second copy that will disagree after somebody changes it. */
    streakStrong: streak.days >= threshold,
    /* WHAT SORTING BY "LONGEST INACTIVE" ORDERS ON, computed once here so the
       server's sort and anything the page shows cannot part company. A person
       with no activity at all sorts first — that is the longest inactivity
       there is — which is why this is -1 and not 0 for them. */
    quietDays: t === null ? -1 : Math.round(
      (Date.parse(`${asOfDay}T00:00:00Z`) - Date.parse(`${istDay(t)}T00:00:00Z`)) / MS_PER_DAY
    ),
    everActive: t !== null || s !== null,
  };
}

/* ---------------------------------------------------------------------------
 * THE WHOLE MARKER SET, FOR THE WHOLE LIST, IN TWO QUERIES.
 *
 * `startedSet` is src/follow-up.js's own set, already fetched for the lists and
 * widened to cover the look-back window — so the streak costs no query at all.
 * That widening is the reason this function takes a set rather than a database
 * handle for the third fact: there is exactly one "started" query per draw and
 * exactly one definition behind it.
 */
async function markersFor(db, people, {
  asOfDay, endDay, startedSet, isWorkingDay, shiftDays, threshold, lookBack,
}) {
  const ids = people.map((p) => p.id);
  const before = endOfDayMs(asOfDay);
  const [timers, seenResult] = await Promise.all([
    lastTimerAt(db, ids, { before }),
    lastSeenAt(db, ids, { before }),
  ]);
  const out = new Map();
  for (const person of people) {
    const streak = streakFor(person, { endDay, startedSet, isWorkingDay, shiftDays, lookBack });
    out.set(person.id, markerFor(person, {
      timer: stampMsOf(timers.get(person.id)),
      seen: stampMsOf(seenResult.map.get(person.id)),
      streak,
      asOfDay,
      seenAvailable: seenResult.available,
      threshold,
    }));
  }
  return { markers: out, seenAvailable: seenResult.available };
}

/* A DATETIME column as an instant. The same reading src/follow-up.js gives, and
   here for the same reason: the driver builds Date objects in the server's local
   zone out of values that are UTC. */
function stampMsOf(value) {
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

/* WHAT THE TOOLTIP SAYS, as one string, from the server.
 *
 * Here rather than in the page because it is a statement about what this
 * application records, and the moment it lives in the browser it is a second
 * description of a rule — which will go on saying "every authenticated request"
 * long after somebody changes what is logged. */
const EXPLAINER = 'Timer: the last time a work session was started, paused, resumed or stopped. '
  + 'Last seen: the last action recorded in the Activity Log, which includes signing in but not '
  + 'simply reading pages — this application records no per-request heartbeat. '
  + 'Both are read as at the end of the day being viewed, so a past date never shows anything '
  + 'that happened after it.';

module.exports = {
  LOOKBACK_WORKING_DAYS, LOOKBACK_CALENDAR_DAYS, EXPLAINER,
  markersFor, markerFor, streakFor, lastTimerAt, lastSeenAt,
  istLabel, istDay, relativeLabel, stampMsOf,
};
