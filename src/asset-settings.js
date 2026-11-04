/* SETTINGS -> ASSET NAMES. One switch, studio-wide.
 *
 * WHY IT SHIPS ON. Every other switch in this application that ships off does
 * so because turning it on changes a number somebody is already reading
 * (leave), or because the feature cannot work until a Super Admin has installed
 * something (the office file server). Neither applies here: editing a name
 * changes a label, the people who may do it are the designations that may
 * already edit the asset, and the feature works the moment the column exists.
 * A studio finding a typo on its second day should not have to go looking in
 * Settings for permission to fix it.
 *
 * WHAT OFF MEANS, and it is the same thing it means everywhere else here:
 *
 *   no control            the pencil is not drawn, on any screen.
 *   the server refuses    PATCH /api/assets/:id/name answers 409
 *                         rename_disabled, whatever the browser believed. A page
 *                         left open across the change cannot get past it.
 *   nothing is undone     a name already changed stays changed, and its history
 *                         row stays readable. A switch that rewrote the past
 *                         would not be a switch — the same argument
 *                         src/leave-settings.js makes about existing marks.
 *
 * MIRRORED IN MEMORY like every other settings row here (work_schedule,
 * timesheet_settings, chat_settings, reminder_settings, leave_settings): one
 * row, changed a handful of times in the life of a deployment, read on every
 * /auth/me poll and every rename. load() runs at boot and again on every save,
 * so a change reaches an open browser inside the twenty-second poll with no
 * redeploy and nobody signing out.
 */

const DEFAULTS = { renameEnabled: true };

let cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
let loaded = false;

async function load(db) {
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT s.rename_enabled AS rename_enabled, s.updated_by AS by_id,
              u.\`name\` AS by_name, s.updated_at AS at
         FROM asset_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.id = 1`
    ));
  } catch {
    /* NO TABLE IS NOT "OFF". A deployment whose migration has not reached this
       step must behave as the shipped default, which is on — the alternative is
       a feature that silently does not exist on the one deployment most likely
       to have an unmigrated schema. */
    cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
    loaded = true;
    return cache;
  }
  const row = rows[0];
  cache = {
    /* NO ROW is the same answer as no table: the default. Only a row says
       otherwise, which is what makes "a Super Admin switched it off" a fact
       rather than an absence. */
    renameEnabled: row ? Boolean(Number(row.rename_enabled)) : DEFAULTS.renameEnabled,
    updatedBy: row ? row.by_id || null : null,
    updatedByName: row ? row.by_name || null : null,
    updatedAt: row ? row.at || null : null,
  };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;

/* THE ONE QUESTION EVERYTHING ASKS — never captured in a variable by a caller,
   because the switch can move while the process runs. */
const renameEnabled = () => cache.renameEnabled;

const current = () => ({
  renameEnabled: cache.renameEnabled,
  updatedBy: cache.updatedBy,
  updatedByName: cache.updatedByName || null,
  updatedAt: cache.updatedAt,
  defaults: { ...DEFAULTS },
});

/* A checkbox is not a number, so there is nothing to validate beyond "was it
   sent at all". An absent field keeps what the studio already chose rather than
   reading as false: a PUT that forgot the field must not switch a feature off. */
function validate(input) {
  const raw = (input || {}).renameEnabled;
  if (raw === undefined || raw === null) {
    return { ok: false, status: 422, errors: [{ field: 'renameEnabled',
      message: 'Say whether asset name editing is on or off.' }] };
  }
  const on = raw === true || raw === 1 || raw === '1' || raw === 'true';
  return { ok: true, value: on };
}

async function save(db, input, userId) {
  const checked = validate(input || {});
  if (!checked.ok) return { ok: false, status: checked.status, errors: checked.errors };
  const before = current();
  await db.query(
    `INSERT INTO asset_settings (id, rename_enabled, updated_by)
     VALUES (1, $1, $2)
     ON DUPLICATE KEY UPDATE rename_enabled = VALUES(rename_enabled),
                             updated_by = VALUES(updated_by)`,
    [checked.value ? 1 : 0, userId || null]
  );
  await load(db);
  return { ok: true, before, settings: current() };
}

/* One line a person reads, for the audit trail — the job timesheet-settings'
   summarise() and chat-settings' describeAttachmentPolicy() do, same reason. */
const summarise = (s) => `asset name editing ${s.renameEnabled ? 'on' : 'off'}`;

module.exports = { DEFAULTS, load, isLoaded, current, renameEnabled, validate, save, summarise };
