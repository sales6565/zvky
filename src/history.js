/* MY HISTORY: one day per card, newest first, built only from what is already
 * recorded.
 *
 * ===========================================================================
 * THIS FILE ADDS NO TRACKING, AND THAT IS A CONSTRAINT RATHER THAN A BOAST.
 *
 * Every figure on a History card already exists somewhere and is already read by
 * some other screen. The brief says so explicitly ("using ONLY existing data, no
 * new tracking"), and the reason is worth writing down: a history that recorded
 * its own version of the day would, within one release, be the screen people
 * trusted — and it would disagree with the Artist Report, the timesheet and the
 * follow-up lists, because those four would be counting different things.
 *
 *   recorded time per asset   work_sessions, through work-log's own
 *                             RECORDED_SECONDS_SQL. The same expression
 *                             recordedFor() uses, so a day card and the Artist
 *                             Report cannot print different hours.
 *   the day's status          user_day_status (leave, idle, onsight, and a
 *                             vacation, which is leave with source 'planned'),
 *                             the holiday calendar, and loggableDays.
 *   the timesheet             timesheet_entries and timesheet_days, with the
 *                             required figure from the exact-hours rule.
 *   the day's events          asset_events.
 *
 * ===========================================================================
 * WHOSE EVENT IS IT. The one genuine gap, and the rule the studio chose.
 *
 * asset_events records an ACTOR. It does not record who was assigned at the
 * time, and there is no assignment history to reconstruct it from — so "TL
 * feedback received" is an event whose actor is the lead and whose subject is
 * the artist, and nothing in the schema says the artist's name.
 *
 * Current assignment is NOT an answer: an asset reassigned last week would put
 * last month's feedback on the wrong person's history, silently and
 * retrospectively. So an event is attributed to somebody's day only when it is
 * clearly theirs:
 *
 *   they are the actor                      they did it
 *   they are routed_to_id                   it was sent TO them
 *   they have a work_sessions row on that
 *     same asset on that same day           they were working on it that day
 *
 * WHICH OF THE FOUR EVENT TYPES THAT REACHES, stated plainly because a screen
 * that silently shows three of four things is worse than one that shows three
 * and says so:
 *
 *   submitted for review     YES, always — the artist is the actor.
 *   approved                 YES when the artist worked on it that day or it
 *                            was routed to them; otherwise it is the
 *                            reviewer's event and appears on the reviewer's day.
 *   TL feedback received     YES when routed_to_id is set (the ordinary case for
 *                            changes-required, which routes the asset back) or
 *                            when they worked on it that day. Feedback left
 *                            without routing and on a day they did not touch the
 *                            asset is not attributable and does not appear.
 *   reassigned               YES for the person it was routed TO, and for the
 *                            actor who did it. NOT for the person it was taken
 *                            FROM, because that is the fact the schema does not
 *                            hold.
 *
 * ===========================================================================
 * SCOPE IS ASKED, NEVER WIDENED. readableUserIds() — the same function the
 * Time Sheet tab and the export use — decides whose history may be read. This
 * module takes an id that has already been checked and never resolves one
 * itself.
 */
const timesheetGate = require('./timesheet-gate');
const timesheetSettings = require('./timesheet-settings');
const dayStatus = require('./day-status');
const holidays = require('./holidays');
const hoursRule = require('./timesheet-hours-rule');
const dayWindow = require('./timesheet-day-window');
const workLog = require('./work-log');
const sheets = require('./timesheets');

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const unavailable = (err) => /doesn't exist|no such table|Unknown column/i.test(
  (err && (err.sqlMessage || err.message)) || ''
);

const MS_PER_DAY = 86400000;
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
const dateAt = (n) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10);

/* THE RANGE, CLAMPED AND ORDERED. A page may send anything; this decides what
 * was actually asked for.
 *
 * `days` IS THE SETTING and the ceiling is the setting's own maximum, so a
 * hand-made request cannot ask for five years of cards — not for secrecy, but
 * because the query would be the slowest thing in the application and nobody
 * would be reading card nine hundred.
 */
function rangeFor({ from = null, to = null, days = null, now = Date.now() } = {}) {
  const settings = require('./history-settings').current();
  const today = timesheetGate.istDate(now);
  const span = Math.min(
    Math.max(Number(days) || settings.defaultDays, settings.MIN_DAYS || 1),
    settings.maxAllowedDays
  );
  const end = isDate(to) && to <= today ? to : today;
  const start = isDate(from) ? from : dateAt(dayNumber(end) - (span - 1));
  /* NEVER INVERTED, and never wider than the ceiling however the two dates
     arrive — a from after a to is a typo, not a request for nothing. */
  const lo = start <= end ? start : end;
  const floor = dateAt(dayNumber(end) - (settings.maxAllowedDays - 1));
  return { from: lo < floor ? floor : lo, to: end, today };
}

/* ---------------------------------------------------------------------------
 * THE READS. One query per kind of thing, over the whole range, assembled in
 * memory — rather than one query per day, which for a month of cards would be
 * thirty round trips to draw one screen.
 */

/* RECORDED TIME PER ASSET PER DAY, grouped in SQL with work-log's own
 * expression.
 *
 * THE DAY IS THE STUDIO'S DAY, not UTC's: a session that started at 21:00 IST
 * belongs to that date, and DATE(started_at) on a UTC server would file it
 * under the next one. The offset is applied in SQL for the same reason it is
 * applied everywhere else — there is one studio timezone and it is not the
 * process's.
 *
 * ATTRIBUTED TO THE DAY THE SESSION STARTED. A session crossing midnight is one
 * piece of work and belongs to the day somebody sat down to it; splitting it
 * would make a card's hours disagree with the asset's own total.
 */
async function recordedByDay(db, userId, from, to) {
  const out = new Map();
  let rows = [];
  try {
    const got = await db.query(
      `SELECT DATE_FORMAT(DATE_ADD(w.started_at, INTERVAL 330 MINUTE), '%Y-%m-%d') AS day,
              w.asset_id AS assetId,
              ${workLog.RECORDED_SECONDS_SQL('w.')} AS seconds,
              COUNT(*) AS sessions,
              SUM(w.ended_at IS NULL) AS stillOpen
         FROM work_sessions w
        WHERE w.user_id = $1
          AND DATE_ADD(w.started_at, INTERVAL 330 MINUTE) >= $2
          AND DATE_ADD(w.started_at, INTERVAL 330 MINUTE) < DATE_ADD($3, INTERVAL 1 DAY)
        GROUP BY day, w.asset_id`,
      [userId, from, to]
    );
    rows = got.rows;
  } catch (err) {
    if (!unavailable(err)) throw err;
    return out;
  }
  for (const row of rows) {
    if (!out.has(row.day)) out.set(row.day, []);
    out.get(row.day).push({
      assetId: row.assetId,
      seconds: Number(row.seconds) || 0,
      sessions: Number(row.sessions) || 0,
      open: Number(row.stillOpen) > 0,
    });
  }
  return out;
}

/* THE ASSETS THOSE IDS NAME, with the client, project and discipline a card
   shows. One query for the set, not one per card. */
async function assetsByIds(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.\`code\`, a.\`name\`, a.\`type\` AS discipline, a.status,
              p.id AS projectId, p.\`name\` AS projectName,
              c.id AS clientId, c.\`name\` AS clientName
         FROM assets a
         LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE a.id IN ($1)`,
      [ids]
    );
    for (const row of rows) out.set(row.id, row);
  } catch (err) {
    if (!unavailable(err)) throw err;
  }
  return out;
}

/* THE DAY'S EVENTS, under the attribution rule at the top of this file.
 *
 * `workedAssetsByDay` is the third limb of that rule — it is passed in rather
 * than queried again, because recordedByDay() has already read exactly that.
 */
async function eventsByDay(db, userId, from, to, workedAssetsByDay) {
  const out = new Map();
  let rows = [];
  try {
    const got = await db.query(
      `SELECT e.id, e.asset_id AS assetId, e.action, e.from_status AS fromStatus,
              e.to_status AS toStatus, e.actor_id AS actorId, e.routed_to_id AS routedToId,
              e.note,
              DATE_FORMAT(DATE_ADD(e.created_at, INTERVAL 330 MINUTE), '%Y-%m-%d') AS day,
              e.created_at AS createdAt,
              u.\`name\` AS actorName
         FROM asset_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE DATE_ADD(e.created_at, INTERVAL 330 MINUTE) >= $1
          AND DATE_ADD(e.created_at, INTERVAL 330 MINUTE) < DATE_ADD($2, INTERVAL 1 DAY)
          AND (e.actor_id = $3 OR e.routed_to_id = $3 OR e.asset_id IN (
            SELECT DISTINCT w.asset_id FROM work_sessions w WHERE w.user_id = $3
          ))
        ORDER BY e.seq`,
      [from, to, userId]
    );
    rows = got.rows;
  } catch (err) {
    if (!unavailable(err)) throw err;
    return out;
  }
  for (const row of rows) {
    const mine = row.actorId === userId
      || row.routedToId === userId
      /* THE THIRD LIMB IS PER DAY, not per asset: the SQL above widened to any
         asset this person has ever touched (one subquery beats one query per
         day), and this narrows it back to the rule — they worked on that asset
         on THAT day. Without this a card would show events from an asset they
         worked on months earlier. */
      || (workedAssetsByDay.get(row.day) || []).some((w) => w.assetId === row.assetId);
    if (!mine) continue;
    if (!out.has(row.day)) out.set(row.day, []);
    out.get(row.day).push({
      id: row.id,
      assetId: row.assetId,
      action: row.action,
      fromStatus: row.fromStatus || null,
      toStatus: row.toStatus || null,
      note: row.note || null,
      byMe: row.actorId === userId,
      toMe: row.routedToId === userId,
      actorName: row.actorId === userId ? null : (row.actorName || null),
      at: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    });
  }
  return out;
}

/* THE TIMESHEET, for the whole range in two queries. */
async function timesheetByDay(db, userId, from, to) {
  const days = new Map();
  const lines = new Map();
  try {
    const { rows } = await db.query(
      `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS day, status,
              submitted_at AS submittedAt
         FROM timesheet_days WHERE user_id = $1 AND work_date >= $2 AND work_date <= $3`,
      [userId, from, to]
    );
    for (const row of rows) days.set(row.day, row);
  } catch (err) {
    if (!unavailable(err)) throw err;
  }
  try {
    const { rows } = await db.query(
      `SELECT e.id, DATE_FORMAT(e.entry_date, '%Y-%m-%d') AS day, e.hours,
              e.non_project AS nonProject, e.non_project_sub AS nonProjectSub,
              e.notes, e.tl_action AS tlAction, e.asset_id AS assetId,
              a.\`code\` AS assetCode, a.\`name\` AS assetName,
              p.\`name\` AS projectName, c.\`name\` AS clientName
         FROM timesheet_entries e
         LEFT JOIN assets a ON a.id = e.asset_id
         LEFT JOIN projects p ON p.id = e.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE e.user_id = $1 AND e.entry_date >= $2 AND e.entry_date <= $3
        ORDER BY e.entry_date, e.created_at`,
      [userId, from, to]
    );
    for (const row of rows) {
      if (!lines.has(row.day)) lines.set(row.day, []);
      lines.get(row.day).push(row);
    }
  } catch (err) {
    if (!unavailable(err)) throw err;
  }
  return { days, lines };
}

/* ---------------------------------------------------------------------------
 * ONE DAY'S CARD.
 */

/* THE CHIP, in the words the rest of the application uses for the same state.
 *
 * VACATION IS NAMED SEPARATELY FROM LEAVE even though it is a leave row,
 * because to the person reading their own history those are different facts
 * about their week — and the row already says which it was, through `source`.
 */
function chipFor({ mark, holiday, weekend, worked, timesheet }) {
  if (holiday) return { kind: 'holiday', label: holiday.name || 'Holiday' };
  if (mark && mark.kind === 'leave') {
    const planned = mark.planned || mark.source === 'planned';
    const half = mark.portion === 'first_half' || mark.portion === 'second_half';
    if (planned && !half) return { kind: 'vacation', label: 'Vacation' };
    if (half) {
      return {
        kind: 'leave_half',
        label: `Leave ${mark.portion === 'first_half' ? '1st half' : '2nd half'}`,
        planned,
      };
    }
    return { kind: 'leave', label: 'Leave', planned };
  }
  if (mark && mark.kind === 'idle') return { kind: 'idle', label: 'Idle' };
  if (mark && mark.kind === 'onsight') {
    return { kind: 'onsight', label: mark.clientName ? `On site — ${mark.clientName}` : 'On site' };
  }
  if (weekend) return { kind: 'weekly_off', label: 'Weekly off' };
  if (worked || (timesheet && timesheet.lines.length)) return { kind: 'worked', label: 'Worked' };
  return { kind: 'nothing', label: 'Nothing recorded' };
}

/* ---------------------------------------------------------------------------
 * THE WHOLE THING. One call, one payload, nothing for the page to work out.
 */
async function build(db, { viewer, userId, from = null, to = null, days = null,
  now = Date.now() } = {}) {
  const who = userId || (viewer && viewer.id);
  if (!who) return { ok: false, status: 400, error: 'Whose history?' };

  const range = rangeFor({ from, to, days, now });
  const settings = timesheetSettings.current();
  const historySettings = require('./history-settings').current();

  /* WHEN THIS PERSON STARTED, so days before they existed are never drawn. The
     brief asks for that and it is right: a card saying "nothing recorded" for a
     Tuesday before somebody was hired is noise that makes the real empty days
     harder to see. */
  let createdOn = null;
  try {
    const { rows } = await db.query(
      `SELECT DATE_FORMAT(DATE_ADD(created_at, INTERVAL 330 MINUTE), '%Y-%m-%d') AS day,
              \`name\`, email
         FROM users WHERE id = $1`, [who]
    );
    if (!rows.length) return { ok: false, status: 404, error: 'That person is not there.' };
    createdOn = rows[0].day;
  } catch (err) {
    if (!unavailable(err)) throw err;
  }

  const worked = await recordedByDay(db, who, range.from, range.to);
  const events = await eventsByDay(db, who, range.from, range.to, worked);
  const sheetsByDay = await timesheetByDay(db, who, range.from, range.to);
  const marks = await dayStatus.activeBetween(db, range.from, range.to)
    .then((rows) => {
      const map = new Map();
      for (const row of rows) if (row.userId === who) map.set(row.date, row);
      return map;
    })
    .catch(() => new Map());
  const unlocks = new Set((await dayWindow.liveFor(db, who,
    { from: range.from, to: range.to }).catch(() => [])).map((r) => r.date));

  const assetIds = [...new Set([
    ...[...worked.values()].flat().map((w) => w.assetId),
    ...[...events.values()].flat().map((e) => e.assetId),
  ].filter(Boolean))];
  const assets = await assetsByIds(db, assetIds);

  const exempt = Boolean(viewer && who === viewer.id
    && require('./permissions').holds(viewer, 'timesheet.min_hours_exempt'));
  const backdateKey = Boolean(viewer && who === viewer.id
    && require('./permissions').holds(viewer, 'timesheet.backdate'));

  const cards = [];
  for (let n = dayNumber(range.to); n >= dayNumber(range.from); n -= 1) {
    const date = dateAt(n);
    if (createdOn && date < createdOn) continue;

    const mark = marks.get(date) || null;
    const holiday = holidays.on(date) || null;
    const weekend = !timesheetGate.isWorkingDay(date, {
      loggableDays: settings.loggableDays,
      isHoliday: () => false,
    });
    const workedToday = (worked.get(date) || []);
    const dayEvents = (events.get(date) || []);
    const lines = (sheetsByDay.lines.get(date) || []);
    const sheetDay = sheetsByDay.days.get(date) || null;

    /* NOTHING AT ALL, AND NOTHING TO SAY. The brief: days with no activity are
       not shown, except the statuses that matter — a holiday, a weekly off, a
       leave day — because those ARE the fact about that day. */
    const chip = chipFor({ mark, holiday, weekend, worked: workedToday.length > 0,
      timesheet: { lines } });
    const empty = !workedToday.length && !dayEvents.length && !lines.length && !sheetDay;
    if (empty && chip.kind === 'nothing') continue;

    /* THE REQUIRED FIGURE AND THE DAY'S STATE, from the exact-hours rule — not
       recomputed here. `timesheetRequiredOn` owns whether anything is owed. */
    const owed = dayStatus.timesheetRequiredOn(date, mark, { settings });
    const verdict = hoursRule.decide({
      enabled: settings.hoursRuleEnabled,
      exempt,
      requiredHours: settings.maxDayHours,
      effectiveFrom: settings.hoursRuleFrom,
      date,
      mark,
      timesheetRequired: owed,
      entries: lines,
    });
    const window = dayWindow.isTimesheetDayOpen({
      policy: settings, date, now, backdateKey, unlocked: unlocks.has(date),
    });

    cards.push({
      date,
      chip,
      weekend,
      holiday: holiday ? { name: holiday.name } : null,
      dayMark: mark
        ? { kind: mark.kind, portion: mark.portion || null, planned: Boolean(mark.planned),
          note: mark.note || null, clientName: mark.clientName || null }
        : null,
      workedOn: workedToday.map((w) => {
        const a = assets.get(w.assetId) || {};
        return {
          assetId: w.assetId,
          code: a.code || null,
          name: a.name || null,
          discipline: a.discipline || null,
          projectName: a.projectName || null,
          clientName: a.clientName || null,
          seconds: w.seconds,
          /* THE LABEL IS THE SERVER'S, from day-status's own formatter — "1 h
             30 m", the way every other duration in this application reads — so
             a card and an asset panel cannot describe the same figure
             differently. (It lives there and not in work-log, which I had to
             check rather than assume.) */
          label: dayStatus.durationLabel(w.seconds),
          open: w.open,
          events: dayEvents.filter((e) => e.assetId === w.assetId),
        };
      }),
      /* EVENTS ON ASSETS THEY DID NOT RECORD TIME AGAINST THAT DAY still belong
         to the day — submitting something and then not touching it again is the
         ordinary shape of a hand-in. */
      otherEvents: dayEvents.filter((e) => !workedToday.some((w) => w.assetId === e.assetId))
        .map((e) => {
          const a = assets.get(e.assetId) || {};
          return { ...e, code: a.code || null, name: a.name || null,
            projectName: a.projectName || null, clientName: a.clientName || null };
        }),
      timesheet: {
        lines: lines.map((l) => ({
          id: l.id,
          hours: Number(l.hours),
          nonProject: l.nonProject || null,
          nonProjectSub: l.nonProjectSub || null,
          tlAction: l.tlAction || null,
          notes: l.notes || null,
          assetCode: l.assetCode || null,
          assetName: l.assetName || null,
          projectName: l.projectName || null,
          clientName: l.clientName || null,
        })),
        status: sheetDay ? sheetDay.status : (lines.length ? 'draft' : 'none'),
        submittedAt: sheetDay && sheetDay.submittedAt
          ? new Date(sheetDay.submittedAt).toISOString() : null,
        locked: sheetDay ? sheets.isLocked(sheetDay.status) : false,
        /* THE SAME NUMBERS THE TIMESHEET TAB DRAWS, from the same module. */
        required: verdict.required,
        logged: verdict.logged,
        remaining: verdict.remaining,
        requiredHours: hoursRule.toHours(verdict.required),
        loggedHours: hoursRule.toHours(verdict.logged),
        ruleApplies: verdict.applies,
        ruleStatus: verdict.status,
        canSubmit: verdict.canSubmit,
        reason: verdict.reason,
        /* WHETHER THE BUTTON MAY EVEN BE DRAWN, decided here. The page must not
           work this out: it is the switch, the window, the lock and whose
           history this is, and all four are the server's. */
        maySubmit: Boolean(
          historySettings.submitFromHistory
          && viewer && who === viewer.id
          && window.open
          && !(sheetDay && sheets.isLocked(sheetDay.status))
          && verdict.canSubmit
          && (lines.length > 0)
        ),
      },
      entryWindow: {
        open: Boolean(window.open),
        reason: window.reason,
        closedMessage: window.open ? null : dayWindow.refusalFor({ ...window, date }),
        unlocked: unlocks.has(date),
      },
    });
  }

  return {
    ok: true,
    user: { id: who, mine: Boolean(viewer && who === viewer.id) },
    from: range.from,
    to: range.to,
    today: range.today,
    days: cards,
    /* SAID OUT LOUD so the page can draw an honest empty state rather than
       guessing why there is nothing. */
    empty: cards.length === 0,
    /* THE CATEGORY LABELS, from the same reference list the week payload sends.
       The LABEL is resolved from the key the line stores, so renaming a category
       in Settings re-labels every historical line that ever used it — which is
       the behaviour the Timesheet tab already has, and the reason the page is
       given the list rather than the words. */
    nonProjectTypes: sheets.nonProject(),
    settings: {
      defaultDays: historySettings.defaultDays,
      maxDays: historySettings.maxAllowedDays,
      submitFromHistory: historySettings.submitFromHistory,
    },
  };
}

module.exports = { build, rangeFor, chipFor, recordedByDay, eventsByDay };
