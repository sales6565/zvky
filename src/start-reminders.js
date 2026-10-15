/* THE TWO START-OF-DAY REMINDERS, SENT BY THE STUDIO ITSELF.
 *
 * ===========================================================================
 * THIS IS THE AUTOMATIC HALF THE TABLE WAS BUILT FOR.
 *
 * reminder_log already exists, with a `source` column whose second value —
 * 'auto' — nothing wrote until now, and a unique key that already spans it:
 *
 *     UNIQUE KEY uq_reminder_slot (recipient_id, kind, source, sent_on, slot)
 *
 * It was created that way on purpose, so that the automatic sender would share
 * this table, this key and this once-a-day rule rather than growing a second
 * set. Nothing in that file or in its migration changes here. The follow-up
 * section's "Auto reminder sent 10:30" line, which has been drawing nothing
 * since it shipped, lights up the moment this sweep runs.
 *
 * ===========================================================================
 * EXACTLY ONCE PER USER PER KIND PER DAY, AND IT IS THE KEY THAT SAYS SO.
 *
 * `slot` is which of the day's sends this is, which for this sender is WHICH
 * OCCASION: the first reminder takes slot 0 and the second takes slot 1. So
 * "the first reminder, for Ana, today" is one row the database will accept once
 * and refuse for ever after — and that holds against a restart, a sweep that
 * runs every minute, two workers racing, and a catch-up pass hours later. There
 * is no read-then-write anywhere in this file that a second process could slip
 * between: the INSERT is the check.
 *
 * A MISSED OCCASION IS SENT LATE BY THE SAME CODE PATH, which is the whole
 * reason there is no scheduler here. Every pass asks the same question — "is
 * this occasion's window open, is the slot free, and does this person still
 * need it" — so the pass at 10:31 after a server that was down at 10:30 sends
 * it, and the pass at 10:32 does not. Nothing is stored about when the sweep
 * last ran, because nothing needs to be. That is the same argument
 * scheduleAutoPause() makes for the work-hours sweep: "the interval is about
 * the screen, not the number".
 *
 * AND THE FIRST IS NEVER SENT AFTER THE SECOND'S TIME HAS PASSED. The brief
 * asks for it and it is the one rule the window shape has to carry: a first
 * reminder arriving at half past two is not a start-of-day nudge, it is noise
 * about a morning that is over.
 *
 * ===========================================================================
 * NOTHING HERE IS A NEW DEFINITION.
 *
 *   who is expected          src/day-state.js isExpected(), which is Prompt 34's
 *                            rule (assignable designations, on the books, not
 *                            created today)
 *   is the clock recording   src/working-time.js, through day-state's clockNow()
 *   did they start today     src/follow-up.js startedDays()
 *   what is waiting on them  src/waiting-work.js countsFor()
 *   the notice               src/notifications.js raise()
 *   the email                src/email-notifications.js -> src/email-outbox.js,
 *                            so it inherits the six-retry backoff and the
 *                            permanent-failure behaviour unchanged
 *   the slot and the key     src/reminders.js claim() and settle()
 *   the schedule's shape     src/work-log.js scheduleAutoPause(), copied in
 *                            form: an immediate pass, then an unref'd interval
 */

const workSchedule = require('./work-schedule');
const workingTime = require('./working-time');
const timesheetGate = require('./timesheet-gate');
const reminderSettings = require('./reminder-settings');
const dayState = require('./day-state');
const followUp = require('./follow-up');
const waitingWork = require('./waiting-work');
const reminders = require('./reminders');
const notifications = require('./notifications');
const emailNotifications = require('./email-notifications');
const { assignableRoles, roleDef } = require('./roles');

/* THE TWO OCCASIONS, AND THEIR SLOTS.
 *
 * `slot` is the column's own meaning — which of the day's sends this is — so
 * the first reminder is slot 0 and the second is slot 1 whichever of them
 * actually goes out. A day on which only the second fires leaves slot 0 unused,
 * which is correct: uniqueness is per slot, not a sequence that must be dense.
 */
const FIRST = 'first';
const SECOND = 'second';
const SLOT = { [FIRST]: 0, [SECOND]: 1 };

/* HOW LONG AFTER ITS DUE MINUTE AN OCCASION MAY STILL BE SENT.
 *
 * The first one's window ends when the second one's begins — the brief's rule —
 * so it needs no number of its own. The second one's ends at the close of the
 * working day, because a reminder about starting work has nothing to say after
 * the studio shuts. Both are derived from the studio's own schedule and the
 * settings; neither is a constant.
 */
function windowsFor({ now, settings, schedule }) {
  const { day, minute } = workingTime.istPartsOf(now);
  const spans = workingTime.spansOn(day, schedule);
  if (!spans.length) return null;                 // a day the studio does not work
  const open = spans[0][0];
  const close = spans[spans.length - 1][1];
  const grace = Number(settings.graceMinutes) || reminderSettings.DEFAULTS.graceMinutes;
  const first = open + grace;
  const second = Number(settings.secondReminderMinutes);
  return {
    minute, open, close,
    /* THE SECOND'S DUE MINUTE IS CLAMPED INTO THE DAY rather than refused here:
       the validator keeps it after the first and inside working hours, and a
       row that predates the validator — or a schedule somebody narrowed
       afterwards — must not make this sweep send nothing for ever. */
    windows: {
      [FIRST]: { from: first, to: Math.max(first, Math.min(second, close)) },
      [SECOND]: { from: Math.max(first, Math.min(second, close)), to: close },
    },
  };
}

/* WHICH OCCASIONS ARE DUE AT THIS INSTANT, oldest first.
 *
 * Both can be due on the same pass — a server that came back at noon owes
 * neither the first (its window has closed) nor, if it is past the close, the
 * second. The ordering matters only for the log. */
function dueNow({ now, settings, schedule }) {
  const w = windowsFor({ now, settings, schedule });
  if (!w) return { due: [], clock: w };
  const due = [];
  for (const key of [FIRST, SECOND]) {
    const win = w.windows[key];
    if (win.to <= win.from) continue;             // a window with no width
    if (w.minute >= win.from && w.minute < win.to) due.push(key);
  }
  return { due, clock: w };
}

/* ---------------------------------------------------------------------------
 * WHO THE STUDIO EXPECTS TODAY, in one query.
 *
 * The same shape src/follow-up.js's expectedPeople() uses — a designation the
 * studio gives work to, read from the whole catalogue rather than only the
 * active part — and then day-state's isExpected() applied per row, so there is
 * one rule and this file holds none of it.
 */
async function expectedToday(db, { today }) {
  const roles = assignableRoles();
  if (!roles.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.\`name\`, u.email, u.\`role\`, u.is_active AS isActive,
            u.deactivated_at AS deactivatedAt, u.created_at AS createdAt
       FROM users u
      WHERE u.\`role\` IN ($1)
        AND u.is_active = 1
      ORDER BY u.\`name\``,
    [roles]
  );
  return rows
    .map((r) => ({
      id: r.id, name: r.name, email: r.email, role: r.role,
      is_active: r.isActive, created_at: r.createdAt, deactivated_at: r.deactivatedAt,
    }))
    .filter((u) => dayState.isExpected(u, { today }));
}

/* ---------------------------------------------------------------------------
 * ONE PASS.
 *
 * Returns a tally rather than logging, so the scheduler below prints one line
 * and the tests can read what happened without parsing a log.
 */
async function sweep(db, { now = Date.now(), settings = null,
  schedule = workSchedule.trackingWindow() } = {}) {
  const set = settings || reminderSettings.current();
  const out = { sent: 0, skipped: 0, reasons: {}, due: [] };
  const note = (why) => { out.skipped += 1; out.reasons[why] = (out.reasons[why] || 0) + 1; };

  /* THE MASTER SWITCH, AND THE CHANNELS. With both channels off there is
     nothing to send and no reason to read the database at all. */
  if (!set.enabled) { out.reasons.disabled = 1; return out; }
  if (!set.inAppEnabled && !set.emailEnabled) { out.reasons.no_channel = 1; return out; }

  /* IS THIS A MOMENT TO SEND AT ALL? A weekend, a holiday, a break and the
     hours outside the day are all one question asked of the studio's own clock
     — spansOn() is where the weekly off and the holiday calendar already meet,
     so none of the three is a rule here. */
  if (!workingTime.isRecording(now, schedule)) {
    out.reasons.not_recording = 1;
    return out;
  }

  const { due } = dueNow({ now, settings: set, schedule });
  out.due = due;
  if (!due.length) { out.reasons.nothing_due = 1; return out; }

  const today = timesheetGate.istDate(now);
  const people = await expectedToday(db, { today });
  if (!people.length) { out.reasons.nobody_expected = 1; return out; }

  const ids = people.map((p) => p.id);
  /* STARTED TODAY, FOR EVERYBODY, IN ONE QUERY — src/follow-up.js's own
     definition. A person who has started is not reminded, and this is where
     that is decided for the whole studio rather than per person. */
  const started = await followUp.startedDays(db, ids, { from: today, to: today })
    .catch(() => new Set());
  /* AND WHAT IS WAITING ON EACH OF THEM, also in one query, from the predicate
     the banner and the follow-up figure share. */
  const waiting = await waitingWork.countsFor(db, ids, { studioWide: true })
    .catch(() => new Map());

  for (const person of people) {
    if (started.has(`${person.id}|${today}`)) { note('started'); continue; }
    /* NO TASKS, NO REMINDER — the brief asked for a decision and this is it,
       with the reasoning: a nudge to start work when there is nothing to start
       is a message whose only possible action is to ignore it, and the studio
       has a different screen for "somebody has nothing to do" (the Idle Report
       and Team Capacity). The banner says so on their own screen, where it
       costs nothing; a notice and an email do not. */
    const count = Number(waiting.get(person.id) || 0);
    if (!count) { note('no_tasks'); continue; }

    for (const occasion of due) {
      /* eslint-disable no-await-in-loop */
      const result = await send(db, { person, occasion, count, today, set });
      if (result.sent) out.sent += 1; else note(result.why);
      /* eslint-enable no-await-in-loop */
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * ONE REMINDER.
 *
 * THE CLAIM IS THE CHECK. src/reminders.js's claim() does the INSERT that the
 * unique key arbitrates, and a duplicate comes back as ER_DUP_ENTRY rather than
 * as a second message. Nothing is read first: a SELECT before the INSERT is
 * exactly the gap two overlapping passes would slip through.
 */
async function send(db, { person, occasion, count, today, set }) {
  const sentence = sentenceFor({ occasion, count });
  const claimed = await reminders.claim(db, {
    person,
    actor: null,                       // the studio did this, not a person
    kind: reminders.KINDS.start,
    subjectDate: today,
    sentOn: today,
    slot: SLOT[occasion],
    source: reminders.SOURCES.auto,
  });
  if (!claimed.ok) return { sent: false, why: claimed.code === reminders.CODES.capped ? 'already_sent' : 'no_table' };

  const channels = [];
  if (set.inAppEnabled) {
    try {
      /* THE EXISTING MECHANISM, and no actor: raise() drops a recipient who is
         also the actor, so passing null is what lets a notice reach the person
         it is about. The same reasoning the work-hours sweep's own notices
         carry. */
      const id = await notifications.raise(db, {
        recipientId: person.id,
        actorId: null,
        kind: notifications.KINDS.start_reminder,
        detail: sentence,
      });
      if (id) channels.push('in_app');
    } catch { /* recorded below; a failed notice must not stop the email */ }
  }
  if (set.emailEnabled) {
    const email = await emailNotifications.reminder(db, {
      recipientId: person.id,
      kind: 'start',
      subjectDate: today,
      sentence,
      origin: null,
    }).catch(() => ({ queued: false }));
    if (email.queued) channels.push('email');
  }

  await reminders.settle(db, claimed.id, {
    channels,
    result: channels.length ? 'sent' : 'nothing_sent',
  });
  return channels.length
    ? { sent: true, channels, sentence }
    : { sent: false, why: 'nothing_sent' };
}

/* THE WORDS, and they say the number because that is what makes the message
   actionable: "you have four tasks waiting" is a different morning from "you
   have one". The second reminder says it is the second, because a person who
   read the first one at half past ten and did nothing should be able to tell
   them apart. */
function sentenceFor({ occasion, count }) {
  const tasks = `${count} task${count === 1 ? '' : 's'} waiting`;
  return occasion === SECOND
    ? `Still not started: you have ${tasks}. Open the tool and start one.`
    : `You haven’t started work today. You have ${tasks}.`;
}

/* ---------------------------------------------------------------------------
 * KEEP DOING IT.
 *
 * THE SAME SHAPE AS src/work-log.js's scheduleAutoPause(), and deliberately:
 * an immediate pass so a restarted process catches up at once, then an
 * unref'd interval so a pending tick cannot keep a worker alive. Safe on more
 * than one worker by the same argument — the write is a conditional INSERT, so
 * of two processes racing the same slot one writes a row and the other is
 * refused by the key.
 *
 * THE INTERVAL IS NOT THE SCHEDULE. Every pass asks whether each occasion's
 * window is open and its slot free, so the cadence only decides how soon after
 * the due minute the reminder lands. One minute, like the hours sweep, so a
 * reminder due at 10:30 goes out at 10:30.
 */
function schedule(db, log = console.log) {
  const minutes = Number(process.env.START_REMINDER_SWEEP_MINUTES ?? 1);
  const tick = () => sweep(db)
    .then((out) => {
      if (out.sent) log(`[nudge] sent ${out.sent} start reminder(s) (${out.due.join(', ')}).`);
    })
    .catch((err) => log(`[nudge] sweep failed: ${err.sqlMessage || err.message}`));
  tick();
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const timer = setInterval(tick, minutes * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  FIRST, SECOND, SLOT,
  windowsFor, dueNow, expectedToday, sweep, send, sentenceFor, schedule,
};
