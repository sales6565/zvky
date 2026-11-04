/* A DAY MUST ADD UP TO EXACTLY THE REQUIRED HOURS.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS REALLY ASSERTING, in one sentence: the figure is an
 * INTEGER NUMBER OF CENTIHOURS on both sides of every comparison, the decision
 * is made in ONE place on the SERVER, and the page can only disagree with it by
 * being out of date — never by holding its own copy of the rule.
 *
 * WHY CENTIHOURS AND NOT MINUTES. `timesheet_entries.hours` is DECIMAL(5,2), so
 * a line can be 7.99h — which is not a whole number of minutes. A rule written
 * in minutes would have to round, and a rounded comparison is not an exact one:
 * "exactly eight hours" would quietly mean "eight hours give or take a third of
 * a minute". The tests below pin the unit from both ends.
 *
 * WHY NOT FLOATING POINT. 0.1 + 0.2 === 0.30000000000000004, so a day of
 * 0.1 + 0.2 + 7.7 is not 8 on any IEEE 754 comparison. There is a test for
 * exactly that sum, and for several more like it.
 *
 * The browser half is tests/timesheet-hours-rule-browser.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rule = require('../src/timesheet-hours-rule');
const tsSettings = require('../src/timesheet-settings');
const catalog = require('../src/permission-catalog');
const roles = require('../src/roles');
const dayStatus = require('../src/day-status');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'timesheets.js'), 'utf8');
const MODULE = fs.readFileSync(path.join(ROOT, 'src', 'timesheet-hours-rule.js'), 'utf8');

const cfg = config('tshoursrule');
const PASSWORD = 'HoursRule-Test-1!';

/* FIXED DATES, never "today": the rule is about a calendar and a suite that
   computed its dates from the clock would pass or fail by the hour it ran at.
   2026-10-07 is a Wednesday, -08 a Thursday, -09 a Friday, -10 a Saturday. */
const WED = '2026-10-07';
const THU = '2026-10-08';
const FRI = '2026-10-09';
const SAT = '2026-10-10';

/* ---- the unit, and the arithmetic ------------------------------------- */

test('hours become centihours exactly, and no sum drifts', () => {
  assert.strictEqual(rule.CENTI_PER_HOUR, 100);
  for (const [hours, centi] of [
    [8, 800], [7.99, 799], [8.01, 801], [0.25, 25], [0.01, 1], [7.5, 750],
    [8.25, 825], [2.35, 235], [0.1, 10], [0.2, 20], [24, 2400], [0, 0],
    ['8.00', 800], ['0.25', 25], [null, 0], [undefined, 0], ['', 0],
  ]) {
    assert.strictEqual(rule.toCenti(hours), centi, `${JSON.stringify(hours)} -> ${centi}`);
  }

  /* THE SUM THAT BREAKS FLOATING POINT, found by searching rather than assumed:
     4.02 + 0.02 + 3.96 is 7.999999999999999 as doubles, so `=== 8` is FALSE and
     a rule written that way would refuse a day that is exactly eight hours. In
     centihours it is 402 + 2 + 396 = 800, full stop.

     The first assertion is there because the second one proves nothing without
     it: if the naive sum ever became exact, this test would be passing for the
     wrong reason. */
  const drifting = [4.02, 0.02, 3.96];
  assert.notStrictEqual(drifting.reduce((a, b) => a + b, 0), 8,
    'the floating-point sum of these three really is wrong');
  assert.strictEqual(rule.loggedCenti(drifting.map((hours) => ({ hours }))), 800);
  // And the classic: two tenths that are not three tenths.
  assert.notStrictEqual(0.1 + 0.2, 0.3);
  assert.strictEqual(rule.loggedCenti([{ hours: 0.1 }, { hours: 0.2 }]), 30);
  assert.strictEqual(rule.loggedCenti([{ hours: 0.1 }, { hours: 0.2 }, { hours: 7.7 }]), 800);

  // Thirty-two quarters plus nothing, and thirty-one quarters plus 0.25.
  assert.strictEqual(rule.loggedCenti(Array.from({ length: 32 }, () => ({ hours: 0.25 }))), 800);
  assert.strictEqual(
    rule.loggedCenti([...Array.from({ length: 31 }, () => ({ hours: 0.25 })), { hours: 0.25 }]), 800
  );
  // A long tail of hundredths: 800 of them is eight hours, and 799 is not.
  assert.strictEqual(rule.loggedCenti(Array.from({ length: 800 }, () => ({ hours: 0.01 }))), 800);
  assert.strictEqual(rule.loggedCenti(Array.from({ length: 799 }, () => ({ hours: 0.01 }))), 799);
  // Mixed shapes, in the order a person would file them.
  assert.strictEqual(rule.loggedCenti(
    [{ hours: 2.35 }, { hours: 1.15 }, { hours: 0.5 }, { hours: 4 }]), 800);

  /* AND THE WHOLE WAY THROUGH decide(), not only through the adder. This is the
     assertion that makes the unit matter: a day filed as those three drifting
     lines is EXACT and submittable, where the same day decided in hours would
     be 7.999999999999999 against 8 — short, refused, and unfixable, because
     there is no line small enough to make up the difference. */
  const drifted = rule.decide({
    enabled: true, requiredHours: 8, effectiveFrom: '2026-01-01', date: '2026-10-07',
    exempt: false, mark: null, timesheetRequired: true,
    entries: drifting.map((hours) => ({ hours })),
  });
  assert.deepStrictEqual([drifted.status, drifted.canSubmit, drifted.logged, drifted.remaining],
    ['exact', true, 800, 0]);

  // And back to hours for a message, never for a comparison.
  assert.strictEqual(rule.toHours(800), 8);
  assert.strictEqual(rule.toHours(799), 7.99);
  assert.strictEqual(rule.label(800), '8h');
  assert.strictEqual(rule.label(750), '7.5h');
  assert.strictEqual(rule.label(25), '0.25h');
  assert.strictEqual(rule.label(1), '0.01h');
});

test('the module never compares hours as floating point', () => {
  /* The whole point of the unit is lost the moment one comparison is written
     against a decimal. Every number in this module is centihours, so a literal
     like 8 or 0.25 in a comparison would be a bug — the only decimals allowed
     are in the two conversion helpers and in the label formatter. */
  const body = MODULE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const suspicious = body.split('\n')
    .filter((l) => /[<>=]=?\s*\d+\.\d/.test(l) || /\d+\.\d\s*[<>=]=?/.test(l));
  assert.deepStrictEqual(suspicious, [], 'a decimal appears in a comparison');
});

/* ---- how much the day asks for ---------------------------------------- */

test('requiredCentiFor, over every kind of day', () => {
  const leave = (portion) => ({ kind: 'leave', portion });
  const cases = [
    // [label, requiredHours, mark, timesheetRequired, expected centihours]
    ['a normal working day', 8, null, true, 800],
    ['a normal day on a 7.5h studio', 7.5, null, true, 750],
    ['first-half leave', 8, leave('first_half'), true, 400],
    ['second-half leave', 8, leave('second_half'), true, 400],
    ['first-half leave on a 7.5h studio', 7.5, leave('first_half'), true, 375],
    ['second-half leave on a 7.5h studio', 7.5, leave('second_half'), true, 375],
    /* FULL-DAY LEAVE, A HOLIDAY AND A WEEKLY OFF ARE ONE CASE HERE, and that is
       the design: each of them makes isTimesheetRequired false, and to this
       rule "nothing is owed" is one answer however it was arrived at. */
    ['full-day leave', 8, leave('full'), false, 0],
    ['a holiday', 8, null, false, 0],
    ['a weekly off', 8, null, false, 0],
    ['a vacation day (a planned full leave)', 8, { ...leave('full'), source: 'planned' }, false, 0],
    ['a planned half day', 8, { ...leave('first_half'), source: 'planned' }, true, 400],
    /* IDLE AND ON SITE ASK FOR A FULL DAY. Somebody idle was at the desk with
       nothing to pick up, and somebody on site was working at a client's. Both
       owe a full day's account of it — which is what Idle is for. */
    ['an idle day', 8, { kind: 'idle', portion: 'full' }, true, 800],
    ['an on-site day', 8, { kind: 'onsight', portion: 'full' }, true, 800],
    ['a half day of idle', 8, { kind: 'idle', portion: 'first_half' }, true, 800],
    ['a required figure of zero', 0, null, true, 0],
  ];
  for (const [what, requiredHours, mark, timesheetRequired, expected] of cases) {
    assert.strictEqual(
      rule.requiredCentiFor({ requiredHours, mark, timesheetRequired }), expected, what);
  }

  // And the half-day predicate itself, which nothing else may re-derive.
  assert.strictEqual(rule.isHalfDayLeave({ kind: 'leave', portion: 'first_half' }), true);
  assert.strictEqual(rule.isHalfDayLeave({ kind: 'leave', portion: 'second_half' }), true);
  assert.strictEqual(rule.isHalfDayLeave({ kind: 'leave', portion: 'full' }), false);
  assert.strictEqual(rule.isHalfDayLeave({ kind: 'idle', portion: 'first_half' }), false);
  assert.strictEqual(rule.isHalfDayLeave(null), false);
  /* THE PORTION VALUES ARE src/day-status.js's, compared by value because this
     module must not require that one. If they ever diverge, a half day would
     silently ask for a whole one. */
  assert.strictEqual(dayStatus.PORTIONS.first_half, 'first_half');
  assert.strictEqual(dayStatus.PORTIONS.second_half, 'second_half');
  assert.strictEqual(dayStatus.KINDS.leave, 'leave');
});

test('the boundary: 799 short, 800 exact, 801 over', () => {
  const at = (centi) => rule.decide({
    enabled: true, requiredHours: 8, effectiveFrom: '2026-01-01', date: WED, logged: centi,
  });
  assert.strictEqual(at(799).status, 'short');
  assert.strictEqual(at(799).canSubmit, false);
  assert.strictEqual(at(799).remaining, 1);
  assert.strictEqual(at(800).status, 'exact');
  assert.strictEqual(at(800).canSubmit, true);
  assert.strictEqual(at(800).remaining, 0);
  assert.strictEqual(at(801).status, 'over');
  assert.strictEqual(at(801).canSubmit, false);
  assert.strictEqual(at(801).remaining, -1);
  assert.strictEqual(at(0).status, 'short');
  // The two sentences, which the page prints as given.
  assert.match(at(650).reason, /Log 1\.5h more to submit\./);
  assert.match(at(925).reason, /1\.25h over 8h/);
  assert.strictEqual(at(800).reason, null);
});

test('the rule does not apply, and says which of the five reasons it was', () => {
  const base = {
    enabled: true, requiredHours: 8, effectiveFrom: '2026-10-07', date: WED,
    timesheetRequired: true, logged: 100,
  };
  const off = rule.decide({ ...base, enabled: false });
  assert.deepStrictEqual(
    [off.applies, off.canSubmit, off.status, off.inactiveBecause],
    [false, true, null, 'switch_off']);

  const exempt = rule.decide({ ...base, exempt: true });
  assert.deepStrictEqual(
    [exempt.applies, exempt.canSubmit, exempt.inactiveBecause], [false, true, 'exempt']);

  const nothing = rule.decide({ ...base, timesheetRequired: false });
  assert.deepStrictEqual(
    [nothing.applies, nothing.canSubmit, nothing.required, nothing.inactiveBecause],
    [false, true, 0, 'nothing_owed']);

  const early = rule.decide({ ...base, date: '2026-10-06' });
  assert.deepStrictEqual(
    [early.applies, early.canSubmit, early.inactiveBecause],
    [false, true, 'before_effective_from']);

  /* THE BOUNDARY ITSELF: the day the rule starts is under it, the day before is
     not. Compared as ISO strings, so no timezone can move it. */
  assert.strictEqual(rule.decide({ ...base, date: '2026-10-07' }).applies, true);
  assert.strictEqual(rule.decide({ ...base, date: '2026-10-08' }).applies, true);
  assert.strictEqual(rule.decide({ ...base, date: '2026-10-06' }).applies, false);
  assert.strictEqual(rule.onOrAfter('2026-10-07', '2026-10-07'), true);
  assert.strictEqual(rule.onOrAfter('2026-10-06', '2026-10-07'), false);
  // No start date means the rule was never started, so no day is under it.
  assert.strictEqual(rule.decide({ ...base, effectiveFrom: null }).applies, false);
  assert.strictEqual(rule.onOrAfter('2026-10-07', null), false);
  assert.strictEqual(rule.onOrAfter(null, '2026-10-07'), false);
});

test('a day the rule says nothing about never reads as exact', () => {
  /* 'exact' is a state with a meaning — the Submit button is enabled on it —
     so a day with no rule must report null rather than borrowing it. */
  for (const over of [{ enabled: false }, { exempt: true }, { timesheetRequired: false },
    { date: '2020-01-01' }]) {
    const v = rule.decide({
      enabled: true, requiredHours: 8, effectiveFrom: '2026-01-01', date: WED, logged: 800,
      timesheetRequired: true, ...over,
    });
    assert.strictEqual(v.status, null, JSON.stringify(over));
    assert.strictEqual(v.applies, false, JSON.stringify(over));
  }
});

test('lineFits gives back the line\'s own room when one is being edited', () => {
  const verdict = rule.decide({
    enabled: true, requiredHours: 8, effectiveFrom: '2026-01-01', date: WED, logged: 800,
  });
  // A full day with no room: nothing new fits.
  assert.strictEqual(rule.lineFits({ verdict, wanted: 25 }).ok, false);
  assert.strictEqual(rule.lineFits({ verdict, wanted: 25 }).headroom, 0);
  // Editing a 3h line on that day: it may be anything up to 3h, and no more.
  assert.strictEqual(rule.lineFits({ verdict, wanted: 300, own: 300 }).ok, true);
  assert.strictEqual(rule.lineFits({ verdict, wanted: 301, own: 300 }).ok, false);
  assert.strictEqual(rule.lineFits({ verdict, wanted: 200, own: 300 }).ok, true);
  // On a day the rule does not touch, everything fits and there is no headroom.
  const free = rule.decide({ enabled: false, requiredHours: 8, date: WED, logged: 800 });
  assert.deepStrictEqual(rule.lineFits({ verdict: free, wanted: 9999 }), { ok: true, headroom: null });
});

/* ---- the setting ------------------------------------------------------- */

test('the required hours, and the three constraints the rule puts on them', () => {
  const errs = (maxDayHours) => {
    const v = tsSettings.validate({ maxDayHours });
    return v.ok ? [] : v.errors.map((e) => e.message);
  };
  /* ACCEPTED: whole hours, halves, and the default.

     CAPPED AT WHAT THE STUDIO'S RECORDING WINDOWS HOLD, which is an existing
     rule and not this feature's: src/timesheet-settings.js already refuses a
     required figure the windows cannot fit, so a test process reading the
     default window (eight loggable hours) cannot try 8.5 or 12 here. The
     half-representability of those values is checked below, through the rule
     module, which has no window to consult. */
  for (const good of [1, 4, 7.5, 8]) {
    assert.deepStrictEqual(errs(good), [], `${good} is allowed`);
  }
  assert.match(errs(8.5)[0], /recording windows/, 'and the window rule still applies');
  // Out of range.
  assert.match(errs(0)[0], /between 1 and 24/);
  assert.match(errs(-8)[0], /between 1 and 24/);
  assert.match(errs(0.5)[0], /between 1 and 24/);
  assert.match(errs(25)[0], /between 1 and 24/);
  // Not a number.
  assert.match(errs('x')[0], /is a number of hours/);
  assert.match(errs(null)[0], /is a number of hours/);
  // Not a quarter of an hour.
  assert.match(errs(8.3)[0], /quarter hours/);
  assert.match(errs(8.1)[0], /quarter hours/);
  /* AND THE ONE THE EXACTNESS RULE ADDS: a value whose half cannot be stored.
     8.25h would make a half day 4.125h, and no line can hold that — so no
     combination of lines could ever satisfy such a day. */
  assert.match(errs(8.25)[0], /A half day would be 4\.125h/);
  assert.match(errs(8.25)[0], /8 or 8\.5/);
  assert.match(errs(7.25)[0], /A half day would be 3\.625h/);
  assert.match(errs(8.75)[0], /A half day would be 4\.375h/);
  // Every accepted value's half IS representable, which is the point of it.
  for (const good of [1, 4, 7.5, 8, 8.5, 12, 24]) {  // eslint-disable-line no-restricted-syntax
    const half = rule.requiredCentiFor({ requiredHours: good, mark: { kind: 'leave', portion: 'first_half' } });
    assert.strictEqual(half * 2, rule.toCenti(good), `half of ${good} is exact`);
  }
});

test('the rule\'s own two settings, with their defaults and their validation', () => {
  assert.strictEqual(tsSettings.DEFAULTS.hoursRuleEnabled, false,
    'OFF on every existing install — switching it on stops people submitting');
  assert.strictEqual(tsSettings.DEFAULTS.hoursRuleFrom, null,
    'and with no start date until somebody starts it');
  assert.strictEqual(tsSettings.DEFAULTS.maxDayHours, 8);

  const bad = tsSettings.validate({ hoursRuleFrom: 'the first of April' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors[0].field, 'hoursRuleFrom');
  assert.match(bad.errors[0].message, /is a day, as 2026-04-01/);
  assert.strictEqual(tsSettings.validate({ hoursRuleFrom: '2026-13-40' }).ok, false);
  assert.strictEqual(tsSettings.validate({ hoursRuleFrom: '2026-04-01' }).ok, true);
  // A cleared date input is "never started", not an error.
  assert.strictEqual(tsSettings.validate({ hoursRuleFrom: '' }).value.hoursRuleFrom, null);
  assert.strictEqual(tsSettings.validate({ hoursRuleFrom: null }).value.hoursRuleFrom, null);
  // And the switch travels through validate(), which is where exportEnabled
  // once did not — see tests/timesheet-export-button.test.js.
  assert.strictEqual(tsSettings.validate({ hoursRuleEnabled: true }).value.hoursRuleEnabled, true);
  assert.strictEqual(tsSettings.validate({ hoursRuleEnabled: false }).value.hoursRuleEnabled, false);

  // The audit sentence names the rule and its start date.
  const on = tsSettings.summarise({ ...tsSettings.DEFAULTS, loggableDayShort: ['M'],
    hoursRuleEnabled: true, hoursRuleFrom: '2026-10-07' });
  assert.match(on, /exact hours REQUIRED from 2026-10-07/);
  const off = tsSettings.summarise({ ...tsSettings.DEFAULTS, loggableDayShort: ['M'] });
  assert.match(off, /exact hours not required/);
});

/* ---- the exemption key ------------------------------------------------- */

test('the exemption is one key, Super Admin only, and the only way round the rule', () => {
  const entry = catalog.BY_KEY.get('timesheet.min_hours_exempt');
  assert.ok(entry, 'the key is in the catalogue');
  assert.strictEqual(entry.label, 'Exempt From The Required-Hours Rule');
  assert.match(entry.describe,
    /Exempt from the required-hours rule \(may submit fewer or more than the required hours\)/);
  const holders = roles.roleKeys().filter((k) => {
    const def = roles.roleDef(k);
    return def && entry.impliedBy(def);
  });
  assert.deepStrictEqual(holders, ['super_admin']);
  const group = catalog.GROUPS.find((g) => g.permissions.some((p) => p.key === 'timesheet.min_hours_exempt'));
  assert.strictEqual(group.key, 'timesheet');

  /* NO OTHER BYPASS EXISTS. The brief asks for exactly one door, so a second
     one — a per-day override, a reason box, a "submit anyway" — would be a
     feature nobody asked for and a rule nobody could rely on. */
  for (const word of ['submitAnyway', 'submit_anyway', 'overrideHours', 'force_submit', 'forceSubmit',
    'bypassHours', 'ignoreHoursRule']) {
    assert.ok(!ROUTE.includes(word), `the route offers no ${word}`);
    assert.ok(!PAGE.includes(word), `the page offers no ${word}`);
  }
});

/* ---- the page holds no copy of the rule -------------------------------- */

test('the page prints the server\'s numbers and holds no copy of the rule', () => {
  /* THE DIVISION THIS FEATURE RESTS ON. The server decides; the page draws. A
     page that worked out the requirement itself would be a second rule, and the
     two would differ the first time a studio changed the setting or somebody
     took a half day. */
  const from = PAGE.indexOf('/* ---------- the exact-hours rule');
  assert.ok(from !== -1, 'the page has the block that draws it');
  const to = PAGE.indexOf('/* ---------- Time Sheet ----------', from);
  assert.ok(to > from);
  const block = PAGE.slice(from, to);

  // It reads the server's fields.
  for (const field of ['status', 'required', 'logged', 'remaining', 'canSubmit']) {
    assert.ok(block.includes(field), `the page reads ${field} from the payload`);
  }
  /* AND IT DOES NONE OF THE ARITHMETIC. No halving for a half day, no reading
     of the setting to compare against, no requirement in minutes or
     centihours, no decision about which days are owed.

     READING A LABEL IS NOT COMPUTING. The block does look at day.holiday.name
     and day.dayMark.label to say WHY a day asks for nothing — "Diwali: nothing
     to fill" — which is the sentence the brief asks for. What it must not do is
     DECIDE that nothing is owed, and that is what this list is about:
     timesheetRequiredOn is the server's, the halving is the server's, and the
     comparison is the server's. */
  for (const forbidden of [' / 2', '* 0.5', 'maxDayHours', 'first_half', 'second_half',
    'isTimesheetRequired', 'timesheetRequiredOn', 'loggableDays', '480', '800']) {
    assert.ok(!block.includes(forbidden), `the page does not compute ${forbidden}`);
  }
  /* The one thing it reads about a day is what to CALL it, and only inside the
     function that writes that sentence. */
  const why = block.slice(block.indexOf('function tsNothingOwed('));
  assert.ok(why.includes('day.holiday'), 'the note names the holiday the server sent');
  assert.ok(!block.slice(0, block.indexOf('function tsNothingOwed(')).includes('day.holiday'),
    'and nothing else in the block looks at it');
  /* THE COMPARISON THE PAGE MAY NOT MAKE is one figure against another: the
     moment it decides for itself whether logged has reached required, there are
     two rules. It takes that answer from `status` and `canSubmit`.

     ONE INEQUALITY IS ALLOWED AND IT IS NAMED: `rule.required > 0`, which is
     the guard on dividing by it to draw the bar's width. It compares the
     requirement with nothing. */
  const pairs = block.split('\n').filter((l) =>
    /(logged|remaining)\s*[<>]=?\s*[A-Za-z.]*required/.test(l)
    || /required\s*[<>]=?\s*[A-Za-z.]*(logged|remaining)/.test(l));
  assert.deepStrictEqual(pairs, [], 'the page compares no two hours figures itself');
  const inequalities = block.split('\n')
    .filter((l) => /(required|logged|remaining)\s*[<>]=?/.test(l))
    .map((l) => l.trim());
  assert.deepStrictEqual(inequalities, ['const pct = rule.required > 0'],
    'and the only inequality is the bar\'s divide-by-zero guard');

  /* AND THE THREE STATUS WORDS ARE ONLY EVER READ, never produced. A page that
     worked out 'over' for itself would be deciding the rule. */
  for (const word of ['exact', 'short', 'over']) {
    const assigned = new RegExp(`(status|canSubmit)\\s*[:=]\\s*'${word}'`);
    assert.ok(!assigned.test(block), `the page does not assign ${word}`);
  }
  assert.match(block, /rule\.status === 'exact'/, 'it reads the status instead');
});

test('nothing in the page or the server still says eight hours', () => {
  /* THE NUMBER WAS A SETTING FOR TWO PROMPTS AND THE WORDS HAD NOT CAUGHT UP.
     The submit route's own day history said "over the eight-hour day", and the
     page's toast said it too, on a studio that may be on seven and a half. */
  /* COMMENTS STRIPPED FIRST. Both files now explain the fix in prose — "it said
     over the eight-hour day while the length of a day had been a setting for
     two prompts" — and a test that failed on its own explanation would be a
     test nobody could document. What must not contain the words is the code. */
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!code(ROUTE).includes('eight-hour'), 'the submit route reads the setting');
  assert.ok(!code(PAGE).includes('eight-hour'), 'and so does the page');
  assert.match(ROUTE, /over the \$\{total\.maxHours\}-hour day/);
  /* The two places the number legitimately lives are the setting's default and
     the fallbacks that exist for a database which cannot be read — both named,
     so a third cannot appear without this failing. */
  const fallbacks = ['src/timesheet-settings.js', 'src/work-schedule.js', 'src/timesheets.js'];
  const hardcoded = fs.readdirSync(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !fallbacks.includes(`src/${f}`))
    .filter((f) => /maxHours:\s*8\b|maxDayHours:\s*8\b|TIMESHEET_MAX_HOURS\s*=\s*8/
      .test(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')));
  assert.deepStrictEqual(hardcoded, [], 'a fourth copy of the number eight appeared');
});

/* ---- against a live server -------------------------------------------- */

test('the exact-hours rule, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const people = {};
  let clientId;
  let projectId;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const q = (statement, params) => sql(cfg, statement, params);

  const settings = async (body) => {
    const res = await as('root', '/admin/settings/timesheet', { method: 'PUT', body });
    return res;
  };
  const setRule = async (body) => {
    const res = await settings(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.settings;
  };
  const add = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });
  const submit = (who, date) => as(who, '/timesheets/submit', { method: 'POST', body: { date } });
  const reopen = (who, date) => as(who, '/timesheets/reopen', { method: 'POST', body: { date } });
  const del = (who, id) => as(who, `/timesheets/entries/${id}`, { method: 'DELETE' });
  const patch = (who, id, body) => as(who, `/timesheets/entries/${id}`, { method: 'PATCH', body });
  const dayOf = async (who, date) => {
    const res = await as(who, `/timesheets/week?date=${date}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.days.find((d) => d.date === date);
  };
  /* A LINE OF PLAIN NON-PROJECT TIME, which needs no asset and no timer. The
     rule is about how much a day adds up to, not about what the hours were
     for, so the fixture uses the simplest line there is. */
  const line = (date, hours, extra = {}) => ({ date, hours, nonProject: 'leave', ...extra });
  const clear = async (who, date) => {
    const day = await dayOf(who, date);
    if (day.locked) await reopen(who, date);
    for (const e of (await dayOf(who, date)).entries) await del(who, e.id);
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'hours-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'hours-token', name: 'Root', email: 'root@hours.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@hours.test');
    people.root = (await as('root', '/auth/me')).body.user.id;
    await openStudio(server.base, token.root);

    clientId = (await as('root', '/clients')).body.clients[0].id;
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Hours Rule' } })).body.project.id;

    for (const [who, role] of [['ana', 'game_artist'], ['bo', 'game_artist'], ['lee', 'team_lead']]) {
      const res = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@hours.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@hours.test`);
    }
    /* THE WINDOW HAS TO HOLD A FULL DAY, because the settings validator refuses
       a required figure the studio's recording windows cannot fit — openStudio
       opens it to the whole twenty-four hours, which is what lets this suite
       try 8, 7.5 and 12. */
    /* AND A LINE MAY BE AS SMALL AS A HUNDREDTH OF AN HOUR, because the
       boundary this suite exists to pin is one centihour wide: 7.99 refused and
       8.00 accepted. The studio's default smallest line is a quarter of an
       hour, which is a separate rule with its own tests — it would simply stop
       this suite from being able to express the boundary at all. */
    await setRule({ loggableDays: [1, 2, 3, 4, 5], backdateDays: null, futureDays: null,
      minLineHours: 0.01 });
  });

  t.after(() => stopServer(server));

  /* ---- the switch, off ------------------------------------------------ */

  await t.test('with the switch off a day submits exactly as it always did', async () => {
    const made = await add('ana', line(WED, 3));
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const day = await dayOf('ana', WED);
    assert.strictEqual(day.hours, 3);
    assert.strictEqual(day.hoursRule.applies, false, 'no rule on this day');
    assert.strictEqual(day.hoursRule.canSubmit, true);
    assert.strictEqual(day.hoursRule.inactiveBecause, 'switch_off');
    assert.strictEqual((await submit('ana', WED)).status, 200, 'three hours submits');

    /* AND OVER THE SETTING IS STILL FLAGGED AND NOT REFUSED, which is the
       behaviour the rule replaces only for the days it covers. */
    await reopen('ana', WED);
    const over = await add('ana', line(WED, 6));
    assert.strictEqual(over.status, 201, JSON.stringify(over.body));
    assert.strictEqual(over.body.overLong, true, 'nine hours is flagged');
    const sent = await submit('ana', WED);
    assert.strictEqual(sent.status, 200, 'and submits anyway');
    assert.strictEqual(sent.body.overLong, true);
    await clear('ana', WED);
  });

  /* ---- the switch on, and the whole of the rule ------------------------ */

  await t.test('switching it on stamps today, and the date is editable', async () => {
    const saved = await setRule({ hoursRuleEnabled: true });
    assert.strictEqual(saved.hoursRuleEnabled, true);
    /* TODAY IN THE STUDIO'S TIMEZONE, which is what makes the rule start when
       somebody starts it rather than reaching back over a month of days. */
    const today = require('../src/timesheet-gate').istDate(Date.now());
    assert.strictEqual(saved.hoursRuleFrom, today, 'stamped with today');

    // Editable afterwards, which is what lets a studio choose its own start.
    const moved = await setRule({ hoursRuleFrom: '2026-10-07' });
    assert.strictEqual(moved.hoursRuleFrom, '2026-10-07');
    // Switching off and on again does not move a date somebody chose.
    await setRule({ hoursRuleEnabled: false });
    const back = await setRule({ hoursRuleEnabled: true });
    assert.strictEqual(back.hoursRuleFrom, '2026-10-07', 'the chosen date is kept');
    assert.strictEqual(back.maxDayHours, 8, 'and the required figure is the default');
  });

  await t.test('a day before the start date submits as it always did', async () => {
    // 2026-10-06 is the Tuesday before the start date set above.
    const before = '2026-10-06';
    assert.strictEqual((await add('ana', line(before, 2))).status, 201);
    const day = await dayOf('ana', before);
    assert.strictEqual(day.hoursRule.applies, false);
    assert.strictEqual(day.hoursRule.inactiveBecause, 'before_effective_from');
    assert.strictEqual((await submit('ana', before)).status, 200, 'two hours, submitted');
    await clear('ana', before);
  });

  await t.test('short is refused, with the code and the numbers', async () => {
    assert.strictEqual((await add('ana', line(WED, 6.5))).status, 201);
    const day = await dayOf('ana', WED);
    assert.deepStrictEqual(
      [day.hoursRule.applies, day.hoursRule.required, day.hoursRule.logged,
        day.hoursRule.remaining, day.hoursRule.status, day.hoursRule.canSubmit],
      [true, 800, 650, 150, 'short', false]);
    assert.strictEqual(day.hoursRule.requiredHours, 8);
    assert.strictEqual(day.hoursRule.loggedHours, 6.5);
    assert.strictEqual(day.hoursRule.remainingHours, 1.5);
    assert.match(day.hoursRule.reason, /Log 1\.5h more to submit\./);

    const refused = await submit('ana', WED);
    assert.strictEqual(refused.status, 422, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'HOURS_BELOW_MINIMUM');
    assert.strictEqual(refused.body.status, 'short');
    assert.strictEqual(refused.body.required, 800);
    assert.strictEqual(refused.body.logged, 650);
    assert.strictEqual(refused.body.remaining, 150);
    assert.strictEqual(refused.body.requiredHours, 8);
    assert.strictEqual(refused.body.loggedHours, 6.5);
    assert.match(refused.body.error, /Log 1\.5h more to submit\./);
    // Nothing happened: the day is still a draft.
    assert.strictEqual((await dayOf('ana', WED)).status, 'draft');
  });

  await t.test('exactly the required hours submits, to the centihour', async () => {
    // 6.5 + 1.49 is 7.99 — one hundredth short, and refused.
    assert.strictEqual((await add('ana', line(WED, 1.49))).status, 201);
    let day = await dayOf('ana', WED);
    assert.strictEqual(day.hoursRule.logged, 799);
    assert.strictEqual(day.hoursRule.status, 'short');
    assert.strictEqual((await submit('ana', WED)).status, 422, '7.99h is not 8h');

    // The hundredth that completes it.
    const last = await add('ana', line(WED, 0.01));
    assert.strictEqual(last.status, 201, JSON.stringify(last.body));
    day = await dayOf('ana', WED);
    assert.deepStrictEqual(
      [day.hoursRule.logged, day.hoursRule.remaining, day.hoursRule.status, day.hoursRule.canSubmit],
      [800, 0, 'exact', true]);
    assert.strictEqual(day.hoursRule.reason, null);
    const sent = await submit('ana', WED);
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual((await dayOf('ana', WED)).status, 'submitted');
  });

  await t.test('a submitted day is locked, which is what keeps it exact', async () => {
    /* THE GUARD THE BRIEF ASKS FOR IS ALREADY THERE, and it is stronger than a
       check on the figure: a submitted day refuses every change, so it cannot
       be edited or deleted off 'exact' at all. The way to change one is to
       reopen it, which makes it a draft and puts it back under the rule. */
    const day = await dayOf('ana', WED);
    const first = day.entries[0];
    assert.strictEqual((await del('ana', first.id)).status, 409, 'delete refused');
    assert.strictEqual((await patch('ana', first.id, { hours: 1 })).status, 409, 'edit refused');
    assert.strictEqual((await add('ana', line(WED, 1))).status, 409, 'and nothing may be added');
    assert.strictEqual((await dayOf('ana', WED)).hoursRule.status, 'exact', 'still exact');

    // Reopened, it is a draft again and the rule applies as before.
    assert.strictEqual((await reopen('ana', WED)).status, 200);
    assert.strictEqual((await del('ana', first.id)).status, 200, 'now it deletes');
    const after = await dayOf('ana', WED);
    assert.strictEqual(after.hoursRule.status, 'short');
    assert.strictEqual((await submit('ana', WED)).status, 422, 'and it cannot be submitted short');
    await clear('ana', WED);
  });

  /* ---- the cap on the way in ------------------------------------------ */

  await t.test('a line that would take the day over is refused, with the room left',
    async () => {
      assert.strictEqual((await add('ana', line(THU, 7))).status, 201);
      const refused = await add('ana', line(THU, 1.5));
      assert.strictEqual(refused.status, 422, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.code, 'HOURS_ABOVE_MAXIMUM');
      assert.match(refused.body.error, /This line \(1\.5h\) is more than the time left today \(1h\)\./);
      assert.strictEqual(refused.body.remaining, 100, 'the room that was left');
      assert.strictEqual(refused.body.attempted, 150, 'and what was attempted');
      assert.strictEqual((await dayOf('ana', THU)).hours, 7, 'nothing was written');

      // Exactly the room left is accepted, and the day is then exact.
      const fits = await add('ana', line(THU, 1));
      assert.strictEqual(fits.status, 201, JSON.stringify(fits.body));
      assert.strictEqual((await dayOf('ana', THU)).hoursRule.status, 'exact');

      // And a full day has no room at all, which is said differently.
      const full = await add('ana', line(THU, 0.25));
      assert.strictEqual(full.status, 422);
      assert.match(full.body.error, /This day already has its 8h\./);
      assert.strictEqual((await submit('ana', THU)).status, 200);
      await clear('ana', THU);
    });

  await t.test('an edit may use its own hours, and no more', async () => {
    assert.strictEqual((await add('ana', line(FRI, 5))).status, 201);
    const three = await add('ana', line(FRI, 3));
    assert.strictEqual(three.status, 201);
    const id = three.body.entry.id;
    assert.strictEqual((await dayOf('ana', FRI)).hoursRule.status, 'exact');

    // Up past its own room: refused, and the line is unchanged.
    const up = await patch('ana', id, { hours: 3.25 });
    assert.strictEqual(up.status, 422, JSON.stringify(up.body));
    assert.strictEqual(up.body.code, 'HOURS_ABOVE_MAXIMUM');
    assert.match(up.body.error, /This line \(3\.25h\) is more than the time left today \(3h\)\./);
    const stillThere = (await dayOf('ana', FRI)).entries.find((e) => e.id === id);
    assert.strictEqual(Number(stillThere.hours), 3, 'the line kept its hours');

    // Exactly its own hours again (an edit that changes only the note) is fine.
    assert.strictEqual((await patch('ana', id, { notes: 'same hours' })).status, 200);
    assert.strictEqual((await dayOf('ana', FRI)).hoursRule.status, 'exact');
    // Down is always allowed, and the day goes short.
    assert.strictEqual((await patch('ana', id, { hours: 2 })).status, 200);
    assert.strictEqual((await dayOf('ana', FRI)).hoursRule.status, 'short');
    await clear('ana', FRI);
  });

  await t.test('two tabs adding at the same moment: exactly one gets in', async () => {
    /* THE RACE THE DAY LOCK EXISTS FOR, fired concurrently rather than one
       after the other — a sequential test would pass without any lock at all.
       Six hours on an eight-hour day leaves two, and both requests want two. */
    assert.strictEqual((await add('ana', line(WED, 6))).status, 201);
    const [one, two] = await Promise.all([
      add('ana', line(WED, 2, { notes: 'tab one' })),
      add('ana', line(WED, 2, { notes: 'tab two' })),
    ]);
    const codes = [one.status, two.status].sort();
    assert.deepStrictEqual(codes, [201, 422],
      `one accepted, one refused — got ${JSON.stringify([one.status, two.status])}`);
    const refused = one.status === 422 ? one : two;
    assert.strictEqual(refused.body.code, 'HOURS_ABOVE_MAXIMUM');
    const day = await dayOf('ana', WED);
    assert.strictEqual(day.hoursRule.logged, 800, 'the day is exactly eight hours');
    assert.strictEqual(day.entries.length, 2, 'two lines, not three');
    assert.strictEqual((await submit('ana', WED)).status, 200);
    await clear('ana', WED);
  });

  await t.test('the add really does hold the day: a held lock blocks it', async () => {
    /* THE CONCURRENT PAIR ABOVE PROVES THE OUTCOME; THIS PROVES THE MECHANISM,
       and it is here because the pair alone does not.
       `Promise.all` over HTTP gives the two requests a sub-millisecond skew, and
       the first commits before the second reads — so the pair passes with the
       row lock REMOVED, by luck rather than by design. A mutation run said so:
       deleting FOR UPDATE from the insert escaped every test in this file.

       So this test takes the lock itself, from its own connection, and asserts
       the route WAITS for it. Without FOR UPDATE in the route the add returns
       immediately and this fails on the first assertion. */
    const mysql = require('mysql2/promise');
    assert.strictEqual((await add('bo', line(FRI, 1))).status, 201, 'the day row exists');
    const holder = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      database: cfg.database,
    });
    let settled = false;
    let pending;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM timesheet_days WHERE user_id = ? AND work_date = ? FOR UPDATE',
        [people.bo, FRI]
      );
      pending = add('bo', line(FRI, 1)).then((r) => { settled = true; return r; });
      /* LONG ENOUGH TO BE THE LOCK AND NOT THE NETWORK. An add on this suite's
         own server answers in single-digit milliseconds; 400 is two orders of
         magnitude more. */
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(settled, false,
        'the add is waiting on the day row, which is what the lock is for');
    } finally {
      await holder.query('COMMIT').catch(() => {});
      await holder.end().catch(() => {});
    }
    /* AND IT GOES THROUGH THE MOMENT THE LOCK IS RELEASED, so what was proved
       above is a wait and not a hang. */
    const done = await pending;
    assert.strictEqual(done.status, 201, JSON.stringify(done.body));
    assert.strictEqual((await dayOf('bo', FRI)).hoursRule.logged, 200);
    await clear('bo', FRI);
  });

  /* ---- what counts ---------------------------------------------------- */

  await t.test('every kind of line counts, and Idle counts too', async () => {
    const kinds = [
      { date: THU, hours: 2, clientId, projectId, notes: 'project work' },
      { date: THU, hours: 1.5, nonProject: 'idle', nonProjectSub: 'idle_no_work_to_assign' },
      { date: THU, hours: 1.5, nonProject: 'training', nonProjectSub: 'training_training_2d_art' },
      { date: THU, hours: 1, nonProject: 'on_site', nonProjectSub: 'on_site_csr2_on_site' },
      { date: THU, hours: 2, nonProject: 'leave' },
    ];
    for (const l of kinds) {
      const made = await add('ana', l);
      assert.strictEqual(made.status, 201, `${JSON.stringify(l)}: ${JSON.stringify(made.body)}`);
    }
    const day = await dayOf('ana', THU);
    assert.strictEqual(day.hoursRule.logged, 800, '2 + 1.5 + 1.5 + 1 + 2 = 8');
    assert.strictEqual(day.hoursRule.status, 'exact');
    /* A LEAVE LINE COUNTS ONCE AND SHRINKS NOTHING. The requirement comes from
       the day's MARK, not from a line somebody typed — so two hours of leave
       logged on a normal day are two hours of the eight, and the day still
       needs eight. */
    assert.strictEqual(day.hoursRule.required, 800, 'a leave line does not halve the day');
    assert.ok(day.idle > 0, 'and the Idle split still works');
    assert.strictEqual((await submit('ana', THU)).status, 200);
    await clear('ana', THU);
  });

  /* ---- the days the rule leaves alone --------------------------------- */

  await t.test('a weekly off can never be under the rule', async () => {
    /* A SATURDAY CANNOT BE REACHED AT ALL on this studio, which is a stronger
       answer than "the rule does not apply to it": the loggable-days rule
       refuses the line, so there is no Saturday day for the rule to rule on and
       no Saturday row in the week. Both halves are asserted — the refusal, and
       the judgement underneath it, which is src/day-status.js's and not this
       feature's. */
    const made = await add('ana', { date: SAT, hours: 1, nonProject: 'leave' });
    assert.strictEqual(made.status, 400, JSON.stringify(made.body));
    assert.match(made.body.error, /nothing can be logged on a Saturday/);
    assert.strictEqual(dayStatus.timesheetRequiredOn(SAT, null,
      { settings: { loggableDays: [1, 2, 3, 4, 5] } }), false, 'nothing is owed for it');
    assert.strictEqual(rule.requiredCentiFor({ requiredHours: 8, timesheetRequired: false }), 0);
    const week = await as('ana', `/timesheets/week?date=${SAT}`);
    assert.ok(!week.body.days.some((d) => d.date === SAT), 'and it is not even a row');
  });

  await t.test('a holiday is not under the rule, and says so', async () => {
    /* THE ONE DATE IN THIS SUITE THAT IS NOT FIXED, and the holiday calendar is
       why: it refuses a date in the past on purpose — "holidays are declared in
       advance, so that hours already recorded are never changed" — so a fixed
       October date cannot be made one. The nearest Wednesday at least a
       fortnight ahead is used instead, which is a working day for this studio
       whatever month it lands in. */
    const ahead = (() => {
      const base = new Date(`${require('../src/timesheet-gate').istDate(Date.now())}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + 14);
      while (base.getUTCDay() !== 3) base.setUTCDate(base.getUTCDate() + 1);
      return base.toISOString().slice(0, 10);
    })();
    const made = await as('root', '/admin/settings/holidays', { method: 'POST',
      body: { date: ahead, name: 'Diwali' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    try {
      const filed = await add('ana', line(ahead, 2));
      assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
      const day = await dayOf('ana', ahead);
      assert.ok(day.holiday, 'the day knows it is a holiday');
      assert.strictEqual(day.holiday.name, 'Diwali');
      assert.strictEqual(day.hoursRule.applies, false);
      assert.strictEqual(day.hoursRule.inactiveBecause, 'nothing_owed');
      assert.strictEqual(day.hoursRule.required, 0);
      assert.strictEqual((await submit('ana', ahead)).status, 200, 'two hours on Diwali submits');
      await clear('ana', ahead);
    } finally {
      const list = (await as('root', '/admin/settings/holidays')).body;
      const entry = (list.entries || list.holidays || []).find((e) => e.date === ahead);
      if (entry) await as('root', `/admin/settings/holidays/${entry.id}`, { method: 'DELETE' });
    }
  });

  await t.test('a full day\'s leave asks for nothing; a half day asks for half', async () => {
    const mark = (kind, portion, date) => as('root', '/admin-dashboard/follow-up/day-status', {
      method: 'POST', body: { userId: people.bo, date, kind, portion } });

    // A full day's leave: nothing owed, and today's behaviour.
    const full = await mark('leave', 'full', WED);
    assert.strictEqual(full.status, 200, JSON.stringify(full.body));
    assert.strictEqual((await add('bo', line(WED, 1))).status, 201);
    let day = await dayOf('bo', WED);
    assert.strictEqual(day.hoursRule.applies, false);
    assert.strictEqual(day.hoursRule.required, 0);
    assert.strictEqual((await submit('bo', WED)).status, 200, 'one hour on a full leave day submits');
    await clear('bo', WED);

    // A half day: four hours, exactly.
    await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
      body: { userId: people.bo, date: WED, reason: 'test' } });
    const half = await mark('leave', 'first_half', WED);
    assert.strictEqual(half.status, 200, JSON.stringify(half.body));
    assert.strictEqual((await add('bo', line(WED, 3.5))).status, 201);
    day = await dayOf('bo', WED);
    assert.deepStrictEqual(
      [day.hoursRule.applies, day.hoursRule.required, day.hoursRule.logged, day.hoursRule.status],
      [true, 400, 350, 'short']);
    assert.strictEqual((await submit('bo', WED)).status, 422, 'three and a half is not four');
    // A line that would take a half day over is refused on the half figure.
    const over = await add('bo', line(WED, 1));
    assert.strictEqual(over.status, 422, JSON.stringify(over.body));
    assert.match(over.body.error, /time left today \(0\.5h\)/);
    assert.strictEqual((await add('bo', line(WED, 0.5))).status, 201);
    day = await dayOf('bo', WED);
    assert.strictEqual(day.hoursRule.status, 'exact');
    assert.strictEqual((await submit('bo', WED)).status, 200, 'four hours on a half day submits');
    await clear('bo', WED);
    await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
      body: { userId: people.bo, date: WED, reason: 'test' } });
  });

  /* ---- the exemption -------------------------------------------------- */

  await t.test('an exempt designation may submit short and over', async () => {
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('timesheet.min_hours_exempt'), 'a lead does not hold it by default');
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...held, 'timesheet.min_hours_exempt'] } });
    try {
      // Short: submitted.
      assert.strictEqual((await add('lee', line(THU, 2))).status, 201);
      const day = await dayOf('lee', THU);
      assert.strictEqual(day.hoursRule.applies, false, 'the rule does not apply to them');
      assert.strictEqual(day.hoursRule.inactiveBecause, 'exempt');
      assert.strictEqual((await submit('lee', THU)).status, 200, 'two hours, submitted');
      await reopen('lee', THU);
      // Over: not even capped on the way in.
      assert.strictEqual((await add('lee', line(THU, 9))).status, 201, 'the cap does not apply');
      assert.strictEqual((await dayOf('lee', THU)).hours, 11);
      assert.strictEqual((await submit('lee', THU)).status, 200, 'eleven hours, submitted');
      await clear('lee', THU);
    } finally {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
    }
    // And with the key taken away again, the rule is back.
    assert.strictEqual((await add('lee', line(THU, 2))).status, 201);
    assert.strictEqual((await submit('lee', THU)).status, 422);
    await clear('lee', THU);
  });

  /* ---- the required figure is a setting ------------------------------- */

  await t.test('changing the required hours changes the rule, not what is submitted',
    async () => {
      // A seven-and-a-half-hour studio.
      assert.strictEqual((await setRule({ maxDayHours: 7.5 })).maxDayHours, 7.5);
      assert.strictEqual((await add('ana', line(WED, 7.5))).status, 201);
      let day = await dayOf('ana', WED);
      assert.deepStrictEqual([day.hoursRule.required, day.hoursRule.status], [750, 'exact']);
      assert.strictEqual((await submit('ana', WED)).status, 200);

      /* AND A DAY ALREADY SUBMITTED IS NOT TOUCHED BY THE CHANGE. The figure
         moves to eight; Wednesday stays submitted at seven and a half. */
      assert.strictEqual((await setRule({ maxDayHours: 8 })).maxDayHours, 8);
      day = await dayOf('ana', WED);
      assert.strictEqual(day.status, 'submitted', 'still submitted');
      assert.strictEqual(day.hours, 7.5, 'with the hours it was submitted with');
      assert.strictEqual(day.hoursRule.required, 800, 'though the rule now asks for eight');
      await clear('ana', WED);
    });

  await t.test('the required figure cannot be set to one whose half cannot be stored',
    async () => {
      const refused = await settings({ maxDayHours: 8.25 });
      assert.strictEqual(refused.status, 422, JSON.stringify(refused.body));
      assert.match(refused.body.error, /A half day would be 4\.125h/);
      assert.strictEqual((await as('root', '/admin/settings/timesheet')).body.settings.maxDayHours, 8,
        'and the stored value is untouched');
    });

  /* ---- the audit trail ------------------------------------------------ */

  await t.test('turning the rule on is in the Activity Log, with both sentences', async () => {
    /* BOTH FIELDS MOVED, so that both appear in the diff. A field that did not
       change is absent from `changes` by design — src/activity.js records what
       moved — so a test that left the date alone would be asserting the absence
       of a change it never made. */
    await setRule({ hoursRuleEnabled: false, hoursRuleFrom: '2026-10-01' });
    const before = (await q(
      "SELECT COUNT(*) AS n FROM activity_log WHERE action = 'timesheet.options_updated'"))[0].n;
    await setRule({ hoursRuleEnabled: true, hoursRuleFrom: '2026-10-07' });
    const entries = await q(
      "SELECT * FROM activity_log WHERE action = 'timesheet.options_updated' ORDER BY seq DESC LIMIT 1");
    assert.strictEqual(Number((await q(
      "SELECT COUNT(*) AS n FROM activity_log WHERE action = 'timesheet.options_updated'"))[0].n),
    Number(before) + 1, 'one entry');
    const entry = entries[0];
    /* THE SENTENCE IS BOUNDED — activity_log.summary is a column, and the
       before-and-after of nine settings is longer than it — so the two halves
       are asserted on `changes`, which is JSON and whole. The summary is
       asserted to be the right entry. */
    assert.match(entry.summary, /Changed the Time Sheet options/);
    assert.strictEqual(entry.actor_id, people.root);
    /* THE THREE NAMED FIELDS, which is where the rule's own change is recorded.
       src/activity.js clips every value at 200 characters and the policy
       sentence is longer than that, so "the rule was turned on, from the 7th"
       was being clipped out of the only record of it — found by this test. */
    const changes = JSON.parse(entry.changes);
    assert.deepStrictEqual(changes.exactHoursRule, { from: 'off', to: 'on' });
    assert.deepStrictEqual(changes.exactHoursRuleFrom, { from: '2026-10-01', to: '2026-10-07' });
    /* AND A SAVE THAT CHANGED NOTHING SAYS SO rather than writing a diff of
       identical values — which is what makes the log worth reading. */
    const quiet = await as('root', '/admin/settings/timesheet', { method: 'PUT', body: {} });
    assert.strictEqual(quiet.status, 200);
    const last = (await q(
      "SELECT * FROM activity_log WHERE action = 'timesheet.options_updated' ORDER BY seq DESC LIMIT 1"))[0];
    assert.match(last.summary, /with no change/);
    assert.ok(changes.policy, 'and the sentence is still there for a person to read');
  });

  /* ---- the previous-day block ----------------------------------------- */

  await t.test('with the previous-day block on, a blocked user can still fix and submit',
    async () => {
      await setRule({ requirePreviousDay: true });
      try {
        /* THE TWO FEATURES ARE INDEPENDENT, which is the thing to prove: the
           block says "you may not start work until yesterday is filled", and
           the hours rule says "yesterday is not filled until it is exactly
           eight". Somebody caught by both has to be able to get out, and the
           way out is to open the day, make it exact and submit it. */
        const blocked = await as('ana', '/timesheets/week?date=' + WED);
        assert.strictEqual(blocked.status, 200, 'the week still opens');
        assert.strictEqual((await add('ana', line(WED, 8))).status, 201, 'and still takes lines');
        assert.strictEqual((await submit('ana', WED)).status, 200, 'and submits when exact');
        await clear('ana', WED);
      } finally {
        await setRule({ requirePreviousDay: false });
      }
    });

  /* ---- every submit path --------------------------------------------- */

  await t.test('there is one path that marks a day submitted, and it is guarded', async () => {
    /* THE CLAIM THE BRIEF ASKS TO BE CHECKED: "every route that can mark a day
       submitted is guarded". Asserted against the source rather than trusted —
       one UPDATE sets the status, it is in the submit route, and the rule check
       is above it. */
    const writes = ROUTE.match(/UPDATE timesheet_days SET status = '[a-z]+'/g) || [];
    assert.deepStrictEqual(writes.sort(),
      ["UPDATE timesheet_days SET status = 'draft'", "UPDATE timesheet_days SET status = 'submitted'"],
      'only submit and reopen move a day');
    const from = ROUTE.indexOf("router.post('/submit'");
    const to = ROUTE.indexOf("router.post('/reopen'");
    const body = ROUTE.slice(from, to);
    assert.ok(body.indexOf('hoursRuleFor(req.user, date)') < body.indexOf("status = 'submitted'"),
      'the rule is asked before the day is marked');
    assert.match(body, /HOURS_BELOW_MINIMUM/);
    assert.match(body, /HOURS_ABOVE_MAXIMUM/);
    assert.match(body, /res\.status\(422\)/);
    // And no other file anywhere marks a day submitted.
    const others = fs.readdirSync(path.join(ROOT, 'src', 'routes'))
      .filter((f) => f !== 'timesheets.js' && f.endsWith('.js'))
      .filter((f) => fs.readFileSync(path.join(ROOT, 'src', 'routes', f), 'utf8')
        .includes("timesheet_days SET status"));
    assert.deepStrictEqual(others, []);
  });

  await t.test('no system path creates timesheet lines behind the cap\'s back', async () => {
    /* THE SURVEY, PINNED. Idle, On Site and leave are marks on user_day_status;
       none of them writes a timesheet line. So there is no path that can push a
       day over without going through the cap — and if one is ever added, this
       fails and whoever adds it has to decide what the cap means to it. */
    const files = ['src', 'src/routes'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`));
    const writers = files.filter((f) => f !== 'src/routes/timesheets.js' && f !== 'src/migrate.js'
      && /INSERT INTO timesheet_entries/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    assert.deepStrictEqual(writers, [], 'something else writes timesheet lines');
    const route = ROUTE.slice(ROUTE.indexOf("router.post('/entries'"));
    const inserts = (ROUTE.match(/insertEntry\(/g) || []).length;
    assert.strictEqual(inserts, 2, 'one definition and one call site');
    assert.ok(route.indexOf('FOR UPDATE') < route.indexOf('insertEntry(id, req.user.id, line, conn)'),
      'and that call site is inside the lock');
  });
});
