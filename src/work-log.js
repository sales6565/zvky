// When work started and when it was handed in.
//
// One row in work_sessions per stretch of work: opened when somebody clicks
// Accept and Start or Resume, closed when they submit for review, put the task
// on hold, or the asset moves to somebody else. `seconds` on the closed row is
// the elapsed wall-clock time between those two stamps.
//
// WHAT THIS USED TO BE, AND WHERE IT HAS ARRIVED. This was a running timer with
// Pause and Resume, and `seconds` meant active worked time — a round could hold
// several rows, one per unpaused stretch. The studio removed that: a round
// recorded two timestamps and nothing else, and Time Spent was the difference
// between them, lunch and evenings and weekends included.
//
// Hold reopens the middle ground, deliberately and with the cost understood.
// Time Spent is once again the SUM of a round's rows rather than the span of
// it, so declared holds are excluded — but nothing forces anybody to declare
// one. The number is therefore neither turnaround nor effort: it is elapsed
// time less whatever was actually put down on purpose, and its accuracy rests
// on people clicking the button, exactly as the Time Sheet's does. That is the
// studio's agreed definition, arrived at knowingly, not an oversight.
//
// The invariant everything here protects is unchanged: AT MOST ONE OPEN SESSION
// PER ASSET. start() refuses while one is open, which is what makes a
// double-click, a second tab, or two people racing each other harmless —
// whoever is second gets a clear 409, not a second start stamp.
//
// Note it is per ASSET, not per person. Nothing stops one person holding
// several assets open at once, and under wall-clock each of them counts the
// same hours. src/idle.js takes the union of the intervals rather than their
// sum for exactly that reason.

const { v4: uuid } = require('uuid');
const workingTime = require('./working-time');
const workSchedule = require('./work-schedule');

/* Why a session ended. Absent on every row written before this change, which is
 * what tells the reports where the meaning of `seconds` switches from active
 * time to elapsed time — see cutover() below. */
const REASONS = {
  submitted: 'submitted',     // handed in for review
  reassigned: 'reassigned',   // somebody else has it now
  unassigned: 'unassigned',   // taken off everybody
  moved: 'moved',             // the asset was put in a status nobody works in
  held: 'held',               // put down on purpose, to be picked up again
  off_hours: 'off_hours',     // the studio shut with this still running
};

/* The two reasons that are a PAUSE rather than a hand-in.
 *
 * 'held' is somebody putting the work down; 'off_hours' is the studio closing
 * around them. They differ in who decided and in what the screen says, and in
 * nothing else: both leave the round open, both free the one-active-task slot,
 * both are picked up again with Resume, and neither is a submission. So every
 * predicate that used to ask `= 'held'` asks this list instead, and the two
 * cannot drift apart — a new pause reason is one entry here rather than a grep
 * for the word 'held' across three files.
 */
const PAUSE_REASONS = [REASONS.held, REASONS.off_hours];
const PAUSED_SQL = `IN (${PAUSE_REASONS.map((r) => `'${r}'`).join(', ')})`;

/* When the studio is open, read fresh on every call.
 *
 * work-schedule keeps one row mirrored in memory, so this is a property read
 * rather than a query — but it is read at the moment it is needed rather than
 * captured once, because a Super Admin can change the window in Settings while
 * the server is up and a timer started before that change must be measured
 * against the window in force when it is closed, not when this module loaded.
 *
 * Before the schedule has been loaded — a very early request, or a deployment
 * whose work_schedule table could not be created — this hands back the
 * defaults, which are the studio's real answer: Monday to Friday, half past
 * nine to seven, with lunch. So the worst case is the right window rather than
 * no window, and no window would mean counting the weekend again.
 */
const schedule = () => workSchedule.trackingWindow();

/* HOLD, AND WHY IT NEEDS NO NEW TABLE.
 *
 * Hold closes the open session with reason 'held'; Resume opens a new one. So a
 * round is once again several rows whose `seconds` sum to the time actually
 * worked — which is the shape this table had under pause/resume and never lost.
 * Every reader already sums rather than subtracting stamps, so the held gap
 * falls out of Time Spent with no arithmetic added anywhere.
 *
 * Three consequences worth stating, because each is a decision:
 *
 *   THE ONE-ACTIVE-TASK SLOT IS FREED. openForUser() reads ended_at IS NULL,
 *   so a hold releases the person to start something else — which is the point
 *   of the feature — and Resume goes through the same check, or holding would
 *   be a way around the rule rather than a use of it.
 *
 *   THE ROUND SURVIVES. currentRound() counts submissions, and a hold submits
 *   nothing, so the resumed session lands back in the round it left. Nothing
 *   has to be carried across the gap.
 *
 *   HELD IS DERIVED, NOT STORED ON THE ASSET. There is no on_hold status and no
 *   column: an asset is held when the newest session belonging to whoever holds
 *   it now ended 'held'. Scoping to the current assignee is what makes a
 *   reassignment clear it for free — the new person has no rows yet, so they
 *   inherit somebody else's pause as a fresh start, which is right.
 */

/* The statuses in which somebody's stretch of work is legitimately still open.
 *
 * A session is opened by Accept and Start and closed by submitting, by a
 * handover, or by the asset being unassigned. Nothing else closed one, and
 * every OTHER way an asset's status can change — a lead moving a started asset
 * back to Assigned, a Super Admin forcing a stage — left the session open on an
 * asset that no longer looked like it was being worked on.
 *
 * That is not a cosmetic leak. The open session is what "one active task at a
 * time" reads, so the person is blocked on every other asset they hold; and
 * because the asset is back in Assigned they can neither submit it ("start the
 * work before submitting it") nor start it again ("work has already been
 * started on this asset"). Deadlocked, with nothing on screen to explain it.
 *
 * So the rule is stated once, here, and asked at every point that writes a
 * status: work stays open only while the asset is in a state its holder is
 * actually working in.
 */
const WORK_CONTINUES = ['in_progress', 'tl_changes_requested', 'cd_changes_requested'];
const worksIn = (status) => WORK_CONTINUES.includes(status);

/* Close whatever is open if this status change means the work is not.
 *
 * Deliberately a no-op when the status has not changed — the relay leaves an
 * asset in CD Feedbacks and hands the notes on, which is the middle of a round,
 * not the end of one — and when nothing was open, which is the ordinary case.
 */
async function closeIfWorkStopped(db, assetId, fromStatus, toStatus, reason = 'moved') {
  if (!toStatus || toStatus === fromStatus || worksIn(toStatus)) return { ok: true, wasOpen: false };
  return close(db, assetId, reason);
}

// Which spell of work this is: 1 until the first submission, 2 for the rework
// after the first change request, and so on. Derived from how many submissions
// exist at the moment the session opens, then stored on the row — so the
// breakdown survives later resubmissions.
async function currentRound(db, assetId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = $1',
    [assetId]
  );
  return Number(rows[0].n) + 1;
}

/* The one thing this person has started and not yet finished, anywhere.
 *
 * The studio's rule is one active task at a time, and this is what it is
 * checked against. Note what it is NOT checked against: the in_progress
 * status. A round returned through TL or CD Feedbacks is started with the same
 * Accept and Start button and worked on with the asset still sitting in
 * tl_changes_requested — the status never becomes in_progress for rework. A
 * rule written against the status would let somebody hold a rework round and a
 * fresh task at the same time, which is the case it most needs to catch.
 *
 * An open session is the honest signal: it opens on Accept and Start and closes
 * on submit, reassign or unassign, so it is exactly "started, not yet handed
 * on" whatever the asset's status happens to say.
 *
 * The asset's code and name come back with it so a refusal can name what to go
 * and finish. A block that cannot say what is blocking you is indistinguishable
 * from the application being broken.
 */
async function openForUser(db, userId, exceptAssetId = null) {
  const params = [userId];
  let sql = `SELECT s.id, s.asset_id AS assetId, s.started_at AS since,
                    a.\`code\`, a.\`name\`, a.status
               FROM work_sessions s
               JOIN assets a ON a.id = s.asset_id
              WHERE s.user_id = $1 AND s.ended_at IS NULL`;
  if (exceptAssetId) {
    params.push(exceptAssetId);
    sql += ' AND s.asset_id <> $2';
  }
  sql += ' ORDER BY s.started_at LIMIT 1';
  const { rows } = await db.query(sql, params).catch((err) => {
    if (!unavailable(err)) throw err;
    /* No table means no sessions to find, which means nobody is blocked. The
       right failure for a deployment that cannot record time is that this rule
       does not apply, rather than that nobody can start anything. */
    return { rows: [] };
  });
  return rows[0] || null;
}

/* HOW A STORED STAMP BECOMES AN INSTANT, WITHOUT TRUSTING ANY TIMEZONE.
 *
 * started_at is a DATETIME: a wall clock with no zone in it. Reading it as an
 * instant means knowing which zone the database wrote it in, and the driver
 * instead parses it in whatever zone the Node process happens to be in. On one
 * machine those agree; the studio asked for time that is right regardless.
 *
 * So no stamp is ever converted. Every query that needs one asks the database
 * how long ago it was — TIMESTAMPDIFF against its own NOW(), in its own clock,
 * a plain number of seconds — and the caller anchors that to Date.now(). The
 * only thing this assumes is that the two machines agree on what time it is
 * now, which is a far weaker assumption than agreeing on a timezone, and one
 * every other part of the application already makes.
 */
const AGE = (col = 'started_at') => `TIMESTAMPDIFF(SECOND, ${col}, NOW())`;
const instantFromAge = (ageSeconds, now) => now - (Number(ageSeconds) || 0) * 1000;

/* What a still-running session has accrued so far.
 *
 * THE FIGURE ON SCREEN HAS TO BE THE FIGURE THAT GETS STORED. A closed session
 * holds the working seconds close() worked out; an open one has no stored
 * figure at all, and the old expression — COALESCE(seconds, TIMESTAMPDIFF(…))
 * — filled that gap with the raw span. Leaving it would have meant a task
 * started at half past twelve reading two hours at half past two on the panel
 * and one hour the moment it was submitted, with nothing on screen to say why
 * an hour had gone. So the live figure is intersected with the window too, by
 * the same function, and the number does not move when the session closes.
 *
 * Takes the age from the database rather than a stamp, for the reason given
 * above AGE. Null — no open session in this group — is nothing to add.
 */
function liveSeconds(ageSeconds, now = Date.now()) {
  if (ageSeconds === null || ageSeconds === undefined) return 0;
  return workingTime.workingSecondsBetween(instantFromAge(ageSeconds, now), now, schedule());
}

async function openSession(db, assetId) {
  const { rows } = await db.query(
    `SELECT *, ${AGE()} AS age_seconds FROM work_sessions WHERE asset_id = $1 AND ended_at IS NULL LIMIT 1`,
    [assetId]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  return rows[0] || null;
}

// Whether anything can be recorded at all. Asked before start/close, so a
// missing table produces "time recording is not available on this deployment
// yet" rather than a database error the person cannot act on.
async function available(db) {
  try {
    await db.query('SELECT 1 FROM work_sessions LIMIT 1');
    return true;
  } catch (err) {
    if (unavailable(err)) return false;
    throw err;
  }
}

/* Stamp the start. Refuses if one is already open — the caller turns that into
 * a 409, and the button that was clicked twice does nothing twice.
 *
 * `at` opens the session at a moment that has already passed rather than now,
 * and is the mirror of the same option on close(). Only the auto-resume sweep
 * passes it: the studio's answer to "when did this start again" is half past
 * nine, not whenever the sweep got round to it, so a tick that is a minute late
 * — or an hour late after a restart — writes the same stamp either way. See
 * resumeOverdue().
 *
 * Written as an offset from the database's own NOW() rather than as a stamp,
 * for the reason given above AGE: this codebase never converts a DATETIME,
 * because doing so means trusting two machines to agree about a timezone. An
 * interval in seconds needs them to agree only about now.
 */
async function start(db, assetId, userId, assignmentId, { at = null } = {}) {
  const running = await openSession(db, assetId);
  if (running) return { ok: false, alreadyOpen: true, since: running.started_at };
  const id = uuid();
  const round = await currentRound(db, assetId);
  /* Never in the future, and never more than a day back: a clock nudged
     forward, or an `at` computed from a stale schedule, must not write a stamp
     that reads as work not yet done or as a week of it.
     
     FLOOR, NOT ROUND, and it is load-bearing rather than fussy. The resume
     back-dates to the start of the stretch being recorded — a boundary instant,
     exactly 09:30 or 11:15 — and a span includes its start but not its end.
     Rounding up puts the stamp a fraction BEFORE that boundary, which is
     outside every span, and the pause sweep then closes the session at its own
     start for nought seconds; the resume opens another one on the next tick,
     and the pair trade the row back and forth for ever, a dead row a minute.
     Flooring the offset can only move the stamp later, so it stays inside. */
  const back = at === null ? 0 : Math.min(Math.max(0, Math.floor((Date.now() - at) / 1000)), 86400);
  const startedAt = back > 0 ? `DATE_SUB(NOW(), INTERVAL ${back} SECOND)` : 'NOW()';
  // Which stretch-with-one-person this belongs to. It is what makes a new
  // assignee's Time Spent start at nothing without anything having to "reset":
  // their episode simply has no sessions in it yet.
  try {
    await db.query(
      `INSERT INTO work_sessions (id, asset_id, user_id, round, assignment_id, started_at)
       VALUES ($1,$2,$3,$4,$5,${startedAt})`,
      [id, assetId, userId, round, assignmentId || null]
    );
  } catch (err) {
    // A deployment whose work_sessions predates episodes still records the
    // stamps; it just cannot attribute them to one.
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    await db.query(
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at)
       VALUES ($1,$2,$3,$4,${startedAt})`,
      [id, assetId, userId, round]
    );
  }
  /* STARTED WITH THE STUDIO SHUT.
   *
   * The click is never refused — somebody sitting down at nine in the evening
   * is taking the work on, and blocking that would only teach them to start it
   * the next morning and mis-state when they began. What is refused is the
   * time: the session is opened and immediately put down again with the reason
   * that explains it, so it accrues nothing and needs Resume to carry on.
   *
   * That is the same state a timer gets into by running past seven, reached by
   * the same route and shown by the same label. Two ways in, one state — which
   * is what keeps "it started outside hours" and "it ran past the end of the
   * day" from needing two explanations on screen and two rules in here. */
  if (!workingTime.isRecording(Date.now(), schedule())) {
    await close(db, assetId, REASONS.off_hours);
    return { ok: true, sessionId: id, round, pausedOffHours: true, opensAt: nextOpening() };
  }
  return { ok: true, sessionId: id, round };
}

/* When the studio next opens, as an ISO instant — what a screen says next to a
   paused timer. Null only if the schedule has no working days at all, which
   Settings will not save but a hand-edited database could hold. */
function nextOpening(from = Date.now()) {
  const at = workingTime.resumesAt(from, schedule());
  return at === null ? null : new Date(at).toISOString();
}

/* PUT DOWN EVERY TIMER THE STUDIO CLOSED AROUND.
 *
 * Walks the open sessions and closes any whose working window has ended, at
 * the instant it ended rather than the instant this ran. That distinction is
 * the whole design: the sweep is a label, not a measurement. Run it at seven
 * o'clock sharp or at midnight and the recorded figure is identical, because
 * close() intersects the span with the window either way — so a missed tick, a
 * restart, or a server asleep for an hour cannot cost anybody a correct number.
 * What being late costs is only how long the panel goes on saying "in progress"
 * after it stopped counting.
 *
 * Returns what it paused, so the caller can tell those people. It tells nobody
 * itself: this module records time and does not know about notifications, and
 * keeping it that way is what lets the whole of it be tested without them.
 */
async function pauseOverdue(db) {
  const now = Date.now();
  const window = schedule();
  const { rows } = await db.query(
    `SELECT w.id, w.asset_id AS assetId, w.user_id AS userId, w.round,
            ${AGE('w.started_at')} AS age_seconds,
            a.\`code\`, a.\`name\`
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.ended_at IS NULL`
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });

  const paused = [];
  for (const row of rows) {
    const startedAt = instantFromAge(row.age_seconds, now);
    /* Null means the session began outside the window and there is nothing for
       it to have run until — so it is put down at its own start and accrues
       nothing. That is the row start() could not close itself: a server that
       was down when somebody's session was open, or a row from before this
       rule existed. */
    const stopsAt = workingTime.stopsAt(startedAt, window);
    const at = stopsAt === null ? startedAt : stopsAt;
    if (stopsAt !== null && now < stopsAt) continue;     // still inside its stretch

    const done = await close(db, row.assetId, REASONS.off_hours, null, { at });
    if (!done.wasOpen) continue;                          // somebody closed it first
    paused.push({
      assetId: row.assetId,
      userId: row.userId,
      code: row.code,
      name: row.name,
      round: Number(row.round) || null,
      at: new Date(at).toISOString(),
      seconds: done.seconds,
      startedOutsideHours: stopsAt === null,
    });
  }
  return paused;
}

/* PICK UP AGAIN EVERY TIMER THE STUDIO CLOSED AROUND.
 *
 * The other half of pauseOverdue, and the studio's decision about what should
 * happen overnight. A timer put down at seven because the day ended is picked
 * up again at half past nine the next WORKING morning, on its own, with nobody
 * pressing anything — provided the work is still there to be done.
 *
 * "STILL THERE TO BE DONE" IS ASKED NOW, NOT ASSUMED FROM LAST NIGHT. Four
 * things can have changed between the two, and each of them means no:
 *
 *   it was submitted      the status left the set work continues in, so there
 *                         is nothing to accrue against. Submitted work that
 *                         went on counting overnight is the worst outcome here
 *                         and the one this is most careful about.
 *   it was reassigned     assignee_id is somebody else now. Their round is
 *                         theirs; resuming the old one would put two people's
 *                         hours on one asset.
 *   it was unassigned     nobody holds it, so nobody's clock should run.
 *   they started something else   the studio's one-active-task rule. Resuming
 *                         would be a way around it rather than a use of it —
 *                         exactly what POST /resume refuses by hand.
 *
 * And the project itself has to still be open, for the same reason its assets
 * cannot be edited when it is not.
 *
 * ONLY THE STUDIO'S PAUSE, NEVER A PERSON'S. A deliberate hold is a decision
 * somebody made and is left exactly where they left it; undoing it overnight
 * would be the application overruling them. That is the whole reason this
 * asks for off_hours specifically rather than reusing PAUSE_REASONS, which
 * every other predicate in this file is right to use.
 *
 * THE STAMP IS THE OPENING, NOT THE TICK. The resumed session is back-dated to
 * when the studio opened, so somebody who signs in at eleven finds the morning
 * already counted rather than an hour and a half missing — which is what the
 * studio asked for. It is bounded to the CURRENT window's opening: a server
 * that was down for three days resumes this morning at half past nine and
 * credits nothing for the days it was asleep.
 *
 * Returns what it resumed, so the caller can tell those people. Like
 * pauseOverdue it tells nobody itself.
 */
async function resumeOverdue(db) {
  const now = Date.now();
  const window = schedule();
  // Shut: nothing to resume into. This is also what makes the sweep a no-op all
  // evening and all weekend rather than something that has to be scheduled.
  if (!workingTime.isRecording(now, window)) return [];

  /* Required here rather than at the top of the file, and not for tidiness:
     src/assignments.js requires THIS module, so a require up there would be a
     cycle. Same reason scheduleAutoPause reaches for notifications the same
     way. lifecycle has no requires at all and rides along for locality. */
  const assignments = require('./assignments');
  const lifecycle = require('./lifecycle');

  /* When the stretch we are inside began — half past nine this morning,
     quarter past eleven after the morning break, two o'clock after lunch. The
     ceiling on how far a late sweep may back-date, and it is per STRETCH
     rather than per day: a sweep that runs at twenty past four must credit
     five minutes since the afternoon break ended, not seven hours since the
     morning. */
  const openedToday = workingTime.startsAt(now, window);
  /* Unreachable while isRecording above agrees with startsAt, and they are the
     same walk over the same spans, so it always will. Kept because the two
     lines say different things and only together do they say the whole rule:
     the one above is the cheap early-out that skips the query all evening and
     all weekend, and this one is what makes the back-dating below safe to do
     without checking again. Removing either as dead code brings back a resume
     that can fire inside a break. */
  if (openedToday === null) return [];

  const { rows } = await db.query(
    `SELECT w.id, w.asset_id AS assetId, w.user_id AS userId,
            ${AGE('w.ended_at')} AS paused_age,
            a.\`code\`, a.\`name\`, a.status, a.assignee_id, a.project_id
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.ended_reason = '${REASONS.off_hours}' AND ${HELD_ROW}`
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });

  const resumed = [];
  for (const row of rows) {
    // Submitted, moved to a status nobody works in, reassigned, or unassigned.
    if (!worksIn(row.status)) continue;
    if (!row.assignee_id || row.assignee_id !== row.userId) continue;

    const { rows: project } = await db.query(
      'SELECT id, `name`, is_active, closed_at FROM projects WHERE id = $1', [row.project_id]
    );
    if (lifecycle.projectRefusal(project[0])) continue;

    /* The one-active-task rule, asked the way POST /resume asks it: anything
       open ANYWHERE, this asset excepted. A person who started something else
       this morning keeps it, and last night's timer stays down for them to
       pick up by hand when they are ready. */
    if (await openForUser(db, row.userId, row.assetId)) continue;

    const pausedAt = instantFromAge(row.paused_age, now);
    const at = Math.max(openedToday, pausedAt);

    const episode = await assignments.current(db, row.assetId).catch(() => null);
    const started = await start(db, row.assetId, row.userId, episode && episode.id, { at });
    /* Somebody started it themselves in the moment between the read and this —
       their session is the real one and this changed nothing. */
    if (!started.ok) continue;

    resumed.push({
      assetId: row.assetId,
      userId: row.userId,
      code: row.code,
      name: row.name,
      round: started.round,
      at: new Date(at).toISOString(),
    });
  }
  return resumed;
}

/* Stamp the end, and record what ended it.
 *
 * Idempotent: closing a closed session is not an error, it is nothing. Closing
 * one that cannot exist is likewise nothing — submitting closes the session
 * first, and on a deployment whose work_sessions table could not be created
 * that raw query used to throw, so the artist could not submit at all with
 * "a database error" as the only explanation.
 *
 * WHAT `seconds` MEANS NOW, AND WHY IT CHANGED. It was the raw wall-clock span
 * between the two stamps: TIMESTAMPDIFF, straight from the database. That made
 * every evening, every weekend and every lunch hour part of what an asset cost.
 * It is now the part of that span the studio was actually open — the span
 * intersected with the configured working days, working hours and breaks, in
 * IST. See src/working-time.js for the arithmetic and why it lives apart.
 *
 * THIS IS THE SOURCE, AND THAT IS THE POINT. work_sessions.seconds is the one
 * column behind Time Spent, the Efficiency report, the Time Sheet's suggested
 * hours and the Fixed and Actual P&L. Correcting it here corrects all of them
 * at once; correcting them one by one would have been five chances to write the
 * same rule five slightly different ways.
 *
 * `at` closes the session at a moment that has already passed rather than now.
 * Only the auto-pause sweep passes it, and it is what makes the seven o'clock
 * cutoff exact no matter when the sweep gets round to it — see pauseOverdue().
 *
 * Stored rather than derived on read, as before, so a later edit to either
 * stamp cannot silently rewrite history and the reports can sum one column.
 */
async function close(db, assetId, reason, note = null, { at = null } = {}) {
  const running = await openSession(db, assetId);
  if (!running) return { ok: true, wasOpen: false };
  const why = REASONS[reason] || null;
  const text = typeof note === 'string' && note.trim() ? note.trim().slice(0, 255) : null;

  const now = Date.now();
  const startedAt = instantFromAge(running.age_seconds, now);
  /* Never in the future, and never before the session began. A clock nudged
     backwards between the start and this call would otherwise write a negative
     span; the intersection would return zero anyway, but the ended_at stamp
     would read as before the started_at one and no report expects that. */
  const endedAt = Math.min(now, Math.max(startedAt, at === null ? now : Number(at)));
  const seconds = workingTime.workingSecondsBetween(startedAt, endedAt, schedule());

  /* The end stamp as an offset from the database's own NOW(), for the same
     reason the age above is read that way: it lands in the database's clock
     without this process having to know what that clock is. Zero is the
     ordinary case and MySQL folds `NOW() - INTERVAL 0 SECOND` away. */
  /* FLOOR, NOT ROUND, and for the same reason start() floors: MySQL's NOW()
     truncates to the second, so an offset rounded UP lands the stamp a second
     BEFORE the boundary it is meant to be. That reads as "paused at 12:59:59"
     for a break that begins at 13:00 — the studio asked for exactly 13:00, and
     a second early is the one direction that looks like a different rule.
     The recorded figure is unaffected either way: `seconds` above is computed
     from the instants, not from this stamp. */
  const back = Math.max(0, Math.floor((now - endedAt) / 1000));
  const STAMP = `ended_at = NOW() - INTERVAL ${back} SECOND, seconds = ${Number(seconds) || 0}`;
  const attempts = [
    [`${STAMP}, ended_reason = $1, hold_note = $2`, [why, text, running.id], '$3'],
    [`${STAMP}, ended_reason = $1`, [why, running.id], '$2'],
    [STAMP, [running.id], '$1'],
  ];
  for (const [sets, params, idParam] of attempts) {
    try {
      await db.query(
        `UPDATE work_sessions SET ${sets} WHERE id = ${idParam} AND ended_at IS NULL`,
        params
      );
      break;
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
  }
  return { ok: true, wasOpen: true, round: running.round, reason: why, note: text, seconds };
}

/* Put the open stretch down, keeping the round.
 *
 * Nothing more than a close with a particular reason — which is the whole
 * economy of doing it this way. The gap between this row's ended_at and the
 * next row's started_at is time nobody is charged for, because no row covers
 * it, and every reader was already summing rows.
 */
async function hold(db, assetId, note = null) {
  return close(db, assetId, 'held', note);
}

/* Is this asset held, and what was said about it?
 *
 * The newest session for whoever holds the asset now. Held when that session
 * ended with reason 'held' — which also means nothing is open, since a row
 * newer than it would be the open one.
 *
 * Scoped by user rather than by assignment episode on purpose: the question is
 * about the person looking at the asset today, and a deployment whose
 * asset_assignments could not be created must still answer it. A reassignment
 * therefore clears the hold without anything having to clear it.
 */
async function heldFor(db, assetId, userId) {
  if (!userId) return null;
  const { rows } = await selectHeld(db, 'w.asset_id = $1 AND w.user_id = $2', [assetId, userId]);
  return rows[0] ? describePause(rows[0]) : null;
}

/* A paused row, as a screen needs it.
 *
 * `byStudio` is the whole reason the reason travels: the two pauses need
 * different words. "You put this down" and "the studio closed around this" are
 * not the same message, and a person who did not touch the button needs telling
 * which one happened and when work can resume. A row written before the reason
 * column existed reads as a hold, which is what every such row was.
 */
function describePause(row) {
  const byStudio = row.ended_reason === REASONS.off_hours;
  // Only worth saying for the automatic one — somebody who chose to stop knows
  // perfectly well when they can start again.
  const opensAt = byStudio ? nextOpening() : null;
  return {
    since: row.ended_at,
    note: row.hold_note || null,
    round: Number(row.round) || null,
    reason: row.ended_reason || REASONS.held,
    byStudio,
    opensAt,
    /* WHICH scheduled stop this is, because the two need different sentences.
     *
     * "The working day ended" is the wrong thing to tell somebody at ten past
     * eleven — the studio is open, they are at their desk, and it is the
     * morning break that stopped the clock. The screen said that for every
     * automatic pause, which was true when the only one was seven o'clock and
     * became wrong the moment breaks started stopping the clock too.
     *
     * Worked out from WHEN it starts again rather than from the stamp: a
     * resume later the same IST day is a break, and one on another day is the
     * end of the day or a day the studio does not work. That avoids converting
     * a stored DATETIME, which this module never does — see the note above
     * AGE. */
    pausedFor: byStudio ? (sameDayResume(opensAt) ? 'break' : 'day') : null,
  };
}

// Does recording pick up again later on the same IST day it stopped?
function sameDayResume(opensAt) {
  if (!opensAt) return false;
  const now = Date.now();
  return workingTime.istPartsOf(now).day === workingTime.istPartsOf(Date.parse(opensAt)).day;
}

/* "This row is the newest stretch of this person's work on this asset, and it
 * ended on hold."
 *
 * Written once and used by both the single-asset question above and the
 * list-wide one in totalsFor, because a panel and a list that disagree about
 * who is held is precisely the bug this shape exists to prevent.
 *
 * Two clauses, and both are needed. Nothing OPEN, or a resume has already
 * happened and the hold is over. Nothing started LATER, or an older hold inside
 * a round that has since moved on would still read as current.
 *
 * The tie-break on ended_at is for the second-granularity of DATETIME: a hold
 * and a resume in the same second sort equally by start, and the open row is
 * what separates them. The one case left indistinguishable — hold, resume and
 * submit inside a single second — describes a round with no work in it.
 */
const HELD_ROW = `w.ended_reason ${PAUSED_SQL} AND NOT EXISTS (
      SELECT 1 FROM work_sessions n
       WHERE n.asset_id = w.asset_id AND n.user_id = w.user_id
         AND (n.ended_at IS NULL
              OR n.started_at > w.started_at
              OR (n.started_at = w.started_at AND n.ended_at > w.ended_at)))`;

/* The end of a stretch that was a HAND-IN rather than a hold.
 *
 * MAX(ended_at) across a round used to be the submit stamp, and with one row
 * per round it was exactly that. A held round's newest row also carries an
 * ended_at, so without this a task somebody put down at 11am reads as submitted
 * at 11am — on the asset panel, in the Assets List, and to every lead looking
 * for something to review that was never handed in.
 *
 * Only 'held' is excluded, not every reason that is not 'submitted'. Rows
 * written before the reason column existed carry NULL and WERE submissions, and
 * excluding those would erase the very history that column was added to keep.
 */
const submitStamp = (prefix = '') =>
  `CASE WHEN ${prefix}ended_reason ${PAUSED_SQL} THEN NULL ELSE ${prefix}ended_at END`;

/* Ask with the hold-aware stamp, and fall back to the plain one.
 *
 * A deployment that has not run the reason migration has never recorded a hold,
 * so plain ended_at is not an approximation there — it is the same answer. The
 * retry exists so that asking about holds cannot cost such a deployment its
 * work log entirely, which is what the surrounding catch would otherwise do:
 * it treats a missing column exactly like a missing table, and returns nothing.
 */
async function askStamped(db, build, params, ifUnavailable) {
  let last = null;
  for (const stamp of [submitStamp, (prefix = '') => `${prefix}ended_at`]) {
    try {
      return await db.query(build(stamp), params);
    } catch (err) {
      if (!unavailable(err)) throw err;
      last = err;
    }
  }
  /* Callers that have an answer for a schema this cannot query say so. One that
     does not gets the error, so it can log which piece is missing rather than
     silently reporting no time at all — the failure mode a report cannot
     distinguish from a studio that did no work. */
  if (ifUnavailable === undefined) throw last;
  return ifUnavailable;
}

/* Held rows matching a scope, tolerating a schema that predates either column.
 *
 * A deployment mid-migration still learns that an asset is held; it just
 * cannot say why. No ended_reason column at all means no holds have ever been
 * recorded, so nothing is held — which is the honest answer, not a guess. */
async function selectHeld(db, where, params) {
  const ask = (noteColumn) => db.query(
    `SELECT w.asset_id, w.ended_at, ${noteColumn} AS hold_note, w.round, w.ended_reason
       FROM work_sessions w WHERE ${where} AND ${HELD_ROW}`,
    params
  );
  return ask('w.hold_note').catch((err) => {
    if (!unavailable(err)) throw err;
    return ask('NULL').catch((again) => {
      if (!unavailable(again)) throw again;
      return { rows: [] };
    });
  });
}

// Everything below tolerates work_sessions not existing yet.
//
// The table arrives with a migration step, and a step can fail — on shared
// hosting, usually because the database user has no CREATE. When that happens
// nothing can be recorded, but the board, the asset list and the whole review
// pipeline have nothing to do with it and must still draw. Reporting no time is
// right; taking the studio's main screen down for it is not.
function unavailable(err) {
  const code = err && err.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

/* How much of this person's work on an asset happened on ONE calendar day.
 *
 * What the Time Sheet suggests when somebody adds a line, and the reason it can
 * suggest anything at all is Hold. The unit here is the SESSION, not the asset
 * and not the round:
 *
 *   An asset started Monday, put down Monday evening, picked up Wednesday and
 *   submitted Wednesday has a round spanning three days and no daily breakdown
 *   — but it has TWO session rows, each of which begins and ends on one day.
 *   Monday's hours and Wednesday's are both exactly known. Asking the question
 *   per round would answer "no idea" for both.
 *
 * A session that CROSSES MIDNIGHT is left out, and the count of those comes
 * back so the screen can say so. There is genuinely no way to know how much of
 * a stretch running from Tuesday afternoon to Wednesday morning was Tuesday's,
 * and a suggestion invented for it would be a number somebody signs their name
 * to. Better to offer nothing and say why.
 *
 * IST, because a timesheet day is a calendar day in the studio. The stamps are
 * instants, so they are shifted by the offset before the date is taken — the
 * same conversion, and the same reasoning, as src/asset-schedule.js.
 *
 * Scoped to ONE PERSON on purpose: this is their timesheet, and an asset they
 * hold now may have been worked on by somebody else last week.
 */
async function dayTotalFor(db, { assetId, userId, day, offsetMinutes = 330 }) {
  if (!assetId || !userId || !day) return { seconds: 0, sessions: 0, spanning: 0 };
  const shift = `INTERVAL ${Number(offsetMinutes) || 0} MINUTE`;
  const { rows } = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN DATE(started_at + ${shift}) = DATE(ended_at + ${shift})
                          THEN COALESCE(seconds, 0) ELSE 0 END), 0) AS seconds,
        SUM(DATE(started_at + ${shift}) = DATE(ended_at + ${shift})) AS same_day,
        SUM(DATE(started_at + ${shift}) <> DATE(ended_at + ${shift})) AS spanning
       FROM work_sessions
      WHERE asset_id = $1 AND user_id = $2 AND ended_at IS NOT NULL
        AND (DATE(started_at + ${shift}) = $3 OR DATE(ended_at + ${shift}) = $3)`,
    [assetId, userId, day]
  ).catch((err) => {
    /* No table, no suggestion — and that is the right failure. The field is
       filled in by hand anyway; refusing to draw the form because time
       recording is unavailable would take the timesheet down with it. */
    if (!unavailable(err)) throw err;
    return { rows: [{ seconds: 0, same_day: 0, spanning: 0 }] };
  });
  return {
    seconds: Number(rows[0].seconds) || 0,
    sessions: Number(rows[0].same_day) || 0,
    spanning: Number(rows[0].spanning) || 0,
  };
}

/* Everything THIS PERSON has recorded against ONE asset, whenever it happened.
 *
 * What the Time Sheet's Hours field is filled from, together with what they
 * have already filed — see hoursLoggedOn() in src/timesheets.js. The pair is
 * "how much of my recorded time on this asset is not yet on a timesheet".
 *
 * SCOPED TO ONE USER, and that is not a detail. An asset's Time Spent on the
 * Efficiency report is the sum over everybody who has held it, because that is
 * what the asset cost. A hand-over means the previous holder's hours are in
 * that number, and they are not this person's to file. So this query filters on
 * user_id and the two figures are deliberately allowed to differ.
 *
 * OPEN SESSIONS COUNT LIVE. COALESCE(seconds, TIMESTAMPDIFF(... NOW())) is the
 * same expression totalsFor() uses two functions below, on purpose: an asset
 * still in progress must offer the same elapsed figure the panel and the report
 * are showing, or the studio has three numbers for one thing.
 *
 * HELD TIME NEEDS NO EXCLUDING. A hold CLOSES a session row and a resume opens
 * a new one, so the held gap is the space between two rows and was never in any
 * of them. Summing rows excludes it by construction — there is no subtraction
 * here to get wrong, which is why the hold feature was built that way.
 */
async function recordedFor(db, { assetId, userId }) {
  if (!assetId || !userId) return { seconds: 0, sessions: 0, open: false };
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(COALESCE(seconds, 0)), 0) AS seconds,
            COUNT(*) AS sessions,
            SUM(ended_at IS NULL) AS still_open,
            MIN(CASE WHEN ended_at IS NULL THEN ${AGE()} END) AS open_age
       FROM work_sessions
      WHERE asset_id = $1 AND user_id = $2`,
    [assetId, userId]
  ).catch((err) => {
    /* No table, no figure — and that is the right failure. The field is filled
       in by hand anyway; refusing to draw the form because time recording is
       unavailable would take the timesheet down with it. */
    if (!unavailable(err)) throw err;
    return { rows: [{ seconds: 0, sessions: 0, still_open: 0, open_age: null }] };
  });
  return {
    seconds: (Number(rows[0].seconds) || 0) + liveSeconds(rows[0].open_age),
    sessions: Number(rows[0].sessions) || 0,
    open: Number(rows[0].still_open) > 0,
  };
}

/* Where the meaning of `seconds` changes.
 *
 * Rows written before this change hold ACTIVE worked time, summed across
 * however many pause/resume stretches a round had. Rows written after it hold
 * ELAPSED time between one start and one submit. The same column, two meanings,
 * and a report that silently mixes them would be comparing hours to hours that
 * are not the same hours.
 *
 * The discriminator is the data itself rather than a date stamped at deploy
 * time: every session closed under the new rule carries an ended_reason and no
 * old one does. So the earliest such row IS the cutover, it cannot drift out of
 * step with what actually happened, and a deployment with no history at all
 * reports no cutover — which is right, because there is nothing to warn about.
 */
async function cutover(db) {
  const { rows } = await db.query(
    `SELECT MIN(CASE WHEN ended_reason IS NOT NULL THEN started_at END) AS at,
            SUM(ended_reason IS NULL AND ended_at IS NOT NULL) AS legacy
       FROM work_sessions`
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [{ at: null, legacy: 0 }] };
  });
  const legacyRows = Number(rows[0].legacy) || 0;
  const at = rows[0].at || null;
  /* Two shapes because two readers need different things, and neither should
     have to guess. The driver hands back a Date for a DATETIME, and String()ing
     one gives "Fri Aug 28 2026 15:00:00 GMT+0000 (…)" — a spreadsheet that
     slices the front off that prints "Fri Aug 28", with no year, which is worse
     than useless in a file somebody opens next year. */
  const date = at ? new Date(at).toISOString().slice(0, 10) : null;
  return { at: at ? new Date(at).toISOString() : null, date, legacyRows, mixed: legacyRows > 0 };
}

// The summary a screen needs: the stamps, the elapsed total, and the per-round
// breakdown. A round still open counts up to now — that is elapsed-so-far, not
// a clock, and nothing on screen ticks it.
async function summary(db, assetId, assignmentId, assigneeId) {
  const { rows } = await askStamped(db, (stamp) =>
    `SELECT round,
            SUM(COALESCE(seconds, 0)) AS seconds,
            MIN(started_at) AS started_at,
            MAX(${stamp()}) AS ended_at,
            SUM(ended_at IS NULL) AS still_open,
            MIN(CASE WHEN ended_at IS NULL THEN ${AGE()} END) AS open_age
       FROM work_sessions WHERE asset_id = $1 GROUP BY round ORDER BY round`,
  [assetId], { rows: [] });
  const rounds = rows.map((r) => ({
    round: Number(r.round),
    seconds: (Number(r.seconds) || 0) + liveSeconds(r.open_age),
    startedAt: r.started_at || null,
    // An open round has no submit stamp yet. Reporting MAX(ended_at) there
    // would hand back the end of some earlier closed row in the same round,
    // which reads as "submitted" on a panel where nothing has been.
    submittedAt: Number(r.still_open) > 0 ? null : (r.ended_at || null),
    open: Number(r.still_open) > 0,
  }));

  // Two numbers, and the difference between them matters.
  //
  //   totalSeconds    every hour ever spent on this asset, by anyone. The
  //                   historical record, which a reassignment must never
  //                   shorten.
  //   currentSeconds  the hours spent by whoever holds it now, in the stretch
  //                   they have held it. This is the figure they see. Hand work
  //                   to somebody new and theirs reads nothing, because it is
  //                   a different stretch — nothing was reset, and the last
  //                   person's hours are still in the total above.
  //
  // Send work back to the SAME person and no new stretch begins, so their
  // number keeps climbing across the round. That is the older rule, unchanged.
  // Scoped to the assignment episode when there is one. When there is not —
  // a deployment where asset_assignments could not be created — fall back to
  // the sessions belonging to whoever holds the asset now, which answers the
  // same question from a table that is definitely there.
  //
  // Falling back to the lifetime total, which is what this did, was the bug
  // behind "the new assignee has no Accept and Start button": their figure
  // showed the previous person's hours, so the panel decided work was already
  // under way. Never fall back to somebody else's time.
  let currentSeconds = null;
  let currentStamps = null;
  const scope = assignmentId
    ? { sql: 'assignment_id = $1', value: assignmentId }
    : (assigneeId ? { sql: 'user_id = $1', value: assigneeId } : null);
  if (scope) {
    const { rows: mine } = await askStamped(db, (stamp) =>
      `SELECT SUM(COALESCE(seconds, 0)) AS seconds,
              MIN(started_at) AS started_at,
              MAX(${stamp()}) AS ended_at,
              SUM(ended_at IS NULL) AS still_open,
              MIN(CASE WHEN ended_at IS NULL THEN ${AGE()} END) AS open_age
         FROM work_sessions WHERE asset_id = $2 AND ${scope.sql}`,
    [scope.value, assetId],
    { rows: [{ seconds: null, started_at: null, ended_at: null, still_open: 0, open_age: null }] });
    currentSeconds = (Number(mine[0].seconds) || 0) + liveSeconds(mine[0].open_age);
    currentStamps = {
      startedAt: mine[0].started_at || null,
      submittedAt: Number(mine[0].still_open) > 0 ? null : (mine[0].ended_at || null),
      open: Number(mine[0].still_open) > 0,
    };
  }

  const totalSeconds = rounds.reduce((sum, r) => sum + r.seconds, 0);
  const latest = rounds.length ? rounds[rounds.length - 1] : null;
  const stamps = currentStamps || (latest
    ? { startedAt: latest.startedAt, submittedAt: latest.submittedAt, open: latest.open }
    : { startedAt: null, submittedAt: null, open: false });
  return {
    totalSeconds,
    currentSeconds: currentSeconds === null ? totalSeconds : currentSeconds,
    rounds,
    ...stamps,
    /* Held, and since when. Asked about the ASSIGNEE rather than the reader, so
       a lead opening the panel sees that the artist has put it down — which is
       the whole reason this state is visible rather than private. */
    held: await heldFor(db, assetId, assigneeId),
  };
}

// Totals for a set of assets in one query — what the Assets List shows.
//
// Two figures per asset, for the same reason summary reports two: `seconds` is
// the lifetime, and `currentSeconds` is what the person holding it now has put
// in. A screen that shows the lifetime to a new assignee is telling them
// somebody else's hours are theirs.
async function totalsFor(db, assetIds) {
  if (!assetIds.length) return new Map();
  const { rows } = await askStamped(db, (stamp) =>
    `SELECT w.asset_id,
            SUM(COALESCE(w.seconds, 0)) AS seconds,
            SUM(w.ended_at IS NULL) AS still_open,
            MIN(CASE WHEN w.user_id = a.assignee_id THEN w.started_at END) AS started_at,
            MAX(CASE WHEN w.user_id = a.assignee_id THEN ${stamp('w.')} END) AS ended_at,
            COUNT(DISTINCT CASE WHEN w.user_id = a.assignee_id THEN w.round END) AS rounds,
            SUM(CASE WHEN w.user_id = a.assignee_id THEN COALESCE(w.seconds, 0) ELSE 0 END)
              AS current_seconds,
            MIN(CASE WHEN w.ended_at IS NULL THEN ${AGE('w.started_at')} END) AS open_age,
            MIN(CASE WHEN w.ended_at IS NULL AND w.user_id = a.assignee_id
                     THEN ${AGE('w.started_at')} END) AS current_open_age
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.asset_id IN ($1) GROUP BY w.asset_id`,
  [assetIds], { rows: [] });

  /* Who is held, asked once for the whole list rather than per row.
   *
   * A separate query because "the newest row ended on hold" is not something a
   * GROUP BY can answer without picking a row, and the alternative — a
   * correlated subquery per asset — is the shape that makes an Assets List of
   * four hundred assets slow. It uses the same HELD_ROW predicate the single
   * asset panel uses, so the two cannot come to different conclusions. */
  const { rows: heldRows } = await selectHeld(
    db,
    'w.asset_id IN ($1) AND w.user_id = (SELECT assignee_id FROM assets WHERE id = w.asset_id)',
    [assetIds]
  );
  const heldBy = new Map(heldRows.map((r) => [r.asset_id, describePause(r)]));

  return new Map(rows.map((r) => [r.asset_id, {
    seconds: (Number(r.seconds) || 0) + liveSeconds(r.open_age),
    currentSeconds: (Number(r.current_seconds) || 0) + liveSeconds(r.current_open_age),
    open: Number(r.still_open) > 0,
    startedAt: r.started_at || null,
    submittedAt: Number(r.still_open) > 0 ? null : (r.ended_at || null),
    rounds: Number(r.rounds) || 0,
    held: heldBy.get(r.asset_id) || null,
  }]));
}

/* Run the sweep, tell the people it affected, and keep doing it.
 *
 * THE INTERVAL IS ABOUT THE SCREEN, NOT THE NUMBER. Every minute, because the
 * studio asked for the pause to land at seven o'clock and a person watching
 * their own task should not see "in progress" for long after it stopped
 * counting. It is emphatically not how the cutoff is measured — pauseOverdue
 * closes at the boundary instant whatever time it is called, so this could run
 * hourly and every recorded figure would be identical. That is what makes a
 * restart, a missed tick or a sleeping server harmless.
 *
 * SAFE ON MORE THAN ONE WORKER, by the same argument the chat sweep uses:
 * close() updates `WHERE id = ? AND ended_at IS NULL`, so of two processes
 * racing the same session one updates a row and the other updates nothing and
 * reports wasOpen false. Nobody is told twice.
 *
 * The first pass runs immediately rather than in a minute's time: a process
 * that was restarted comes back holding sessions the studio closed around
 * while it was down, and no timer ever fired for those.
 */
function scheduleAutoPause(db, log = console.log) {
  const minutes = Number(process.env.WORK_HOURS_SWEEP_MINUTES ?? 1);
  const notifications = require('./notifications');

  const tell = async (rows, kind) => {
    for (const row of rows) {
      /* No actor: the clock did this, not a person. raise() drops a recipient
         who is also the actor, so passing null is also what makes sure this
         reaches somebody who paused their own work by starting it late. */
      await notifications.raise(db, {
        recipientId: row.userId,
        actorId: null,
        kind,
        assetId: row.assetId,
      }).catch(() => {});
    }
  };

  const run = async () => {
    const paused = await pauseOverdue(db);
    await tell(paused, notifications.KINDS.work_paused);
    if (paused.length) {
      log(`[hours] paused ${paused.length} timer(s) outside working hours.`);
    }

    /* And the other direction. Pausing first is not an accident of order: a
       session the studio has already closed around is not a candidate for
       resuming, and doing it the other way round could pick one up a
       millisecond before putting it down again. */
    const resumed = await resumeOverdue(db);
    await tell(resumed, notifications.KINDS.work_resumed);
    if (resumed.length) {
      log(`[hours] resumed ${resumed.length} timer(s) at the start of the working day.`);
    }
  };

  const tick = () => run().catch((err) => log(`[hours] sweep failed: ${err.sqlMessage || err.message}`));
  tick();
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const timer = setInterval(tick, minutes * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  REASONS, PAUSE_REASONS, WORK_CONTINUES, start, close, closeIfWorkStopped, hold, heldFor,
  summary, totalsFor, pauseOverdue, resumeOverdue, scheduleAutoPause, nextOpening,
  openSession, openForUser, currentRound, available, cutover, dayTotalFor, recordedFor,
  // Exported so every reader of a submit stamp uses the same expression. There
  // are three, and the third was found by a test rather than by reading.
  submitStamp, askStamped,
};
