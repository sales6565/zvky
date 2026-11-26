/* THE SCHEDULE, AND THE ONE SECRET IT NEEDS TO KEEP.
 *
 * ===========================================================================
 * THE PROBLEM A SCHEDULED BACKUP HAS AND A MANUAL ONE DOES NOT.
 *
 * A manual backup gets its passphrase from the owner, who is standing there
 * typing it. A backup at two in the morning cannot. Something has to hold a
 * passphrase that nobody is present to type.
 *
 * So it is stored — ENCRYPTED with the strict mechanism (src/email-secret.js
 * with strict: true: EMAIL_ENCRYPTION_KEY and no JWT_SECRET fall-back), and
 * write-only through the API: the screen shows "set" or "not set" and nothing
 * can read it back. It is decrypted in memory by the scheduler, used, and
 * dropped.
 *
 * WHY STRICT, which is the whole reason that mode exists. The loose mode
 * borrows JWT_SECRET when EMAIL_ENCRYPTION_KEY is unset — right for the SMTP
 * password, because a studio that has not configured a key should still be able
 * to send mail. Wrong here, for two reasons that compound: JWT_SECRET SHOULD be
 * rotated, and rotating it would silently turn the scheduler's passphrase into
 * undecryptable bytes, so the nightly backup would start failing with nothing
 * pointing at the cause; and the shipped placeholder JWT_SECRET is in the
 * repository, so a deployment that has not rotated it would be encrypting the
 * key to every backup under a value anybody can read.
 *
 * ===========================================================================
 * WHAT THE OWNER IS ACCEPTING BY SWITCHING THE SCHEDULE ON, said on the screen
 * as well as here: the passphrase to the nightly packages lives on the same
 * server as the packages, encrypted under a key that also lives there. Somebody
 * who can read both the database and the environment can open those backups.
 * That is strictly worse than a passphrase that exists only in the owner's
 * head — and strictly better than no backups, which is the alternative for a
 * studio that will not remember to take one by hand. The manual path keeps the
 * stronger property for anybody who wants it.
 */
const emailSecret = require('./email-secret');
const crypt = require('./backup-crypto');

const STRICT = { strict: true };
const FREQUENCIES = ['daily', 'weekly'];
const KEEP_MIN = 1;
const KEEP_MAX = 365;

const DEFAULTS = {
  scheduleEnabled: false,
  frequency: 'daily',
  hour: 2,
  minute: 0,
  weekday: 0,
  keepLast: 7,
  includeSecrets: false,
};

/* THE SENTENCE THE SCREEN AND THE README BOTH USE. One place, so they cannot
   drift into saying different things about the same risk. */
const STORED_PASSPHRASE_WARNING =
  'A scheduled backup cannot ask anybody for a passphrase at two in the morning, so this one is '
  + 'stored — encrypted with EMAIL_ENCRYPTION_KEY, write-only, and never shown again. That means '
  + 'the key to the nightly packages lives on the same server as the packages. It is weaker than a '
  + 'passphrase only you know, and far better than no backups at all. Backups you take by hand '
  + 'keep the stronger property.';

async function row(db) {
  const { rows } = await db.query('SELECT * FROM backup_settings WHERE id = 1');
  if (rows.length) return rows[0];
  /* A deployment whose migration has not run, or a row somebody deleted. The
     defaults ARE the shipped configuration, so answering them is honest. */
  await db.query('INSERT IGNORE INTO backup_settings (id, schedule_enabled) VALUES (1, 0)')
    .catch(() => {});
  const { rows: again } = await db.query('SELECT * FROM backup_settings WHERE id = 1');
  return again[0] || null;
}

/* What the screen is shown. NO PASSPHRASE, encrypted or otherwise — only
   whether one is set, when and by whom. */
async function current(db) {
  const r = await row(db);
  if (!r) {
    return { ...DEFAULTS, passphraseSet: false, encryptionAvailable: emailSecret.available(STRICT) };
  }
  return {
    scheduleEnabled: r.schedule_enabled !== 0,
    frequency: r.frequency,
    hour: Number(r.hour),
    minute: Number(r.minute),
    weekday: Number(r.weekday),
    keepLast: Number(r.keep_last),
    includeSecrets: r.include_secrets !== 0,
    passphraseSet: Boolean(r.passphrase_enc),
    passphraseSetAt: r.passphrase_set_at || null,
    passphraseSetBy: r.passphrase_set_by || null,
    lastRunSlot: r.last_run_slot || null,
    lastRunAt: r.last_run_at || null,
    updatedAt: r.updated_at || null,
    updatedBy: r.updated_by || null,
    /* Whether a passphrase COULD be stored at all on this deployment, so the
       screen can explain a refusal before somebody types one. */
    encryptionAvailable: emailSecret.available(STRICT),
    warning: STORED_PASSPHRASE_WARNING,
  };
}

function validate(patch) {
  const out = {};
  if (patch.scheduleEnabled !== undefined) out.scheduleEnabled = Boolean(patch.scheduleEnabled);

  if (patch.frequency !== undefined) {
    const freq = String(patch.frequency || '').toLowerCase();
    if (!FREQUENCIES.includes(freq)) {
      return { ok: false, status: 400, field: 'frequency',
        error: `A schedule is ${FREQUENCIES.join(' or ')} — not "${patch.frequency}".` };
    }
    out.frequency = freq;
  }

  if (patch.hour !== undefined) {
    const hour = Number(patch.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { ok: false, status: 400, field: 'hour', error: 'The hour is 0 to 23.' };
    }
    out.hour = hour;
  }
  if (patch.minute !== undefined) {
    const minute = Number(patch.minute);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return { ok: false, status: 400, field: 'minute', error: 'The minute is 0 to 59.' };
    }
    out.minute = minute;
  }
  if (patch.weekday !== undefined) {
    const weekday = Number(patch.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, status: 400, field: 'weekday',
        error: 'The day of the week is 0 (Sunday) to 6 (Saturday).' };
    }
    out.weekday = weekday;
  }
  if (patch.keepLast !== undefined) {
    const keep = Number(patch.keepLast);
    if (!Number.isInteger(keep) || keep < KEEP_MIN || keep > KEEP_MAX) {
      return { ok: false, status: 400, field: 'keepLast',
        error: `Keep between ${KEEP_MIN} and ${KEEP_MAX} backups.` };
    }
    out.keepLast = keep;
  }
  if (patch.includeSecrets !== undefined) out.includeSecrets = Boolean(patch.includeSecrets);

  return { ok: true, patch: out };
}

async function save(db, patch, actor) {
  const checked = validate(patch || {});
  if (!checked.ok) return checked;
  const before = await current(db);

  /* A SCHEDULE CANNOT BE SWITCHED ON WITHOUT A PASSPHRASE TO USE. Refused here
     rather than discovered at two in the morning by a job that fails. */
  const wantEnabled = checked.patch.scheduleEnabled === undefined
    ? before.scheduleEnabled : checked.patch.scheduleEnabled;
  if (wantEnabled && !before.passphraseSet && !patch.passphrase) {
    return { ok: false, status: 400, field: 'passphrase',
      error: 'Set the passphrase the scheduled backups will use before switching the schedule on. '
        + 'Without one there is nothing to encrypt them with.' };
  }

  const sets = [];
  const params = [];
  const column = {
    scheduleEnabled: 'schedule_enabled', frequency: 'frequency', hour: 'hour',
    minute: 'minute', weekday: 'weekday', keepLast: 'keep_last', includeSecrets: 'include_secrets',
  };
  for (const [key, value] of Object.entries(checked.patch)) {
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    sets.push(`${column[key]} = $${params.length}`);
  }

  /* THE PASSPHRASE, IF ONE WAS SENT. Never stored in clear and never compared:
     there is nothing to compare it to, because nothing reads it back. */
  if (patch.passphrase !== undefined && patch.passphrase !== null && String(patch.passphrase) !== '') {
    if (!emailSecret.available(STRICT)) {
      return { ok: false, status: 409, field: 'passphrase',
        error: 'Set EMAIL_ENCRYPTION_KEY and restart before storing a scheduler passphrase. '
          + 'JWT_SECRET is deliberately not accepted for it: rotating JWT_SECRET signs everybody '
          + 'out, which is an inconvenience, and would silently make every scheduled backup '
          + 'unopenable, which is not.' };
    }
    const strong = crypt.strength(patch.passphrase);
    if (!strong.ok) {
      return { ok: false, status: 400, field: 'passphrase', error: strong.message };
    }
    const sealed = emailSecret.encrypt(String(patch.passphrase), STRICT);
    if (!sealed.ok) {
      return { ok: false, status: 409, field: 'passphrase', error: sealed.error };
    }
    params.push(sealed.value);
    sets.push(`passphrase_enc = $${params.length}`);
    /* THE KEY'S FINGERPRINT BESIDE IT, the way src/server-settings.js stores
       its two secrets: it is what turns a rotated EMAIL_ENCRYPTION_KEY into
       "set the passphrase again" instead of an unreadable failure at two in
       the morning. */
    params.push(emailSecret.currentFingerprint(STRICT) || null);
    sets.push(`passphrase_fp = $${params.length}`);
    sets.push('passphrase_set_at = NOW()');
    params.push(actor ? actor.email : null);
    sets.push(`passphrase_set_by = $${params.length}`);
  }

  if (!sets.length) return { ok: true, settings: before, unchanged: true };

  params.push(actor ? actor.email : null);
  sets.push(`updated_by = $${params.length}`);

  await db.query(`UPDATE backup_settings SET ${sets.join(', ')} WHERE id = 1`, params);
  const after = await current(db);

  /* WHAT CHANGED, for the audit entry — and the passphrase is reported as the
     FACT that it was replaced, never as a value or a length. */
  const changes = {};
  for (const key of Object.keys(checked.patch)) {
    if (String(before[key]) !== String(after[key])) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  if (patch.passphrase) changes.passphrase = { from: before.passphraseSet ? 'set' : 'not set', to: 'set' };

  return { ok: true, settings: after, changes };
}

/* THE SCHEDULER'S OWN READ, and the only thing in the application that gets the
   passphrase back. Not exported through any route; the route module does not
   even import it. */
async function passphraseForScheduler(db) {
  const r = await row(db);
  if (!r || !r.passphrase_enc) return null;
  const out = emailSecret.decrypt(r.passphrase_enc, r.passphrase_fp, STRICT);
  if (out.ok) return out.value;
  /* A KEY THAT HAS CHANGED is the one failure worth naming precisely: the value
     is still there and no longer readable, so the answer is null and a log line
     that says what to do about it. The scheduler turns that into a failed run
     with the same sentence, which is how the owner finds out at all. */
  console.warn(`[backup] the stored scheduler passphrase cannot be read (${out.reason || 'unknown'}) `
    + '— set it again in Settings → Backup.');
  return null;
}

/* ===========================================================================
 * WHICH SLOT IS DUE, which is how running twice is made impossible.
 *
 * A slot is a STRING: 'daily-2026-11-26' or 'weekly-2026-W48'. The row records
 * the last slot that ran. A tick computes the slot it is in, compares, and only
 * runs when they differ — then writes the new slot before doing the work.
 *
 * WHY A STRING AND NOT A TIMESTAMP COMPARISON. Two processes ticking a second
 * apart both see "the last run was yesterday" and both start. With a slot, the
 * write is a conditional UPDATE on the old value, so exactly one of them
 * changes a row and the other gets zero rows affected and stands down. The
 * database does the arbitration, which is the only arbiter both processes
 * share.
 *
 * THE STUDIO'S CLOCK is the server's local time, which is what the owner means
 * by "two in the morning" and what every other schedule in this application
 * already uses.
 */
function slotFor(settings, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  if (settings.frequency === 'weekly') {
    /* ISO week, so a weekly slot does not change meaning at new year. */
    const d = new Date(when.getFullYear(), when.getMonth(), when.getDate());
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day + 3);
    const firstThursday = new Date(d.getFullYear(), 0, 4);
    const week = 1 + Math.round(
      ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7
    );
    return `weekly-${d.getFullYear()}-W${pad(week)}`;
  }
  return `daily-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/* Is the configured time of day past, within this slot? */
function due(settings, when = new Date()) {
  if (!settings.scheduleEnabled) return { due: false, reason: 'the schedule is off' };
  if (!settings.passphraseSet) return { due: false, reason: 'no passphrase is stored' };
  if (settings.frequency === 'weekly' && when.getDay() !== settings.weekday) {
    return { due: false, reason: 'not the configured day' };
  }
  const minutes = when.getHours() * 60 + when.getMinutes();
  const wanted = settings.hour * 60 + settings.minute;
  if (minutes < wanted) return { due: false, reason: 'not yet the configured time' };
  const slot = slotFor(settings, when);
  if (settings.lastRunSlot === slot) return { due: false, reason: 'already run for this slot', slot };
  return { due: true, slot };
}

/* CLAIM THE SLOT, and the conditional UPDATE is the whole of the two-process
   safety. Answers true to exactly one caller. */
async function claimSlot(db, slot) {
  const { result } = await db.query(
    `UPDATE backup_settings
        SET last_run_slot = $1, last_run_at = NOW()
      WHERE id = 1 AND (last_run_slot IS NULL OR last_run_slot <> $1)`,
    [slot]
  );
  return Boolean(result && result.affectedRows);
}

module.exports = {
  DEFAULTS, FREQUENCIES, KEEP_MIN, KEEP_MAX, STORED_PASSPHRASE_WARNING,
  current, save, validate, passphraseForScheduler, slotFor, due, claimSlot,
};
