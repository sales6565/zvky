const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const adminDashboard = require('../admin-dashboard');
const teamCapacity = require('../team-capacity');
const followUp = require('../follow-up');
const reminders = require('../reminders');
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
