// The two things the studio gets email about.
//
// A SECOND CHANNEL, NOT A SECOND SYSTEM. The bell, the desktop notification and
// Pending Actions are untouched by this file and know nothing about it. Nothing
// here writes to the `notifications` table, and no new notification kind was
// added — a submission raises an email and only an email, so somebody who turns
// mail off sees exactly the application they saw before.
//
// WHERE EACH ONE IS RAISED FROM, and why they differ:
//
//   assigned    hung off notifications.raise(), which is the choke point every
//               path that changes who holds an asset already funnels through —
//               creating one with an assignee, editing the assignee, bulk
//               assigning, and the hand-over out of review. Four routes today,
//               one hook, and the fifth somebody adds next year is covered
//               without them remembering.
//
//   submitted   raised from the submit route directly, because there is no
//               existing choke point for it and inventing one would have meant
//               adding a notification kind — which would put a new row in
//               everybody's bell, and the bell was to be left alone.
//
// NOTHING HERE CAN FAIL A REQUEST. Every entry point swallows its own errors
// and returns; the send itself is queued and happens after the response has
// gone. An artist whose asset could not be assigned because a mail server was
// unreachable would be a much worse bug than a missing email.

const emailConfig = require('./email-config');
const mailer = require('./mailer');
const branding = require('./branding');

/* How long to wait for more assignments to the same person before sending.
 *
 * This is what turns "bulk assign 40 assets to Priya" into one email rather
 * than forty. The window is short because it is not really a delay — the
 * assignments in a bulk operation all happen inside one request, milliseconds
 * apart, so anything above a few hundred milliseconds catches the whole batch;
 * the rest of the window is only insurance against a slow loop.
 *
 * 0 sends immediately, which is what the tests use so they are not waiting on a
 * timer to make an assertion. */
const BATCH_MS = process.env.EMAIL_BATCH_MS === undefined ? 1500 : Number(process.env.EMAIL_BATCH_MS);

/* How long to wait before the one retry below. Long enough for a transaction to
   commit, short enough that nobody notices. */
const RETRY_MS = 250;

/* Pending assignment emails, keyed by recipient.
 *
 * In memory and per process, deliberately. A durable queue would be the right
 * answer for email that must not be lost; this is a courtesy notification whose
 * authoritative copy is already in the bell, and a table plus a worker to drain
 * it is a great deal of machinery to guarantee delivery of "you have been
 * assigned FX-014". A restart mid-window loses an email and nothing else. */
const pending = new Map();

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/* A due date as somebody reads it, not as MySQL stores it.
 *
 * Kept to the date alone: due_date is a DATE, and dressing it up with a time
 * would invent a precision the studio never entered. */
function readableDate(value) {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function readableDateTime(value) {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  return at.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function appName() {
  try { return branding.current().appName || 'ZVKY FORGE'; }
  catch { return 'ZVKY FORGE'; }
}

// --- who may be written to ---------------------------------------------------

/* One recipient, or null if they must not be mailed.
 *
 * The opt-out is enforced HERE, in the lookup, rather than at each call site.
 * A caller that forgets to check would send mail to somebody who asked not to
 * receive it, and there is no way to un-send that; a lookup that cannot return
 * an opted-out person makes the mistake unavailable.
 *
 * A missing email_opt_out column — a deployment mid-upgrade — is read as "not
 * opted out", which matches the column's own default. */
async function recipient(db, userId) {
  if (!userId) return null;
  try {
    const { rows } = await db.query(
      'SELECT id, `name`, email, email_opt_out AS optOut FROM users WHERE id = $1', [userId]);
    const row = rows[0];
    if (!row || !row.email) return null;
    if (row.optOut) return null;
    return { id: row.id, name: row.name || row.email, email: row.email };
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      const { rows } = await db.query('SELECT id, `name`, email FROM users WHERE id = $1', [userId]);
      const row = rows[0];
      return row && row.email ? { id: row.id, name: row.name || row.email, email: row.email } : null;
    }
    return null;
  }
}

/* The task, in the words an email needs. Null if it has gone. */
async function task(db, assetId) {
  const { rows } = await db.query(
    `SELECT a.id, a.\`code\`, a.\`name\`, a.due_date AS dueDate, a.\`status\`,
            p.\`name\` AS projectName, c.\`name\` AS clientName
       FROM assets a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN clients  c ON c.id = p.client_id
      WHERE a.id = $1`, [assetId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    code: row.code || '',
    name: row.name || '',
    dueDate: row.dueDate || null,
    projectName: row.projectName || '',
    clientName: row.clientName || '',
  };
}

const personName = async (db, id) => {
  if (!id) return null;
  try {
    const { rows } = await db.query('SELECT `name`, email FROM users WHERE id = $1', [id]);
    return rows[0] ? (rows[0].name || rows[0].email) : null;
  } catch { return null; }
};

/* A task's one-line title: "FX-014 — Dragon idle loop". */
const title = (t) => [t.code, t.name].filter(Boolean).join(' — ') || 'a task';

// --- the shell every message shares ------------------------------------------

/* Plain text and HTML, both, always.
 *
 * The text part is not a fallback nobody sees: it is what a phone notification
 * preview shows, what a screen reader reads, and what survives a client that
 * strips HTML. Writing it as an afterthought is how emails end up previewing as
 * "View this email in your browser".
 *
 * The HTML is inline-styled and table-free by choice. Every real email client
 * strips <style> blocks, so a stylesheet would render as nothing; and a layout
 * table for two paragraphs and a list is machinery this does not need. */
function shell({ heading, lead, rows, footer }) {
  const detail = rows.filter((r) => r.value);
  const text = [
    heading,
    '',
    lead,
    '',
    ...detail.map((r) => `${r.label}: ${r.value}`),
    '',
    footer,
  ].join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`
    + `font-size:15px;line-height:1.55;color:#1c1e21;max-width:560px;">`
    + `<p style="margin:0 0 4px;font-size:17px;font-weight:600;">${escapeHtml(heading)}</p>`
    + `<p style="margin:0 0 18px;">${escapeHtml(lead)}</p>`
    + `<table style="border-collapse:collapse;margin:0 0 18px;">`
    + detail.map((r) => `<tr>`
      + `<td style="padding:3px 16px 3px 0;color:#6b7280;vertical-align:top;white-space:nowrap;">${escapeHtml(r.label)}</td>`
      + `<td style="padding:3px 0;font-weight:500;">${escapeHtml(r.value)}</td></tr>`).join('')
    + `</table>`
    + `<p style="margin:0;color:#6b7280;font-size:12.5px;border-top:1px solid #e5e7eb;padding-top:12px;">`
    + `${escapeHtml(footer)}</p></div>`;

  return { text, html };
}

/* The same closing line on both messages.
 *
 * It names the opt-out, because an email nobody can turn off is one people
 * filter to spam — which loses the ones that mattered too. */
const footerLine = () =>
  `Sent by ${appName()}. To stop receiving these, open your Profile and switch off email notifications.`;

// --- 1. a task was assigned ---------------------------------------------------

function assignedMessage({ tasks, assignedBy }) {
  const by = assignedBy ? `${assignedBy} assigned` : 'You have been assigned';
  const many = tasks.length > 1;

  if (!many) {
    const t = tasks[0];
    return {
      subject: `Assigned to you: ${title(t)}`,
      ...shell({
        heading: 'A task has been assigned to you',
        lead: assignedBy ? `${assignedBy} assigned you ${title(t)}.` : `You have been assigned ${title(t)}.`,
        rows: [
          { label: 'Task', value: title(t) },
          { label: 'Project', value: [t.clientName, t.projectName].filter(Boolean).join(' · ') },
          { label: 'Due', value: readableDate(t.dueDate) },
          { label: 'Assigned by', value: assignedBy },
        ],
        footer: footerLine(),
      }),
    };
  }

  /* The digest. One bulk assign is one email, because forty separate ones for
     one action is the thing that makes people switch email off entirely. */
  const lines = tasks.map((t) => {
    const due = readableDate(t.dueDate);
    return `• ${title(t)}${due ? ` (due ${due})` : ''}`;
  });
  const text = [
    `${tasks.length} tasks have been assigned to you`,
    '',
    assignedBy ? `${assignedBy} assigned you ${tasks.length} tasks.` : `You have been assigned ${tasks.length} tasks.`,
    '',
    ...lines,
    '',
    footerLine(),
  ].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`
    + `font-size:15px;line-height:1.55;color:#1c1e21;max-width:560px;">`
    + `<p style="margin:0 0 4px;font-size:17px;font-weight:600;">${tasks.length} tasks have been assigned to you</p>`
    + `<p style="margin:0 0 14px;">${escapeHtml(by === 'You have been assigned'
      ? `You have been assigned ${tasks.length} tasks.` : `${assignedBy} assigned you ${tasks.length} tasks.`)}</p>`
    + `<ul style="margin:0 0 18px;padding-left:20px;">`
    + tasks.map((t) => {
      const due = readableDate(t.dueDate);
      return `<li style="margin-bottom:5px;">${escapeHtml(title(t))}`
        + (due ? ` <span style="color:#6b7280;">— due ${escapeHtml(due)}</span>` : '') + `</li>`;
    }).join('')
    + `</ul>`
    + `<p style="margin:0;color:#6b7280;font-size:12.5px;border-top:1px solid #e5e7eb;padding-top:12px;">`
    + `${escapeHtml(footerLine())}</p></div>`;

  return { subject: `${tasks.length} tasks assigned to you`, text, html };
}

/* Queue an assignment email, and flush after the window.
 *
 * Called from notifications.raise(). Returns immediately; the send happens on a
 * timer, off the request. */
function queueAssignment({ recipientId, actorId, assetId }) {
  if (!recipientId || recipientId === actorId || !assetId) return;
  if (!emailConfig.isUsable()) return;   // cheap: no DB work when email is off

  const key = recipientId;
  const entry = pending.get(key) || { recipientId, actorId, assetIds: [], timer: null, attempt: 0 };
  entry.actorId = entry.actorId || actorId;
  if (!entry.assetIds.includes(assetId)) entry.assetIds.push(assetId);
  pending.set(key, entry);

  if (BATCH_MS <= 0) { flushOne(key); return; }
  if (!entry.timer) {
    entry.timer = setTimeout(() => { flushOne(key); }, BATCH_MS);
    /* unref so a pending email cannot keep a process alive — it matters for the
       test runner, and for a worker being shut down for a deploy. */
    if (entry.timer.unref) entry.timer.unref();
  }
}

/* THE POOL, NOT THE CALLER'S CONNECTION.
 *
 * queueAssignment is called from inside the transaction that performs the
 * assignment, and this runs on a timer some time after that transaction has
 * committed — or rolled back. Holding its connection would mean querying a
 * connection that has been returned to the pool and handed to somebody else,
 * which is the kind of bug that shows up as one request seeing another's data.
 * The pool is asked for a fresh one here instead, and required lazily so this
 * module stays loadable without a database (the template tests do that). */
async function flushOne(key) {
  const db = require('./db');
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  if (entry.timer) clearTimeout(entry.timer);

  try {
    const to = await recipient(db, entry.recipientId);
    /* Said out loud, both of them.
     *
     * These are the two ways a queued email disappears without anything going
     * wrong, and a silent return makes "nobody is getting mail" impossible to
     * diagnose from the outside — the administrator sees a configured screen, a
     * green state and an empty inbox. Logged at info rather than warn for the
     * opt-out, which is somebody's choice working correctly. */
    if (!to) {
      console.log(`[email] no assignment notice for ${entry.recipientId}: no address, or opted out`);
      return;
    }
    const found = [];
    for (const id of entry.assetIds) {
      const t = await task(db, id);
      if (t) found.push(t);
    }
    if (!found.length) {
      /* THE COMMIT RACE, and the one place it can appear.
       *
       * queueAssignment is called from inside the transaction that writes the
       * assignment — and, when the asset is being CREATED, from inside the one
       * that writes the asset itself. This flush reads through the pool, on a
       * different connection, which cannot see either until that transaction
       * commits. Lose the race and the task "does not exist", so the email is
       * dropped for a row that is about to be perfectly real.
       *
       * The batching window normally hides this, which is worse than it
       * sounding: it means the failure depends on how long a transaction took,
       * so it would appear as email that works in testing and goes missing
       * under load. One retry, once, a moment later, removes the timing
       * dependence rather than widening the window and hoping.
       *
       * Bounded at one. If the task is still unreadable after that it has
       * genuinely gone — a rolled-back transaction, or an asset deleted in the
       * meantime — and in both cases NOT sending is the right answer. */
      if (entry.attempt === 0) {
        entry.attempt = 1;
        entry.timer = null;
        pending.set(key, entry);
        const retry = setTimeout(() => { flushOne(key); }, RETRY_MS);
        if (retry.unref) retry.unref();
        entry.timer = retry;
        return;
      }
      console.warn(`[email] dropped an assignment notice to ${to.email}: `
        + `none of ${entry.assetIds.length} task(s) could be read back`);
      return;
    }
    const assignedBy = await personName(db, entry.actorId);
    const message = assignedMessage({ tasks: found, assignedBy });
    await mailer.sendWithSavedConfig(db, { to: to.email, ...message });
  } catch (err) {
    console.warn(`[email] assignment notice to ${entry.recipientId} failed: ${err.message}`);
  }
}

/* Send anything still waiting. For the tests, and for a clean shutdown. */
async function flushAll() {
  for (const key of [...pending.keys()]) await flushOne(key);
}

// --- 2. a task was submitted --------------------------------------------------

function submittedMessage({ task: t, completedBy, at }) {
  return {
    subject: `Submitted: ${title(t)}`,
    ...shell({
      heading: 'A task has been submitted for review',
      lead: `${completedBy || 'Somebody'} has submitted ${title(t)}.`,
      rows: [
        { label: 'Task', value: title(t) },
        { label: 'Project', value: [t.clientName, t.projectName].filter(Boolean).join(' · ') },
        { label: 'Submitted by', value: completedBy },
        { label: 'Submitted', value: readableDateTime(at || new Date()) },
      ],
      footer: footerLine(),
    }),
  };
}

/* Who hears that a task is done.
 *
 * Whoever assigned it, and the submitter's team lead — the answer chosen for
 * this studio. Deduplicated, and the submitter is dropped from their own list:
 * a team lead who submits their own work does not need an email telling them
 * they did.
 *
 * assigned_by_id comes off the OPEN episode rather than the newest, because a
 * reassigned task belongs to whoever assigned it last, not to whoever started
 * the chain. It falls back to the asset's creator for rows written before
 * episodes existed. */
async function submissionRecipients(db, { assetId, actorId }) {
  const ids = new Set();
  try {
    const { rows } = await db.query(
      `SELECT ass.assigned_by_id AS assignedBy, a.created_by AS createdBy, u.team_lead_id AS teamLead
         FROM assets a
         LEFT JOIN asset_assignments ass
                ON ass.asset_id = a.id AND ass.ended_at IS NULL
         LEFT JOIN users u ON u.id = $2
        WHERE a.id = $1`, [assetId, actorId]);
    const row = rows[0];
    if (!row) return [];
    if (row.assignedBy) ids.add(row.assignedBy);
    else if (row.createdBy) ids.add(row.createdBy);
    if (row.teamLead) ids.add(row.teamLead);
  } catch (err) {
    /* A deployment without asset_assignments still tells the creator, which is
       worth more than telling nobody. */
    try {
      const { rows } = await db.query('SELECT created_by AS createdBy FROM assets WHERE id = $1', [assetId]);
      if (rows[0] && rows[0].createdBy) ids.add(rows[0].createdBy);
    } catch { return []; }
  }
  ids.delete(actorId);
  return [...ids];
}

/* Raise the completion email. Never throws, never awaited by the route. */
async function taskSubmitted(db, { assetId, actorId, at }) {
  try {
    if (!emailConfig.isUsable()) return;
    const t = await task(db, assetId);
    if (!t) return;
    const completedBy = await personName(db, actorId);
    const ids = await submissionRecipients(db, { assetId, actorId });
    for (const id of ids) {
      const to = await recipient(db, id);
      if (!to) continue;                    // no address, or opted out
      const message = submittedMessage({ task: t, completedBy, at });
      await mailer.sendWithSavedConfig(db, { to: to.email, ...message });
    }
  } catch (err) {
    console.warn(`[email] submission notice for ${assetId} failed: ${err.message}`);
  }
}

/* The message the Test button sends.
 *
 * Deliberately says what it proves and what it does not: a delivered test says
 * the server accepted the credentials and the route out is open, and says
 * nothing about whether the two real emails are switched on. */
function testMessage({ to, byName }) {
  const name = appName();
  return {
    to,
    subject: `${name}: test email`,
    ...shell({
      heading: 'Email is working',
      lead: `This is a test message from ${name}. If you are reading it, the mail server accepted the `
        + 'settings on that screen and this host can reach it.',
      rows: [
        { label: 'Sent', value: readableDateTime(new Date()) },
        { label: 'Requested by', value: byName },
      ],
      footer: 'Nothing else was sent. Task notifications go out only when the master switch on the '
        + 'Email Configuration screen is on.',
    }),
  };
}

module.exports = {
  queueAssignment, flushAll, taskSubmitted, testMessage,
  // exported for the tests, which assert on the rendered strings
  assignedMessage, submittedMessage, submissionRecipients, recipient, BATCH_MS,
};
