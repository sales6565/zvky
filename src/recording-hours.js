/* The studio's recording windows, by name, in any number.
 *
 * WHY THIS REPLACED A FORM WITH FOUR TIME PAIRS ON IT. Working Hours could say
 * one thing: a single window, the same on every working day, with three breaks
 * cut out of it. That was the studio's schedule, and while it was the only
 * schedule anyone needed the fixed form was the simpler answer.
 *
 * It cannot say a half day on Saturday, a night shift, a blackout that applies
 * on weekdays and not at the weekend, or a fourth break. Each of those is a
 * column on the old table and a field on the old form, and the fourth one would
 * have been the fourth time somebody copied the same four places. So the shape
 * changed: any number of named windows in two lists, each carrying its own days
 * of the week.
 *
 * THESE ARE NOT REPORTING METADATA. They are the schedule itself. Every timer
 * decision in the application — when recording stops, when it starts again the
 * next morning, and how many of a session's seconds count at all — is taken
 * from these rows by way of src/working-time.js, which reads them through
 * workSchedule.current().entries. There is one definition of "is the studio
 * recording right now" and this is where it is stored.
 *
 * MIRRORED IN MEMORY, like the work_schedule row it grew out of and for the
 * same reason: it is studio-wide, changed a handful of times in the life of a
 * deployment, and read on every pause sweep and every asset board. A query per
 * decision would be a query per row of every Assets List.
 */

const crypto = require('crypto');

const TYPES = ['recording', 'non_recording'];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MINUTES_PER_DAY = 24 * 60;
const LABEL_MAX = 120;

/* "09:30" | "9:30" | 570 -> 570. Anything else -> null. The same parser
   src/work-schedule.js uses, spelled out again rather than imported, because
   these two modules are deliberately not dependent on each other: this one
   outlives the other's form. */
function parseClock(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 && value < MINUTES_PER_DAY ? value : null;
  }
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

const clockLabel = (minutes) => (minutes === null || minutes === undefined ? ''
  : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);

function parseDays(value) {
  if (value === null || value === undefined || value === '') return [...ALL_DAYS];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const days = list
    .map((d) => Number(String(d).trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

// --- the in-memory mirror ---------------------------------------------------

let cache = [];
let loaded = false;
/* Has this deployment EVER had windows seeded? The difference between "no rows
   because nobody has migrated yet" and "no rows because an admin deleted them
   all", which are opposite answers and would otherwise look identical. */
let seeded = false;

const rowToEntry = (row) => ({
  id: row.id,
  type: row.type,
  label: row.label || '',
  start: Number(row.start_min),
  end: Number(row.end_min),
  spansMidnight: Boolean(Number(row.spans_midnight)),
  daysOfWeek: parseDays(row.days_of_week),
  enabled: Boolean(Number(row.enabled)),
  sortOrder: Number(row.sort_order || 0),
  createdBy: row.created_by || null,
  createdByName: row.created_by_name || null,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
});

async function load(db) {
  const { rows: mark } = await db.query(
    'SELECT recording_hours_seeded_at AS seeded FROM work_schedule WHERE id = 1'
  ).catch(() => ({ rows: [] }));
  seeded = Boolean(mark.length && mark[0].seeded);

  const { rows } = await db.query(
    `SELECT c.*, u.name AS created_by_name
       FROM recording_hour_configs c
       LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.type, c.sort_order, c.start_min, c.id`
  ).catch(() => ({ rows: [] }));
  cache = rows.map(rowToEntry);
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;
const list = () => cache.map((e) => ({
  ...e,
  daysOfWeek: [...e.daysOfWeek],
  startLabel: clockLabel(e.start),
  endLabel: clockLabel(e.end),
  dayNames: e.daysOfWeek.map((d) => DAY_SHORT[d]),
  allDays: e.daysOfWeek.length === 7,
  minutes: e.spansMidnight ? (MINUTES_PER_DAY - e.start) + e.end : e.end - e.start,
}));

/* What src/working-time.js reads. Deliberately the raw shape rather than the
   decorated one above: the span maths wants numbers and nothing else, and a
   label leaking into it would be a label nobody could see was unused.

   Null — not an empty array — when no row has ever been written, which is how a
   deployment that has not run the seed yet keeps its old schedule instead of
   recording nothing at all. Once there is a row, an empty enabled set is a real
   answer and is honoured. */
function entriesForSchedule() {
  if (!loaded) return null;
  /* AN EMPTY LIST IS AN ANSWER once the seed has run. A Super Admin who deletes
     every window has said the studio records nothing, and falling back to the
     old day_start/day_end pair would quietly reinstate hours nobody chose —
     which is the disagreement between two schedules this feature exists to
     end. Before the seed there is nothing to fall back FROM, so the legacy
     shape stays in force and an unmigrated deployment keeps working. */
  if (!cache.length) return seeded ? [] : null;
  return cache.map((e) => ({
    type: e.type,
    start: e.start,
    end: e.end,
    spansMidnight: e.spansMidnight,
    daysOfWeek: e.daysOfWeek,
    enabled: e.enabled,
    /* Carried for one reader only: work-schedule.js names the gaps it derives
       after the blackout that made each one, so "Lunch" is still called Lunch
       wherever the studio's breaks are listed. The span maths ignores it. */
    label: e.label,
  }));
}

// --- validation -------------------------------------------------------------

/* One row's worth of checking, as a list of {field, message}.
 *
 * A LIST, not the first problem found, because the screen shows these against
 * the field they belong to and a person fixing a row wants to see both ends of
 * it wrong at once rather than one, then the other.
 */
function validate(input, { partial = false, current = null } = {}) {
  const errors = [];
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);

  const type = pick('type', current ? current.type : undefined);
  if (!TYPES.includes(type)) {
    errors.push({ field: 'type', message: 'Choose Recording Hours or Non-Recording Hours.' });
  }

  const rawStart = pick('startTime', current ? current.start : undefined);
  const rawEnd = pick('endTime', current ? current.end : undefined);
  const start = parseClock(rawStart);
  const end = parseClock(rawEnd);
  if (rawStart === undefined || rawStart === null || rawStart === '') {
    errors.push({ field: 'startTime', message: 'A start time is required.' });
  } else if (start === null) {
    errors.push({ field: 'startTime', message: 'Enter a start time as HH:mm, in 24-hour form.' });
  }
  if (rawEnd === undefined || rawEnd === null || rawEnd === '') {
    errors.push({ field: 'endTime', message: 'An end time is required.' });
  } else if (end === null) {
    errors.push({ field: 'endTime', message: 'Enter an end time as HH:mm, in 24-hour form.' });
  }

  const spansMidnight = Boolean(pick('spansMidnight', current ? current.spansMidnight : false));

  if (start !== null && end !== null) {
    if (start === end) {
      errors.push({ field: 'endTime', message: 'The start and end times are the same, so this window is empty. Set an end time after the start.' });
    } else if (end < start && !spansMidnight) {
      /* The one error the spec asks to be helpful rather than merely correct:
         22:00 to 06:00 is a real window somebody means, and the box that makes
         it legal is right there on the row. */
      errors.push({
        field: 'endTime',
        message: `${clockLabel(end)} is before ${clockLabel(start)}. Tick "crosses midnight" if this window runs overnight.`,
      });
    } else if (end > start && spansMidnight) {
      errors.push({
        field: 'spansMidnight',
        message: `${clockLabel(start)} to ${clockLabel(end)} is inside one day, so it does not cross midnight.`,
      });
    }
  }

  const label = pick('label', current ? current.label : '');
  const labelText = label === null || label === undefined ? '' : String(label).trim();
  if (labelText.length > LABEL_MAX) {
    errors.push({ field: 'label', message: `A label is at most ${LABEL_MAX} characters.` });
  }

  const daysGiven = pick('daysOfWeek', current ? current.daysOfWeek : undefined);
  const days = parseDays(daysGiven === undefined ? null : daysGiven);
  if (!days.length) {
    errors.push({ field: 'daysOfWeek', message: 'Choose at least one day, or leave every day ticked.' });
  }

  const enabled = pick('enabled', current ? current.enabled : true);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      type, start, end, spansMidnight, daysOfWeek: days, enabled: Boolean(enabled),
      label: labelText,
    },
  };
}

/* The minute intervals one entry covers on a given weekday, for the overlap
   check below. A window that crosses midnight is two of them, on two days —
   the same reading src/working-time.js takes. */
function coverage(entry) {
  const out = [];
  for (const dow of entry.daysOfWeek) {
    if (entry.spansMidnight) {
      if (entry.start < MINUTES_PER_DAY) out.push({ dow, from: entry.start, to: MINUTES_PER_DAY });
      if (entry.end > 0) out.push({ dow: (dow % 7) + 1, from: 0, to: entry.end });
    } else {
      out.push({ dow, from: entry.start, to: entry.end });
    }
  }
  return out;
}

const describe = (e) => (e.label ? e.label : `${clockLabel(e.start)}–${clockLabel(e.end)}`);

/* Overlapping windows in the SAME list, as warnings rather than errors.
 *
 * The spec's word is warn, and it is the right one. Two overlapping recording
 * windows are not a contradiction — the union is what records, which is a
 * perfectly sensible thing to build out of "Core hours" plus "Friday late
 * shift". What it is, is the kind of thing somebody does by accident, so the
 * conflicting labels are named and the admin decides.
 *
 * Across the two lists there is no warning at all: a non-recording window
 * overlapping a recording one is the entire point of the second list.
 */
function overlapWarnings(entries) {
  const warnings = [];
  for (const type of TYPES) {
    const of = entries.filter((e) => e.type === type && e.enabled !== false);
    for (let i = 0; i < of.length; i += 1) {
      for (let k = i + 1; k < of.length; k += 1) {
        const a = coverage(of[i]);
        const b = coverage(of[k]);
        const clash = a.some((x) => b.some((y) => y.dow === x.dow && y.from < x.to && x.from < y.to));
        if (!clash) continue;
        warnings.push({
          type,
          ids: [of[i].id, of[k].id].filter(Boolean),
          message: `"${describe(of[i])}" and "${describe(of[k])}" overlap.`,
        });
      }
    }
  }
  return warnings;
}

/* A studio that would record nothing at all. Not refused — an admin switching
   every window off may be doing exactly that deliberately, and refusing it
   would leave no way back from a schedule they wanted gone — but it stops every
   timer in the building, so it is said plainly. */
function silenceWarning(entries) {
  const recording = entries.filter((e) => e.type === 'recording' && e.enabled !== false);
  if (!recording.length) {
    return { type: 'recording', ids: [], message: 'No recording window is switched on, so no time will be tracked at all.' };
  }
  const workingTime = require('./working-time');
  const shape = entries.map((e) => ({
    type: e.type, start: e.start, end: e.end,
    spansMidnight: e.spansMidnight, daysOfWeek: e.daysOfWeek, enabled: e.enabled,
  }));
  for (let d = 0; d < 7; d += 1) {
    if (workingTime.spansFromEntries(d, shape).length) return null;
  }
  return { type: 'non_recording', ids: [], message: 'The non-recording windows cover every recording window, so no time will be tracked at all.' };
}

function warningsFor(entries) {
  const out = overlapWarnings(entries);
  const silent = silenceWarning(entries);
  if (silent) out.unshift(silent);
  return out;
}

// --- writing ----------------------------------------------------------------

const nextOrder = () => (cache.length ? Math.max(...cache.map((e) => e.sortOrder)) + 1 : 0);

async function create(db, input, userId) {
  const checked = validate(input);
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO recording_hour_configs
       (id, type, label, start_min, end_min, spans_midnight, days_of_week, enabled, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, v.type, v.label || null, v.start, v.end, v.spansMidnight ? 1 : 0,
      v.daysOfWeek.join(','), v.enabled ? 1 : 0, nextOrder(), userId || null]
  );
  await load(db);
  return { ok: true, entry: list().find((e) => e.id === id), warnings: warningsFor(cache) };
}

async function update(db, id, input) {
  const current = cache.find((e) => e.id === id);
  if (!current) return { ok: false, status: 404, errors: [{ field: null, message: 'That window no longer exists.' }] };
  const checked = validate(input, { partial: true, current });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  await db.query(
    `UPDATE recording_hour_configs
        SET type = $1, label = $2, start_min = $3, end_min = $4, spans_midnight = $5,
            days_of_week = $6, enabled = $7
      WHERE id = $8`,
    [v.type, v.label || null, v.start, v.end, v.spansMidnight ? 1 : 0,
      v.daysOfWeek.join(','), v.enabled ? 1 : 0, id]
  );
  await load(db);
  return { ok: true, before: current, entry: list().find((e) => e.id === id), warnings: warningsFor(cache) };
}

async function remove(db, id) {
  const current = cache.find((e) => e.id === id);
  if (!current) return { ok: false, status: 404, errors: [{ field: null, message: 'That window no longer exists.' }] };
  await db.query('DELETE FROM recording_hour_configs WHERE id = $1', [id]);
  await load(db);
  return { ok: true, before: current, warnings: warningsFor(cache) };
}

/* Does the named set still say only what the old Working Hours form could say?
 *
 * One recording window on some set of days, with blackouts that apply every day
 * and sit inside it. That is exactly the old four-time-pair form, and while the
 * windows are still in that shape the old screen and the old endpoint can go on
 * describing them without losing anything.
 *
 * The moment somebody adds a second recording window, a night shift or a
 * weekday-only blackout, the old form can no longer say what the schedule is —
 * and a write through it would silently throw the rest away. So it stops being
 * a write and becomes a read, which is what the Settings screen tells the
 * reader in as many words.
 */
function isSimpleShape() {
  const recording = cache.filter((e) => e.type === 'recording');
  if (recording.length !== 1) return false;
  if (recording[0].spansMidnight || !recording[0].enabled) return false;
  return cache
    .filter((e) => e.type === 'non_recording')
    .every((e) => !e.spansMidnight && e.daysOfWeek.length === 7 && e.enabled);
}

/* The old form's values, written into the named windows.
 *
 * WHY THIS EXISTS rather than the old endpoint simply being retired. The named
 * windows are the schedule now, but PUT /api/branding/schedule is what every
 * existing caller uses — the Settings screen before this release, the test
 * suite, and anything a studio has wired up itself. Refusing all of those
 * outright would break working integrations to make a point about which table
 * is authoritative.
 *
 * So the old endpoint keeps working, and keeps ONE source of truth, by writing
 * through to here. It is refused only when the windows have outgrown what it
 * can express (see isSimpleShape) — at which point silently accepting it would
 * be the destructive option, not the kind one.
 */
async function syncFromLegacy(db, schedule, userId = null) {
  if (!isSimpleShape() && cache.length) return false;
  const days = (schedule.workingDays || []).join(',') || '1,2,3,4,5';
  const keep = cache.find((e) => e.type === 'recording');
  await db.query("DELETE FROM recording_hour_configs WHERE type IN ('recording','non_recording')");

  const rows = [];
  const start = Number(schedule.dayStart);
  const end = Number(schedule.dayEnd);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    rows.push(['recording', (keep && keep.label) || 'Core hours', start, end, days]);
  }
  for (const b of schedule.breaks || []) {
    if (!(Number(b.end) > Number(b.start))) continue;
    rows.push(['non_recording', b.label || 'Break', Number(b.start), Number(b.end), '1,2,3,4,5,6,7']);
  }
  let order = 0;
  for (const [type, label, from, to, dow] of rows) {
    await db.query(
      `INSERT INTO recording_hour_configs
         (id, type, label, start_min, end_min, spans_midnight, days_of_week, enabled, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 1, $7, $8)`,
      [crypto.randomUUID(), type, label, from, to, dow, order += 1, userId]
    );
  }
  await load(db);
  return true;
}

/* One line a person reads, for the audit trail: "Core hours 09:30–19:00,
   Mon/Tue/Wed/Thu/Fri". The same sentence before and after a change is what
   makes the log worth keeping. */
function summarise(entry) {
  if (!entry) return 'none';
  const days = entry.daysOfWeek.length === 7 ? 'every day' : entry.daysOfWeek.map((d) => DAY_SHORT[d]).join('/');
  const name = entry.label ? `${entry.label} ` : '';
  const midnight = entry.spansMidnight ? ' (crosses midnight)' : '';
  const off = entry.enabled ? '' : ' [off]';
  return `${name}${clockLabel(entry.start)}–${clockLabel(entry.end)}${midnight}, ${days}${off}`;
}

const typeLabel = (type) => (type === 'recording' ? 'Recording Hours' : 'Non-Recording Hours');

module.exports = {
  TYPES, ALL_DAYS, DAY_NAMES, DAY_SHORT,
  parseClock, clockLabel, parseDays,
  load, isLoaded, list, entriesForSchedule, isSeeded: () => seeded,
  validate, warningsFor, overlapWarnings, isSimpleShape, syncFromLegacy,
  create, update, remove, summarise, typeLabel,
};
