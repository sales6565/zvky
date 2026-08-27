// Reference data: the value lists behind the dropdowns — asset types,
// priorities and roles — held in tables a Super Admin can manage instead of
// arrays that need a code change.
//
// Everything is mirrored in memory. The permission checks call roleDef() on
// every request, from inside functions that are not async, so making them wait
// on a query would mean rewriting the permission layer. The cache is loaded at
// startup and reloaded on every write, which is cheap: these are three small
// tables that change a few times a year.

const { v4: uuid } = require('uuid');
const { isTier, capabilitiesForTier, TIERS } = require('./role-tiers');

// --- what each collection is -------------------------------------------------
// `usedBy` is how deletion decides whether a value is still in use. Nothing is
// deleted out from under existing records.
const COLLECTIONS = {
  asset_types: {
    table: 'asset_types',
    singular: 'asset type',
    // Columns beyond the ones every collection has.
    extra: ['code_prefix', 'color'],
    usedBy: { table: 'assets', column: '`type`' },
  },
  priorities: {
    table: 'priorities',
    singular: 'priority',
    extra: ['color'],
    usedBy: { table: 'assets', column: 'priority' },
  },
  // Starts empty and is filled in Settings; an asset with no category is
  // normal, so nothing here treats an empty list as a broken one.
  categories: {
    table: 'categories',
    singular: 'category',
    extra: ['color'],
    usedBy: { table: 'assets', column: 'category' },
  },
  roles: {
    table: 'roles',
    singular: 'role',
    extra: ['group_name', 'tier', 'color'],
    usedBy: { table: 'users', column: '`role`' },
  },
};

const COLLECTION_NAMES = Object.keys(COLLECTIONS);

let cache = Object.fromEntries(COLLECTION_NAMES.map((name) => [name, []]));
let loaded = false;

// --- keys --------------------------------------------------------------------
// A label is what people read; a key is what the database stores and existing
// rows already hold. Keys are generated once, on creation, and never change —
// renaming a value must not orphan the records using it.
function toKey(label) {
  return String(label)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// CHR from "Character", ENV from "Environment". Asset codes are built from it.
function toCodePrefix(label) {
  const letters = String(label).toUpperCase().replace(/[^A-Z]/g, '');
  return (letters.slice(0, 3) || 'AST');
}

// --- shaping rows for consumers ---------------------------------------------
function shape(name, row) {
  const base = {
    id: row.id,
    key: row.key,
    label: row.label,
    color: row.color || null,
    position: Number(row.position) || 0,
    isActive: Boolean(row.is_active),
    isSystem: Boolean(row.is_system),
  };
  if (name === 'asset_types') return { ...base, codePrefix: row.code_prefix };
  if (name === 'roles') {
    const capabilities = capabilitiesForTier(row.tier) || capabilitiesForTier('staff');
    return {
      ...base,
      group: row.group_name,
      tier: row.tier,
      tierLabel: (TIERS[row.tier] || {}).label || row.tier,
      rank: Number(row.position) || 0,
      ...capabilities,
    };
  }
  return base;
}

// --- loading -----------------------------------------------------------------
//
// The mirror is per-process, so anything that changes these tables by another
// route is invisible here until it is reloaded: a SQL script, `npm run seed`, a
// migration — and, on any host that runs more than one Node worker, a write
// made through a sibling worker. That last one is the common case in
// production, and it does not resolve itself: two workers serve two different
// lists indefinitely.
//
// So loading is no longer only a startup step. refresh() below is called
// whenever an answer has to be authoritative, and on a timer as a backstop.
let lastLoadedAt = 0;

async function load(db) {
  for (const name of COLLECTION_NAMES) {
    const { rows } = await db.query(
      `SELECT * FROM ${COLLECTIONS[name].table} ORDER BY position DESC, label`
    );
    cache[name] = rows.map((row) => shape(name, row));
  }
  loaded = true;
  lastLoadedAt = Date.now();
  return cache;
}

// Reload, collapsing concurrent callers onto one query.
//
// The Settings page asks for all three lists at once and every one of them
// wants fresh data; without this that is three identical round trips. Sharing
// the in-flight promise makes it one, and keeps a burst of role-lookup misses
// from turning into a burst of queries.
let inFlight = null;

function refresh(db) {
  if (inFlight) return inFlight;
  inFlight = load(db).finally(() => { inFlight = null; });
  return inFlight;
}

// Reload, and say whether anything actually changed. Used by the background
// refresh so a quiet studio logs nothing.
async function refreshIfChanged(db) {
  const before = COLLECTION_NAMES.map((name) => `${name}:${(cache[name] || []).length}`).join('|');
  await refresh(db);
  const after = COLLECTION_NAMES.map((name) => `${name}:${(cache[name] || []).length}`).join('|');
  return before !== after;
}

function isLoaded() {
  return loaded;
}

function loadedAt() {
  return lastLoadedAt;
}

// Used by the tests and by anything that needs to run without a database.
function seedCache(name, entries) {
  cache[name] = entries;
  loaded = true;
}

// --- reading -----------------------------------------------------------------
// Dropdowns show active values only; lookups must still resolve a deactivated
// one, or every record already using it would render as unknown.
function list(name, { includeInactive = false } = {}) {
  const all = cache[name] || [];
  return includeInactive ? all.slice() : all.filter((e) => e.isActive);
}

function get(name, key) {
  return (cache[name] || []).find((e) => e.key === key) || null;
}

function keys(name, options) {
  return list(name, options).map((e) => e.key);
}

// --- validation --------------------------------------------------------------
function validate(name, payload, { existingKey = null } = {}) {
  const errors = [];
  const label = String(payload.label ?? '').trim();

  if (!label) errors.push({ field: 'label', message: 'Name is required.' });
  if (label.length > 100) errors.push({ field: 'label', message: 'Name must be 100 characters or fewer.' });

  // Duplicates are compared case-insensitively and trimmed, against both the
  // label people see and the key the database stores.
  const clash = (cache[name] || []).find(
    (e) => e.key !== existingKey && e.label.trim().toLowerCase() === label.toLowerCase()
  );
  if (label && clash) {
    errors.push({ field: 'label', message: `"${clash.label}" already exists${clash.isActive ? '' : ' (deactivated — reactivate it instead)'}.` });
  }

  if (name === 'roles') {
    const tier = String(payload.tier ?? '').trim();
    if (!tier) errors.push({ field: 'tier', message: 'Pick what this role can do.' });
    else if (!isTier(tier)) errors.push({ field: 'tier', message: 'That is not a known tier.' });
    else if (TIERS[tier].system) {
      errors.push({ field: 'tier', message: `The ${TIERS[tier].label} tier cannot be assigned to a new role.` });
    }
    if (!String(payload.group ?? '').trim()) {
      errors.push({ field: 'group', message: 'Pick or name a group for this role.' });
    }
  }

  if (name === 'asset_types') {
    const prefix = String(payload.codePrefix ?? '').trim().toUpperCase();
    if (prefix && !/^[A-Z]{1,6}$/.test(prefix)) {
      errors.push({ field: 'codePrefix', message: 'Code prefix must be 1-6 letters.' });
    }
    const prefixClash = (cache[name] || []).find(
      (e) => e.key !== existingKey && prefix && e.codePrefix === prefix
    );
    if (prefixClash) {
      errors.push({ field: 'codePrefix', message: `Prefix ${prefix} is already used by "${prefixClash.label}".` });
    }
  }

  const color = payload.color === undefined || payload.color === null || payload.color === ''
    ? null
    : String(payload.color).trim();
  if (color && !/^#[0-9a-f]{3,8}$/i.test(color)) {
    errors.push({ field: 'color', message: 'Colour must be a hex value such as #4db8ff.' });
  }

  return errors;
}

// --- how many records use this value ----------------------------------------
async function usageCount(db, name, key) {
  const { usedBy } = COLLECTIONS[name];
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM ${usedBy.table} WHERE ${usedBy.column} = $1`,
    [key]
  );
  return Number(rows[0].n);
}

// --- writing -----------------------------------------------------------------
async function create(db, name, payload) {
  const errors = validate(name, payload);
  if (errors.length) return { ok: false, status: 400, errors };

  const label = String(payload.label).trim();
  let key = toKey(label);
  if (!key) return { ok: false, status: 400, errors: [{ field: 'label', message: 'Name must contain a letter or number.' }] };
  // A label that reduces to a key already taken by a different label (renamed
  // since) still needs a key of its own.
  if (get(name, key)) {
    let n = 2;
    while (get(name, `${key}_${n}`)) n++;
    key = `${key}_${n}`;
  }

  const color = payload.color ? String(payload.color).trim() : null;
  const position = Number.isFinite(Number(payload.position)) ? Number(payload.position) : 50;
  const id = uuid();

  if (name === 'asset_types') {
    const prefix = (String(payload.codePrefix ?? '').trim().toUpperCase()) || toCodePrefix(label);
    await db.query(
      'INSERT INTO asset_types (id, `key`, label, code_prefix, color, position, is_active, is_system) VALUES ($1,$2,$3,$4,$5,$6,1,0)',
      [id, key, label, prefix, color, position]
    );
  } else if (name === 'priorities' || name === 'categories') {
    // Both are label, colour and position and nothing else, so they share the
    // insert rather than each having a near-identical branch.
    await db.query(
      `INSERT INTO ${COLLECTIONS[name].table} (id, \`key\`, label, color, position, is_active, is_system) VALUES ($1,$2,$3,$4,$5,1,0)`,
      [id, key, label, color, position]
    );
  } else {
    await db.query(
      'INSERT INTO roles (id, `key`, label, group_name, tier, color, position, is_active, is_system) VALUES ($1,$2,$3,$4,$5,$6,$7,1,0)',
      [id, key, label, String(payload.group).trim(), String(payload.tier).trim(), color, position]
    );
  }

  await load(db);
  return { ok: true, status: 201, entry: get(name, key) };
}

async function update(db, name, key, payload) {
  const current = get(name, key);
  if (!current) return { ok: false, status: 404, errors: [{ message: 'That value does not exist.' }] };

  // Renaming is fine; the key stays, so records already using it are untouched.
  const merged = {
    label: payload.label !== undefined ? payload.label : current.label,
    color: payload.color !== undefined ? payload.color : current.color,
    tier: payload.tier !== undefined ? payload.tier : current.tier,
    group: payload.group !== undefined ? payload.group : current.group,
    codePrefix: payload.codePrefix !== undefined ? payload.codePrefix : current.codePrefix,
    position: payload.position !== undefined ? payload.position : current.position,
  };

  const errors = validate(name, merged, { existingKey: key });
  // A system value's tier is what makes it that value; changing it would turn
  // the Super Admin role into something else while people are signed in as it.
  if (current.isSystem && payload.tier !== undefined && payload.tier !== current.tier) {
    errors.push({ field: 'tier', message: 'A built-in role cannot change what it can do.' });
  }
  if (errors.length) return { ok: false, status: 400, errors };

  const sets = ['label = $1', 'color = $2', 'position = $3'];
  const values = [String(merged.label).trim(), merged.color || null, Number(merged.position) || 0];
  if (name === 'asset_types') {
    sets.push('code_prefix = $4');
    values.push(String(merged.codePrefix || toCodePrefix(merged.label)).toUpperCase());
  } else if (name === 'roles') {
    sets.push('group_name = $4', 'tier = $5');
    values.push(String(merged.group).trim(), String(merged.tier).trim());
  }
  if (payload.isActive !== undefined) {
    if (current.isSystem && !payload.isActive) {
      return { ok: false, status: 400, errors: [{ field: 'isActive', message: 'A built-in value cannot be deactivated.' }] };
    }
    sets.push(`is_active = $${values.length + 1}`);
    values.push(payload.isActive ? 1 : 0);
  }
  values.push(key);

  await db.query(
    `UPDATE ${COLLECTIONS[name].table} SET ${sets.join(', ')} WHERE \`key\` = $${values.length}`,
    values
  );
  await load(db);
  return { ok: true, status: 200, entry: get(name, key) };
}

// Deleting is only allowed when nothing uses the value. Anything in use is
// deactivated instead: it disappears from the dropdowns while every record
// already holding it keeps rendering correctly.
async function remove(db, name, key) {
  const current = get(name, key);
  if (!current) return { ok: false, status: 404, errors: [{ message: 'That value does not exist.' }] };
  if (current.isSystem) {
    return { ok: false, status: 400, errors: [{ message: `"${current.label}" is built in and cannot be deleted.` }] };
  }

  const inUse = await usageCount(db, name, key);
  if (inUse > 0) {
    return {
      ok: false,
      status: 409,
      inUse,
      errors: [{
        message: `"${current.label}" is used by ${inUse} record${inUse === 1 ? '' : 's'}. Deactivate it instead — it will disappear from the dropdowns and those records will keep working.`,
      }],
    };
  }

  await db.query(`DELETE FROM ${COLLECTIONS[name].table} WHERE \`key\` = $1`, [key]);
  await load(db);
  return { ok: true, status: 200, deleted: current };
}

module.exports = {
  refresh,
  refreshIfChanged,
  loadedAt,
  COLLECTIONS,
  COLLECTION_NAMES,
  load,
  isLoaded,
  seedCache,
  list,
  get,
  keys,
  validate,
  usageCount,
  create,
  update,
  remove,
  toKey,
  toCodePrefix,
  shape,
};
