/* VACATIONS: /api/leave.
 *
 * ===========================================================================
 * FIVE ENDPOINTS AND FIVE PERMISSIONS, none of them a role tier.
 *
 *   GET  /mine          leave.request     my own vacations, and the rules
 *   POST /mine          leave.request     book one, from tomorrow
 *   POST /:id/cancel    leave.request     cancel mine, or end it early
 *                       leave.manage_all  …or anybody's, including today
 *   POST /:id/decide    leave.approve     approve or reject a submitted one
 *   GET  /team          leave.view_team   who is away, scoped
 *
 * requirePermission on every one, can() on the page, and visibleProjects() for
 * anything that names somebody else. Nothing here asks whether the caller is a
 * Super Admin except the one place that has to — booking on somebody else's
 * behalf — and that asks leave.manage_all, which is a key.
 */
const express = require('express');

const db = require('../db');
const permissions = require('../permissions');
const { authenticate, requirePermission } = require('../middleware/auth');
const vacation = require('../vacation');
const leaveSettings = require('../leave-settings');
const dayStatus = require('../day-status');
const timesheetGate = require('../timesheet-gate');
const notifications = require('../notifications');
const emailNotifications = require('../email-notifications');
const followUp = require('../follow-up');
const { roleDef } = require('../roles');

const router = express.Router();

/* EVERY ROUTE HERE IS SIGNED IN. Without this line requirePermission reads an
   undefined req.user and refuses everything with a 403 — which is a safe
   failure and an invisible one, and it is how the first run of
   tests/onsight-vacation.test.js found this file. */
router.use(authenticate);

/* ---------------------------------------------------------------------------
 * WHO THIS VIEWER MAY NAME, answered once and the same way People to follow up
 * answers it.
 *
 * NOT A SECOND SCOPE RULE. visibleProjects() decides which projects, and
 * src/follow-up.js's inScope() turns those into people — the pair that already
 * draws the two follow-up lists. Writing a third version of "the people in the
 * projects I can see" is precisely the drift this codebase keeps finding, and a
 * vacation screen that disagreed with the dashboard about whose name may appear
 * would be a scope leak dressed as a convenience.
 *
 * `ids` is null for a studio-wide account, meaning everybody — the same
 * convention reachable() uses in src/routes/admin-dashboard.js. Studio-wide is
 * read from the designation's projectScope, which is what that concept IS here;
 * it is not the Super Admin tier, and a studio that gives another designation
 * studio-wide scope has told this function too.
 */
async function reachable(user) {
  const projects = await permissions.visibleProjects(user);
  const projectIds = projects.map((p) => p.id);
  const studioWide = (roleDef(user.role) || {}).projectScope === 'all';
  if (studioWide) return { ids: null, studioWide: true, projects: projectIds.length };
  if (!projectIds.length) return { ids: new Set(), studioWide: false, projects: 0 };
  const ids = await followUp.inScope(db, { projectIds, studioWide: false }).catch(() => new Set());
  return { ids, studioWide: false, projects: projectIds.length };
}

/* ---------------------------------------------------------------------------
 * WHO HEARS ABOUT SOMEBODY'S VACATION.
 *
 * THE BRIEF SAYS "via the existing lead resolution" AND THERE IS NOT ONE. I
 * went looking: src/user-project.js maps a person to their project, and
 * src/permissions.js maps a person to the projects they can SEE, but nothing in
 * this application answers "who leads this person" — the three places that
 * needed something like it (the hold rule, the submission mail, the TL feedback
 * screen) each answer a narrower question of their own. So this is the minimal
 * version, built here rather than invented in four places later.
 *
 * IT IS THE PROJECT'S LEADERSHIP, not a reporting line, because that is the
 * only relationship this schema holds. And it is asked of
 * permissions.projectLeadIds(), which OWNS that union — the team leads, the
 * acting team leads, the coordinators and the supervisors of a project.
 *
 * ASKED RATHER THAN RETYPED, and a frozen run is why: the first version of this
 * function joined the acting-team-lead membership table itself, and
 * tests/acting-team-leads.test.js refused it — that table has an allowlist of
 * readers precisely so it does not acquire a fifth the way its three older
 * siblings did. The allowlist was right and this function was wrong. (The name
 * is deliberately not spelled here either: the allowlist is enforced by a
 * substring scan over src/, so a comment that named it would trip the same
 * check for no reason.)
 *
 * DE-DUPLICATED BY ID, since one person is commonly two of those things on two
 * projects, and nobody should be told twice.
 */
async function leadsFor(userId) {
  /* WHICH PROJECTS THIS PERSON IS ON. The membership tables src/user-project.js
     names, which is where "this person belongs to this project" lives. */
  const { rows: mine } = await db.query(
    `SELECT project_id AS projectId FROM project_members WHERE user_id = $1
     UNION SELECT project_id FROM project_team_leads WHERE user_id = $1
     UNION SELECT project_id FROM project_coordinators WHERE user_id = $1`,
    [userId]
  ).catch(() => ({ rows: [] }));
  if (!mine.length) return [];

  const ids = new Set();
  for (const row of mine) {
    for (const leadId of await permissions.projectLeadIds(row.projectId)) {
      if (leadId !== userId) ids.add(leadId);
    }
  }
  if (!ids.size) return [];
  const { rows } = await db.query(
    'SELECT id, `name`, email FROM users WHERE id IN ($1) AND is_active = 1 ORDER BY `name`',
    [[...ids]]
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email }));
}

/* WHO MAY APPROVE, for the approval-mode recipients.
   src/role-permissions.js's usersWithPermission() already answers exactly this
   — every active account whose designation resolves to the key, groups and
   grants included — so a studio that hands leave.approve to its production
   manager has told this function too, with nothing here reading a role list. */
async function approvers() {
  const rolePermissions = require('../role-permissions');
  const rows = await rolePermissions.usersWithPermission(db, 'leave.approve').catch(() => []);
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email }));
}

/* THE ANNOUNCEMENT, in-app always and by email only when the switch is on.
 *
 * A FAILURE NEVER FAILS THE REQUEST: both halves are caught here, and the
 * caller gets a count rather than an exception. The brief asks for that in as
 * many words and src/email-notifications.js already works that way; this is the
 * in-app half held to the same promise. */
/* ---------------------------------------------------------------------------
 * A VACATION THAT COVERS THIS MOMENT PUTS THE PERSON'S TIMERS DOWN, NOW.
 *
 * THE SAME MECHANISM AS LEAVE, not a second one: this calls
 * dayStatus.sweepLeave — the function the minute sweep calls — scoped to one
 * user and given the moment of booking as the stop time. So the close reason is
 * REASONS.on_leave exactly as before, resumeOverdue() still ignores it (nothing
 * auto-resumes), a session started yesterday is still handled, and the figures
 * are still produced by close(). There is nothing here that could drift from
 * what the sweep does, because it IS what the sweep does.
 *
 * WHY IT IS NEEDED AT ALL, when the sweep runs every minute: because the sweep
 * would close the timer at the window's START, which for a vacation beginning
 * today is midnight — throwing away the hours somebody genuinely worked this
 * morning before deciding to take the day. Passing `at` keeps that time and
 * cuts only what follows the booking.
 *
 * ONLY WHEN THE DAYS ARE REAL. A booking awaiting approval has materialised no
 * leave rows, so sweepLeave finds no window and stops nothing — which is the
 * correct behaviour rather than a special case, and a test asserts it by
 * calling this on a pending request.
 *
 * AND ONLY WHEN THE STUDIO ASKS. The switch is read inside liveWindowsNow, so
 * it is read in one place for both the sweep and this.
 */
async function stopTimersForVacation(req, { userId, at = Date.now() }) {
  const stopped = await dayStatus.sweepLeave(db, { now: Date.now(), at, userId })
    .catch(() => []);
  for (const row of stopped) {
    /* THE SAME NOTIFICATION THE SWEEP RAISES, with no actor for the same
       reason: the booking did this, and raise() drops a recipient who is also
       the actor — which would be this very person. */
    await notifications.raise(db, {
      recipientId: row.userId,
      actorId: null,
      kind: notifications.KINDS.work_paused,
      assetId: row.assetId,
    }).catch(() => {});
  }
  if (stopped.length) {
    req.activity({
      module: 'users',
      action: 'vacation.timers_stopped',
      entityType: 'user',
      entityId: userId,
      entityLabel: stopped[0].code || 'asset',
      summary: `Vacation started — stopped ${stopped.length} running timer(s): `
        + stopped.map((r) => r.code || r.assetId).join(', '),
    });
  }
  return stopped;
}

async function announce(req, { person, request, action, recipients }) {
  const sentence = {
    submitted: `${person.name} booked a vacation — ${request.label}.`,
    pending: `${person.name} asked for a vacation — ${request.label}. It needs approving.`,
    cancelled: `${person.name} cancelled their vacation — ${request.label}.`,
    ended_early: `${person.name} ended their vacation early — ${request.label}.`,
  }[action] || `${person.name}’s vacation changed — ${request.label}.`;

  const seen = new Set();
  let raised = 0;
  for (const to of recipients) {
    if (!to || !to.id || seen.has(to.id)) continue;
    seen.add(to.id);
    /* raise() refuses recipientId === actorId on its own, so the person who
       pressed the button cannot be told about their own press even if they are
       on the list — which they are, whenever a lead books their own vacation. */
    const id = await notifications.raise(db, {
      recipientId: to.id,
      actorId: req.user.id,
      kind: notifications.KINDS.vacation,
      otherUserId: person.id,
      detail: sentence,
    }).catch(() => null);
    if (id) raised += 1;
  }

  let mailed = { queued: 0, reason: 'switch_off' };
  if (leaveSettings.vacationEmailEnabled()) {
    mailed = await emailNotifications.vacationSubmitted(db, {
      recipients, actor: req.user, person, request, action,
      origin: req.headers.origin || null,
    }).catch(() => ({ queued: 0, reason: 'error' }));
  }
  return { raised, mailed };
}

const rules = () => ({
  enabled: leaveSettings.vacationEnabled(),
  leaveEnabled: leaveSettings.leaveIdleEnabled(),
  approvalRequired: leaveSettings.vacationApprovalRequired(),
  minNoticeDays: leaveSettings.minNoticeDays(),
  maxRangeDays: leaveSettings.maxRangeDays(),
  earliest: vacation.addDays(timesheetGate.istDate(), leaveSettings.minNoticeDays()),
  today: timesheetGate.istDate(),
  firstHalfEnd: leaveSettings.clock(leaveSettings.split().firstHalfEndMinutes),
  secondHalfStart: leaveSettings.clock(leaveSettings.split().secondHalfStartMinutes),
});

/* ---------------------------------------------------------------------------
 * MINE.
 *
 * READABLE WHATEVER THE SWITCH SAYS. A vacation already booked keeps its
 * effect when Vacation mode is switched off — the same rule Settings → Leave
 * already follows for marked leave — and a booking nobody can see is a booking
 * nobody can cancel. So the list and its Cancel buttons survive the switch; only
 * the submit endpoint refuses.
 */
router.get('/mine', requirePermission('leave.request'), async (req, res) => {
  const today = timesheetGate.istDate();
  return res.json({
    rules: rules(),
    vacations: await vacation.listFor(db, req.user.id, { today }),
  });
});

router.post('/mine', requirePermission('leave.request'), async (req, res) => {
  /* THE SWITCH, ON THE SERVER. The profile hides the form when it is off; this
     is what makes that a rule rather than a decoration. */
  if (!leaveSettings.vacationEnabled()) {
    return res.status(409).json({
      error: leaveSettings.leaveIdleEnabled()
        ? 'Vacation mode is switched off in Settings → Leave.'
        : 'Leave, Idle & Onsight is switched off in Settings → Leave, so vacations are too.',
      code: 'feature_disabled',
    });
  }

  /* ON SOMEBODY ELSE'S BEHALF needs leave.manage_all, and only then may the
     dates reach today or backwards. Everything else is the caller's own. */
  const target = typeof req.body.userId === 'string' && req.body.userId && req.body.userId !== req.user.id
    ? req.body.userId : req.user.id;
  const forSelf = target === req.user.id;
  if (!forSelf && !permissions.holds(req.user, 'leave.manage_all')) {
    return res.status(403).json({ error: 'You can only book your own vacation.', code: 'not_yours' });
  }
  if (!forSelf) {
    const reach = await reachable(req.user);
    if (reach.ids && !reach.ids.has(target)) {
      return res.status(403).json({ error: 'That person is not in the projects you can see.' });
    }
  }

  const made = await vacation.submit(db, {
    userId: target,
    input: req.body || {},
    actor: req.user,
    forSelf,
  });
  if (!made.ok) {
    return res.status(made.status).json({
      error: made.error || (made.errors && made.errors[0] && made.errors[0].message) || 'That could not be booked.',
      code: made.code,
      errors: made.errors || null,
      overlap: made.overlap || null,
    });
  }

  const { rows: who } = await db.query('SELECT id, `name` FROM users WHERE id = $1', [target]);
  const person = who[0] || { id: target, name: 'Somebody' };
  const recipients = [...await leadsFor(target), ...(made.approvalNeeded ? await approvers() : [])];
  const sent = await announce(req, {
    person, request: made.request,
    action: made.approvalNeeded ? 'pending' : 'submitted',
    recipients,
  });

  req.activity({
    module: 'users',
    action: made.approvalNeeded ? 'vacation.submitted' : 'vacation.booked',
    entityType: 'user',
    entityId: target,
    entityLabel: person.name,
    summary: `${person.name} — ${made.request.label}${made.approvalNeeded ? ' (awaiting approval)' : ''}`,
  });

  /* THE TIMERS, IN THIS REQUEST. Only once the days exist — a booking awaiting
     approval has none — and stopTimersForVacation finds nothing to stop for a
     vacation that starts tomorrow, so this is one query on the ordinary path. */
  const stopped = made.approvalNeeded
    ? [] : await stopTimersForVacation(req, { userId: target });

  return res.status(201).json({ ...made, notified: sent, stoppedTimers: stopped });
});

/* ---------------------------------------------------------------------------
 * CHANGING THE DATES OF YOUR OWN BOOKING. PATCH /leave/:id
 *
 * ALWAYS ALLOWED FOR THE OWNER, which is the brief's instruction, and that is
 * why the permission here is leave.request and not leave.approve: editing your
 * own holiday is the same act as booking it. Somebody else's needs
 * leave.manage_all, exactly as booking on their behalf does.
 *
 * APPROVAL IS NOT RE-ASKED, and that is a decision worth recording. An edit to
 * a LIVE vacation leaves it live; an edit to one still awaiting approval leaves
 * it waiting. The alternative — sending an approved vacation back to pending
 * because its owner moved the end date by a day — would clear the days under
 * somebody who is already away, and a person mid-holiday is the worst possible
 * moment to make their time off provisional again. A studio that wants the
 * change reviewed has the audit entry and the notification below.
 */
router.patch('/:id', requirePermission('leave.request'), async (req, res) => {
  if (!leaveSettings.vacationEnabled()) {
    return res.status(409).json({
      error: 'Vacation mode is switched off in Settings → Leave.',
      code: 'feature_disabled',
    });
  }
  const today = timesheetGate.istDate();
  const existing = await vacation.byId(db, req.params.id, { today });
  if (!existing) return res.status(404).json({ error: 'That vacation is not there.' });

  const forSelf = existing.userId === req.user.id;
  if (!forSelf && !permissions.holds(req.user, 'leave.manage_all')) {
    return res.status(403).json({ error: 'You can only change your own vacation.', code: 'not_yours' });
  }
  if (!forSelf) {
    const reach = await reachable(req.user);
    if (reach.ids && !reach.ids.has(existing.userId)) {
      return res.status(403).json({ error: 'That person is not in the projects you can see.' });
    }
  }

  const done = await vacation.edit(db, {
    requestId: existing.id, input: req.body || {}, actor: req.user, today, forSelf,
  });
  if (!done.ok) {
    return res.status(done.status).json({
      error: done.error || (done.errors && done.errors[0] && done.errors[0].message)
        || 'That could not be changed.',
      code: done.code,
      errors: done.errors || null,
      overlap: done.overlap || null,
    });
  }

  req.activity({
    module: 'users',
    action: 'vacation.edited',
    entityType: 'user',
    entityId: existing.userId,
    entityLabel: existing.personName,
    summary: `${existing.personName} — ${existing.label} — changed to ${done.request.label}`
      + `${done.cleared.length ? `; ${done.cleared.length} day(s) released` : ''}`
      + `${done.added.length ? `; ${done.added.length} day(s) added` : ''}`,
  });

  /* THE LEADS ARE TOLD, as they were when it was booked: a date somebody was
     planning around has moved. The owner is not told about their own edit —
     raise() drops a recipient who is also the actor. */
  await Promise.all((await leadsFor(existing.userId)).map((id) => notifications.raise(db, {
    recipientId: id,
    actorId: req.user.id,
    kind: notifications.KINDS.vacation,
    detail: `${existing.personName} changed a vacation — now ${done.request.label}`,
  }).catch(() => {})));

  /* AND IF THE NEW RANGE NOW COVERS THIS MOMENT, the timers go down — the same
     call the booking makes, for the case where somebody extends a vacation
     backwards onto today or brings tomorrow's forward. */
  const stopped = await stopTimersForVacation(req, { userId: existing.userId });

  return res.json({ ...done, stoppedTimers: stopped });
});

router.post('/:id/cancel', requirePermission('leave.request'), async (req, res) => {
  const today = timesheetGate.istDate();
  const request = await vacation.byId(db, req.params.id, { today });
  if (!request) return res.status(404).json({ error: 'That vacation is not there.' });

  const mine = request.userId === req.user.id;
  const mayAll = permissions.holds(req.user, 'leave.manage_all');
  if (!mine && !mayAll) {
    return res.status(403).json({ error: 'You can only cancel your own vacation.', code: 'not_yours' });
  }

  /* REACHING INTO TODAY OR THE PAST IS leave.manage_all's, including on your
     own vacation. Ending early cuts from TOMORROW: today's exclusion may
     already be in a figure somebody has read, and a person un-excusing their
     own morning after the fact is the separation that key exists for. */
  const asked = typeof req.body.fromDate === 'string' ? req.body.fromDate : null;
  if (asked && asked <= today && !mayAll) {
    return res.status(403).json({
      error: 'Ending a vacation clears tomorrow onward. Today and days that have passed need a '
        + 'further permission.',
      code: 'past_date',
    });
  }

  const done = await vacation.cancel(db, {
    requestId: request.id, actor: req.user, today,
    fromDate: asked, mayManageAll: mayAll,
  });
  if (!done.ok) return res.status(done.status).json({ error: 'That could not be changed.', code: done.code });

  const { rows: who } = await db.query('SELECT id, `name` FROM users WHERE id = $1', [request.userId]);
  const person = who[0] || { id: request.userId, name: 'Somebody' };
  const sent = await announce(req, {
    person, request: done.request,
    action: done.status === vacation.STATUS.cancelled ? 'cancelled' : 'ended_early',
    recipients: await leadsFor(request.userId),
  });

  req.activity({
    module: 'users',
    action: done.status === vacation.STATUS.cancelled ? 'vacation.cancelled' : 'vacation.ended_early',
    entityType: 'user',
    entityId: request.userId,
    entityLabel: person.name,
    summary: `${person.name} — ${done.request.label}`,
    changes: done.cleared.length ? `cleared ${done.cleared.join(', ')}` : 'nothing left to clear',
  });

  /* AND WHAT WAS TAKEN OFF THE TIMESHEET, which is never the past. Its own
     entry for the same reason the filling has one: it is rows removed from
     somebody's record, and the log should say which and leave no doubt about
     the days it did not touch. */
  const unfilled = (done.unfilled && done.unfilled.removed) || [];
  if (unfilled.length) {
    req.activity({
      module: 'users',
      action: 'vacation.timesheet_cleared',
      entityType: 'user',
      entityId: request.userId,
      entityLabel: person.name,
      summary: `${person.name} — ${unfilled.length} filled-in leave day(s) removed`,
      changes: {
        request: request.id,
        removed: unfilled.join(', '),
        reopened: ((done.unfilled && done.unfilled.reopened) || []).join(', ') || 'none',
        note: 'days already past are left exactly as recorded',
      },
    });
  }

  return res.json({ ...done, notified: sent });
});

/* ---------------------------------------------------------------------------
 * THE APPROVER'S QUEUE. GET /api/leave/pending
 *
 * THE GAP THIS FILLS, found in the survey: with approval switched on, a pending
 * vacation was surfaced ONLY by the notification raised when it was submitted.
 * There was no list anywhere. A notification that is missed, or read on a phone
 * at the weekend, left a booking waiting with nobody able to find it again, and
 * the person who booked it believing it was in. The decide route has existed
 * since Prompt 55; what was missing was any way to know what to decide.
 *
 * ITS OWN KEY, NOT THE DASHBOARD'S, and that is a deliberate difference from
 * the other lists on that screen. The Admin Dashboard guards everything behind
 * report.admin_dashboard, so mounting this there would mean a studio that gives
 * a producer leave.approve — the authority to decide these — hands them a
 * button that returns nothing unless they are also given the whole dashboard.
 * The authority to approve is the right gate for the queue of things to
 * approve. The dashboard DRAWS this list; it does not own it.
 *
 * SCOPED LIKE EVERY OTHER READ, by reachable() — the same visibleProjects()
 * union the booking route uses to decide whose vacation you may book. A lead
 * sees their own people's requests; a studio-wide account sees the studio's.
 * The `ids: null` case is studio-wide and the empty-Set case is "nobody", which
 * vacation.pending() keeps distinct from each other.
 */
router.get('/pending', requirePermission('leave.approve'), async (req, res) => {
  const today = timesheetGate.istDate();
  const reach = await reachable(req.user);
  const list = await vacation.pending(db, {
    scopeIds: reach.ids ? [...reach.ids] : null,
    today,
  });
  return res.json({
    today,
    /* SAID OUT LOUD so the screen can tell "nothing is waiting" from "approval
       is switched off, so nothing ever will be". */
    approvalRequired: leaveSettings.vacationApprovalRequired(),
    vacationEnabled: leaveSettings.vacationEnabled(),
    studioWide: reach.studioWide,
    requests: list,
  });
});

router.post('/:id/decide', requirePermission('leave.approve'), async (req, res) => {
  const today = timesheetGate.istDate();
  const approve = req.body.approve === true || req.body.approve === 'true';
  const existing = await vacation.byId(db, req.params.id, { today });
  if (!existing) return res.status(404).json({ error: 'That vacation is not there.' });

  const done = await vacation.decide(db, {
    requestId: existing.id, approve, actor: req.user, note: req.body.note || null, today,
  });
  if (!done.ok) {
    return res.status(done.status).json({
      error: done.error || (done.code === 'already_decided' ? 'That has already been decided.' : 'That could not be decided.'),
      code: done.code,
      overlap: done.overlap || null,
    });
  }

  /* THE DECISION GOES BACK TO THE PERSON, and to nobody else: the leads were
     told when it was submitted. */
  await notifications.raise(db, {
    recipientId: existing.userId,
    actorId: req.user.id,
    kind: notifications.KINDS.vacation,
    detail: `Your vacation — ${done.request.label} — was ${approve ? 'approved' : 'not approved'}`
      + `${req.body.note ? `: ${String(req.body.note).slice(0, 200)}` : '.'}`,
  }).catch(() => {});
  let mailed = { queued: false, reason: 'switch_off' };
  if (leaveSettings.vacationEmailEnabled()) {
    mailed = await emailNotifications.vacationDecided(db, {
      recipientId: existing.userId, actor: req.user, request: done.request,
      approved: approve, note: req.body.note || null, origin: req.headers.origin || null,
    }).catch(() => ({ queued: false, reason: 'error' }));
  }

  req.activity({
    module: 'users',
    action: approve ? 'vacation.approved' : 'vacation.rejected',
    entityType: 'user',
    entityId: existing.userId,
    entityLabel: existing.personName,
    summary: `${existing.personName} — ${done.request.label} — ${approve ? 'approved' : 'rejected'}`,
  });

  /* THE TIMESHEET LINES, AS THEIR OWN ENTRY (Prompt 67 Part C).
   *
   * A SEPARATE LINE IN THE LOG rather than a field on the approval, because it
   * is a separate act with a separate outcome: the approval is a decision, and
   * this is a set of rows written on somebody's timesheet and a set of days
   * submitted in their name. Somebody asking "why is my Monday submitted and
   * who did it" is looking for this, and would not find it inside an entry
   * titled "approved".
   *
   * THE SKIPPED DAYS ARE NAMED WITH THEIR REASON, which the brief asks for and
   * which is the half that matters: a day left alone because the person had
   * already filed something is the case where this feature deliberately does
   * nothing, and silence about it reads as a bug. */
  const filled = (done.filled && done.filled.created) || [];
  const skipped = (done.filled && done.filled.skipped) || [];
  if (filled.length || skipped.length) {
    req.activity({
      module: 'users',
      action: 'vacation.timesheet_filled',
      entityType: 'user',
      entityId: existing.userId,
      entityLabel: existing.personName,
      summary: `${existing.personName} — ${filled.length} leave day(s) filled in`
        + `${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      changes: {
        request: done.request.id,
        created: filled.join(', ') || 'none',
        skipped: skipped.map((x) => `${x.date} (${x.why})`).join('; ') || 'none',
      },
    });
  }

  /* APPROVING IS WHEN THE DAYS APPEAR, so it is also when the timers go down if
     the vacation already covers now — the approval may well come after the
     start date. A rejection materialises nothing and stops nothing. */
  const stopped = approve
    ? await stopTimersForVacation(req, { userId: existing.userId }) : [];

  return res.json({ ...done, mailed, stoppedTimers: stopped });
});

/* ---------------------------------------------------------------------------
 * WHO IS AWAY, for the Admin Dashboard and the assignee picker's chip.
 *
 * SCOPED BY visibleProjects() LIKE EVERY OTHER READ. A lead sees their own
 * people; a studio-wide account sees the studio. The window defaults to the
 * next fortnight, which is the horizon the dashboard plans over.
 */
router.get('/team', requirePermission('leave.view_team'), async (req, res) => {
  const today = timesheetGate.istDate();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))
    ? req.query.to : vacation.addDays(from, 14);

  const reach = await reachable(req.user);
  let ids = reach.ids ? [...reach.ids] : null;
  if (ids === null) {
    const { rows } = await db.query('SELECT id FROM users WHERE is_active = 1').catch(() => ({ rows: [] }));
    ids = rows.map((r) => r.id);
  }
  const vacations = await vacation.inWindow(db, ids, from, to);

  /* HOW MUCH WORK IS SITTING WITH SOMEBODY WHO WILL BE AWAY, so the dashboard
     entry is clickable and a coordinator can reassign ahead of time. The count
     is dayStatus.actionableCount() — the same predicate the Idle button and the
     "waiting on them" figure use — so the three cannot disagree. */
  const withLoad = [];
  for (const v of vacations) {
    withLoad.push({ ...v, type: 'Vacation', actionable: await dayStatus.actionableCount(db, v.userId) });
  }

  return res.json({
    from, to, today, vacations: withLoad,
    scope: { projects: reach.projects, studioWide: reach.studioWide },
  });
});

module.exports = router;
