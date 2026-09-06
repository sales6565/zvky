/* The dated stages inside a project: Art from here to here, Animation from
 * there to there.
 *
 * WHAT A MILESTONE IS. A type from the studio's own Milestone Types list, and a
 * pair of dates. Nothing else, and nothing in the pipeline reads it — a
 * milestone that ended last week does not warn, block or move anything, in the
 * same way the project's own Start and End Dates do not. These are for planning
 * and for reading off a list, and that is written here so a later reader does
 * not take the absence of a rule for an oversight.
 *
 * THE ONE RULE THAT IS NOT A REFUSAL. A milestone outside the project's own
 * dates is a WARNING, not an error: the save goes through and the caller is
 * told. That is deliberate and it is the only date check in this application
 * that behaves that way, so it is worth saying why. Project dates are optional
 * and they move — a project slips a month, and the Art milestone that was
 * inside its window on Monday is outside it on Friday. Refusing the save would
 * mean the person who moved the project date could not save the project at all
 * until they had also fixed every milestone under it, in a form that shows them
 * one at a time. A start date after its own end date is different: that is not
 * a plan that has drifted, it is a plan that cannot happen, so it is refused
 * like every other date pair in this app.
 */
const { v4: uuid } = require('uuid');
const referenceData = require('./reference-data');
const assetSchedule = require('./asset-schedule');

// One project cannot carry an unbounded number of these — the column they draw
// stacks one line per milestone, and a row eighty lines tall is not a table.
// Well above anything a studio would plan, and low enough to be a bound.
const MAX_PER_PROJECT = 20;

/* Check a submitted set, whole.
 *
 * Takes the list as the browser sends it and the project's own two dates, and
 * answers with either a refusal or the rows to store plus any warnings. The
 * whole set at once rather than one at a time, because "no two milestones of
 * the same type" is a fact about the set and cannot be checked from inside one.
 *
 * Returns { ok:false, error, field } or { ok:true, milestones:[…], warnings:[…] }.
 */
function validate(list, { startDate = null, endDate = null } = {}) {
  if (list === undefined || list === null) return { ok: true, milestones: null, warnings: [] };
  if (!Array.isArray(list)) {
    return { ok: false, field: 'milestones', error: 'Milestones must be a list.' };
  }
  if (list.length > MAX_PER_PROJECT) {
    return { ok: false, field: 'milestones',
      error: `A project can hold ${MAX_PER_PROJECT} milestones. This one has ${list.length}.` };
  }

  const projectStart = assetSchedule.asISODate(startDate);
  const projectEnd = assetSchedule.asISODate(endDate);

  const milestones = [];
  const warnings = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const type = raw.type === undefined || raw.type === null ? '' : String(raw.type).trim();

    if (!type) {
      return { ok: false, field: `milestones.${i}.type`, error: 'Pick a milestone type.' };
    }
    /* Against the milestone list, never the asset type one. "Animation" is in
       both, so reading the wrong collection here would appear to work and would
       accept a type nobody put on this list. */
    const entry = referenceData.get('milestone_types', type);
    if (!entry || !entry.isActive) {
      return { ok: false, field: `milestones.${i}.type`,
        error: `"${type}" is not a milestone type. Add it in Settings first, or pick one from the list.` };
    }
    if (seen.has(type)) {
      return { ok: false, field: `milestones.${i}.type`,
        error: `This project already has a ${entry.label} milestone. One of each per project — `
          + 'change the dates on the existing one, or use a different type.' };
    }
    seen.add(type);

    /* Both dates required. A milestone is a stretch of the calendar; one with
       no dates draws as a label and a dash, which tells a reader nothing the
       absence of the row would not have told them. */
    const start = assetSchedule.asISODate(raw.startDate);
    const end = assetSchedule.asISODate(raw.endDate);
    if (!start) {
      return { ok: false, field: `milestones.${i}.startDate`,
        error: `The ${entry.label} milestone needs a start date.` };
    }
    if (!end) {
      return { ok: false, field: `milestones.${i}.endDate`,
        error: `The ${entry.label} milestone needs an end date.` };
    }
    if (start > end) {
      return { ok: false, field: `milestones.${i}.startDate`,
        error: `The ${entry.label} milestone starts on ${start} and ends on ${end}. `
          + 'It cannot end before it begins.' };
    }

    // The soft half. Said, not refused — see the note at the top of this file.
    if (projectStart && start < projectStart) {
      warnings.push({
        type,
        label: entry.label,
        message: `${entry.label} starts on ${start}, before the project's own start date of ${projectStart}.`,
      });
    }
    if (projectEnd && end > projectEnd) {
      warnings.push({
        type,
        label: entry.label,
        message: `${entry.label} ends on ${end}, after the project's own end date of ${projectEnd}.`,
      });
    }

    milestones.push({ type, label: entry.label, startDate: start, endDate: end });
  }

  /* Stored in the order the list itself is ordered in Settings, not the order
     somebody happened to add the rows in. Two projects with an Art and an
     Animation milestone then read the same way down the column, which is what
     makes a column scannable. */
  milestones.sort((a, b) => positionOf(b.type) - positionOf(a.type) || a.label.localeCompare(b.label));

  return { ok: true, milestones, warnings };
}

function positionOf(type) {
  const entry = referenceData.get('milestone_types', type);
  return entry ? Number(entry.position) || 0 : 0;
}

/* Replace a project's whole set.
 *
 * Delete-then-insert rather than a diff, because the form submits the whole set
 * every time: what is not in the list is what somebody removed. A diff would be
 * more code to reach the same state, and would have to decide what an absent
 * row means — which is the question the form has already answered.
 */
async function replaceFor(db, projectId, milestones) {
  await db.query('DELETE FROM project_milestones WHERE project_id = $1', [projectId]);
  if (!milestones || !milestones.length) return;
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    await db.query(
      `INSERT INTO project_milestones (id, project_id, milestone_type, start_date, end_date, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuid(), projectId, m.type, m.startDate, m.endDate, milestones.length - i]
    );
  }
}

/* Every milestone on every one of these projects, in one query.
 *
 * One query rather than one per project: the Projects list draws a whole
 * client's worth of rows at once, and a studio with sixty projects would
 * otherwise make sixty round trips to fill one column.
 *
 * Labels are resolved here rather than in the browser. The browser holds the
 * milestone type list for its dropdowns and could label them itself — but this
 * payload is also what an export or a second reader would use, and a key is not
 * a thing a person reads.
 */
async function forProjects(db, projectIds) {
  const byProject = new Map();
  const ids = (projectIds || []).filter(Boolean);
  if (!ids.length) return byProject;

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT project_id, milestone_type, start_date, end_date, position
       FROM project_milestones
      WHERE project_id IN (${placeholders})
      ORDER BY position DESC, milestone_type ASC`,
    ids
  ).catch((err) => {
    /* A deployment whose milestone table could not be created still gets its
       Projects list. The column reads as empty, which is what a project with no
       milestones looks like anyway — losing the whole screen to a missing table
       would be the worse failure. */
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    console.warn('[milestones] project_milestones unavailable — the Milestones column will be empty. See /api/health.');
    return { rows: [] };
  });

  for (const row of rows) {
    const entry = referenceData.get('milestone_types', row.milestone_type);
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id).push({
      type: row.milestone_type,
      /* A type retired in Settings after a project used it still has to read as
         something. The key, tidied, rather than a blank — the milestone is
         still there and its dates still mean what they meant. */
      label: entry ? entry.label : String(row.milestone_type).replace(/_/g, ' '),
      color: entry ? entry.color : null,
      retired: !entry || !entry.isActive,
      startDate: row.start_date || null,
      endDate: row.end_date || null,
    });
  }
  return byProject;
}

module.exports = { validate, replaceFor, forProjects, MAX_PER_PROJECT };
