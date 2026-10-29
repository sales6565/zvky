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
 * only relationship this schema holds: the team leads, the acting team leads
 * and the production coordinators of the projects the person is a member of.
 * All three, because all three plan the work the person was going to do.
 *
 * DE-DUPLICATED BY ID, since one person is commonly two of those things on two
 * projects, and nobody should be told twice.
 */
async function leadsFor(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.id, u.\`name\`, u.email
       FROM (
         SELECT project_id FROM project_members     WHERE user_id = $1
         UNION SELECT project_id FROM project_team_leads  WHERE user_id = $1
         UNION SELECT project_id FROM project_coordinators WHERE user_id = $1
       ) mine
       JOIN (
         SELECT project_id, user_id FROM project_team_leads
         UNION SELECT project_id, user_id FROM project_acting_team_leads
         UNION SELECT project_id, user_id FROM project_coordinators
       ) lead ON lead.project_id = mine.project_id
       JOIN users u ON u.id = lead.user_id AND u.is_active = 1
      WHERE lead.user_id <> $1`,
    [userId]
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

  return res.status(201).json({ ...made, notified: sent });
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

  return res.json({ ...done, notified: sent });
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

  return res.json({ ...done, mailed });
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
