/* ONE-CLICK REMINDERS, from the two follow-up lists.
 *
 * A lead reads a name and nudges that person: an in-app notice always, an email
 * as well when the studio has switched email reminders on. At most one per
 * person per kind per day, enforced by a unique key rather than by a check.
 *
 * ===========================================================================
 * WHAT THIS DEPENDS ON THAT DOES NOT EXIST, said first because the brief
 * assumed it did.
 *
 * There are NO AUTOMATIC REMINDERS in this application. No start-of-day sweep,
 * no "Start-of-day nudges" settings section, and no table recording reminders
 * sent — `grep -ri nudge src/` finds three comments about a clock being nudged
 * backwards, and nothing else. The brief refers to all of that as built. It is
 * not, and nothing here pretends otherwise:
 *
 *   the settings section    CREATED, as src/reminder-settings.js, holding
 *                           exactly the four switches these reminders need.
 *   the once-a-day rule     CREATED HERE, as the unique key below. It is the
 *                           rule the brief describes, implemented once.
 *   reminder_log            CREATED with a `source` column that already has an
 *                           'auto' value, and a unique key that already spans
 *                           it. When the automatic nudge is built it inserts
 *                           its rows here and the screen's "Auto reminder sent
 *                           10:30" line lights up with no change to this file.
 *                           Until then that line is simply absent, which is the
 *                           truth rather than a stub pretending to be data.
 *   the working-hours rule  DERIVED FROM THE SCHEDULE, below, because there was
 *                           no existing reminder policy to inherit one from.
 *
 * ===========================================================================
 * NO SECOND DEFINITION OF ANYTHING. The re-check at send time is a call to
 * src/follow-up.js's own build() — the same function that drew the list the
 * sender clicked on — so "expected", "started", "filled" and "in scope" are
 * asked, never restated. That is also what makes the re-check honest: it cannot
 * agree with the list when the list is right and disagree when it is wrong.
 */

const reminderSettings = require('./reminder-settings');
const workSchedule = require('./work-schedule');
const workingTime = require('./working-time');
const timesheetSettings = require('./timesheet-settings');
const timesheetGate = require('./timesheet-gate');
const notifications = require('./notifications');
const emailNotifications = require('./email-notifications');
const { roleDef } = require('./roles');
const { v4: uuid } = require('uuid');

const KINDS = { start: 'start', timesheet: 'timesheet' };
const SOURCES = { manual: 'manual', auto: 'auto' };

/* WHICH BREAKS SILENCE A START REMINDER.
 *
 * The brief calls it "the lunch blackout". There is no lunch constant to read:
 * Settings -> Recording Hours is a list of named windows a Super Admin edits,
 * and lunch is simply the gap between two of them — today 13:00 to 14:00, but
 * that is a row in a table and not a rule in the code. Hard-coding the hour
 * here would be the exact mistake Prompt 39 was raised to correct.
 *
 * So the blackout is DERIVED: any gap between the day's recording windows that
 * is at least half an hour long. That catches lunch in every studio that has
 * one and skips the fifteen-minute tea breaks, which nobody means by a
 * blackout — and it moves on its own the day somebody moves the window.
 */
const BLACKOUT_MIN_BREAK_MINUTES = 30;

/* Every way a reminder can be refused, as keys, so the page and the tests name
   the same thing the server does. */
const CODES = {
  ok: 'ok',
  manual_off: 'manual_off',
  unknown_kind: 'unknown_kind',
  no_person: 'no_person',
  self: 'self',
  out_of_scope: 'out_of_scope',
  not_working_day: 'not_working_day',
  blackout: 'blackout',
  clock_shut: 'clock_shut',
  start_not_today: 'start_not_today',
  already_started: 'already_started',
  already_filled: 'already_filled',
  backdate_closed: 'backdate_closed',
  capped: 'capped',
  no_email: 'no_email',
};

const MS_PER_DAY = 86400000;
const IST_OFFSET_MS = workingTime.IST_OFFSET_MINUTES * 60 * 1000;
const dayNumberOf = (date) => (Date.parse(`${date}T00:00:00Z`)) / MS_PER_DAY;

/* ---------------------------------------------------------------------------
 * IS THE STUDIO IN A STATE TO BE NUDGING ANYBODY, right now?
 *
 * Only asked of START reminders. "You have not started work today" is a
 * sentence about a working morning: on a Sunday there is nothing to start, and
 * in the middle of lunch the honest answer is "they are at lunch".
 *
 * A TIMESHEET REMINDER IS NOT SUBJECT TO THIS, and the difference is not an
 * oversight. It is a request for paperwork about a day that is over; it can be
 * answered at any point in the day, and the brief says so.
 */
function windowState(now, { schedule = workSchedule.trackingWindow() } = {}) {
  const today = timesheetGate.istDate(now);
  const dayNumber = dayNumberOf(today);
  const spans = workingTime.spansOn(dayNumber, schedule);
  if (!spans.length) {
    return {
      ok: false,
      code: CODES.clock_shut,
      message: 'The studio’s clock is not open today, so there is nothing to have started yet. '
        + 'A start reminder waits for a recording day.',
    };
  }
  const minutes = Math.floor((now + IST_OFFSET_MS - dayNumber * MS_PER_DAY) / 60000);
  const open = spans[0][0];
  const close = spans[spans.length - 1][1];
  if (minutes < open) {
    return {
      ok: false,
      code: CODES.clock_shut,
      message: `The studio opens at ${clock(open)}. Nobody is late before then.`,
    };
  }
  if (minutes >= close) {
    return {
      ok: false,
      code: CODES.clock_shut,
      message: `The studio closed at ${clock(close)}. A start reminder for today has missed `
        + 'its day — the timesheet list is the one to use now.',
    };
  }
  /* THE GAPS, which is where lunch lives. Walked rather than looked up, so a
     studio with two long breaks has two blackouts and a studio with none has
     none. */
  for (let i = 0; i < spans.length - 1; i += 1) {
    const from = spans[i][1];
    const to = spans[i + 1][0];
    if (to - from < BLACKOUT_MIN_BREAK_MINUTES) continue;
    if (minutes >= from && minutes < to) {
      return {
        ok: false,
        code: CODES.blackout,
        message: `The studio is on a break until ${clock(to)}. A start reminder waits until `
          + 'work resumes — nudging somebody through their lunch is not what this is for.',
      };
    }
  }
  return { ok: true, code: CODES.ok, message: null };
}

/* Minutes past midnight as a wall clock, for a sentence somebody reads. */
function clock(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = String(Math.floor(minutes) % 60).padStart(2, '0');
  const ampm = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${m}${ampm}`;
}

/* ---------------------------------------------------------------------------
 * THE DECISION, in one function, in one order.
 *
 * Ordered cheapest-and-most-general first, exactly like src/tl-feedback.js's
 * decide(): a studio that has switched manual reminders off should be told that
 * and not told who is out of scope, and somebody out of scope must never be
 * told whether that person started work — the refusal itself would answer the
 * question the scope rule exists to withhold.
 *
 * NO DATABASE, NO CLOCK OF ITS OWN. Every fact arrives as an argument, which is
 * what makes all twelve refusals testable in arithmetic and what stops this
 * function growing a second opinion about any of them.
 */
function decide(facts = {}) {
  const {
    kind, settings, person, inScope, listed, subjectDate, today,
    workingDay, window: win, manualCount, backdateClosed, actorId,
  } = facts;

  const refuse = (code, message) => ({ ok: false, code, message });

  if (!settings || !settings.manualEnabled) {
    return refuse(CODES.manual_off,
      'Manual reminders are switched off in Settings → Start-of-day nudges.');
  }
  if (kind !== KINDS.start && kind !== KINDS.timesheet) {
    return refuse(CODES.unknown_kind, 'That is not a kind of reminder this section sends.');
  }
  if (!person) {
    return refuse(CODES.no_person, 'That person is no longer on the books.');
  }
  if (actorId && person.id === actorId) {
    return refuse(CODES.self, 'You cannot send yourself a reminder.');
  }
  /* SCOPE BEFORE CONDITION, always. See the note above: "Priya has started work
     since this list loaded" about somebody outside your projects would disclose
     Priya's morning to a lead who is not allowed to ask about it. */
  if (!inScope) {
    return refuse(CODES.out_of_scope,
      `${person.name} is not in the projects you can see, so they are not yours to nudge.`);
  }

  if (kind === KINDS.start) {
    /* A START REMINDER IS ABOUT TODAY, and only about today.
       "You haven't started work today" is the sentence; sending it on Thursday
       about last Tuesday is a sentence that is not true of either day. The
       timesheet list is what a past date is followed up with. */
    if (subjectDate !== today) {
      return refuse(CODES.start_not_today,
        `A start reminder is about today. ${subjectDate} is over — use the timesheet `
        + 'reminder for a past day.');
    }
    if (!workingDay) {
      return refuse(CODES.not_working_day,
        `${subjectDate} is not a working day for the studio — a weekly off or a holiday — so `
        + 'there is no work to have started.');
    }
    if (win && !win.ok) return refuse(win.code, win.message);
  } else if (!workingDay) {
    /* THE DAY THE TIMESHEET IS FOR has to be a day a timesheet can exist for.
       The day it is SENT on need not be — the brief allows a past date on any
       working day, and this function is never asked about the sending day. */
    return refuse(CODES.not_working_day,
      `${subjectDate} is not a day the studio logs time for, so there is no timesheet to fill.`);
  }

  /* THE CONDITION, RE-ASKED. `listed` is whether src/follow-up.js still has
     this person on that list, a moment ago, from the live tables — not a flag
     the browser sent back. */
  if (!listed) {
    return kind === KINDS.start
      ? refuse(CODES.already_started, `${person.name} has started work since this list loaded.`)
      : refuse(CODES.already_filled,
        `${person.name} has filled their timesheet for ${subjectDate} since this list loaded.`);
  }

  /* OUTSIDE THE BACK-DATING WINDOW: refused, and the reason named.
   *
   * The brief asks that this be said "rather than asking them to do something
   * they cannot", and a reminder IS the asking — so the refusal is the whole of
   * saying it. Sending the notice anyway with a caveat attached would be a
   * message whose own second sentence withdraws its first. */
  if (kind === KINDS.timesheet && backdateClosed) {
    return refuse(CODES.backdate_closed,
      `Back-dating is limited to ${backdateClosed.days} day(s), so ${subjectDate} can no longer `
      + 'be filled. Widen the window in Settings → Time Sheet first, or there is nothing '
      + `${person.name} can do about it.`);
  }

  const cap = Number(settings.dailyCap) || 1;
  if (Number(manualCount || 0) >= cap) {
    return refuse(CODES.capped, cap === 1
      ? `${person.name} has already been reminded today.`
      : `${person.name} has had ${manualCount} reminders today, which is the cap of ${cap}.`);
  }

  return { ok: true, code: CODES.ok, message: null, slot: Number(manualCount || 0) };
}

/* ---------------------------------------------------------------------------
 * THE WORDS, in one place, for all three consumers.
 *
 * The in-app notice, the email and the history row all read the same sentence,
 * because three copies of a sentence is three places for the date in it to be
 * formatted differently. The sentences themselves are the brief's, verbatim
 * apart from the punctuation a real name needs.
 */
function sentenceFor({ kind, actor, person, subjectDate, waiting }) {
  if (kind === KINDS.start) {
    const role = actor && actor.role ? ((roleDef(actor.role) || {}).label || actor.role) : null;
    const who = `${(actor && actor.name) || 'A lead'}${role ? ` (${role})` : ''}`;
    const tasks = Number(waiting) || 0;
    return `${who} is checking in: you haven’t started work today.`
      + ` You have ${tasks} task${tasks === 1 ? '' : 's'} waiting.`;
  }
  return `Please fill your timesheet for ${readableDay(subjectDate)}.`;
}

/* A date as a person reads it, from the ISO day. Written out rather than
   toLocaleDateString'd, so it cannot depend on which locale data this Node was
   built with — the same reason src/last-activity.js formats its own. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function readableDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return String(date || '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/* ---------------------------------------------------------------------------
 * THE ONCE-A-DAY RULE, AS A UNIQUE KEY.
 *
 * WHY A KEY AND NOT A COUNT. Two leads clicking at the same second both read
 * "nobody has been reminded" and both send — which is the failure the brief
 * names, and no amount of checking first can fix it, because the gap between
 * the check and the insert is where it lives. The database decides instead.
 *
 * HOW A CAP ABOVE ONE IS STILL A KEY. A unique key enforces "exactly one", not
 * "at most N", so the row carries a SLOT: the number of manual reminders
 * already sent to that person for that kind today. The key spans
 * (recipient, kind, source, sent_on, slot), so the first click takes slot 0,
 * the second takes slot 1, and two simultaneous clicks both aim at the same
 * slot and exactly one of them lands. The loser is told the cap, which is the
 * same answer it would have got a second later.
 *
 * THE ROW IS CLAIMED BEFORE ANYTHING IS SENT. A notice delivered and then
 * recorded could be delivered twice if the record failed; a row recorded and
 * then not delivered shows on the screen as a reminder that went nowhere, which
 * somebody can see and resend tomorrow. Of the two, the visible failure is the
 * one to have.
 */
async function claim(db, { person, actor, kind, subjectDate, sentOn, slot, source = SOURCES.manual }) {
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO reminder_log
         (id, recipient_id, sender_id, sender_name, kind, source, subject_date, sent_on, slot,
          channels, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'','claimed')`,
      [id, person.id, (actor && actor.id) || null, (actor && actor.name) || null,
        kind, source, subjectDate, sentOn, slot]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return { ok: false, code: CODES.capped, raced: true };
    if (err && err.code === 'ER_NO_SUCH_TABLE') {
      return { ok: false, code: 'no_table', message: 'The reminder log does not exist yet. Run the migration.' };
    }
    throw err;
  }
  return { ok: true, id };
}

/* What actually went out, written back onto the claimed row. */
async function settle(db, id, { channels, result }) {
  await db.query(
    'UPDATE reminder_log SET channels = $1, `result` = $2 WHERE id = $3',
    [channels.join(','), result, id]
  ).catch(() => {});
}

/* ---------------------------------------------------------------------------
 * SENDING ONE.
 *
 * The decision has already been made by the caller — this does not re-decide,
 * because a second opinion between the decision and the send is exactly the gap
 * the unique key exists to close.
 */
async function deliver(db, { person, actor, kind, subjectDate, waiting, slot, origin }) {
  const sentOn = timesheetGate.istDate(Date.now());
  const claimed = await claim(db, { person, actor, kind, subjectDate, sentOn, slot });
  if (!claimed.ok) {
    return {
      ok: false,
      code: claimed.code,
      message: claimed.message
        || `${person.name} has already been reminded today.`,
    };
  }

  const sentence = sentenceFor({ kind, actor, person, subjectDate, waiting });
  const channels = [];
  let notified = null;

  /* THE IN-APP NOTICE, THROUGH THE EXISTING MECHANISM. notifications.raise is
     the one choke point every notice in this application goes through — the
     bell, the desktop notification and the phone push all hang off it (see
     pushFor in src/notifications.js), so this reminder reaches all three
     without this file knowing any of them exist. */
  try {
    notified = await notifications.raise(db, {
      recipientId: person.id,
      actorId: (actor && actor.id) || null,
      kind: kind === KINDS.start ? notifications.KINDS.start_reminder
        : notifications.KINDS.timesheet_reminder,
      otherUserId: (actor && actor.id) || null,
      detail: sentence,
    });
    if (notified) channels.push('in_app');
  } catch {
    /* Swallowed and recorded, never thrown: the row says what did and did not
       go out, and a failed notice must not take down the request that sent it.
       The sender is told below. */
  }

  /* THE EMAIL, THROUGH THE EXISTING QUEUE, and only when the studio has said so.
     emailNotifications owns the opt-out lookup and the message shell; the outbox
     owns the retries, the backoff and the permanent-failure alert. Nothing about
     either is re-implemented here — the two lines below are the whole of it. */
  const settings = reminderSettings.current();
  let email = { queued: false, reason: 'disabled' };
  if (settings.emailEnabled) {
    email = await emailNotifications.reminder(db, {
      recipientId: person.id, kind, subjectDate, sentence, origin,
    }).catch(() => ({ queued: false, reason: 'error' }));
    if (email.queued) channels.push('email');
  }

  const result = channels.length ? 'sent' : 'nothing_sent';
  await settle(db, claimed.id, { channels, result });

  return {
    ok: channels.length > 0,
    code: channels.length ? CODES.ok : 'nothing_sent',
    message: channels.length ? null
      : 'Nothing could be sent — neither the in-app notice nor an email. Nobody was reminded.',
    id: claimed.id,
    sentence,
    channels,
    emailReason: email.queued ? null : email.reason,
    at: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------------------
 * WHAT HAS ALREADY GONE OUT TODAY, for the whole list, in one query.
 *
 * Both sources, because the screen shows both: the manual count is what the cap
 * is measured against, and the automatic one is there so a lead can see a
 * reminder has already been sent before adding a second. Grouped rather than
 * fetched per row — a query per person is the N+1 this section's own test
 * forbids.
 */
async function sentOnDay(db, ids, { day }) {
  const empty = { byUser: new Map(), available: true };
  if (!ids.length) return empty;
  try {
    const { rows } = await db.query(
      `SELECT r.recipient_id AS userId, r.kind, r.source, r.slot, r.sender_name AS senderName,
              r.subject_date AS subjectDate, r.created_at AS at, r.channels, r.\`result\`
         FROM reminder_log r
        WHERE r.recipient_id IN ($1)
          AND r.sent_on = $2
        ORDER BY r.created_at`,
      [ids, day]
    );
    const byUser = new Map();
    for (const row of rows) {
      const forUser = byUser.get(row.userId) || {};
      const forKind = forUser[row.kind] || { manual: [], auto: [] };
      const entry = {
        at: row.at, source: row.source, senderName: row.senderName || null,
        subjectDate: isoDay(row.subjectDate), channels: String(row.channels || '').split(',').filter(Boolean),
        result: row.result,
      };
      if (row.source === SOURCES.auto) forKind.auto.push(entry);
      else forKind.manual.push(entry);
      forUser[row.kind] = forKind;
      byUser.set(row.userId, forUser);
    }
    return { byUser, available: true };
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return { byUser: new Map(), available: false };
    throw err;
  }
}

/* A DATE column as the ISO day it is. The driver hands DATE back as a Date in
   the server's local zone, which for a date-only value is a day boundary
   waiting to go wrong. */
function isoDay(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-`
      + `${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

/* IS THE DAY STILL FILLABLE BY THE PERSON BEING REMINDED?
 *
 * Asked of src/timesheet-gate.js's own exemption rule and the studio's own
 * window, never of a number written here. Null when there is no limit, which is
 * what this application shipped with. */
function backdateState(subjectDate, { today, policy = timesheetSettings.current() } = {}) {
  if (!policy || policy.backdateDays === null || policy.backdateDays === undefined) return null;
  if (timesheetGate.exemptBackdate(policy)) return null;
  const behind = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${subjectDate}T00:00:00Z`)) / MS_PER_DAY
  );
  return behind > Number(policy.backdateDays) ? { days: Number(policy.backdateDays), behind } : null;
}

module.exports = {
  KINDS, SOURCES, CODES, BLACKOUT_MIN_BREAK_MINUTES,
  decide, deliver, claim, settle, sentOnDay, sentenceFor, readableDay,
  windowState, backdateState, isoDay, clock,
};
