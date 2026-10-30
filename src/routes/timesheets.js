const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { holds } = require('../permissions');
const permissions = require('../permissions');
const tlReview = require('../tl-review');
const sheets = require('../timesheets');
const workSchedule = require('../work-schedule');
const dayStatus = require('../day-status');
const holidays = require('../holidays');
// For the Hours suggestion: what this person's own work sessions say about one day.
const workLog = require('../work-log');
/* "Thursday 9 Oct" — the same formatter the previous-working-day refusal uses,
   because two date formatters is two ways to write the same day. */
const { label: dayLabel } = require('../timesheet-gate');
const xlsx = require('xlsx');
const branding = require('../branding');
const exporter = require('../report-export');
const reportPdf = require('../report-pdf');

router.use(authenticate);

/* The manual timesheet.
 *
 * Independent of work_sessions and of the Efficiency and Idle reports, and
 * nothing here reads or writes either. Those measure the clock between Accept
 * and Submit on one asset; this records what a person says they did, including
 * the parts of a day that are not an asset. One feeding the other would make
 * "Time Spent" mean two things and leave neither answer trustworthy.
 */

// The table arrives with a migration, and a step can fail. An unavailable table
// reads as an empty week rather than a 500 — the same bargain the rest of this
// codebase makes with its newer tables.
const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

/* The flag columns are named separately because a deployment can be missing
 * them: they arrive in a migration, a migration step can fail, and this file
 * already reads ER_BAD_FIELD_ERROR as "no timesheet on this deployment". Left
 * inline, a database that did not get the ALTER would answer every week with an
 * empty sheet rather than with a sheet that has no flags on it — losing the
 * hours to save the marker. selectEntries() below asks with them and asks again
 * without. */
const ENTRY_SELECT_BASE = `
  SELECT e.id, e.user_id AS userId, e.entry_date AS date, e.hours, e.notes,
         e.start_min AS startMin, e.end_min AS endMin,
         e.non_project AS nonProject,
         e.client_id AS clientId,  c.\`name\` AS clientName,
         e.project_id AS projectId, p.\`name\` AS projectName,
         e.asset_id AS assetId,     a.\`code\` AS assetCode, a.\`name\` AS assetName`;
const ENTRY_SELECT_FROM = `
    FROM timesheet_entries e
    LEFT JOIN clients  c ON c.id = e.client_id
    LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN assets   a ON a.id = e.asset_id`;

/* THE COLUMNS ADDED SINCE THE TABLE WAS CREATED, each optional.
 *
 * A deployment whose ALTER did not apply — no ALTER permission on shared
 * hosting is the usual reason — still reads its timesheet, with the fields it
 * cannot store coming back null. Written as a list of attempts rather than a
 * nest of catches, which is the shape src/work-log.js close() uses for the same
 * problem: widest first, and each fallback fills in what it could not ask for.
 */
const ENTRY_EXTRAS = [
  { select: ',\n         e.flagged_at AS flaggedAt, e.flag_note AS flagNote,\n         e.non_project_sub AS nonProjectSub,\n         e.tl_action AS tlAction',
    missing: {} },
  { select: ',\n         e.flagged_at AS flaggedAt, e.flag_note AS flagNote,\n         e.non_project_sub AS nonProjectSub',
    missing: { tlAction: null } },
  { select: ',\n         e.flagged_at AS flaggedAt, e.flag_note AS flagNote',
    missing: { nonProjectSub: null, tlAction: null } },
  { select: '', missing: { flaggedAt: null, flagNote: null, nonProjectSub: null, tlAction: null } },
];

async function selectEntries(tail, params) {
  let last;
  for (const attempt of ENTRY_EXTRAS) {
    try {
      const { rows } = await db.query(
        `${ENTRY_SELECT_BASE}${attempt.select}${ENTRY_SELECT_FROM} ${tail}`,
        params
      );
      return rows.map((r) => ({ ...attempt.missing, ...r }));
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      last = err;
    }
  }
  throw last;
}

/* Whose sheet may this person open?
 *
 * Three answers, widening: your own always; your team if you hold
 * timesheet.team; anybody if you hold timesheet.all. "Your team" is the
 * reporting line the rest of the app already uses — reports_to_id or
 * team_lead_id — rather than a second idea of a team invented here.
 *
 * Returns null when the answer is "no", so a caller can 403 without a second
 * lookup deciding the same thing differently.
 */
async function mayRead(viewer, targetId) {
  if (!targetId || targetId === viewer.id) return { ok: true, scope: 'own' };
  if (holds(viewer, 'timesheet.all')) return { ok: true, scope: 'all' };
  if (holds(viewer, 'timesheet.team')) {
    const { rows } = await db.query(
      'SELECT 1 AS ok FROM users WHERE id = $1 AND (reports_to_id = $2 OR team_lead_id = $2)',
      [targetId, viewer.id]
    );
    if (rows.length) return { ok: true, scope: 'team' };
  }
  return { ok: false };
}

// Everybody whose sheet this person may read, for the picker and the queue.
async function readableUserIds(viewer) {
  if (holds(viewer, 'timesheet.all')) {
    /* Everybody, deactivated accounts included. There IS an is_active on a
       user now — see src/user-deactivation.js — and this deliberately does not
       filter by it: somebody who has left still has the weeks they filled in,
       and a timesheet report that quietly dropped them would stop adding up.
       (This comment used to say no such column existed, which stopped being
       true when deactivation was added.) */
    const { rows } = await db.query('SELECT id FROM users');
    return rows.map((r) => r.id);
  }
  const mine = [viewer.id];
  if (holds(viewer, 'timesheet.team')) {
    const { rows } = await db.query(
      'SELECT id FROM users WHERE reports_to_id = $1 OR team_lead_id = $1', [viewer.id]
    );
    rows.forEach((r) => mine.push(r.id));
  }
  return [...new Set(mine)];
}

// The week row, made on demand. A week nobody has touched has no row, which is
// the right default: a draft is the absence of a decision, not a record of one.
async function dayRow(userId, workDate) {
  const { rows } = await db.query(
    'SELECT * FROM timesheet_days WHERE user_id = $1 AND work_date = $2', [userId, workDate]
  );
  return rows[0] || null;
}

async function ensureDay(userId, workDate) {
  const found = await dayRow(userId, workDate);
  if (found) return found;
  await db.query(
    'INSERT INTO timesheet_days (id, user_id, work_date, status) VALUES ($1,$2,$3,$4)',
    [uuid(), userId, workDate, 'draft']
  );
  return dayRow(userId, workDate);
}

/* Every change to a timesheet, on the record.
 *
 * Hours are the input to somebody's pay, so this covers edits a person makes to
 * their own week as well as decisions made about it — the self-edits are
 * exactly what a dispute turns on. Swallowed on failure for the reason
 * notifications are: an edit that happened and was not logged beats an edit
 * refused because the log could not be written.
 */
async function record(userId, workDate, action, actor, detail) {
  try {
    await db.query(
      `INSERT INTO timesheet_events (id, user_id, work_date, action, actor_id, actor_email, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), userId, workDate, action, actor.id, actor.email, detail || null]
    );
  } catch (err) {
    console.warn(`[timesheet] could not log ${action} on ${workDate}: ${err.message}`);
  }
}

/* One line, in the words the audit trail should carry: what it was against,
   not which row it was. */
function describeLine(row) {
  if (!row) return 'a line';
  if (row.nonProject) {
    /* The label for a key, INCLUDING a category that has since been retired —
       sheets.nonProjectLabel reads the whole list rather than the active one, so
       last month's Training lines keep saying Training. */
    const category = sheets.nonProjectLabel(row.nonProject);
    /* And the second dropdown's choice beside it, so the audit trail says
       "Idle — Left Early" rather than leaving somebody to look the line up. */
    const chosen = row.nonProjectSub ? sheets.subOptionLabel(row.nonProjectSub) : null;
    return chosen ? `${category} \u2014 ${chosen}` : category;
  }
  const where = [row.clientName, row.projectName].filter(Boolean).join(' / ') || 'a project';
  const base = row.assetCode ? `${where} · ${row.assetCode}` : where;
  /* AND WHAT KIND OF LINE IT WAS, in the audit trail as on the screen. Without
     it the log of a lead's day reads as ordinary project work, which is the one
     thing a TL Action line is not. */
  const tl = tlReview.labelFor(row.tlAction);
  return tl ? `${base} · ${tl}` : base;
}

/* ONE SHAPE FOR ONE LINE, wherever a line goes back.
 *
 * It was written inline inside the week's day shape, which is how the single
 * entry POST and PATCH hand back came to be a different thing: the raw row,
 * without the rendered clock or the resolved sub-option. Two shapes for one
 * object is two things to keep in step, and the second one was already behind.
 */
const shapeEntry = (e) => ({
  ...e,
  date: sheets.toISO(e.date),
  hours: Number(e.hours),
  startMin: Number(e.startMin),
  endMin: Number(e.endMin),
  /* Rendered here so the page never turns a number into a clock itself. Empty
     on everything filed since a line became a number of hours, and still filled
     on the older rows so a sheet from before the change reads the way it was
     written. Rendering a null minute would print "00:00", which reads as
     midnight rather than as absent. */
  startLabel: e.startMin === null ? '' : sheets.clockLabel(Number(e.startMin)),
  endLabel: e.endMin === null ? '' : sheets.clockLabel(Number(e.endMin)),
  /* THE SECOND DROPDOWN'S CHOICE, resolved here rather than snapshotted on the
     row. The line stores the KEY; the label is looked up at read time, so
     renaming "Left Early" changes every line that ever used it and breaks no
     report — and a RETIRED option still resolves, because the lookup reads the
     whole list. `subOptionRetired` is what lets a screen mark it as no longer
     offered without a second request. */
  subOptionLabel: sheets.subOptionLabel(e.nonProjectSub),
  subOptionRetired: sheets.subOptionRetired(e.nonProjectSub),
  /* WHAT KIND OF TL ACTION, in words, from the one function that spells them —
     so the screen, the admin views and both exports cannot come to disagree
     about what a line says. The words themselves live in src/tl-review.js and
     a test fails on any second copy of them, this comment included. null on
     every ordinary line, which is all of them until a lead files one. */
  tlActionLabel: tlReview.labelFor(e.tlAction),
});

/* One day, in the shape the page and the exports both read.
 *
 * `dayTotal` carries the two flags an approver needs — over eight hours, and
 * work on a weekend — which are flags rather than refusals because both are
 * real things that happen and a form that blocks them teaches people to lie to
 * it. Everything to do with the clock is minutes past midnight IST, which is
 * what makes the times identical for a reader in any timezone.
 */
const shapeDay = (day, entries, workDate, mark = null) => {
  const total = sheets.dayTotal(entries, workSchedule.timesheetWindow());
  return {
    date: workDate,
    /* WHAT KIND OF DAY THIS WAS, and the marker the brief asks for on lines
     * that overlap it.
     *
     * NOTHING IS DELETED AND NOTHING IS REFUSED. A line filed before somebody
     * was marked on leave stays exactly as it was typed; what changes is that
     * the hours inside the window stop counting towards the figures the app
     * calculates, and the day says so. A sheet that silently dropped a line
     * would be a sheet nobody could reconcile.
     *
     * STILL REQUIRED ON A HALF DAY AND ON AN IDLE DAY, which is why this is a
     * marker and not an exemption — src/day-status.js's timesheetRequiredFromRow
     * is the one place that is decided. */
    dayMark: mark ? {
      kind: mark.kind,
      portion: mark.portion,
      label: dayStatus.describe(mark),
      /* The half the window covers, so the banner on the person's own sheet can
         say "until 13:00" without the page doing clock arithmetic. */
      overlapsLeave: mark.kind === dayStatus.KINDS.leave,
      required: dayStatus.timesheetRequiredFromRow(mark),
    } : null,
    status: day ? day.status : 'draft',
    submittedAt: day ? day.submitted_at : null,
    decidedAt: day ? day.decided_at : null,
    decidedBy: day ? day.decider_email : null,
    rejectionReason: day ? day.rejection_reason : null,
    locked: sheets.isLocked(day ? day.status : 'draft'),
    entries: entries.map(shapeEntry),
    hours: total.hours,
    overLong: total.overLong,
    /* THE DAY SPLIT THREE WAYS. dayTotal computes it; this is where it reaches
       the payload. Spelled out field by field like everything else in this
       shape rather than spread, so a reader can see what the day carries. */
    project: total.project,
    nonProject: total.nonProject,
    idle: total.idle,
    /* AND WHAT THE IDLE HOURS WERE. The figure says there was slack; the
       breakdown says whose problem it was, which is the whole purpose of the
       Idle remarks. Spelled out like the three above it rather than spread. */
    idleByRemark: total.idleByRemark,
    weekend: sheets.isWeekend(workDate),
    /* THE STUDIO WAS SHUT THAT DAY — a flag, exactly like `weekend` beside it,
     * and for the reason this function's own comment already gives: these are
     * real things that happen and a form that blocks them teaches people to lie
     * to it. Somebody who did come in on a holiday files the hours and the
     * approver sees why the day is unusual.
     *
     * AND THE ROW IS STILL OFFERED, which is where a holiday deliberately
     * parts company with a weekend. workingDays() drops an unfilled Saturday
     * from the week, on the grounds that the studio never works one — a
     * permanent, known fact. A holiday is a row an admin added, possibly for a
     * date that was a normal working day when somebody worked it, and hiding
     * the row would leave them unable to file hours they really put in. The
     * Time Sheet has no expected-hours figure for a holiday to zero out
     * anyway: it has a soft cap and whatever has been filed. So the day is
     * labelled rather than removed.
     *
     * Null on an ordinary day, which is what lets the page choose its chip
     * from one field. */
    holiday: (() => {
      const closed = holidays.on(workDate);
      return closed ? { date: closed.date, name: closed.name } : null;
    })(),
  };
};

/* The studio's working day, handed to the page rather than repeated in it.
   It comes from Settings -> Working Hours, so changing the window there changes
   the form, its refusals and its hints together, with nothing to redeploy.
   hasLunch is false for a studio with no fixed break, which is a real answer
   and not the same as a lunch hour of length zero. */
const policy = () => require('../timesheet-settings').current();

const workingDay = () => {
  const win = workSchedule.timesheetWindow();
  return {
    timezone: win.timezone,
    /* Only the soft cap is left of the working-day window. The clock times
       and the lunch hour went with the clock fields on the form, and the four
       Settings inputs that set them went with them — a setting nothing reads is
       worse than no setting. hoursPerDay stays: it is this cap AND what the
       Idle report measures a day against. */
    maxHours: win.maxHours,
    /* THE POLICY THE FORM HAS TO QUOTE, from the studio's setting rather than
       from words in the page. "Monday to Friday" was hardcoded in two places on
       screen while the rule itself was hardcoded in validateEntry; now the form
       says what the server will actually accept, so a studio that logs Saturdays
       does not read a hint that contradicts its own settings. */
    loggableDayNames: policy().loggableDayNames,
    loggableDays: policy().loggableDays,
    minLineHours: policy().minLineHours,
    maxLineHours: policy().maxLineHours,
    backdateDays: policy().backdateDays,
    futureDays: policy().futureDays,
    /* WHETHER THE TL ACTION BOX EXISTS AT ALL. The page still asks can() for
       the key and still asks the server which projects this person leads — this
       is only the studio-wide switch, published with the rest of the policy so
       the form does not have to fetch the settings separately. */
    tlAction: policy().tlAction,
  };
};

/* WHICH PROJECTS THIS PERSON LEADS, for the TL Action box.
 *
 * SENT WITH THE WEEK RATHER THAN ASKED PER PROJECT. The first build of this
 * feature had an endpoint the form called every time the project picker
 * changed; a list of ids sent once with the week it belongs to answers the same
 * question with no endpoint at all, no round trip while somebody is filling in
 * a form, and nothing to cache or invalidate.
 *
 * ONLY FOR SOMEBODY WHO COULD USE IT. Two queries, skipped entirely for the
 * people who do not hold the key — which is almost everybody, and all of them
 * on every load of the week.
 *
 * THE PAGE STILL DECIDES NOTHING. This is the server's answer to "do you lead
 * it", exactly as the endpoint's was; the form draws the box from it, and the
 * save asks permissions.isProjectLead() again regardless. A list here that
 * somebody tampered with buys nothing.
 */
async function tlActionProjectsFor(user) {
  if (!policy().tlAction || !holds(user, 'timesheet.tl_action')) return [];
  const reach = await permissions.visibleProjects(user).catch(() => []);
  const ids = reach.map((p) => p.id).filter(Boolean);
  if (!ids.length) return [];
  const led = await permissions.reviewTeamProjects(user.id, ids).catch(() => new Set());
  return ids.filter((id) => led.has(id));
}

/* GET /api/timesheets/week?date=&userId= — seven days, for filling in.
 *
 * Still a week on screen even though submission is now daily: a week is how
 * somebody wants to SEE their time, and one day at a time is seven navigations
 * to do one job. Each day carries its own status and its own lock, which is
 * what changed.
 */
router.get('/week', requirePermission('timesheet.own'), async (req, res) => {
  const anchor = sheets.toISO(req.query.date) || sheets.toISO(new Date().toISOString().slice(0, 10));
  const days = sheets.weekDays(anchor);
  const userId = req.query.userId || req.user.id;

  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  try {
    const entries = await selectEntries(
      'WHERE e.user_id = $1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.created_at',
      [userId, days[0], days[6]]
    );
    const { rows: dayRows } = await db.query(
      'SELECT * FROM timesheet_days WHERE user_id = $1 AND work_date BETWEEN $2 AND $3',
      [userId, days[0], days[6]]
    );
    const byDate = new Map(dayRows.map((d) => [sheets.toISO(d.work_date), d]));
    const { rows: who } = await db.query('SELECT id, `name`, email FROM users WHERE id = $1', [userId]);

    /* Monday to Friday, plus any weekend day that already has hours on it.
       The RANGE above is still the whole week, so the totals below add up
       whatever is really there — what changes is which days are offered as
       rows. See workingDays() for why a filled Saturday is still shown. */
    const filledWeekend = entries.map((e) => sheets.toISO(e.date)).filter((d) => sheets.isWeekend(d));
    const shownDays = sheets.workingDays(anchor, { alsoShow: filledWeekend });

    /* THE WEEK'S MARKS, in one query for seven days — never one per day. */
    const marks = await dayStatus.statusesFor(db, [userId], days[0], days[6]).catch(() => new Map());

    const shaped = shownDays.map((d) =>
      shapeDay(byDate.get(d) || null, entries.filter((e) => sheets.toISO(e.date) === d), d,
        marks.get(`${userId}|${d}`) || null));

    res.json({
      user: who[0] || null,
      mine: userId === req.user.id,
      mayEdit: userId === req.user.id,
      /* Somebody else's sheet is read-only for everybody now. There is no
         decision to make on it — approving was removed, and what replaced the
         way back out of a locked day is the owner's own reopen. */
      nonProjectTypes: sheets.nonProject(),
      workingDay: workingDay(),
      /* THE PROJECTS THIS READER LEADS, so the TL Action box knows whether it
         belongs on the line being added. Empty for everybody without the key,
         and for everybody when the studio's switch is off. */
      tlActionProjects: await tlActionProjectsFor(req.user),
      days: shaped,
      weekStart: days[0],
      weekEnd: days[6],
      /* So the screen can say why Saturday and Sunday are not there. */
      weekendOff: true,
      weekHours: Math.round(shaped.reduce((n, d) => n + d.hours, 0) * 100) / 100,
      /* THE WEEK SPLIT THREE WAYS, which is where Idle becomes visible.
       *
       * Computed by sheets.splitHours over the week's RANGE rather than over the
       * shown days, so it agrees with weekHours above: a filled Saturday that is
       * shown and a filled Saturday on a studio that has stopped logging
       * Saturdays both land in the same total. One function, used here and by the
       * day totals and the exports, so no two of them can split differently. */
      weekSplit: sheets.splitHours(entries),
    });
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] timesheet tables unavailable (${err.code}); the week reads empty.`);
    res.json({
      user: null, mine: true, mayEdit: false, mayDecide: false, unavailable: true,
      nonProjectTypes: sheets.nonProject(), workingDay: workingDay(),
      /* Empty on the unavailable path, like every other list in this payload:
         a deployment whose timesheet tables are missing has no lines to add. */
      tlActionProjects: [],
      days: days.map((d) => shapeDay(null, [], d)),
      weekStart: days[0], weekEnd: days[6], weekHours: 0,
      weekSplit: { project: 0, nonProject: 0, idle: 0 },
    });
  }
});

// Who this person may look at, for the picker beside the week.
router.get('/people', requirePermission('timesheet.own'), async (req, res) => {
  const ids = await readableUserIds(req.user);
  if (!ids.length) return res.json({ users: [] });
  const holes = ids.map((_, n) => `$${n + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT id, \`name\`, email, \`role\` FROM users WHERE id IN (${holes}) ORDER BY \`name\``, ids
  );
  res.json({ users: rows, scope: holds(req.user, 'timesheet.all') ? 'all'
    : (holds(req.user, 'timesheet.team') ? 'team' : 'own') });
});

/* POST /api/timesheets/entries — add a line to your own day.
 *
 * Your own, always: there is no path here to writing hours onto somebody else's
 * sheet. An approver sends a day back for its owner to correct rather than
 * correcting it themselves, because a timesheet somebody else edited is no
 * longer that person's statement of their day.
 */
/* One INSERT, tolerant of a deployment whose flag columns did not apply.
 * The flag is a convenience; losing it must not lose the hours. */
/* ONE LINE WRITTEN, AND THE COLUMNS THAT MAY NOT BE THERE.
 *
 * timesheet_entries has gained columns since it was created — the dispute flag,
 * and now the second dropdown's choice — and each arrived as an ALTER that can
 * fail on a host where the database user cannot run one. The hours are the
 * point; a column that could not be added must not take them down with it.
 *
 * So the optional columns are listed youngest LAST and dropped from the end on
 * ER_BAD_FIELD_ERROR: everything, then without the sub-option, then without the
 * flag either. Declared as column/value pairs rather than written out three
 * times, because three near-identical statements is where the fourth column
 * gets added to two of them.
 */
const ENTRY_CORE = (line) => [
  ['entry_date', line.date], ['start_min', line.startMin], ['end_min', line.endMin],
  ['client_id', line.clientId], ['project_id', line.projectId], ['asset_id', line.assetId],
  ['non_project', line.nonProject], ['hours', line.hours], ['notes', line.notes],
];
const ENTRY_OPTIONAL = (line, stamp) => [
  [['flagged_at', stamp], ['flag_note', line.flagNote]],
  [['non_project_sub', line.nonProjectSub || null]],
  /* LAST, because writeEntry drops from the end: a deployment whose tl_action
     ALTER was refused still files every other kind of line, and loses only the
     one thing it cannot store. */
  [['tl_action', line.tlAction || null]],
];

async function writeEntry(build, line, stamp) {
  const optional = ENTRY_OPTIONAL(line, stamp);
  let last;
  for (let drop = 0; drop <= optional.length; drop += 1) {
    const pairs = [...ENTRY_CORE(line), ...optional.slice(0, optional.length - drop).flat()];
    try {
      const { sql, values } = build(pairs);
      await db.query(sql, values);
      return;
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      last = err;
    }
  }
  throw last;
}

async function insertEntry(id, userId, line) {
  await writeEntry((pairs) => {
    const columns = ['id', 'user_id', ...pairs.map(([c]) => c)];
    const values = [id, userId, ...pairs.map(([, v]) => v)];
    return {
      sql: `INSERT INTO timesheet_entries (${columns.join(', ')})
            VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`,
      values,
    };
  }, line, line.flagNote ? new Date() : null);
}

/* The same tolerance on the way back out. An unchanged flag keeps its original
 * stamp: re-stamping it on every edit would make the flag look raised at the
 * moment of the last unrelated change. */
async function updateEntry(id, line, was) {
  const stamp = line.flagNote
    ? (was.flag_note === line.flagNote && was.flagged_at ? was.flagged_at : new Date())
    : null;
  await writeEntry((pairs) => {
    const sets = pairs.map(([c], i) => `${c} = $${i + 1}`);
    const values = [...pairs.map(([, v]) => v), id];
    return {
      sql: `UPDATE timesheet_entries SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    };
  }, line, stamp);
}

/* THE ONE FIGURE A TIMESHEET LINE IS WORTH, asked once and read twice — by the
 * form through GET /suggest, and by the save below through hoursFor().
 *
 * WHAT A LINE IS WORTH IS WHAT THIS PERSON RECORDED ON THAT ASSET ON THAT DAY,
 * less whatever they have already filed against it on THAT SAME DAY. Both
 * halves are the day's.
 *
 * WHAT IT WAS, AND THE BUG. It was the asset's whole recorded time for this
 * person, less everything they had ever filed against it. Three hours on
 * Thursday and two on Friday therefore offered FIVE on Thursday — and filed
 * five, because the field is locked and the server recalculates — and then
 * refused Friday's line with "all 5h is already on your timesheet". The day
 * figure existed and was shown as a footnote beside the number that was
 * actually used.
 *
 * THE PROPERTY THE OLD PAIR BOUGHT IS KEPT. Subtracting every day from the
 * whole total made the days add up to the recorded time exactly once, and the
 * reason it was done that way is that the day figure DROPPED any stretch
 * running past midnight. That is fixed at the source: dayTotalFor splits such a
 * stretch between the two days, so the per-day figures already sum to the
 * recorded total and the whole-asset number is not needed to make them.
 *
 * THE WHOLE-ASSET TOTAL IS NO LONGER READ HERE AT ALL, which is the invariant
 * worth stating plainly: Time Spent on the asset, the Efficiency report and the
 * P&L are the asset's whole cost across everybody who held it, and that number
 * has no business in a line about one person's day. workLog.recordedFor() is
 * still the reader for those screens; the timesheet does not call it.
 *
 * ONE FUNCTION FOR BOTH CALLERS on purpose. A form showing three and a save
 * filing five is the exact shape this change is undoing, and two call sites
 * computing "the same" figure is how that happened.
 */
async function dayFigure(userId, { assetId, date }, { exceptId = null } = {}) {
  const day = sheets.toISO(date);
  if (!assetId || !day) return null;
  const [recorded, logged] = await Promise.all([
    workLog.dayTotalFor(db, { assetId, userId, day }),
    sheets.hoursLoggedOn(db, { assetId, userId, day, exceptId }),
  ]);
  const round = (n) => Math.round(n * 100) / 100;
  /* Hours to two places, which is what the field steps in, what the column
     stores and what every other hours figure in the timesheet is rounded to.
     ROUNDED ONCE, HERE. dayTotalFor returns the exact overlap in milliseconds
     and an unrounded seconds figure beside it, so a session split across two
     days is not rounded twice and the days still sum to the session's own
     working time. */
  const dayHours = round(recorded.seconds / 3600);
  const outstanding = round(Math.max(0, dayHours - logged));
  /* No single line is longer than a day, and that rule predates this one. */
  const left = Math.min(outstanding, sheets.MAX_LINE_HOURS);
  if (recorded.openCapped) {
    /* Reported rather than silently capped: an open row spanning a day that has
       already ended means the pause sweep never closed it. The figure is capped
       at the end of that day, which is right, but somebody should know. */
    console.warn(`[timesheet] ${recorded.openCapped} open session(s) on asset ${assetId} `
      + `span ${day}, which has ended — capped at the end of that day for ${userId}.`);
  }
  return {
    day,
    dayHours,
    /* READABLE, AND BUILT HERE. The field is decimal hours because that is what
       the column stores and what the step is; the sentence beside it reads
       "1 h 30 m", which is what somebody checking their own day actually
       thinks in. Formatted on the server so the page shows what it is given and
       the two cannot disagree about 1.5. */
    label: hoursLabel(dayHours),
    logged,
    left,
    open: recorded.open,
    crossing: recorded.crossing,
    openCapped: recorded.openCapped,
    /* Sessions that overlapped the day and were worth nothing — outside the
       hours, inside the lunch blackout, or on a day the studio is shut. The
       difference between "you recorded nothing" and "what you recorded was not
       in working hours", which are different things to be told. */
    outside: recorded.outside,
    future: recorded.future,
  };
}

/* "1 h 30 m", "45 m", "0 m". The unit the form reads in, from the figure the
   column stores. Minutes only below an hour, and never "1 h 0 m". */
function hoursLabel(hours) {
  const total = Math.max(0, Math.round(Number(hours || 0) * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} m`;
  return m ? `${h} h ${m} m` : `${h} h`;
}

/* The hours a line is worth, decided here rather than taken from the caller.
 *
 * WHEN A LINE NAMES AN ASSET the figure is calculated and the field is locked,
 * so whatever the request carried is ignored: the day figure above. A locked
 * field that the API will happily overwrite is not locked, it is decorated, and
 * this application has both layers of every other restriction for the same
 * reason.
 *
 * WHEN IT DOES NOT, the number is typed and kept. Leave, Holiday, Internal
 * Meeting, Training and Admin have no asset to calculate from, and neither does
 * project time somebody logs without naming one. Calculating those is not
 * possible, so locking them would not make them automatic — it would make them
 * unfileable, and take five categories of time out of the timesheet on the way.
 *
 * IT TAKES THE DATE because the figure is now per day. A request with no usable
 * date falls through to the typed path, where sheets.validateEntry() refuses the
 * date with its own message — all the date messaging stays in one place, and
 * nothing is filed either way.
 *
 * NOTHING RECORDED ON THAT DAY is refused rather than filed as nought, and the
 * message says what to do instead: the same line without an asset takes a typed
 * figure, which is how offline work and a day the timer was never started have
 * always been filed. That is the existing rule, applied to the day.
 */
/* ---------------------------------------------------------------------------
 * TL ACTION, ON THE WAY IN.
 *
 * EVERY QUESTION ASKED ON THE SERVER, because the check box, the dropdown and
 * the hidden Asset field are all things a person can change with a developer
 * console open. The page's version of these rules is there so somebody is told
 * before the round trip; this is the one that decides.
 *
 * ORDER MATTERS AND IS CHEAP-FIRST: the shape of the value, then the studio's
 * switch, then the key, then the kind of line, then the project membership —
 * which is the only one that costs a query.
 *
 * BOTH KINDS ARE THE SAME SHAPE now that a review is typed: project work, a
 * project, no asset, and a number of hours the lead types. The hours are left
 * to validateEntry, which already owns the step, the minimum, the maximum and
 * the soft day cap — there is no second opinion about what a valid number of
 * hours is, here or anywhere.
 */
async function tlActionFor(user, body) {
  const raw = body.tlAction === undefined || body.tlAction === null || body.tlAction === ''
    ? null : String(body.tlAction);
  if (raw === null) return { ok: true, tlAction: null };

  if (!tlReview.isAction(raw)) {
    /* INCLUDING 'asset_review', the name the first build of this feature used.
       A client still sending it is told rather than quietly filed, which is why
       isAction refuses it even though labelFor still reads it — strict on the
       way in, lenient on the way out. */
    return { ok: false, status: 400, error: 'That is not a kind of TL Action.', field: 'tlAction' };
  }
  if (!policy().tlAction) {
    return { ok: false, status: 409, field: 'tlAction',
      error: 'TL Action is switched off for this studio. Lines already filed are unaffected.' };
  }
  if (!holds(user, 'timesheet.tl_action')) {
    return { ok: false, status: 403, field: 'tlAction',
      error: 'You do not have the permission to log TL Action time.' };
  }
  /* PROJECT WORK ONLY. A meeting about a project and a review of its work are
     both project time; neither is Leave, Training or Idle, and the non-project
     categories have their own second dropdown that would collide with this one. */
  const projectId = body.projectId || null;
  if (body.nonProject || !projectId) {
    return { ok: false, status: 400, field: 'projectId',
      error: 'TL Action is project work: choose the client and the project it was for.' };
  }
  /* NO ASSET, FOR EITHER KIND. A meeting is not about one asset and a review is
     the lead's own time rather than time on the thing reviewed — allowing one
     would put a lead's hours on an asset's row in every screen that groups by
     asset. Refused rather than quietly cleared: a request that names an asset
     meant to name one. */
  if (body.assetId) {
    return { ok: false, status: 400, field: 'assetId',
      error: 'TL Action time is not logged against an asset. Leave the asset unset.' };
  }
  const reach = await permissions.visibleProjects(user);
  const inScope = reach.some((p) => p.id === projectId);
  if (!inScope || !await permissions.isProjectLead(user, projectId)) {
    return { ok: false, status: 403, field: 'projectId',
      error: 'You do not lead that project, so you cannot log TL Action time on it.' };
  }
  return { ok: true, tlAction: raw };
}

async function hoursFor(userId, { assetId, hours, date }, { exceptId = null } = {}) {
  if (!assetId) return { ok: true, hours, calculated: false };
  const figure = await dayFigure(userId, { assetId, date }, { exceptId });
  if (!figure) return { ok: true, hours, calculated: false };

  if (figure.dayHours === 0) {
    return {
      ok: false,
      error: `Nothing was recorded against that asset by you on ${dayLabel(figure.day)}, so there `
        + 'are no hours to log against it for that day. Time is measured from Accept and Start — if '
        + 'you worked on it without the timer, file the hours as project time without naming an '
        + 'asset and the figure is yours to type.',
      field: 'assetId',
    };
  }
  if (figure.left < sheets.MIN_LINE_HOURS) {
    return {
      ok: false,
      error: `All ${figure.dayHours}h you recorded against that asset on ${dayLabel(figure.day)} `
        + 'is already on your timesheet for that day.',
      field: 'assetId',
    };
  }
  return { ok: true, hours: figure.left, calculated: true };
}

router.post('/entries', requirePermission('timesheet.own'), async (req, res) => {
  /* The figure BEFORE the validation, not after.
   *
   * Where a line names an asset the hours are the server's, so validating what
   * the caller sent would be validating a number nobody can type and that is
   * about to be thrown away — a request carrying 99 would be refused for being
   * over the daily limit rather than simply filed as the three hours the timer
   * recorded. Calculating first means every rule below applies to the figure
   * that actually gets filed. */
  /* TL ACTION FIRST, because it decides where the hours come from. An asset
     review's figure is the review sessions, not the clock on the asset — the
     two are different measurements of different people's time, and asking
     hoursFor() for a lead's review would offer them the ARTIST's recorded
     hours. See tlActionFor() above. */
  const tl = await tlActionFor(req.user, req.body || {});
  if (!tl.ok) return res.status(tl.status).json({ error: tl.error, field: tl.field });

  /* A TL Action line names no asset, so hoursFor() falls straight through to
     "the number is the caller's" — the same path Leave, Training and
     unattributed project time have always taken. Called anyway rather than
     skipped, so there is one route into the figure and not two. */
  const worth = await hoursFor(req.user.id, req.body || {});
  if (!worth.ok) return res.status(400).json({ error: worth.error, field: worth.field });

  const verdict = sheets.validateEntry(
    { ...(req.body || {}), hours: worth.hours }, workSchedule.timesheetWindow());
  if (!verdict.ok) return res.status(400).json(verdict);
  const line = verdict.value;
  line.calculated = worth.calculated;
  line.tlAction = tl.tlAction;

  const day = await ensureDay(req.user.id, line.date).catch((err) => {
    if (unavailable(err)) return null;
    throw err;
  });
  if (!day) {
    return res.status(503).json({
      error: 'Timesheets are not available on this deployment yet — the database is missing the '
        + 'timesheet tables. See /api/health.',
    });
  }
  if (sheets.isLocked(day.status)) {
    return res.status(409).json({
      error: day.status === 'approved'
        ? 'That day has been approved and can no longer be changed.'
        : 'That day is with your approver. Ask them to send it back if it needs changing.',
      status: day.status,
    });
  }

  /* There is no overlap check any more, and its absence is the price of the
     simpler form. Two lines claiming the same minutes used to be refused, and
     it is the one arithmetic error a timesheet cannot catch by adding up — the
     total looks perfectly reasonable. With hours alone there is nothing to
     compare, so the day's total and its soft warning are the only defence
     left. See validateEntry in src/timesheets.js. */

  const id = uuid();
  await insertEntry(id, req.user.id, line);

  const rows = await selectEntries('WHERE e.id = $1', [id]);
  const said = `${line.hours}h `
    + `(${line.hours}h) — ${describeLine(rows[0])}`;
  await record(req.user.id, line.date, 'entry_added', req.user, said);
  req.activity({
    module: 'timesheet', action: 'timesheet.entry', entityType: 'day',
    entityId: id, entityLabel: line.date,
    summary: `Logged ${said} on ${line.date}`,
  });
  /* The day as it stands after this line, so the page can say "that makes nine
     hours" at the moment somebody adds the ninth rather than on the next draw.
     Read back rather than added up in the browser, because the day may have
     lines this session never saw. */
  const { rows: onDay } = await db.query(
    'SELECT hours FROM timesheet_entries WHERE user_id = $1 AND entry_date = $2',
    [req.user.id, line.date]
  );
  const total = sheets.dayTotal(onDay, workSchedule.timesheetWindow());
  res.status(201).json({
    entry: shapeEntry(rows[0]),
    dayHours: total.hours,
    // Allowed and flagged, not refused — the soft cap the studio asked for.
    overLong: total.overLong,
    maxHours: total.maxHours,
  });
});

// PATCH /api/timesheets/entries/:id — change one of your own lines.
router.patch('/entries/:id', requirePermission('timesheet.own'), async (req, res) => {
  const { rows: found } = await db.query('SELECT * FROM timesheet_entries WHERE id = $1', [req.params.id])
    .catch(() => ({ rows: [] }));
  if (!found.length) return res.status(404).json({ error: 'That line does not exist.' });
  if (found[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'That line is on somebody else\'s timesheet.' });
  }

  const wasOn = sheets.toISO(found[0].entry_date);
  const day = await dayRow(req.user.id, wasOn);
  if (day && sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day is locked.', status: day.status });
  }

  // Validated as a whole rather than field by field: the window, the lunch hour
  // and the either/or rule are all about the row, not about one cell.
  const merged = {
    date: req.body.date ?? wasOn,
    hours: req.body.hours ?? Number(found[0].hours),
    clientId: 'clientId' in req.body ? req.body.clientId : found[0].client_id,
    projectId: 'projectId' in req.body ? req.body.projectId : found[0].project_id,
    assetId: 'assetId' in req.body ? req.body.assetId : found[0].asset_id,
    nonProject: 'nonProject' in req.body ? req.body.nonProject : found[0].non_project,
    /* The second dropdown's choice, from the request or from the row. Taken
       from the row when the request is silent, which is what lets an edit that
       changes only the hours keep a remark — including one that has since been
       retired. */
    nonProjectSub: 'nonProjectSub' in req.body ? req.body.nonProjectSub : found[0].non_project_sub,
    notes: 'notes' in req.body ? req.body.notes : found[0].notes,
    flagged: 'flagged' in req.body ? req.body.flagged : Boolean(found[0].flagged_at),
    flagNote: 'flagNote' in req.body ? req.body.flagNote : found[0].flag_note,
  };
  /* WHAT AN EDIT MAY NOT CHANGE ON A TL ACTION LINE: what kind of action it was.
     
     A meeting is not a review and a review is not a meeting; they are two
     different things that happened, not two labels on one. Turning an ordinary
     line into a TL Action one is the same refusal from the other side — an
     ordinary line was filed against an asset by somebody filling in their own
     work, and relabelling it would move hours between two different meanings.
     The way to correct either is to delete the line and add the right one,
     which costs nothing: both kinds are typed.
     
     Said plainly rather than silently ignored, so somebody who tried is told.
     
     AND THE ASSET IS FROZEN RATHER THAN FORBIDDEN, which is not the same rule
     the POST applies and is deliberately not.
     
     A TL Action line filed today has no asset. But a line converted from the
     first build of this feature may still carry one, and that row has to stay
     editable — somebody must be able to fix its hours or its note. Running the
     POST's rule here would read the row's own inherited asset_id, refuse, and
     leave the line permanently uneditable: a rule about what may be FILED,
     applied to what was already filed.
     
     So the asset may not be changed, and is not re-examined. The value stays
     exactly as it is rather than being cleared, because clearing it would
     destroy the one record of which asset that line was about. */
  const wasTl = found[0].tl_action || null;
  if ('tlAction' in req.body && (req.body.tlAction || null) !== wasTl) {
    return res.status(400).json({ field: 'tlAction',
      error: wasTl
        ? 'A TL Action line keeps the kind it was filed as. Delete it and add the right one.'
        : 'An ordinary line cannot become a TL Action line. Delete it and add the TL Action line.' });
  }
  if (wasTl && 'assetId' in req.body && (req.body.assetId || null) !== (found[0].asset_id || null)) {
    return res.status(400).json({ field: 'assetId',
      error: 'A TL Action line keeps the asset it was filed against. Delete it and add the right one.' });
  }

  /* The same lock as on the way in, and in the same order: a line naming an
     asset is worth what the timer recorded, and this row's own hours are
     excluded from the subtraction so an untouched edit does not shrink itself
     to nothing. A TL Action line names no asset, so it falls through to the
     typed-hours path every other non-asset line takes. */
  /* ASKED WITHOUT THE ASSET, because the line above has just established that
     it is unchanged. Passing the row's own inherited asset_id into a rule about
     what may be filed is what would make a converted row uneditable. */
  const tl = wasTl
    ? await tlActionFor(req.user, { ...merged, assetId: null, tlAction: wasTl })
    : { ok: true, tlAction: null };
  if (!tl.ok) return res.status(tl.status).json({ error: tl.error, field: tl.field });

  /* A TL ACTION LINE'S HOURS ARE TYPED, whatever asset_id it carries.
     
     hoursFor() reads an asset_id as "this line is worth what the timer
     recorded", which is right for every other line and wrong for this one. A
     row converted from the first build of this feature still has the asset it
     was filed against, so asking hoursFor() about it would answer "nothing was
     recorded against that asset by you that day" and refuse the edit — leaving
     the line permanently uncorrectable. The kind of line decides where the
     figure comes from, not the presence of an asset_id. */
  const worth = wasTl
    ? { ok: true, hours: merged.hours, calculated: false }
    : await hoursFor(req.user.id, merged, { exceptId: req.params.id });
  if (!worth.ok) return res.status(400).json({ error: worth.error, field: worth.field });

  /* THE LINE AS STORED, handed over so a line filed before the second dropdown
     existed stays editable. With the category and the option both unchanged,
     validateEntry takes the pair as given — no remark is demanded of a legacy
     Idle line somebody is only correcting the hours of, and a retired option
     keeps working on the line that already holds it. Change the category and
     the full rules apply. See the note on `was` in src/timesheets.js. */
  const verdict = sheets.validateEntry(
    { ...merged, hours: worth.hours }, workSchedule.timesheetWindow(),
    { was: { nonProject: found[0].non_project, nonProjectSub: found[0].non_project_sub } });
  if (!verdict.ok) return res.status(400).json(verdict);
  const line = verdict.value;
  line.tlAction = wasTl;

  // Moving a line to another day needs that day to exist and to be unlocked.
  if (line.date !== wasOn) {
    const target = await ensureDay(req.user.id, line.date);
    if (sheets.isLocked(target.status)) {
      return res.status(409).json({ error: 'That day is locked.', status: target.status });
    }
  }

  await updateEntry(req.params.id, line, found[0]);
  const rows = await selectEntries('WHERE e.id = $1', [req.params.id]);
  await record(req.user.id, line.date, 'entry_edited', req.user,
    `now ${line.hours}h — ${describeLine(rows[0])}`);
  res.json({
    entry: shapeEntry(rows[0]),
    lunchSubtracted: verdict.lunchSubtracted || 0,
  });
});

// DELETE /api/timesheets/entries/:id
router.delete('/entries/:id', requirePermission('timesheet.own'), async (req, res) => {
  const { rows: found } = await db.query('SELECT * FROM timesheet_entries WHERE id = $1', [req.params.id])
    .catch(() => ({ rows: [] }));
  if (!found.length) return res.status(404).json({ error: 'That line does not exist.' });
  if (found[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'That line is on somebody else\'s timesheet.' });
  }
  const on = sheets.toISO(found[0].entry_date);
  const day = await dayRow(req.user.id, on);
  if (day && sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day is locked.', status: day.status });
  }
  await db.query('DELETE FROM timesheet_entries WHERE id = $1', [req.params.id]);
  await record(req.user.id, on, 'entry_removed', req.user,
    `${Number(found[0].hours)}h removed`);
  res.json({ ok: true });
});

/* POST /api/timesheets/submit — hand ONE DAY to your approver.
 * body: { date }
 *
 * Daily, replacing the weekly cycle the feature shipped with. A day is what
 * gets approved now, which means a Tuesday can be approved while Wednesday is
 * still being filled in — the thing a weekly row could not express.
 */
router.post('/submit', requirePermission('timesheet.own'), async (req, res) => {
  const date = sheets.toISO(req.body.date || new Date().toISOString().slice(0, 10));
  if (!date) return res.status(400).json({ error: 'Which day?', field: 'date' });

  const day = await ensureDay(req.user.id, date).catch((err) => {
    if (unavailable(err)) return null; throw err;
  });
  if (!day) return res.status(503).json({ error: 'Timesheets are not available on this deployment yet.' });
  if (sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day has already been submitted.', status: day.status });
  }

  const { rows } = await db.query(
    'SELECT hours FROM timesheet_entries WHERE user_id = $1 AND entry_date = $2',
    [req.user.id, date]
  );
  // An empty day is not a submission. Somebody who worked nothing has nothing
  // to approve, and a queue of empty days is a queue nobody reads.
  if (!rows.length) {
    return res.status(400).json({ error: 'There is nothing on that day to submit.' });
  }

  await db.query(
    `UPDATE timesheet_days SET status = 'submitted', submitted_at = NOW(),
        decided_by = NULL, decider_email = NULL, decided_at = NULL, rejection_reason = NULL
      WHERE user_id = $1 AND work_date = $2`,
    [req.user.id, date]
  );
  const total = sheets.dayTotal(rows, workSchedule.timesheetWindow());
  await record(req.user.id, date, 'submitted', req.user,
    `${total.hours}h across ${total.lines} line(s)${total.overLong ? ' — over the eight-hour day' : ''}`);
  console.log(`${req.user.email} submitted their timesheet for ${date} (${total.hours}h).`);

  req.activity({
    module: 'timesheet', action: 'timesheet.submit', entityType: 'day', entityLabel: date,
    summary: `Submitted their timesheet for ${date} — ${total.hours}h across ${total.lines} line(s)`,
    changes: { status: { from: 'draft', to: 'submitted' } },
  });

  const saved = await dayRow(req.user.id, date);
  res.json({
    day: { date, status: saved.status, submittedAt: saved.submitted_at, locked: true },
    overLong: total.overLong,
  });
});

/* POST /api/timesheets/reopen — take back a day you submitted.
 * body: { date }
 *
 * THIS EXISTS BECAUSE APPROVAL DOES NOT.
 *
 * Submitting still locks a day — the studio kept that — but the way back used
 * to be to ask your approver to send it back. With nobody to ask, a locked day
 * would be locked for ever, and a mistyped 8 that should have been 0.8 would be
 * permanent. So the person whose sheet it is can unlock their own day.
 *
 * That is a weaker lock than the old one, and deliberately so: the lock was
 * only ever there to stop a sheet changing under an approver mid-decision, and
 * there is no decision now. What it still does is make submitting a definite
 * act rather than an autosave, which is the part the studio asked to keep.
 *
 * Every unlock is written to the day's own history and to the Activity Log, so
 * a sheet that was submitted, changed and submitted again says so.
 */
router.post('/reopen', requirePermission('timesheet.own'), async (req, res) => {
  const date = sheets.toISO(req.body.date);
  if (!date) return res.status(400).json({ error: 'Which day?', field: 'date' });

  const day = await dayRow(req.user.id, date);
  if (!day) return res.status(404).json({ error: 'There is no timesheet for that day.' });
  if (!sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day is already open for changes.', status: day.status });
  }

  await db.query(
    `UPDATE timesheet_days SET status = 'draft', submitted_at = NULL
      WHERE user_id = $1 AND work_date = $2`,
    [req.user.id, date]
  );
  await record(req.user.id, date, 'reopened', req.user, 'unlocked by its owner to be changed');
  console.log(`${req.user.email} reopened their timesheet for ${date}.`);

  req.activity({
    module: 'timesheet', action: 'timesheet.reopen', entityType: 'day', entityLabel: date,
    summary: `Reopened their own timesheet for ${date} to change it`,
    changes: { status: { from: day.status, to: 'draft' } },
  });

  const saved = await dayRow(req.user.id, date);
  res.json({ day: { date, status: saved.status, locked: sheets.isLocked(saved.status) } });
});

/* GET /api/timesheets/suggest?assetId=&date=&exclude= — the hours to fill in.
 *
 * WHAT THIS PERSON RECORDED ON THAT ASSET ON THAT DAY, less what they have
 * already filed against it on that day. dayFigure() above is the whole of it,
 * and the save uses the same function — the form cannot show one number and the
 * server file another.
 *
 * THE ASSET'S WHOLE RECORDED TIME IS NOT IN THIS RESPONSE. It used to be, as
 * `recorded`, and it was the figure the field was filled from: five hours
 * offered on a three-hour Thursday. A timesheet line is a day, so the only
 * figure a timesheet context has any business showing is the day's.
 *
 * THE DATE IS REQUIRED AND VALIDATED HERE. A malformed one is a 400 rather than
 * a quiet fallback to today — a form that asked about the wrong day would be
 * harder to notice than an error. A date in the future comes back as zero: the
 * day has not happened, so nothing can have been recorded on it.
 *
 * IT IS ONE PERSON'S OWN TIME. There is no userId parameter: the figure is
 * always req.user's, which is also whose line POST /entries writes. If a
 * file-on-behalf-of path is ever added, dayFigure() already takes the owner's
 * id as its first argument and that is the only place it would need to change.
 *
 * STILL NOT A SUGGESTION, despite the name the path has carried since before
 * the field was locked: where a line names an asset this figure is what gets
 * filed, and hoursFor() works it out again on save.
 */
router.get('/suggest', requirePermission('timesheet.own'), async (req, res) => {
  /* WHOSE TIME, and it is the SHEET'S OWNER rather than whoever is looking.
   *
   * There is no fill-on-behalf-of write path today — POST /entries always files
   * for req.user.id — so for every request the application currently makes these
   * are the same person. The parameter is here because GET /week already takes
   * one and a lead can read a report's sheet, so the figure beside it has to be
   * theirs; and because when an on-behalf write does arrive, the figure is
   * already right rather than quietly the lead's own hours.
   *
   * GUARDED BY mayRead, the same check /week and /history use. Without it this
   * would be a way to read anybody's clock by guessing a user id. */
  const userId = String(req.query.userId || '') || req.user.id;
  if (userId !== req.user.id) {
    const verdict = await mayRead(req.user, userId);
    if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });
  }
  const date = sheets.toISO(req.query.date);
  /* A DAY THAT DOES NOT EXIST IS A 400, not a quiet zero. toISO accepts a Date
     and an ISO instant on purpose and checks no calendar, so '2026-13-40'
     reaches here looking like a date; answering "no hours on the 40th" would be
     agreeing with the question. */
  if (!date || !sheets.isRealDate(date)) {
    return res.status(400).json({ error: 'Which day?', field: 'date' });
  }
  const assetId = String(req.query.assetId || '').trim();
  if (!assetId) {
    return res.json({ date, hours: null, onThisDay: 0, onThisDayLabel: '0 m',
      logged: 0, open: false, crossing: 0, outside: 0 });
  }

  const figure = await dayFigure(userId, { assetId, date },
    { exceptId: req.query.exclude || null });

  res.json({
    // The day the figure is for, echoed so the page can throw away a response
    // that arrived after it had moved on.
    date: figure.day,
    assetId,
    // Below the minimum line, there is nothing worth offering.
    hours: figure.left >= sheets.MIN_LINE_HOURS ? figure.left : null,
    // What the day holds, and what of it is already filed.
    onThisDay: figure.dayHours,
    // The same figure in the words the form prints — see hoursLabel().
    onThisDayLabel: figure.label,
    logged: figure.logged,
    open: figure.open,
    // Stretches that ran past midnight and had this day's part counted. Shown
    // so a figure smaller than a session somebody remembers is explained.
    crossing: figure.crossing,
    // Open sessions spanning a day that has ended — capped at its end, not run
    // up to now. Reported so the screen can say the figure may be short.
    openCapped: figure.openCapped,
    /* Stretches that touched this day and were worth nothing: outside the
       studio's hours, inside the lunch blackout, or on a day it was shut. Told
       apart from "nothing recorded" because the two need different answers. */
    outside: figure.outside,
    future: figure.future,
  });
});

/* GET /api/timesheets/history?userId=&date= — the audit trail for a day. */
router.get('/history', requirePermission('timesheet.own'), async (req, res) => {
  const userId = req.query.userId || req.user.id;
  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });
  const date = sheets.toISO(req.query.date || new Date().toISOString().slice(0, 10));
  try {
    const { rows } = await db.query(
      `SELECT action, actor_email AS actorEmail, detail, created_at AS at
         FROM timesheet_events WHERE user_id = $1 AND work_date = $2 ORDER BY seq`,
      [userId, date]
    );
    res.json({ date, events: rows });
  } catch (err) {
    if (!unavailable(err)) throw err;
    res.json({ date, events: [], unavailable: true });
  }
});

/* --- exports ---------------------------------------------------------------

   The spreadsheet and the document, built from the same rows the screen shows.
   Gated on reading rather than on a permission of their own: the studio's
   Reports exports work the same way — being able to download a report is being
   able to read it, in another shape. Scope is the same mayRead as everywhere
   else in this file, so an export can never reach further than the tab can.
*/
async function exportRows(req) {
  const userId = req.query.userId || req.user.id;
  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return { ok: false };

  const from = sheets.toISO(req.query.from) || sheets.weekStart(new Date().toISOString().slice(0, 10));
  const to = sheets.toISO(req.query.to) || from;

  /* THROUGH selectEntries, not a query of its own.
   *
   * It built the SELECT by hand, which is how the Option column shipped empty
   * the first time: the columns added since the table was created live in
   * ENTRY_EXTRAS, and a second copy of the SELECT does not have them. One
   * reader, so a column added later reaches the export and the screen
   * together. */
  const rows = await selectEntries(
    `WHERE e.user_id = $1 AND e.entry_date BETWEEN $2 AND $3
      ORDER BY e.entry_date, e.created_at`,
    [userId, from, to]
  );
  const { rows: who } = await db.query('SELECT `name`, email FROM users WHERE id = $1', [userId]);
  /* Status per DAY now, not per week — an export of a fortnight can legitimately
     show some days approved and others still in draft, which the weekly shape
     could not express. */
  const { rows: dayRows } = await db.query(
    'SELECT work_date AS date, status FROM timesheet_days WHERE user_id = $1 AND work_date BETWEEN $2 AND $3',
    [userId, from, to]
  );
  const statusOf = new Map(dayRows.map((d) => [sheets.toISO(d.date), d.status]));

  /* Every category INCLUDING retired ones, because an export covers filed lines
     and a line filed against a category since deactivated must print its name
     rather than its key. */
  const nonProjectLabel = (key) => sheets.nonProjectLabel(key);
  return {
    ok: true,
    person: who[0] || { name: 'Unknown', email: '' },
    from,
    to,
    total: Math.round(rows.reduce((n, r) => n + Number(r.hours), 0) * 100) / 100,
    rows: rows.map((r) => ({
      Date: sheets.toISO(r.date),
      // The clock, as the studio reads it. IST for every reader, because these
      // are minutes past midnight rather than instants needing a timezone.

      Client: r.clientName || '',
      Project: r.projectName || '',
      Asset: r.assetCode ? `${r.assetCode} — ${r.assetName}` : '',
      Category: r.nonProject ? nonProjectLabel(r.nonProject) : '',
      /* THE SECOND DROPDOWN'S CHOICE, resolved to its label here as every other
         key in this file is — including a RETIRED option, because an export
         covers filed lines and a line must print the words it was filed
         against. One column rather than one per category: the heading differs
         per category ("Idle Remarks", "Training Type") and a spreadsheet gets
         one column, so it is named for what it holds. Blank on a project line
         and on a line filed before the dropdown existed. */
      Option: r.nonProjectSub ? sheets.subOptionLabel(r.nonProjectSub) : '',
      /* A LEAD'S OWN TIME, named in its own column rather than folded into
         Category — Category is the non-project list, and a TL Action line IS
         project work. Anybody adding these up outside Forge needs to be able to
         take them out of an asset's hours, and a column they can filter on is
         how. From the one label function, like the screen. */
      'TL Action': tlReview.labelFor(r.tlAction) || '',
      Hours: Number(r.hours),
      Notes: r.notes || '',
      Status: statusOf.get(sheets.toISO(r.date)) || 'draft',
    })),
  };
}

/* Start and End are gone from both exports, because a line no longer has them.
 *
 * Not kept as empty columns for the sake of the older rows that still hold a
 * span: two blank columns on every sheet from here on, to carry a detail from
 * before the change, would make every export worse to read for ever. The span
 * is still on those rows and still in each day's own history — this is the
 * summary, and its shape follows what a line is now. */
const EXPORT_HEADERS = ['Date', 'Client', 'Project', 'Asset', 'Category', 'Option',
  'TL Action', 'Hours', 'Notes', 'Status'];

router.get('/export.xlsx', requirePermission('timesheet.own'), async (req, res) => {
  const data = await exportRows(req);
  if (!data.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  const book = xlsx.utils.book_new();
  const head = [
    [branding.current().appName],
    ['Time sheet'],
    [],
    ['Person', `${data.person.name} <${data.person.email}>`],
    ['From', data.from],
    ['To', data.to],
    ['Total hours', data.total],
    ['Times shown in', workSchedule.timesheetWindow().timezone],
    [],
  ];
  const sheet = xlsx.utils.aoa_to_sheet(head);
  xlsx.utils.sheet_add_json(sheet, data.rows, { header: EXPORT_HEADERS, origin: -1 });
  xlsx.utils.book_append_sheet(book, sheet, 'Time sheet');

  const buffer = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, 'timesheet', 'xlsx')}"`);
  res.send(buffer);
});

router.get('/export.pdf', requirePermission('timesheet.own'), async (req, res) => {
  const data = await exportRows(req);
  if (!data.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  const logo = await branding.readLogo(db).catch(() => null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, 'timesheet', 'pdf')}"`);
  reportPdf.write(res, {
    appName: branding.current().appName,
    tagline: branding.current().tagline,
    logo,
    view: { label: 'Time sheet', sheet: 'Time sheet' },
    title: 'Time sheet',
    blurb: `Every line logged in this range, in ${workSchedule.timesheetWindow().timezone}. `
      + 'Hours exclude the lunch break. Status is the state of the day the line belongs to.',
    footer: 'time sheet',
    emptyMessage: 'No time was logged in this range.',
    headers: EXPORT_HEADERS,
    /* The row objects, not a positional mapping of them. report-pdf reads each
       cell by header name, so mapping to arrays here produced a document with
       the right totals and forty blank rows under them. */
    rows: data.rows,
    filters: [
      ['Person', `${data.person.name} <${data.person.email}>`],
      ['From', data.from],
      ['To', data.to],
    ],
    summary: [['Total hours', String(data.total)], ['Lines', String(data.rows.length)]],
    excluded: [],
  });
});

module.exports = router;
module.exports.readableUserIds = readableUserIds;
module.exports.mayRead = mayRead;
