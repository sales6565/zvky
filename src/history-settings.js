/* THE HISTORY TAB'S OWN THREE SETTINGS.
 *
 * ===========================================================================
 * THE TAB SHIPS ON, which is the opposite of how the restrictive features in
 * this application ship and is the right way round for this one.
 *
 * src/reminder-settings.js has always argued that a feature shipping switched
 * off is one nobody finds, and the leave settings reversed their own default on
 * exactly that ground (Prompt 56). The rule this codebase has settled on is:
 * anything that STOPS somebody doing what they could do yesterday ships OFF
 * (the exact-hours rule, the entry window, requirePreviousDay), and anything
 * that only SHOWS somebody something ships ON. History shows; it refuses
 * nothing and changes no figure. So it is on, and an owner who does not want it
 * turns it off.
 *
 * ===========================================================================
 * WHY A TABLE AND NOT THREE COLUMNS ON AN EXISTING SETTINGS ROW: because
 * Settings is an accordion of sections and each section is a row somewhere, and
 * putting "History tab" into timesheet_settings would mean the timesheet's PUT
 * could silently reset the history's values and vice versa. Every other section
 * in this application owns its row for that reason.
 */
const DEFAULTS = {
  /* THE TAB ITSELF. See above for why this is on. */
  enabled: true,
  /* HOW MANY DAYS A CARD LIST STARTS WITH. Thirty is a month, which is the
     period somebody reconciles against; the floor of seven is a week, below
     which "history" is just the current timesheet with extra steps. */
  defaultDays: 30,
  /* WHETHER THE DAY'S TIMESHEET MAY BE SUBMITTED FROM A CARD. On, because the
     commonest reason to look at a day in History is that it is not finished —
     and sending somebody to another tab to press a button about the day they
     are already looking at is the kind of friction that makes people stop
     filling timesheets in. It submits through the SAME route with the SAME
     rules; it is a second door, never a second rule. */
  submitFromHistory: true,
};

const MIN_DAYS = 7;
const MAX_DAYS = 366;

let cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
let loaded = false;

const unavailable = (err) => /doesn't exist|no such table|Unknown column/i.test(
  (err && (err.sqlMessage || err.message)) || ''
);

async function load(db) {
  try {
    const { rows } = await db.query(
      `SELECT h.*, u.\`name\` AS updated_by_name
         FROM history_settings h
         LEFT JOIN users u ON u.id = h.updated_by
        WHERE h.id = 1`
    );
    const row = rows[0] || {};
    cache = {
      enabled: row.enabled === undefined || row.enabled === null
        ? DEFAULTS.enabled : Boolean(Number(row.enabled)),
      defaultDays: row.default_days === undefined || row.default_days === null
        ? DEFAULTS.defaultDays : Number(row.default_days),
      submitFromHistory: row.submit_from_history === undefined || row.submit_from_history === null
        ? DEFAULTS.submitFromHistory : Boolean(Number(row.submit_from_history)),
      updatedBy: row.updated_by || null,
      updatedByName: row.updated_by_name || null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
    loaded = true;
  } catch (err) {
    /* AN UNMIGRATED DEPLOYMENT GETS THE DEFAULTS, which is the same thing every
       other settings module does and for the same reason: a missing table is a
       migration that has not run, not a studio that has chosen something. */
    if (!unavailable(err)) throw err;
    cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
    loaded = true;
  }
  return cache;
}

const isLoaded = () => loaded;
/* MIN_DAYS AND maxAllowedDays TRAVEL WITH THE VALUES, because src/history.js
   clamps the requested range against them and should not have to require this
   module's constants separately from its values. */
const current = () => ({ ...cache, MIN_DAYS, maxAllowedDays: MAX_DAYS });
const enabled = () => Boolean(cache.enabled);
const submitFromHistory = () => Boolean(cache.submitFromHistory);
const defaultDays = () => Number(cache.defaultDays) || DEFAULTS.defaultDays;

function validate(input = {}, { existing = cache } = {}) {
  const errors = [];
  const pick = (key) => (Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined);
  const bool = (key) => {
    const v = pick(key);
    if (v === undefined || v === null || v === '') return Boolean(existing[key]);
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  };

  const enabledNow = bool('enabled');
  const submitNow = bool('submitFromHistory');

  let defaultDaysNow = existing.defaultDays;
  const raw = pick('defaultDays');
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      errors.push({ field: 'defaultDays', message: 'Days shown is a whole number of days.' });
    } else if (n < MIN_DAYS || n > MAX_DAYS) {
      errors.push({
        field: 'defaultDays',
        message: `Days shown is between ${MIN_DAYS} and ${MAX_DAYS} days.`,
      });
    } else {
      defaultDaysNow = n;
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { enabled: enabledNow, defaultDays: defaultDaysNow, submitFromHistory: submitNow },
  };
}

const clauses = (s) => [
  `History tab ${s.enabled ? 'on' : 'OFF'}`,
  `${Number(s.defaultDays) || DEFAULTS.defaultDays} day(s) shown by default`,
  `submitting from History ${s.submitFromHistory ? 'on' : 'OFF'}`,
];
const summarise = (s) => clauses(s).join('; ');

function describeChange(before, after) {
  const was = clauses(before);
  const now = clauses(after);
  const moved = now.filter((line, i) => line !== was[i]);
  return moved.length ? moved.join('; ') : 'nothing changed';
}

async function save(db, input, userId) {
  const checked = validate(input || {});
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  const v = checked.value;
  await db.query(
    `INSERT INTO history_settings (id, enabled, default_days, submit_from_history, updated_by)
     VALUES (1, $1, $2, $3, $4)
     ON DUPLICATE KEY UPDATE
       enabled = $1, default_days = $2, submit_from_history = $3, updated_by = $4`,
    [v.enabled ? 1 : 0, v.defaultDays, v.submitFromHistory ? 1 : 0, userId || null]
  );
  await load(db);
  return { ok: true, before, settings: current() };
}

module.exports = {
  DEFAULTS, MIN_DAYS, MAX_DAYS,
  load, isLoaded, current, enabled, submitFromHistory, defaultDays,
  validate, save, summarise, clauses, describeChange,
};
