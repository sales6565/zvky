const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const adminDashboard = require('../admin-dashboard');
const teamCapacity = require('../team-capacity');
const followUp = require('../follow-up');
const reminders = require('../reminders');
const waitingWork = require('../waiting-work');
const timesheetGate = require('../timesheet-gate');
const dayStatus = require('../day-status');
const leaveSettings = require('../leave-settings');
const permissions = require('../permissions');
const { roleDef } = require('../roles');
const { holds } = require('../permissions');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// The studio in one screen.
//
// READ-ONLY, and there is exactly one verb here to keep it that way. Every row
// the screen draws is a link into the tab that already owns that work; nothing
// is edited, approved or reassigned from the overview. A dashboard that can
// change things is a second place the studio's rules have to be enforced, and
// this one deliberately is not.
router.use(authenticate);
router.use(requirePermission('report.admin_dashboard'));

/* GET /api/admin-dashboard
 *
 * One payload rather than one endpoint per panel — see the note on build() in
 * src/admin-dashboard.js for why the panels have to be drawn from a single
 * moment.
 *
 * What it returns is SCOPED by the caller's own projectScope, not by this
 * permission. Holding the permission opens the tab; it does not widen anybody's
 * reach. An Admin (projectScope 'owned') sees the projects they created, a
 * Super Admin sees the studio, and neither is shown a figure they could not
 * click through to.
 */
router.get('/', async (req, res) => {
  const data = await adminDashboard.build(db, req.user);

  /* TEAM CAPACITY IS GATED TWICE, and the second gate is the one that matters.
   *
   * The block shows exactly what report.idle already gates: standard working
   * hours against hours actually tracked, aggregated. A studio that withheld
   * the Idle Report from a designation and then granted them this dashboard
   * would have handed over the same numbers by another door.
   *
   * So the key is ABSENT from the payload rather than present and empty. An
   * empty capacity block tells somebody the studio has no capacity, which is a
   * different untruth from telling them nothing; and a zeroed one would still
   * disclose the headcount. The browser hides the panel on the key's absence.
   */
  const capacity = holds(req.user, 'report.idle')
    ? await teamCapacity.build(req.user, {
      buildIdleReport: require('./idle').buildIdleReport,
    })
    : null;

  /* PEOPLE TO FOLLOW UP, on the same terms as capacity above: the key is ABSENT
   * without report.follow_up rather than present and empty.
   *
   * Here for the default date — Today — so the section paints with the rest of
   * the screen rather than after it; every other date the reader picks goes to
   * GET /follow-up below. One builder either way, so the first draw and every
   * later one cannot disagree.
   *
   * An empty object would tell somebody without the permission that nobody in
   * the studio is behind, which is a different untruth from telling them
   * nothing, and a zeroed overlap count would still disclose the headcount. */
  const follow = holds(req.user, 'report.follow_up')
    ? await followUp.build(db, req.user, {})
    : null;

  res.json({
    ...data,
    ...(capacity ? { capacity } : {}),
    ...(follow ? { followUp: follow } : {}),
    /* Said back, so the screen can be honest about whose numbers these are.
       "12 active" means something different to an Admin than to a Super Admin,
       and a panel that does not say which is inviting a misreading. */
    viewer: { name: req.user.name, role: req.user.role },
  });
});

/* GET /api/admin-dashboard/follow-up?date=YYYY-MM-DD
 *            …/follow-up?from=YYYY-MM-DD&to=YYYY-MM-DD
 *            …&all=1
 *
 * The section on its own, for every date after the first draw.
 *
 * ITS OWN PERMISSION ON TOP OF THE SCREEN'S. router.use() above already demands
 * report.admin_dashboard, and this adds report.follow_up — so the endpoint and
 * the payload key are gated by the same two checks, and neither is the page's
 * own `can()`. Those three have diverged in this application before, which is
 * why tests/follow-up.test.js asserts all of them.
 *
 * VALIDATION IS THE BUILDER'S, not this handler's: a date control is a
 * convenience and a URL is not, so the rules the picker draws — a real calendar
 * day, nothing in the future, a range no wider than the cap — are checked in
 * src/follow-up.js where the section's other definitions live, and answered
 * here with the status it chose.
 */
router.get('/follow-up', requirePermission('report.follow_up'), async (req, res) => {
  const data = await followUp.build(db, req.user, { query: req.query });
  if (data.ok === false) return res.status(data.status || 400).json({ error: data.error });
  return res.json(data);
});

/* GET /api/admin-dashboard/follow-up/waiting/:userId?all=1
 *
 * WHAT IS WAITING ON ONE PERSON, grouped Client -> Project -> assets. The list
 * behind the "N waiting on them" button on a follow-up row.
 *
 * THE SECTION'S OWN KEY AND NOTHING MORE. report.follow_up, the same key that
 * draws the lists — the panel is the figure the row already prints, expanded.
 * Giving it a key of its own would mean a studio could grant the number and
 * withhold the names, which is a distinction nobody asked for and which the
 * number already breaks (four waiting is four names to anybody with the Users
 * tab). router.use() above adds report.admin_dashboard, as for every other
 * endpoint on this screen.
 *
 * THE SAME SCOPING, ASKED OF THE SAME FUNCTION. permissions.visibleProjects()
 * decides which projects, and src/follow-up.js's own inScope() decides whether
 * this is even a person the viewer may ask about — because without that check
 * the endpoint is a probe: a narrower viewer could name any user id and be told
 * whether that person has work, which is the disclosure the section's scope rule
 * exists to prevent.
 *
 * TODAY ONLY. The figure is clickable only where it is the "waiting now" one;
 * see nowFigure in src/follow-up.js for why a past date cannot answer this.
 */
router.get('/follow-up/waiting/:userId', requirePermission('report.follow_up'), async (req, res) => {
  const userId = String(req.params.userId || '');
  if (!userId) return res.status(400).json({ error: 'Which person?' });

  let projects;
  try {
    projects = await permissions.visibleProjects(req.user);
  } catch (err) {
    return res.status(503).json({ error: `The project list could not be read (${err.code || 'error'}).` });
  }
  const projectIds = projects.map((p) => p.id);
  const def = roleDef(req.user.role) || {};
  const studioWide = def.projectScope === 'all';

  if (!studioWide) {
    if (!projectIds.length) {
      return res.status(403).json({ error: 'You have no projects in view, so there is nothing to open.' });
    }
    const reach = await followUp.inScope(db, { projectIds, studioWide });
    if (reach && !reach.has(userId)) {
      /* NOT 404, AND THE WORDING DISCLOSES NOTHING. Whether that id is a person
         at all, and whether they hold any work, are both things this answer must
         not reveal to somebody outside their reach. */
      return res.status(403).json({ error: 'That person is not in the projects you can see.' });
    }
  }

  const today = timesheetGate.istDate(Date.now());
  const panel = await waitingWork.panelFor(db, userId, {
    projectIds,
    studioWide,
    today,
    all: req.query.all === '1' || req.query.all === 'true',
  });

  /* IS ANY OF THEIR WORK OUTSIDE THIS VIEWER'S REACH?
   *
   * A BOOLEAN AND NOT A NUMBER, deliberately. The brief asked for a note
   * "without revealing details", and a count is a detail: "4 more elsewhere"
   * tells an Admin how busy somebody is on projects they are not on, which is
   * most of what the scope rule withholds. The note says that there is some, so
   * the reader knows the panel is a view and not the whole truth, and stops
   * there.
   *
   * One query, and only for a viewer who is narrowed at all — a studio-wide
   * viewer has nothing outside their reach by definition. It returns a count
   * and is reduced to a boolean before it leaves this handler. */
  let elsewhere = false;
  if (!studioWide) {
    const whole = await waitingWork.countsFor(db, [userId], { studioWide: true });
    elsewhere = (whole.get(userId) || 0) > panel.count;
  }

  /* LEAVE DOES NOT PAUSE THE WAITING CLOCK, and the panel says so rather than
   * quietly hiding the fact.
   *
   * The time an asset has been waiting is a fact about the ASSET — how long the
   * studio has not moved it — and a reviewer's or an artist's absence does not
   * make the client's wait shorter. Subtracting leave from it would be this
   * application deciding that a deadline moves because somebody took a morning
   * off. So the figures are untouched and the panel is annotated: "(on leave)"
   * beside the name, so a reader knows why nothing is moving. */
  const mark = await dayStatus.userDayStatus(db, userId, today).catch(() => null);

  return res.json({
    ...panel,
    onLeave: mark && mark.kind === dayStatus.KINDS.leave
      ? { label: dayStatus.describe(mark), inWindow: !dayStatus.expectedToWorkFromRow(mark, Date.now()) }
      : null,
    userId,
    elsewhere,
    studioWide,
    /* The sentence that says what "waiting" means, from the module that decides
       it — the panel prints it as its help line. */
    explainer: waitingWork.EXPLAINER,
  });
});

/* ===========================================================================
 * THE TWO REMINDER ENDPOINTS.
 *
 * TWO PERMISSIONS, BOTH REQUIRED. report.follow_up opens the lists and
 * report.remind sends from them, and the second is useless without the first —
 * there is nothing to send from. They are separate keys because seeing who is
 * behind and messaging those people are two different powers; see the catalogue
 * entry in src/permission-catalog.js.
 *
 * THE ONE PLACE THE ADMIN DASHBOARD IS NOT READ-ONLY, which the header above
 * says it deliberately is. The exception is stated rather than quietly made:
 * these two endpoints change nothing about the studio's work — no asset moves,
 * no status changes, no figure is edited. They send a message and record that
 * they did. The rule the header is defending is "a dashboard that can change
 * things is a second place the studio's rules have to be enforced", and that
 * still holds: everything either endpoint decides is decided by
 * src/reminders.js and src/follow-up.js, which are the same two modules the
 * list itself is drawn from.
 *
 * EVERY REFUSAL IS THE BUILDER'S OWN DECISION, re-run against live tables a
 * moment before the send. Nothing the browser posts is trusted except which
 * person and which kind.
 */

/* Which HTTP status a refusal is.
 *
 * 409 for every refusal that is about the STATE of the studio — they have
 * started, the day is a holiday, the cap is spent — because the request was
 * well-formed and would have worked a moment earlier or will work a moment
 * later. That is the same reading src/routes/assets.js gives a stage that has
 * moved under somebody. 403 for scope, which is not going to change by waiting.
 */
const STATUS_FOR = {
  unknown_kind: 400,
  no_person: 404,
  out_of_scope: 403,
  self: 409,
  manual_off: 409,
  not_working_day: 409,
  blackout: 409,
  clock_shut: 409,
  start_not_today: 409,
  already_started: 409,
  already_filled: 409,
  backdate_closed: 409,
  capped: 409,
  nothing_sent: 502,
  no_table: 500,
};
const statusFor = (code) => STATUS_FOR[code] || 409;

/* The lists, rebuilt from live tables, with the names of the people who have
   since cleared — see withCleared in src/follow-up.js. */
async function freshLists(user, date) {
  return followUp.build(db, user, {
    /* EVERY ROW, NOT THE SCREEN'S FIRST TWENTY-FIVE. The row cap is a drawing
       decision; somebody at number thirty is still on the list, and a lookup
       that could not find them would refuse a legitimate reminder with the one
       message that must never be wrong — "not in the projects you can see". */
    query: { ...(date ? { date } : {}), all: '1' },
    fresh: true,
    withCleared: true,
  });
}

/* ONE PERSON ON ONE LIST, AS THE SERVER SEES THEM NOW.
 *
 * Returns the decorated row when they are still on it, and otherwise the reason
 * they are not — distinguishing "cleared since" (a name this viewer is already
 * entitled to) from "not yours" (a name they are not, so the refusal does not
 * carry one). */
function locate(payload, { kind, userId }) {
  const list = kind === reminders.KINDS.start ? payload.notStarted : payload.notFilled;
  const row = (list.rows || []).find((r) => r.id === userId);
  if (row) return { row };

  /* THE GRACE PERIOD EMPTIES LIST 1 WITHOUT CLEARING ANYBODY, which is the one
     case where "not on the list" means neither of the two below. A list drawn at
     09:31 is the whole studio, so src/follow-up.js holds it back for the first
     hour — and somebody asking at 09:45 deserves that sentence rather than being
     told they are out of scope. No button is drawn during the hour, so only a
     hand-made request arrives here; it is answered honestly all the same. */
  if (kind === reminders.KINDS.start && payload.grace && payload.grace.holds) {
    return {
      code: reminders.CODES.clock_shut,
      message: payload.grace.clockShut
        ? 'The studio’s clock is not open today, so there is nothing to have started yet.'
        : `Nobody is listed until the studio has been open ${payload.grace.minutes} minutes — `
          + 'before that, "has not started" only means "has not arrived yet".',
    };
  }

  const cleared = ((payload.cleared || {})[kind] || []).find((p) => p.id === userId);
  if (cleared) {
    return {
      code: kind === reminders.KINDS.start ? reminders.CODES.already_started
        : reminders.CODES.already_filled,
      message: kind === reminders.KINDS.start
        ? `${cleared.name} has started work since this list loaded.`
        : `${cleared.name} has filled their timesheet since this list loaded.`,
    };
  }
  return {
    code: reminders.CODES.out_of_scope,
    message: 'That person is not on this list — they are not in the projects you can see, or they '
      + 'were never expected on that day. Reload the section.',
  };
}

/* POST /api/admin-dashboard/follow-up/remind
 *   { userId, kind: 'start' | 'timesheet', date? }
 *
 * `date` is the date the section was showing, not a date the sender chooses: the
 * day a reminder is ABOUT is worked out by src/follow-up.js from the list the
 * person is on, which is the only way the two can agree.
 */
router.post('/follow-up/remind',
  requirePermission('report.follow_up'),
  requirePermission('report.remind'),
  async (req, res) => {
    const { userId, kind, date } = req.body || {};
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'Which person?' });
    }
    if (kind !== reminders.KINDS.start && kind !== reminders.KINDS.timesheet) {
      return res.status(400).json({ error: 'That is not a kind of reminder this section sends.' });
    }

    const payload = await freshLists(req.user, date);
    if (payload.ok === false) return res.status(payload.status || 400).json({ error: payload.error });
    if (payload.unavailable) return res.status(409).json({ error: payload.unavailable });

    const found = locate(payload, { kind, userId });
    if (!found.row) {
      return res.status(statusFor(found.code)).json({ error: found.message, code: found.code });
    }

    /* THE DECISION IS THE ROW'S OWN, not a second one taken here. It was made by
       reminders.decide() inside the draw — the same call that decided whether to
       draw the button — so the endpoint and the screen cannot disagree about
       what is allowed. */
    const { remind } = found.row;
    if (!remind.may) {
      return res.status(statusFor(remind.code)).json({ error: remind.reason, code: remind.code });
    }

    const result = await reminders.deliver(db, {
      person: { id: found.row.id, name: found.row.name },
      actor: req.user,
      kind,
      subjectDate: remind.subjectDate,
      waiting: found.row.held,
      slot: remind.sent,
      origin: originOf(req),
    });
    if (!result.ok) {
      return res.status(statusFor(result.code)).json({ error: result.message, code: result.code });
    }

    req.activity({
      module: 'users',
      action: `reminder.${kind}`,
      entityType: 'user',
      entityId: found.row.id,
      entityLabel: found.row.name,
      summary: `Reminded ${found.row.name} — ${kind === reminders.KINDS.start
        ? 'has not started work today' : `timesheet for ${remind.subjectDate} not filled`}`
        + ` (${result.channels.join(' and ') || 'nothing sent'})`,
    });

    /* THE ROW AS IT NOW IS, so the page can update in place without refetching
       the section — and so that what it draws is the server's state rather than
       an optimistic guess the next refresh would contradict. */
    const after = await freshLists(req.user, date);
    const again = locate(after, { kind, userId });
    return res.json({
      ok: true,
      sentence: result.sentence,
      channels: result.channels,
      emailReason: result.emailReason,
      row: again.row || null,
    });
  });

/* ---------------------------------------------------------------------------
 * LEAVE AND IDLE.
 *
 * POST /api/admin-dashboard/follow-up/day-status   { userId, date, kind, portion, note }
 * POST /api/admin-dashboard/follow-up/day-status/clear  { userId, date }
 *
 * TWO ENDPOINTS AND NOT ONE, because they are not the same action: marking is
 * gated on the feature switch and on the kind's own permission, and UNDOING IS
 * ALWAYS ALLOWED to somebody who holds the permission — including when the
 * feature has since been switched off. A mark that could be made and not undone
 * is a mark that is stuck, which is the one outcome the brief rules out by
 * name.
 *
 * THE SCOPE RULE IS THE SECTION'S OWN. followUp.inScope() is what decides who
 * this viewer may see, and marking somebody is a thing done to a person, so it
 * is the same question the list already answers — asked of the same function,
 * never restated here.
 */
const DAY_STATUS_PERMISSION = {
  leave: 'followup.mark_leave',
  idle: 'followup.mark_idle',
};

/* WHO THIS VIEWER MAY ACT ON, answered once per request.
 *
 * Returns null when the viewer is studio-wide (everybody), and otherwise the
 * set of ids they can reach. The refusal that follows discloses nothing: whether
 * that id is a person at all is not a thing this answer may reveal. */
async function reachable(req) {
  const projects = await permissions.visibleProjects(req.user);
  const projectIds = projects.map((p) => p.id);
  const def = roleDef(req.user.role) || {};
  if (def.projectScope === 'all') return { ok: true, ids: null };
  if (!projectIds.length) {
    return { ok: false, status: 403, error: 'You have no projects in view, so there is nobody to mark.' };
  }
  const reach = await followUp.inScope(db, { projectIds, studioWide: false });
  return { ok: true, ids: reach };
}

/* GET .../day-status/preview?userId&date&kind&portion
 *
 * WHAT MARKING THIS WOULD COST, asked before the question is put so the
 * confirmation can say it. The number comes from the same arithmetic that will
 * do the removing — src/day-status.js's recordedInside() walks the sessions
 * with the same working-time intersection countedMs() uses — so the figure
 * shown and the figure lost cannot differ.
 *
 * READ-ONLY, and gated on the marking permission rather than on report.remind:
 * "how many hours has this person recorded this afternoon" is not something to
 * hand to somebody who may not act on it.
 */
router.get('/follow-up/day-status/preview',
  requirePermission('report.follow_up'),
  async (req, res) => {
    const userId = String(req.query.userId || '');
    const kind = String(req.query.kind || '');
    const portion = String(req.query.portion || '') || null;
    const today = timesheetGate.istDate(Date.now());
    const day = String(req.query.date || today);
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Which person, and which date?' });
    const key = DAY_STATUS_PERMISSION[kind];
    if (!key || !permissions.holds(req.user, key)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    const reach = await reachable(req);
    if (!reach.ok) return res.status(reach.status).json({ error: reach.error });
    if (reach.ids && !reach.ids.has(userId)) {
      return res.status(403).json({ error: 'That person is not in the projects you can see.' });
    }

    /* IDLE REMOVES NOTHING, so there is nothing to preview for it beyond what
       the button already knows. Said rather than computed, so the answer cannot
       drift into implying otherwise. */
    if (kind === dayStatus.KINDS.idle) {
      return res.json({ seconds: 0, recordedLabel: null, warning: null });
    }
    const inside = await dayStatus.recordedInside(db, { userId, date: day, portion })
      .catch(() => ({ seconds: 0, sessions: 0 }));
    return res.json({
      seconds: inside.seconds,
      sessions: inside.sessions,
      recordedLabel: inside.seconds > 0 ? dayStatus.durationLabel(inside.seconds) : null,
      /* A past date is excluded at READ time: nothing is rewritten in place
         beyond the derived seconds column, and the note says so because the
         figures somebody is looking at are about to move. */
      warning: day < today
        ? 'This is a past date. Figures that have already been reported on will change.'
        : null,
    });
  });

router.post('/follow-up/day-status',
  requirePermission('report.follow_up'),
  async (req, res) => {
    const { userId, date, kind, portion, note } = req.body || {};
    if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Which person?' });
    if (kind !== dayStatus.KINDS.leave && kind !== dayStatus.KINDS.idle) {
      return res.status(400).json({ error: 'That is not something this section records.' });
    }

    /* THE PERMISSION FOR THE KIND, checked here rather than as middleware
       because which key is needed depends on the body. requirePermission is
       still what answers it — holds() reads the same resolved list — so this is
       the same gate and not a weaker one beside it. */
    const key = DAY_STATUS_PERMISSION[kind];
    if (!permissions.holds(req.user, key)) {
      return res.status(403).json({ error: 'You do not have permission to do that.', code: 'forbidden' });
    }

    /* THE FEATURE SWITCH, ON THE SERVER. The page hides the buttons when it is
       off; this is what makes that a rule rather than a decoration. */
    if (!leaveSettings.leaveIdleEnabled()) {
      return res.status(409).json({
        error: 'Leave & Idle is switched off in Settings → Leave.',
        code: 'feature_disabled',
      });
    }

    const today = timesheetGate.istDate(Date.now());
    const day = String(date || today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Which date?' });
    if (day > today) return res.status(400).json({ error: 'That date has not happened yet.' });

    /* A PAST DATE IS ITS OWN PERMISSION. Marking last Tuesday changes a figure
       somebody may already have acted on, which is a different act from marking
       today and is gated separately. */
    if (day < today && !permissions.holds(req.user, 'followup.mark_past_dates')) {
      return res.status(403).json({
        error: 'You can only mark today. Marking a past date needs a further permission.',
        code: 'past_date',
      });
    }

    /* ONLY A SUPER ADMIN MAY MARK THEMSELVES. Everybody else's own leave is
       somebody else's to record — which is the ordinary separation between
       asking for leave and granting it. */
    /* "Super Admin" IS A TIER AND NOT A PERMISSION, so this one check is the one
       place in this feature that asks the tier — hasFullAccess() is the same
       predicate every other "this account administers the studio" rule in
       src/permissions.js uses. Everything else here is a catalogue key, which
       is why this is called out rather than left to look like an oversight:
       marking your own day is not a power a studio delegates, it is the absence
       of a separation, and the tier that can grant itself every key anyway is
       the only one for whom that separation would be theatre. */
    if (userId === req.user.id && !permissions.hasFullAccess(req.user)) {
      return res.status(403).json({
        error: 'You cannot mark your own day. Ask somebody who can.',
        code: 'self',
      });
    }

    const reach = await reachable(req);
    if (!reach.ok) return res.status(reach.status).json({ error: reach.error });
    if (reach.ids && !reach.ids.has(userId)) {
      return res.status(403).json({ error: 'That person is not in the projects you can see.' });
    }

    const { rows: people } = await db.query(
      'SELECT id, `name`, is_active AS isActive FROM users WHERE id = $1', [userId]
    );
    const person = people[0];
    if (!person) return res.status(404).json({ error: 'That person is no longer on the books.' });
    if (!Number(person.isActive)) {
      return res.status(409).json({ error: `${person.name} is not an active account.` });
    }

    /* A DAY THE STUDIO IS ALREADY SHUT FOR. Leave on a Sunday is a mark with no
       effect that would read on the strip as something somebody decided — and
       the holiday calendar from Prompt 22 is where that is already recorded. */
    const policy = require('../timesheet-settings').current() || {};
    const isWorking = timesheetGate.isWorkingDay(day, {
      loggableDays: policy.loggableDays,
      isHoliday: (d) => Boolean(require('../holidays').on(d)),
    });
    if (!isWorking) {
      return res.status(409).json({
        error: `${day} is already a non-working day — a weekly off or a holiday.`,
        code: 'non_working_day',
      });
    }

    if (kind === dayStatus.KINDS.idle) {
      if (day !== today) {
        return res.status(409).json({
          error: 'Idle can only be marked for today.', code: 'idle_not_today',
        });
      }
      /* THE SERVER RE-CHECKS WHAT THE BUTTON ASSERTED. The page disables Idle
         when somebody has work; this is what makes it true, and it is asked of
         the shared status list rather than of a number the browser sent. */
      const n = await dayStatus.actionableCount(db, userId);
      if (n > 0) {
        return res.status(409).json({
          error: `${person.name} has ${n} asset${n === 1 ? '' : 's'} assigned, so there is `
            + 'something for them to do.',
          code: 'has_assets',
        });
      }
    } else if (!dayStatus.PORTIONS[portion]) {
      return res.status(400).json({ error: 'Which part of the day — first half, second half or full day?' });
    }

    const marked = await dayStatus.mark(db, {
      userId, date: day, kind, portion: kind === dayStatus.KINDS.leave ? portion : null,
      note: note || null, setBy: req.user.id,
    });
    if (!marked.ok) {
      const status = marked.code === 'race' ? 409 : 400;
      return res.status(status).json({
        error: marked.code === 'race'
          ? 'Somebody marked that person a moment ago. Refresh to see what was recorded.'
          : 'That could not be recorded.',
        code: marked.code,
      });
    }

    let stopped = [];
    if (!marked.unchanged) {
      /* THE TIMERS, AND THE CACHED FIGURES, both brought up to date before this
         request returns — so the person who clicked sees the truth rather than
         the state a sweep will reach a minute later. The sweep still runs, for
         the windows that open later in the day. */
      stopped = await dayStatus.sweepLeave(db).catch(() => []);
      await dayStatus.recount(db, { userId, date: day }).catch(() => {});

      /* THE PERSON IS TOLD, through the existing mechanism. No email in this
         prompt — the brief says so, and an attendance mark leaving the building
         through a shared mailbox is the decision reminder-settings already
         declined to make by default. */
      await require('../notifications').raise(db, {
        recipientId: userId,
        actorId: req.user.id,
        kind: require('../notifications').KINDS.day_status,
        detail: `You were marked ${dayStatus.describe(marked.row).toLowerCase()} for ${day} `
          + `by ${req.user.name}.`,
      }).catch(() => {});

      req.activity({
        module: 'users',
        action: `day_status.${kind}`,
        entityType: 'user',
        entityId: userId,
        entityLabel: person.name,
        summary: `Marked ${person.name} — ${dayStatus.describe(marked.row)} — for ${day}`,
        changes: marked.replaced
          ? `${dayStatus.describe(marked.replaced)} → ${dayStatus.describe(marked.row)}`
          : null,
      });
    }

    /* WHAT IS STILL ON THEIR DESK, offered after a FULL DAY recorded for TODAY
     * and in no other case.
     *
     * NOT FOR A HALF-DAY, because they are back this afternoon and handing
     * their work to somebody else for the morning would be the wrong answer to
     * a question nobody asked. NOT FOR A PAST DATE, because the day is over.
     *
     * THE LIST ONLY. The handover itself goes through /assets/:id/reassign and
     * /assets/:id/reassign-options — the existing flow, with its own
     * permissions, its own exclusivity rule and its own history sentence — so
     * nothing here decides who may receive work. */
    const offerReassign = kind === dayStatus.KINDS.leave
      && portion === dayStatus.PORTIONS.full && day === today && !marked.unchanged;

    const after = await freshLists(req.user, day);
    return res.json({
      ok: true,
      unchanged: Boolean(marked.unchanged),
      status: marked.row,
      label: dayStatus.describe(marked.row),
      stoppedTimers: stopped.filter((t) => t.userId === userId).length,
      reassign: offerReassign
        ? { name: person.name, assets: await dayStatus.actionableAssets(db, userId) }
        : null,
      leave: after.leave || null,
      notStarted: after.notStarted,
      notFilled: after.notFilled,
      overlap: after.overlap,
      expected: after.expected,
    });
  });

/* UNDO. Never gated on the feature switch — see the note above the pair. */
router.post('/follow-up/day-status/clear',
  requirePermission('report.follow_up'),
  async (req, res) => {
    const { userId, date } = req.body || {};
    if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Which person?' });
    const today = timesheetGate.istDate(Date.now());
    const day = String(date || today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Which date?' });

    const existing = await dayStatus.userDayStatus(db, userId, day);
    if (!existing) return res.status(404).json({ error: 'There is no mark on that day to undo.' });

    const key = DAY_STATUS_PERMISSION[existing.kind];
    if (!permissions.holds(req.user, key)) {
      return res.status(403).json({ error: 'You do not have permission to do that.', code: 'forbidden' });
    }
    if (day < today && !permissions.holds(req.user, 'followup.mark_past_dates')) {
      return res.status(403).json({
        error: 'Undoing a past date needs a further permission.', code: 'past_date',
      });
    }

    const reach = await reachable(req);
    if (!reach.ok) return res.status(reach.status).json({ error: reach.error });
    if (reach.ids && !reach.ids.has(userId)) {
      return res.status(403).json({ error: 'That person is not in the projects you can see.' });
    }

    await dayStatus.clear(db, { userId, date: day, clearedBy: req.user.id, reason: 'undone' });
    /* THE FIGURES COME BACK EXACTLY AS THEY WERE, and they come back because
       they are derived again rather than remembered — see recount(). */
    await dayStatus.recount(db, { userId, date: day }).catch(() => {});

    const { rows: people } = await db.query('SELECT `name` FROM users WHERE id = $1', [userId]);
    const name = (people[0] && people[0].name) || 'that person';
    await require('../notifications').raise(db, {
      recipientId: userId,
      actorId: req.user.id,
      kind: require('../notifications').KINDS.day_status,
      detail: `The ${existing.kind === dayStatus.KINDS.idle ? 'idle mark' : 'leave'} recorded `
        + `for you on ${day} was undone by ${req.user.name}.`,
    }).catch(() => {});

    req.activity({
      module: 'users',
      action: `day_status.clear.${existing.kind}`,
      entityType: 'user',
      entityId: userId,
      entityLabel: name,
      summary: `Undid ${name}'s ${dayStatus.describe(existing)} for ${day}`,
    });

    const after = await freshLists(req.user, day);
    return res.json({
      ok: true,
      cleared: existing,
      leave: after.leave || null,
      notStarted: after.notStarted,
      notFilled: after.notFilled,
      overlap: after.overlap,
      expected: after.expected,
    });
  });

/* POST /api/admin-dashboard/follow-up/remind-all
 *   { kind, date? }
 *
 * ONE DRAW FOR THE WHOLE BATCH, then one decision and one send per person. A
 * FAILURE NEVER STOPS THE OTHERS — each person is caught on their own and
 * appears in the result either way, which is the whole difference between a
 * bulk action and a loop.
 */
router.post('/follow-up/remind-all',
  requirePermission('report.follow_up'),
  requirePermission('report.remind'),
  async (req, res) => {
    const { kind, date } = req.body || {};
    if (kind !== reminders.KINDS.start && kind !== reminders.KINDS.timesheet) {
      return res.status(400).json({ error: 'That is not a kind of reminder this section sends.' });
    }

    /* EVERY ROW, NOT THE CAPPED PAGE OF THEM. "Remind all" means the list, and
       a list showing twenty-five of forty would otherwise nudge twenty-five. */
    const payload = await followUp.build(db, req.user, {
      query: { ...(date ? { date } : {}), all: '1' },
      fresh: true,
      withCleared: true,
    });
    if (payload.ok === false) return res.status(payload.status || 400).json({ error: payload.error });
    if (payload.unavailable) return res.status(409).json({ error: payload.unavailable });

    const list = kind === reminders.KINDS.start ? payload.notStarted : payload.notFilled;
    const sent = [];
    const skipped = [];

    for (const row of list.rows || []) {
      const { remind } = row;
      if (!remind.may) {
        skipped.push({ id: row.id, name: row.name, code: remind.code, reason: remind.reason });
        continue;
      }
      try {
        const result = await reminders.deliver(db, {
          person: { id: row.id, name: row.name },
          actor: req.user,
          kind,
          subjectDate: remind.subjectDate,
          waiting: row.held,
          slot: remind.sent,
          origin: originOf(req),
        });
        if (result.ok) sent.push({ id: row.id, name: row.name, channels: result.channels });
        else skipped.push({ id: row.id, name: row.name, code: result.code, reason: result.message });
      } catch (err) {
        /* CAUGHT PER PERSON. One unreachable mail queue or one deleted account
           must not decide the fate of the other thirty-nine. */
        skipped.push({
          id: row.id,
          name: row.name,
          code: 'error',
          reason: `That one could not be sent (${err.code || 'error'}).`,
        });
      }
    }

    req.activity({
      module: 'users',
      action: `reminder.${kind}.bulk`,
      entityType: 'setting',
      entityId: 'follow_up',
      entityLabel: 'People to follow up',
      summary: `Reminded ${sent.length} ${sent.length === 1 ? 'person' : 'people'} `
        + `(${kind === reminders.KINDS.start ? 'not started' : 'timesheet not filled'})`
        + `${skipped.length ? `, skipped ${skipped.length}` : ''}`,
    });

    const after = await freshLists(req.user, date);
    return res.json({
      ok: true,
      sent,
      skipped,
      section: after,
    });
  });

/* WHERE THIS APPLICATION LIVES, as the browser just reached it.
 *
 * There is no configured public URL in this deployment — see
 * src/mobile-dist.js, which derives its own the same way — so the link in a
 * reminder email is the origin the request arrived on. A proxy header is
 * honoured because this app runs behind one, and a value with anything odd in
 * it is dropped rather than pasted into an email. */
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^https?$/.test(proto) || !/^[A-Za-z0-9.:-]+$/.test(host)) return null;
  return `${proto}://${host}`;
}

module.exports = router;
