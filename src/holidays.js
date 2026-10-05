/* The days the studio is shut, by calendar date.
 *
 * WHY THIS IS NOT A NEW KIND OF RULE. src/working-time.js used to carry this
 * note: "WHAT IT DELIBERATELY DOES NOT KNOW. Holidays. A studio closed for
 * Diwali still counts Diwali as a working day here, because nothing in the
 * application records a holiday calendar." This is that calendar, and the gap
 * is closed where the note said it would have to be — inside the schedule
 * rather than beside it.
 *
 * A holiday is therefore not a second check bolted on to /start, the pause
 * sweep and the automatic resume. It is a day on which the studio's recording
 * windows produce NO spans, which is exactly what a Sunday already is. One line
 * in working-time's spansOn() does it, and every decision downstream of that
 * one funnel — is the clock running, when does it next start, when did it last
 * stop, how many of a span's seconds count — is right without being told about
 * holidays at all. That is the same route the lunch blackout takes.
 *
 * A CALENDAR DATE IN THE STUDIO'S TIMEZONE, not a UTC instant and not a range.
 * "26 January" is a date on one wall calendar in one office; it begins at
 * 00:00 IST and ends at 24:00 IST, and a server in UTC must not shift it by
 * five and a half hours. So the column is a DATE, the value moved around is a
 * 'YYYY-MM-DD' string, and the only conversion anywhere is working-time's
 * istDateOf() turning its IST day number into one of these strings. Comparing
 * two 'YYYY-MM-DD' strings needs no timezone and cannot be off by one.
 *
 * MIRRORED IN MEMORY, for the reason recording-hours gives for the same choice:
 * this is read on every pause sweep, every automatic resume, every Accept and
 * Start and every row of every Assets List. A query per decision would be a
 * query per asset on a board.
 *
 * THE PAST IS READ-ONLY, and that is the load-bearing rule rather than a
 * nicety. Because holidays go into the one funnel, a holiday dated over a day
 * that already has work on it would change what that work was worth: a session
 * open since half past nine, with today declared a holiday at two o'clock,
 * would be put down for nought seconds and the morning would be gone. So the
 * earliest date that can be entered is TOMORROW, and a holiday that has begun
 * or passed cannot be removed. Recorded time is then safe by construction and
 * not by a rule somewhere else remembering to protect it — see validate().
 */

const crypto = require('crypto');
const workingTime = require('./working-time');

const NAME_MAX = 120;
const NOTE_MAX = 500;

/* 'YYYY-MM-DD', from whatever a caller has: what MySQL hands back for a DATE
   (a Date), what the browser sends (a string), what a test writes. One shape
   out, because the alternative is every caller remembering which it holds.
   Deliberately the same contract as src/timesheets.js toISO(). */
function toISODate(value) {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  /* The 31st of February is well-formed and not a date. Round-tripping through
     UTC catches it without a month-length table; UTC rather than local time
     because the string carries no timezone and must not acquire the server's. */
  const probe = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/* Today, on the studio's wall calendar. The ONE place an instant becomes a
   date here, and it goes through working-time so the holiday calendar and the
   clock cannot disagree about when a day begins. */
const todayISO = (at = Date.now()) => workingTime.istDateOf(workingTime.istPartsOf(at).day);

// Tomorrow, which is the earliest date this screen accepts. See the header.
function tomorrowISO(at = Date.now()) {
  return workingTime.istDateOf(workingTime.istPartsOf(at).day + 1);
}

// --- the in-memory mirror ---------------------------------------------------

let cache = [];
let loaded = false;

const rowToEntry = (row) => ({
  id: row.id,
  date: toISODate(row.holiday_date),
  name: row.name || '',
  note: row.note || null,
  createdBy: row.created_by || null,
  createdByName: row.created_by_name || null,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
});

async function load(db) {
  const { rows } = await db.query(
    `SELECT h.*, u.name AS created_by_name
       FROM studio_holidays h
       LEFT JOIN users u ON u.id = h.created_by
      ORDER BY h.holiday_date`
  ).catch(() => ({ rows: [] }));
  cache = rows.map(rowToEntry).filter((e) => e.date);
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;
const list = () => cache.map((e) => ({ ...e }));

/* The set working-time reads, and nothing else about a holiday.
 *
 * A Set of date strings rather than the rows: the span arithmetic wants one
 * membership test per day it walks and has no use for a name, and handing it
 * the rows would put a label into a hot loop where nobody could see it was
 * unused. Rebuilt on each call rather than cached beside `cache`, because a
 * stale second copy of a studio-wide setting is the bug this codebase keeps
 * finding; the list is a handful of rows a year. */
const dates = () => new Set(cache.map((e) => e.date));

// The holiday on a given calendar date, or null. Name and all, for a message.
const on = (date) => {
  const iso = toISODate(date);
  return iso ? (cache.find((e) => e.date === iso) || null) : null;
};

/* Is the studio shut at this instant because of a holiday?
 *
 * The question /start, resume and the paused label all ask. It is about the
 * studio's CALENDAR DAY, so an instant at 23:59 IST on the eve is not a
 * holiday and one at 00:00 IST is — see the midnight cases in
 * tests/holidays.test.js. */
const at = (ms = Date.now()) => on(todayISO(ms));

// --- validation -------------------------------------------------------------

/* One row's worth of checking, as a list of {field, message}.
 *
 * A LIST rather than the first problem found, for the reason
 * src/recording-hours.js gives: the screen draws these against the field they
 * belong to, and somebody fixing a row wants both ends of it wrong at once.
 */
function validate(input, { current = null, now = Date.now() } = {}) {
  const errors = [];
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);

  const rawDate = pick('date', current ? current.date : undefined);
  const date = toISODate(rawDate);
  if (rawDate === undefined || rawDate === null || rawDate === '') {
    errors.push({ field: 'date', message: 'A date is required.' });
  } else if (!date) {
    errors.push({ field: 'date', message: 'Enter the date as YYYY-MM-DD.' });
  } else if (date < tomorrowISO(now)) {
    /* THE RULE THE WHOLE DESIGN RESTS ON. A holiday takes a day out of the
       schedule, and the schedule is what every session's seconds are measured
       against — so a holiday dated today or earlier would change what work
       already done was worth. Tomorrow is the earliest date that cannot. */
    errors.push({
      field: 'date',
      message: date === todayISO(now)
        ? 'A holiday cannot be added for today — the clock has already been running. '
          + `The earliest date is ${tomorrowISO(now)}.`
        : `${date} has passed. Holidays are declared in advance, so that hours already `
          + `recorded are never changed. The earliest date is ${tomorrowISO(now)}.`,
    });
  }

  /* One row per date, refused rather than merged. Two names for one closed day
     is not extra information, it is a disagreement — and the schedule would
     read the day as shut twice, which is the same as once and makes the second
     row a row that does nothing. The table carries a UNIQUE key as well, so a
     race between two admins ends the same way; this is what makes the ordinary
     case a sentence instead of a driver error. */
  if (date) {
    const clash = cache.find((e) => e.date === date && (!current || e.id !== current.id));
    if (clash) {
      errors.push({
        field: 'date',
        message: `${date} is already a holiday — "${clash.name}". Edit that one, or choose another date.`,
      });
    }
  }

  const rawName = pick('name', current ? current.name : undefined);
  const name = String(rawName ?? '').trim();
  if (!name) errors.push({ field: 'name', message: 'A name is required — it is what the refusal tells people.' });
  else if (name.length > NAME_MAX) errors.push({ field: 'name', message: `A name is at most ${NAME_MAX} characters.` });

  const rawNote = pick('note', current ? current.note : null);
  const note = rawNote === null || rawNote === undefined ? '' : String(rawNote).trim();
  if (note.length > NOTE_MAX) errors.push({ field: 'note', message: `A note is at most ${NOTE_MAX} characters.` });

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], value: { date, name, note: note || null } };
}

// --- writing ----------------------------------------------------------------

async function create(db, input, userId, { now = Date.now() } = {}) {
  const checked = validate(input, { now });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  const id = crypto.randomUUID();
  try {
    await db.query(
      'INSERT INTO studio_holidays (id, holiday_date, name, note, created_by) VALUES ($1, $2, $3, $4, $5)',
      [id, v.date, v.name, v.note, userId || null]
    );
  } catch (err) {
    // The UNIQUE key, reached by two admins at once. Said the same way the
    // check above says it, rather than as a driver error.
    if (err.code === 'ER_DUP_ENTRY') {
      await load(db);
      return { ok: false, status: 422, errors: [{ field: 'date', message: `${v.date} is already a holiday.` }] };
    }
    throw err;
  }
  await load(db);
  return { ok: true, entry: cache.find((e) => e.id === id) };
}

/* Why a change is refused for the same dates a create is.
 *
 * Both ends matter and for the same reason. Moving a holiday ONTO a past day
 * would take hours away from work already done; moving one OFF a day that has
 * begun would hand back time the studio had said was closed, on a day whose
 * sessions have already been paused. So a row is editable only while both the
 * date it has and the date it is being given are still in the future. */
async function update(db, id, input, { now = Date.now() } = {}) {
  const current = cache.find((e) => e.id === id);
  if (!current) return { ok: false, status: 404, errors: [{ field: null, message: 'That holiday no longer exists.' }] };
  const locked = pastRefusal(current, now, 'changed');
  if (locked) return { ok: false, status: 409, errors: [{ field: 'date', message: locked }] };

  const checked = validate(input, { current, now });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  await db.query(
    'UPDATE studio_holidays SET holiday_date = $1, name = $2, note = $3 WHERE id = $4',
    [v.date, v.name, v.note, id]
  );
  await load(db);
  return { ok: true, before: current, entry: cache.find((e) => e.id === id) };
}

async function remove(db, id, { now = Date.now() } = {}) {
  const current = cache.find((e) => e.id === id);
  if (!current) return { ok: false, status: 404, errors: [{ field: null, message: 'That holiday no longer exists.' }] };
  const locked = pastRefusal(current, now, 'removed');
  if (locked) return { ok: false, status: 409, errors: [{ field: 'date', message: locked }] };
  await db.query('DELETE FROM studio_holidays WHERE id = $1', [id]);
  await load(db);
  return { ok: true, before: current };
}

// The sentence a locked row is refused with, in one place so a delete and an
// edit cannot explain the same rule two different ways.
function pastRefusal(entry, now, verb) {
  if (entry.date >= tomorrowISO(now)) return null;
  return `${entry.name} on ${entry.date} has ${entry.date === todayISO(now) ? 'begun' : 'passed'} `
    + `and can no longer be ${verb}. Hours already recorded are measured against the schedule as it `
    + 'stood, and the record is kept rather than rewritten.';
}

// Upcoming first, then the ones that have been, newest of those first — which
// is the order the Settings section lists them in and the order somebody
// planning a quarter wants.
function grouped(now = Date.now()) {
  const today = todayISO(now);
  return {
    upcoming: cache.filter((e) => e.date >= today).map((e) => ({ ...e, editable: e.date >= tomorrowISO(now) })),
    past: cache.filter((e) => e.date < today).slice().reverse().map((e) => ({ ...e, editable: false })),
  };
}

/* One line a person reads, for the audit trail — the same job
   recording-hours' summarise() does, and the same reason: the sentence before
   and a sentence after is what makes the log worth keeping. */
const summarise = (entry) => (entry ? `${entry.date} — ${entry.name}${entry.note ? ` (${entry.note})` : ''}` : 'none');

module.exports = {
  NAME_MAX, NOTE_MAX,
  toISODate, todayISO, tomorrowISO,
  load, isLoaded, list, dates, on, at, grouped,
  validate, create, update, remove, summarise,
};
