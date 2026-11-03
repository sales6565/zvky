/* THE TIMESHEET DOWNLOAD — two routes, one of which hands over a file.
 *
 * ===========================================================================
 * MOUNTED AT /api/timesheet (singular) rather than beside the Timesheet tab's
 * own /api/timesheets, which is what the brief asks for and what keeps this
 * one's authorisation visible: every route in this file needs
 * timesheet.export AND the studio's switch, where nothing in /api/timesheets
 * does. A reader opening this file sees both checks at the top.
 *
 * THREE THINGS GUARD IT, and they answer three different questions:
 *   requirePermission('timesheet.export')  may this ROLE download at all;
 *   the studio switch                      is the feature on for anybody;
 *   readableUserIds()                      WHOSE lines may be in it — the same
 *                                          function the Timesheet tab uses, so
 *                                          a download can never contain a line
 *                                          its requester cannot open on screen.
 *
 * The third is not a permission check and is not optional: a role with
 * timesheet.export and nothing else downloads its own lines.
 */
const { asyncRouter } = require('../async-router');
const crypto = require('node:crypto');

const router = asyncRouter();
const { authenticate, requirePermission } = require('../middleware/auth');
const timesheetSettings = require('../timesheet-settings');
const exporter = require('../timesheet-export');
const writer = require('../timesheet-export-xlsx');

router.use(authenticate);
router.use(requirePermission('timesheet.export'));

/* THE SWITCH, AFTER THE PERMISSION AND BEFORE EVERYTHING ELSE.
 *
 * 403 rather than 409: the page hides the button when the switch is off, so a
 * request arriving here is either a stale tab or somebody who kept the URL, and
 * "you cannot do this" is the honest answer to both. The sentence says where it
 * is switched on, because the person reading it may well be the one who can. */
router.use((req, res, next) => {
  if (timesheetSettings.current().exportEnabled) return next();
  return res.status(403).json({
    error: 'The timesheet download is switched off for this studio. A Super Admin can turn it '
      + 'on in Settings → Time Sheet.',
    code: 'export_disabled',
  });
});

/* The filters, from the query string, refused with a sentence. */
function asked(req, res) {
  const checked = exporter.validate({
    from: req.query.from, to: req.query.to, users: req.query.users,
  });
  if (!checked.ok) {
    res.status(checked.status).json({ error: checked.error, field: checked.field });
    return null;
  }
  return checked;
}

/* GET /api/timesheet/export/count — the line under the modal's controls.
 *
 * The same filters and the same joins as the download, so the number somebody
 * reads before pressing Download is the number of rows they get. Counted in
 * SQL: the whole point of this endpoint is that it is cheap enough to run on
 * every change of a date picker. */
router.get('/export/count', async (req, res) => {
  const want = asked(req, res);
  if (!want) return;
  const counted = await exporter.countFor(req.user, want);
  res.json({ ...counted, from: want.from, to: want.to, cap: exporter.MAX_ROWS });
});

/* GET /api/timesheet/export — the workbook. */
router.get('/export', async (req, res) => {
  const want = asked(req, res);
  if (!want) return;

  /* COUNTED BEFORE IT IS BUILT. The cap exists so a studio asking for a year
     gets a sentence rather than a timeout, and a cap applied after building
     the rows would have done the expensive thing first. */
  const counted = await exporter.countFor(req.user, want);
  if (counted.lines > exporter.MAX_ROWS) {
    return res.status(400).json({
      error: `That period holds ${counted.lines.toLocaleString('en-GB')} timesheet lines, and a `
        + `download covers at most ${exporter.MAX_ROWS.toLocaleString('en-GB')}. Ask for a shorter `
        + 'period — a month at a time for a studio this size.',
      field: 'to',
      lines: counted.lines,
      cap: exporter.MAX_ROWS,
    });
  }

  const { rows, people } = await exporter.rowsFor(req.user, want);
  const file = writer.build({ rows });
  const name = exporter.fileNameFor(want.from, want.to);

  /* AUDIT-LOGGED ON THE WAY OUT, and only on the way out: a refusal above
     writes nothing, because a download that did not happen is not a thing to
     record as one. Who, which period, how many people and how many lines —
     which is what somebody asking "where did this spreadsheet come from?"
     needs. */
  req.activity({
    module: 'timesheet',
    action: 'timesheet.export',
    entityType: 'report',
    entityLabel: name,
    summary: `Downloaded the timesheet report for ${want.from === want.to ? want.from
      : `${want.from} to ${want.to}`} — ${rows.length} line(s) from ${people} person(s)`,
    changes: {
      period: { from: null, to: `${want.from} .. ${want.to}` },
      lines: { from: null, to: rows.length },
      people: { from: null, to: people },
      users: { from: null, to: want.users.length ? `${want.users.length} chosen` : 'everyone visible' },
    },
  });

  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  /* NO CACHING ANYWHERE. The file holds people's hours and the page fetches it
     with a bearer token; a proxy or a back button producing yesterday's copy
     would be both wrong and a disclosure. */
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Length', String(file.length));
  /* THE BYTES' OWN CHECKSUM, as a header. The browser test compares it with the
     sha-256 of what the page saved — which is how Prompt 54's transport bug
     would have been caught the first time, rather than by a studio opening a
     truncated file. */
  res.setHeader('X-Content-SHA256', crypto.createHash('sha256').update(file).digest('hex'));
  return res.end(file);
});

module.exports = router;
