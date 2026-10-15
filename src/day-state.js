/* WHERE THIS PERSON'S DAY STANDS, decided on the server, once.
 *
 * One object, carried on /auth/me, that answers every question the start-of-day
 * banner and the top-bar timer indicator ask:
 *
 *   is a timer running, and for how long
 *   if not, why not — on hold, lunch, after hours, a holiday, or simply not begun
 *   have they started anything today at all
 *   how many tasks are waiting, and which three
 *   is starting blocked, and by what
 *
 * ===========================================================================
 * THE PAGE DOES NO SCHEDULE ARITHMETIC. That is the whole reason this file
 * exists rather than four fields and a browser that works it out. The studio's
 * clock spans a weekly off, a holiday calendar, three break windows and a
 * timezone, and this application has had two copies of a date rule drift apart
 * before — which is why src/routes/auth.js already hands over the timesheet
 * gate's ANSWER rather than its inputs. The indicator is the same shape of
 * problem: the browser is told "paused, lunch, back at 14:00" and renders it.
 *
 * ===========================================================================
 * EVERYTHING HERE IS ASKED OF SOMETHING THAT ALREADY OWNS IT.
 *
 *   is a timer running          src/work-log.js   openForUser()
 *   how long has it run         src/work-log.js   liveSeconds(), from the
 *                                                 database's own clock — this
 *                                                 file never parses a DATETIME
 *   is it on hold, and why      src/work-log.js   heldAnyFor(), which carries
 *                                                 the studio-pause reason the
 *                                                 sweep wrote
 *   is the clock recording now  src/working-time.js isRecording(), spansOn()
 *   when does it start again    src/working-time.js resumesAt()
 *   is the studio shut today    src/holidays.js, through spansOn
 *   did they start today        src/follow-up.js  startedDays(), the one
 *                                                 definition of "started on D"
 *   what is waiting on them     src/waiting-work.js, the one definition of
 *                                                 "waiting", shared with the
 *                                                 follow-up section's figure
 *   may they start at all       src/timesheet-gate.js check(), handed in by the
 *                                                 route that already ran it
 *   are they expected to work   src/follow-up.js  assignable roles + onBooksOn
 *   which parts are switched on src/reminder-settings.js
 *
 * NOTHING IS RESTATED. There is no working-day rule, no "started" rule and no
 * "waiting" rule in this file.
 *
 * ===========================================================================
 * WHAT IT COSTS, because /auth/me is the most-polled endpoint in the
 * application — every signed-in browser, every twenty seconds.
 *
 *   1  the open session (with its age, from the database's clock)
 *   +1 the held row              only when nothing is running
 *   +1 did they start today      only when nothing is running
 *   +1 what is waiting on them   only when nothing is running
 *
 * So a running timer costs ONE query and an idle morning costs four. With the
 * master switch off, or with both the banner and the indicator off, it costs
 * nothing at all. A person who is not expected to clock time and has no timer
 * running costs one.
 */

const workLog = require('./work-log');
const workingTime = require('./working-time');
const workSchedule = require('./work-schedule');
const followUp = require('./follow-up');
const waitingWork = require('./waiting-work');
const reminderSettings = require('./reminder-settings');
const timesheetGate = require('./timesheet-gate');
const holidays = require('./holidays');
const { assignableRoles, roleDef } = require('./roles');

/* THE STATES, as keys. The page maps each to an icon, a word and a colour
 * token; it never derives one from another field.
 *
 * `off` is not a state the person is in — it is "this studio has switched the
 * indicator off" — and it is here so the page has one thing to read rather than
 * a flag beside a state. */
const STATES = {
  off: 'off',
  running: 'running',
  held: 'held',
  paused: 'paused',
  off_hours: 'off_hours',
  closed_day: 'closed_day',
  idle: 'idle',
};

/* HOW MANY TASKS THE BANNER OFFERS A START FOR.
 *
 * Three, which is the brief's number and a defensible one: a banner is one line
 * of a screen and a fourth button turns it into a list. "See all my tasks" is
 * the way out, and it goes to the board rather than to a list this feature would
 * have to invent. */
const BANNER_TASKS = 3;

/* ---------------------------------------------------------------------------
 * IS THIS PERSON EXPECTED TO BE WORKING TODAY?
 *
 * PROMPT 34'S DEFINITION, asked of the same two things src/follow-up.js asks:
 * a designation the studio gives work to (assignableRoles — the convention the
 * Assignee dropdown, the Idle Report and Team Capacity all use), and being on
 * the books on the day (onBooksOn, which reads created_at and deactivated_at
 * and never today's is_active flag for a past day).
 *
 * "NONE CREATED TODAY" falls out of onBooksOn rather than being a rule here:
 * it compares created_at against the END of the day, so somebody whose account
 * was made this morning is on the books today — and the follow-up list would
 * name them. The brief asks for them to be excluded from the nudges, which is a
 * different question from being on the books, so it is applied here, once, and
 * named: somebody's first hour in the tool should not open with a scolding
 * banner.
 *
 * FREELANCERS ARE NOT EXCLUDED BY A FILTER. They have no users row at all, so
 * there is nothing to exclude — the same note src/follow-up.js carries.
 */
function isExpected(user, { today }) {
  if (!user || !user.id) return false;
  const def = roleDef(user.role);
  if (!def || !assignableRoles().includes(user.role)) return false;
  const person = {
    id: user.id,
    isActive: user.is_active === undefined ? true : Number(user.is_active) !== 0,
    createdAtMs: stampOf(user.created_at || user.createdAt),
    deactivatedAtMs: stampOf(user.deactivated_at || user.deactivatedAt),
  };
  if (!followUp.onBooksOn(person, today)) return false;
  /* JOINED TODAY: on the books, and still not expected. Compared as IST dates
     through the gate's own helper, so an account made at 23:00 IST is not read
     as having existed yesterday. */
  if (person.createdAtMs !== null && timesheetGate.istDate(person.createdAtMs) >= today) return false;
  return true;
}

function stampOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/* ---------------------------------------------------------------------------
 * THE STUDIO'S CLOCK AT THIS INSTANT, as the indicator needs it.
 *
 * Four facts, all from src/working-time.js, and the reason each is here rather
 * than in the browser is that every one of them spans the weekly off, the
 * holiday calendar and the break windows.
 */
function clockNow(now, schedule = workSchedule.trackingWindow()) {
  const { day, minute } = workingTime.istPartsOf(now);
  const spans = workingTime.spansOn(day, schedule);
  const recording = workingTime.isRecording(now, schedule);
  const resumes = workingTime.resumesAt(now, schedule);
  return {
    recording,
    /* NO SPANS AT ALL is a day the studio does not work — a weekly off or a
       holiday — and the two are told apart by asking the holiday calendar,
       which is the only thing that knows. */
    openToday: spans.length > 0,
    holiday: spans.length ? null : (holidays.at(now) || null),
    openMinute: spans.length ? spans[0][0] : null,
    closeMinute: spans.length ? spans[spans.length - 1][1] : null,
    minute,
    /* IS THIS A BREAK OR IS THE DAY OVER? The distinction the screen needs:
       "back at 2pm" and "back tomorrow at 9:30" are different sentences, and
       telling somebody the working day has ended at ten past eleven — which the
       asset panel once did — is the mistake this field prevents. */
    inBreak: Boolean(spans.length && !recording && minute >= spans[0][0] && minute < spans[spans.length - 1][1]),
    resumesAt: resumes === null ? null : new Date(resumes).toISOString(),
  };
}

/* ---------------------------------------------------------------------------
 * THE WHOLE ANSWER.
 *
 * `gate` is the timesheet gate's verdict, handed in by src/routes/auth.js —
 * which has already run it for its own `timesheetGate` field. Computing it
 * again here would be the same query twice on the application's most-polled
 * endpoint, and worse, two answers that could differ inside one response.
 */
async function forUser(db, user, { now = Date.now(), gate = null, settings = null,
  schedule = workSchedule.trackingWindow() } = {}) {
  const set = settings || reminderSettings.current();
  const today = timesheetGate.istDate(now);
  const serverNow = new Date(now).toISOString();

  /* THE MASTER SWITCH, AND THE TWO IT GOVERNS. With nothing to draw there is
     nothing to ask the database, which is the point of checking first: this
     runs on every poll of every open browser. */
  const wanted = Boolean(set.enabled) && (Boolean(set.bannerEnabled) || Boolean(set.indicatorEnabled));
  if (!wanted) {
    return {
      on: false, state: STATES.off, reason: null, label: null,
      running: null, held: null, expected: false, startedToday: null,
      assignedCount: null, tasks: [], blocked: null,
      banner: { show: false, variant: null, why: 'switched off' },
      indicator: { show: false },
      today, serverNow, clock: null,
      settings: publicSettings(set),
    };
  }

  const clock = clockNow(now, schedule);
  const expected = isExpected(user, { today });

  /* THE RUNNING TIMER, FIRST AND ALWAYS. It is the one fact that matters to
     everybody — an administrator who started something sees their own clock —
     and the one that short-circuits the rest: with a timer running there is no
     banner to draw and no count to show. */
  const open = await workLog.openForUser(db, user.id).catch(() => null);

  if (open) {
    /* THE ELAPSED FIGURE IS WORKING SECONDS, not wall seconds, and it comes
       from the database's own clock by way of liveSeconds() — the same
       expression every other figure in this application uses. A session that
       ran through lunch does not count lunch, so the indicator agrees with the
       timesheet instead of being a second, larger number beside it. */
    const age = Number(open.age_seconds) || 0;
    const elapsed = workLog.liveSeconds(age, now);
    return {
      on: true,
      state: STATES.running,
      reason: null,
      label: open.name || open.code || 'Running',
      running: {
        assetId: open.assetId,
        projectId: open.projectId || null,
        code: open.code || null,
        name: open.name || null,
        status: open.status || null,
        /* THE START INSTANT, RECOVERED FROM THE AGE rather than from the stamp,
           so nothing here depends on which zone the database writes in. The
           page ticks from it and re-syncs on every poll. */
        startedAt: new Date(now - age * 1000).toISOString(),
        ageSeconds: age,
        elapsedSeconds: elapsed,
        /* WHETHER THE FIGURE IS ADVANCING RIGHT NOW. During a break the clock
           is recording nothing, so the page must stop ticking rather than
           counting lunch — and it must be told, not work it out. */
        ticking: clock.recording,
      },
      held: null,
      expected,
      startedToday: true,
      assignedCount: null,
      tasks: [],
      blocked: null,
      banner: { show: false, variant: null, why: 'a timer is running' },
      indicator: { show: Boolean(set.indicatorEnabled) },
      today, serverNow, clock,
      settings: publicSettings(set),
    };
  }

  /* NOTHING RUNNING. Three more reads, and only now.
     
     ON HOLD is asked before the clock, because a held round is a fact about
     this person's work and "lunch" is a fact about the studio: somebody who put
     a task down at eleven is on hold, not at lunch, and the row carries which
     of the two stopped it. */
  const held = await workLog.heldAnyFor(db, user.id).catch(() => null);
  const startedSet = await followUp.startedDays(db, [user.id], { from: today, to: today })
    .catch(() => new Set());
  const startedToday = startedSet.has(`${user.id}|${today}`);

  /* WHAT IS WAITING ON THEM — the same predicate the follow-up section's figure
     uses, so the banner's count and that row's number are the same number.
     
     STUDIO-WIDE, and that is a decision: scope in src/waiting-work.js is about
     what a VIEWER may be shown about somebody else, and this is a person's own
     queue. Clipping it to the projects they can see would be the same number by
     construction for an artist and wrong for anybody broader. */
  const rows = await waitingWork.listFor(db, user.id, { studioWide: true }).catch(() => []);
  const assets = rows.map((r) => waitingWork.shape(r, { today, now }))
    .sort(waitingWork.assetUrgency);

  const state = heldState(held, clock);
  const blocked = gate && gate.blocked ? {
    blocked: true, date: gate.date, dateLabel: gate.dateLabel,
    message: gate.error || gate.message || null,
  } : null;

  /* THE BANNER'S CONDITIONS, ALL OF THEM, IN ONE PLACE.
   *
   * Every one is a fact computed above, and the reason the whole set is
   * evaluated here rather than in the page is that the page would then hold a
   * copy of the rule — including the grace period, which is a Settings value.
   *
   * THE LUNCH BLACKOUT IS NOT A SEPARATE CONDITION: clock.recording is false
   * during any break, so "inside working hours and not at lunch" is one
   * predicate asked of src/working-time.js. A banner during lunch is the thing
   * that cannot happen, and it cannot happen because there is nothing to
   * switch off. */
  const graceMinutes = Number(set.graceMinutes) || reminderSettings.DEFAULTS.graceMinutes;
  const pastGrace = clock.openMinute !== null && clock.minute >= clock.openMinute + graceMinutes;
  const show = Boolean(set.bannerEnabled)
    && expected
    && clock.openToday
    && clock.recording
    && !startedToday
    && pastGrace;

  return {
    on: true,
    state,
    reason: reasonFor(state, held, clock),
    label: labelFor(state, held, clock),
    running: null,
    held: held ? {
      assetId: held.assetId, since: held.since, byStudio: Boolean(held.byStudio),
      which: held.which || null, opensAt: held.opensAt || null,
    } : null,
    expected,
    startedToday,
    assignedCount: assets.length,
    tasks: assets.slice(0, BANNER_TASKS).map((a) => ({
      assetId: a.id, code: a.code, name: a.name, projectId: a.projectId,
      status: a.status, statusLabel: a.statusLabel,
      dueDate: a.dueDate, overdue: a.overdue,
    })),
    moreTasks: Math.max(0, assets.length - BANNER_TASKS),
    blocked,
    banner: {
      show,
      /* THREE VARIANTS AND THE SERVER PICKS. "blocked" outranks "none",
         because somebody with no tasks AND an unfilled timesheet is told the
         thing they can act on. */
      variant: !show ? null : (blocked ? 'blocked' : (assets.length ? 'start' : 'none')),
      why: show ? null : notShownBecause({ set, expected, clock, startedToday, pastGrace }),
      graceMinutes,
      snoozeMinutes: Number(set.snoozeMinutes) || reminderSettings.DEFAULTS.snoozeMinutes,
      /* WHEN IT WOULD APPEAR, so the page can say "not yet" honestly rather
         than drawing nothing for an unexplained reason. */
      graceUntil: clock.openMinute === null ? null
        : new Date(workingTime.instantAt(workingTime.istPartsOf(now).day,
          clock.openMinute + graceMinutes)).toISOString(),
    },
    indicator: { show: Boolean(set.indicatorEnabled) && (expected || Boolean(held)) },
    today, serverNow, clock,
    settings: publicSettings(set),
  };
}

/* Which neutral state this is, when nothing is running. Ordered: a person's own
   hold first, then the studio's. */
function heldState(held, clock) {
  if (held && !held.byStudio) return STATES.held;
  if (!clock.openToday) return STATES.closed_day;
  if (clock.inBreak) return STATES.paused;
  if (!clock.recording) return STATES.off_hours;
  return STATES.idle;
}

/* THE SENTENCE, FROM THE SERVER, for every state. The page prints it and adds
   an icon; it composes none of this. A state with no reason — idle during
   working hours — is the one the banner is about, and it gets its words there. */
function reasonFor(state, held, clock) {
  if (state === STATES.held) {
    return 'You put this task down. Resume it to carry on.';
  }
  if (state === STATES.closed_day) {
    return clock.holiday
      ? `The studio is closed today — ${clock.holiday.name || 'a holiday'}.`
      : 'The studio does not work today.';
  }
  if (state === STATES.paused) {
    return held && held.byStudio && held.opensAt
      ? 'Paused for a break — the clock starts again when the studio does.'
      : 'The studio is on a break, so nothing is being recorded.';
  }
  if (state === STATES.off_hours) return 'Outside working hours.';
  return null;
}

/* The two or three words the indicator shows beside its icon. Short, because it
   sits in a header beside four other controls. */
function labelFor(state, held, clock) {
  if (state === STATES.held) return 'On hold';
  if (state === STATES.closed_day) return clock.holiday ? 'Holiday' : 'Studio closed';
  if (state === STATES.paused) return 'Paused – break';
  if (state === STATES.off_hours) return 'Outside hours';
  return 'No timer running';
}

/* WHY THE BANNER IS NOT SHOWN, as a short key. For the tests and for a Super
   Admin wondering where it is — not drawn anywhere by default. */
function notShownBecause({ set, expected, clock, startedToday, pastGrace }) {
  if (!set.bannerEnabled) return 'banner switched off';
  if (!expected) return 'not expected to be working today';
  if (!clock.openToday) return 'the studio is closed today';
  if (!clock.recording) return clock.inBreak ? 'the studio is on a break' : 'outside working hours';
  if (startedToday) return 'already started today';
  if (!pastGrace) return 'inside the grace period';
  return null;
}

/* WHAT THE PAGE IS TOLD ABOUT THE SETTINGS, which is only what it draws with.
   Not the whole row: the cap, the manual switch and the streak threshold belong
   to the follow-up section and have no business on every poll. */
const publicSettings = (set) => ({
  bannerEnabled: Boolean(set.bannerEnabled),
  indicatorEnabled: Boolean(set.indicatorEnabled),
  snoozeMinutes: Number(set.snoozeMinutes) || reminderSettings.DEFAULTS.snoozeMinutes,
});

module.exports = {
  STATES, BANNER_TASKS,
  forUser, isExpected, clockNow, heldState, reasonFor, labelFor, notShownBecause,
};
