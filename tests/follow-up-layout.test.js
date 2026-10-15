/* THE "PEOPLE TO FOLLOW UP" ROW, MEASURED IN A REAL BROWSER.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A STRING ASSERTION.
 *
 * Every other test of this section asks what the page PRINTS. None of them
 * could have caught the bug this file was raised for, because the markup was
 * correct the whole time: the row said the right words in the right order and
 * the browser drew them on top of each other. A reminded row put FOUR things on
 * one strip — the badges, the figure, the streak chip, the sentence "Reminded
 * today 11:59am by Akilesh K" and the button — and the only flex item that
 * could give was the one holding the person's name, so the name shrank to a
 * few characters wide, overflowed its box, and ran underneath the badges. The
 * server's refusal, "… has already been reminded today.", was drawn as visible
 * text as well and landed on the button.
 *
 * An overlap is a FACT ABOUT A LAYOUT, so the only honest test of one is a
 * layout: a real engine, a real stylesheet, a real width, and bounding boxes.
 *
 * ===========================================================================
 * WHAT IS REAL HERE AND WHAT IS NOT.
 *
 * REAL: the whole of public/index.html's stylesheet, both <style> blocks, byte
 * for byte; the real fuRow / fuRemind / fuStreak / fuHeld / fuActivity, run
 * through the same `new Function` slice that tests/follow-up-reminders.test.js
 * uses, so the markup under test is the markup the application ships; the real
 * #app and .ad-wrap wrappers, so the column width is the one a reader gets;
 * Chromium.
 *
 * NOT REAL: the three webfonts. The stylesheet @imports them from Google and
 * this container has no route to it, so every request leaves the page blocked
 * and the browser falls back. That makes the test STRICTER rather than weaker —
 * a layout that only holds in one font is not a layout — and it is the reason
 * nothing below asserts a pixel width. The assertions are all relational: no
 * two boxes intersect, no word is split, the document is not wider than the
 * window.
 *
 * FIXED DATA THROUGHOUT. No clock is read; the rows are literals.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ---------------------------------------------------------------------------
 * The browser. Skipped, never failed, where there is no engine to drive: the
 * same shape as the database-backed suites, so a checkout without it still
 * reports a clean run and says why this file did not take part.
 */
let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (err) { chromium = null; }

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : null,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch (err) { return false; } }) || null;

const SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser layout tests.'
  : (!EXECUTABLE
    ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}. Set CHROMIUM_PATH to run the layout tests.`
    : false);

/* ---------------------------------------------------------------------------
 * THE PAGE UNDER TEST, built out of the real file.
 *
 * `mutate` is how the mutation cases below damage it: a function over the
 * source text of public/index.html, applied before anything is extracted, so a
 * mutation reaches the stylesheet and the markup exactly as an edit would.
 */
function fixture(mutate) {
  const source = mutate ? mutate(PAGE) : PAGE;

  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(source))) styles.push(m[1]);
  assert.ok(styles.length >= 2, 'both of the page\'s <style> blocks were found');

  const from = source.indexOf('let FOLLOW_UP = null;');
  const to = source.indexOf('let THEME_VERSION = null;');
  assert.ok(from !== -1 && to > from, 'the follow-up section is in the page');
  const section = source.slice(from, to);

  /* The @import of the webfonts is dropped rather than left to time out: the
     container has no route to Google and a blocked stylesheet import delays
     first paint, which would make every measurement below a race. */
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');

  return {
    section,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
      + '<body><div id="app"><div class="ad-wrap"><div id="followUpSlot"></div></div></div></body></html>',
  };
}

/* ---------------------------------------------------------------------------
 * THE ROWS. Three shapes, because three shapes is what the brief named:
 *   a  a long name and a long designation,
 *   b  the reminded state,
 *   c  the repeated (strong streak) chip,
 * and the worst row carries all three at once, which is the row in the report
 * that started this.
 */
const TUE = '2026-03-17';
const WED = '2026-03-18';
const MON = '2026-03-16';

const ACTIVITY = {
  timer: { at: '2026-03-16T12:10:00.000Z', relative: 'yesterday 5:40 PM', exact: '16 Mar 2026, 5:40 PM IST' },
  seen: { at: '2026-03-17T04:00:00.000Z', relative: 'today 9:30 AM', exact: '17 Mar 2026, 9:30 AM IST' },
  seenAvailable: true, streak: 4, streakCapped: false, streakSince: MON,
  streakStrong: true, quietDays: 1, everActive: true,
};

const row = (over = {}) => ({
  id: 'u-1', name: 'Ana Rao', role: 'game_artist', roleLabel: 'Game Artist',
  held: 3, missed: 1, both: false, days: [TUE], expandable: false,
  activity: { ...ACTIVITY, streak: 2, streakStrong: false },
  remind: {
    kind: 'timesheet', subjectDate: TUE, permitted: true, may: true,
    code: 'ok', reason: null, sent: 0, cap: 1, last: null, auto: null,
  },
  ...over,
});

/* The row from the screenshot: everything at once. */
const WORST = row({
  id: 'u-worst',
  name: 'Siddhartha Venkataraghavan Mandal',
  roleLabel: 'Associate Game Animator',
  held: 3, both: true, expandable: true,
  activity: { ...ACTIVITY, streak: 4, streakStrong: true },
  remind: {
    kind: 'timesheet', subjectDate: TUE, permitted: true, may: false,
    code: 'capped', reason: 'Siddhartha Venkataraghavan Mandal has already been reminded today.',
    sent: 1, cap: 1,
    last: { at: '2026-03-18T06:29:00.000Z', by: 'Akilesh Kumaraswamy', channels: ['in_app', 'email'] },
    auto: { at: '2026-03-18T05:00:00.000Z', channels: ['in_app'] },
  },
});

/* A refusal that is NOT the cap, so the visible .fu-reason is exercised too. */
const REFUSED = row({
  id: 'u-refused',
  name: 'Vijay Vignesh Vadivel',
  roleLabel: 'Senior UI/UX Designer',
  held: 9, both: true,
  activity: { ...ACTIVITY, streak: 9, streakStrong: true },
  remind: {
    kind: 'timesheet', subjectDate: TUE, permitted: true, may: false,
    code: 'out_of_scope', reason: 'Vijay Vignesh Vadivel is not on any project you can see, so this is not yours to chase.',
    sent: 0, cap: 1, last: null, auto: null,
  },
});

const PLAIN = row({ id: 'u-plain', name: 'Moinak Nag', roleLabel: 'Associate Game Animator', held: 2 });
const NEW_JOINER = row({
  id: 'u-new', name: 'Manjusha Mardi', roleLabel: 'Trainee Game Animator', held: 0,
  activity: { timer: null, seen: null, seenAvailable: true, streak: 0, streakCapped: false,
    streakSince: null, streakStrong: false, quietDays: 0, everActive: false },
});

const ROWS = [WORST, REFUSED, PLAIN, NEW_JOINER];

const PAYLOAD = {
  ok: true, unavailable: null, mode: 'day', date: WED, from: WED, to: WED,
  today: WED, previousWorkingDay: TUE,
  startedFor: { from: WED, to: WED, days: [WED] },
  filledFor: { from: TUE, to: TUE, days: [TUE] },
  workingDay: true,
  grace: { minutes: 60, holds: false, until: null, opensAt: null, clockShut: false },
  /* BOTH COLUMNS CARRY ROWS, because the brief asks for the reminded state to
     look the same in each and a two-column grid is where a width bug hides. */
  notStarted: { rows: ROWS, total: ROWS.length, more: 102 },
  notFilled: { rows: ROWS, total: ROWS.length, more: 58 },
  overlap: 4, expected: 116, heldLabel: 'waiting on them',
  earliest: '2026-01-02', cap: 25, maxRangeDays: 31, notes: [],
  scope: { projects: 12, studioWide: true, roles: 8 },
  activityExplainer: 'Timer activity is the most recent work session; last seen is the most recent recorded action.',
  streakThreshold: 3, streakLookBack: 30, lastSeenRecorded: true, sort: 'urgency',
  cached: false, waitingExplainer: 'Assigned and rework statuses, outsourced work excluded.',
  waitingFigure: 'waiting on them',
  reminders: { permitted: true, manualEnabled: true, emailEnabled: true, cap: 1,
    logged: true, window: { ok: true, code: 'ok', message: null } },
};

/* ---------------------------------------------------------------------------
 * THE MEASUREMENTS, run inside the page.
 *
 * EPS is half a pixel. Browsers lay out on fractional pixels and two boxes that
 * share an edge round into each other; anything above half a pixel of overlap
 * in BOTH axes is two things drawn on top of each other.
 */
const MEASURE = `(() => {
  const EPS = 0.5;
  const seen = (el) => {
    if (el.classList.contains('sr')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const hits = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > EPS
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPS;
  const name = (el) => el.tagName.toLowerCase()
    + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : '')
    + ' "' + el.textContent.trim().slice(0, 44) + '"';
  const ownText = (el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');

  const out = {
    rows: 0, overlaps: [], buttonHits: [], brokenWords: [], inlineReminded: [],
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    buttons: [],
  };

  document.querySelectorAll('.fu-row').forEach((row) => {
    out.rows += 1;

    /* 1. NO TWO ELEMENTS IN THE ROW INTERSECT — and that is every pair that is
          not nested, not merely every pair of siblings. A sibling check is not
          enough and the reason is worth keeping: when a block that may not
          shrink is allowed to, its own box stays where it was and its CONTENTS
          spill out of it, so the two boxes still clear each other while the
          badges sit squarely on the name. The boxes agreeing is exactly the
          state a sibling check calls a pass.
          A parent overlapping its own child is not an overlap, so nested pairs
          are skipped. */
    const all = Array.from(row.querySelectorAll('*')).filter(seen);
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (hits(a.getBoundingClientRect(), b.getBoundingClientRect())) {
          out.overlaps.push(name(a) + '  ><  ' + name(b));
        }
      }
    }

    /* 2. THE REMIND BUTTON TOUCHES NO TEXT ANYWHERE ON THE PAGE, not merely
          none in its own row. Two reasons it is not scoped to the row: the
          text it landed on in the report was in another block of the same row,
          which a sibling check misses; and a right-hand block allowed to
          shrink overflows SIDEWAYS, into the other list of the two-column
          grid, where it lands on somebody else's name. Ancestors and
          descendants are excluded — a parent box containing its own button is
          not an overlap. */
    const btn = row.querySelector('[data-fu-remind]');
    if (btn && seen(btn)) {
      out.buttons.push({
        text: btn.textContent.trim(),
        title: btn.getAttribute('title') || '',
        aria: btn.getAttribute('aria-label') || '',
        disabled: btn.disabled,
      });
      const br = btn.getBoundingClientRect();
      document.querySelectorAll('.fu-lists *').forEach((el) => {
        if (el === btn || btn.contains(el) || el.contains(btn)) return;
        if (!seen(el) || !el.textContent.trim()) return;
        if (hits(br, el.getBoundingClientRect())) out.buttonHits.push(name(btn) + '  ><  ' + name(el));
      });
    }

    /* 3. NO NAME AND NO DESIGNATION IS BROKEN MID-WORD. Each word is measured
          as a Range: a word that straddles a line break has two client rects. */
    row.querySelectorAll('.fu-name, .fu-name-plain, .fu-role').forEach((el) => {
      const node = Array.from(el.childNodes).find((n) => n.nodeType === 3);
      if (!node) return;
      const text = node.textContent;
      const re = /\\S+/g;
      let m;
      while ((m = re.exec(text))) {
        const r = document.createRange();
        r.setStart(node, m.index);
        r.setEnd(node, m.index + m[0].length);
        if (r.getClientRects().length > 1) out.brokenWords.push(m[0]);
      }
    });

    /* 4. THE REMINDED SENTENCE IS NOWHERE IN VISIBLE TEXT. */
    row.querySelectorAll('*').forEach((el) => {
      if (!seen(el)) return;
      const t = ownText(el);
      if (/Reminded today/.test(t) || /has already been reminded today/.test(t)) {
        out.inlineReminded.push(name(el));
      }
    });
  });

  return out;
})()`;

/* ------------------------------------------------------------------------- */

const WIDTHS = [1280, 1440, 1920];

let browser = null;
async function open() {
  if (!browser) {
    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}
test.after(async () => { if (browser) await browser.close(); browser = null; });

/* Draw the section at one width and measure it. */
async function measure(width, { mutate = null } = {}) {
  const b = await open();
  const context = await b.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  /* NOTHING LEAVES THIS PAGE. The stylesheet's webfont @import is already
     stripped; this is the belt to that pair of braces, so a test can never sit
     waiting on a network the container does not have. */
  await context.route('**', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://') || url.startsWith('https://')) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  try {
    const f = fixture(mutate);
    await page.setContent(f.html, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ section, payload }) => {
      const escapeHTML = (s) => String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const can = (...keys) => ['report.follow_up', 'report.remind', 'user.view']
        .some((k) => keys.includes(k));
      const caps = () => ({ projectScope: 'all' });
      const api = async () => payload;
      const built = new Function(
        'document', 'escapeHTML', 'can', 'caps', 'api', 'openUserDetail', 'showToast', 'askConfirm',
        `${section}
         return { paintFollowUp,
                  set: (d) => { FOLLOW_UP = d; },
                  setAsk: (a) => { FOLLOW_UP_ASK = a; FOLLOW_UP_SHOWN = a; } };`
      )(document, escapeHTML, can, caps, api, () => {}, () => {}, async () => true);
      built.set(payload);
      built.setAsk({ mode: 'day', date: payload.date });
      built.paintFollowUp();
    }, { section: f.section, payload: PAYLOAD });
    /* One frame, so the engine has laid out what was just written. */
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return await page.evaluate(MEASURE);
  } finally {
    await context.close();
  }
}

// ===========================================================================
// 1. THE LAYOUT HOLDS AT EVERY WIDTH.
// ===========================================================================

for (const width of WIDTHS) {
  test(`at ${width}px nothing in a follow-up row overlaps anything else`,
    { skip: SKIP }, async () => {
      const out = await measure(width);

      assert.strictEqual(out.rows, ROWS.length * 2,
        'both lists drew every row — otherwise this measured an empty section');

      assert.deepStrictEqual(out.overlaps, [],
        `sibling elements intersect at ${width}px`);
      assert.deepStrictEqual(out.buttonHits, [],
        `the Remind button is drawn over text at ${width}px`);
      assert.deepStrictEqual(out.brokenWords, [],
        `a name or designation was broken mid-word at ${width}px`);

      /* NO SIDEWAYS SCROLL. The dashboard column was widened to 1320px and this
         is the assertion that the widening stopped where it had to: #app is
         capped at 1400 with 24px of padding a side, so 1352 is the ceiling. */
      assert.ok(out.scrollWidth <= out.innerWidth + 1,
        `the page scrolls sideways at ${width}px: ${out.scrollWidth} > ${out.innerWidth}`);
    });
}

test('the reminded state is the button, and the refusal is never visible text',
  { skip: SKIP }, async () => {
    const out = await measure(1440);

    /* IT IS NOT A SENTENCE ON THE ROW. Neither the one the page used to draw
       nor the one the server sends back with the refusal. */
    assert.deepStrictEqual(out.inlineReminded, [],
      'the reminded sentence is drawn as visible text somewhere on the row');

    /* IT IS THE BUTTON. "Reminded 11:59am", disabled, with who sent it in the
       tooltip and in the accessible name — and identically in both columns,
       which is why this looks at every button and not at the first. */
    const done = out.buttons.filter((b) => /^Reminded /.test(b.text));
    assert.strictEqual(done.length, 2, 'one reminded button in each of the two lists');
    for (const b of done) {
      assert.strictEqual(b.text, 'Reminded 11:59am');
      assert.ok(b.disabled, 'and it cannot be pressed again');
      assert.match(b.title, /Reminded today 11:59am by Akilesh Kumaraswamy\./);
      assert.match(b.title, /has already been reminded today\./,
        'the server\'s own sentence is still carried, as the tooltip');
      assert.match(b.aria, /by Akilesh Kumaraswamy/,
        'and in the accessible name, which a tooltip alone would not reach');
    }

    /* AND THE ORDINARY BUTTONS ARE UNTOUCHED. */
    assert.ok(out.buttons.some((b) => b.text === 'Remind' && !b.disabled),
      'a sendable row still reads "Remind"');
  });

// ===========================================================================
// 2. THE MUTATIONS. Each one is the fix undone; each one must be caught.
// ===========================================================================

/* Run the whole width sweep and report what, if anything, it caught. */
async function sweep(mutate) {
  const found = { overlaps: [], buttonHits: [], brokenWords: [], inlineReminded: [], scroll: [] };
  for (const width of WIDTHS) {
    const out = await measure(width, { mutate });
    for (const k of ['overlaps', 'buttonHits', 'brokenWords', 'inlineReminded']) {
      for (const v of out[k]) found[k].push(`${width}px: ${v}`);
    }
    if (out.scrollWidth > out.innerWidth + 1) found.scroll.push(`${width}px: ${out.scrollWidth} > ${out.innerWidth}`);
  }
  found.any = Object.values(found).some((v) => Array.isArray(v) && v.length);
  return found;
}

const must = (source, from, to) => {
  assert.ok(source.includes(from), `the mutation's anchor is still in the page: ${from.slice(0, 60)}`);
  return source.replace(from, to);
};

test('MUTATION A — the left block loses min-width:0 and its basis, and the row stops wrapping',
  { skip: SKIP }, async () => {
    /* This is the layout as it shipped before the fix: one flex line, and the
       only item that may shrink is the one holding the name. */
    const out = await sweep((s) => {
      let v = must(s, '.fu-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;',
        '.fu-row{display:flex;align-items:center;gap:9px;');
      v = must(v, '.fu-who{flex:1 1 210px;min-width:0;}', '.fu-who{flex:1;}');
      return v;
    });
    /* AND IT IS CAUGHT AS THE REPORTED BUG, not as some side effect: the
       Remind button is drawn on top of the person's name. Note what is NOT
       caught — out.overlaps is empty, because .fu-who's BOX still clears
       .fu-side's box; only the text inside it has spilled. That is the whole
       case for measuring every non-nested pair and for measuring the button
       against the page rather than against its own row. */
    assert.ok(out.buttonHits.length,
      `the row layout was undone and nothing caught it: ${JSON.stringify(out)}`);
    assert.ok(out.buttonHits.some((h) => /fu-name/.test(h)),
      'the button is drawn over the name, which is the bug this was raised for');
  });

test('MUTATION B — the right block may shrink, and its contents may not reflow',
  { skip: SKIP }, async () => {
    /* flex-shrink:0 is only half the promise. The other half is that whatever
       the block cannot fit on one line it puts on the next; take both away and
       the badges, the figure and the button run out of the column and over the
       list beside them. */
    const out = await sweep((s) => {
      let v = must(s, '.fu-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;',
        '.fu-row{display:flex;align-items:center;gap:9px;');
      v = must(v, '.fu-side{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;\n'
        + '  flex:0 0 auto;gap:7px;margin-left:auto;max-width:100%;}',
      '.fu-side{display:flex;align-items:center;justify-content:flex-end;flex-wrap:nowrap;\n'
        + '  flex:1 1 auto;gap:7px;margin-left:auto;}');
      return v;
    });
    assert.ok(out.overlaps.length,
      `the right block was allowed to shrink and nothing caught it: ${JSON.stringify(out)}`);
    assert.ok(out.overlaps.some((h) => /fu-role/.test(h) && /fu-both|fu-held/.test(h)),
      'the badges are drawn over the designation');
  });

test('MUTATION C — the reminded sentence goes back inline on the row',
  { skip: SKIP }, async () => {
    const out = await sweep((s) => must(s,
      '    ${auto}\n    <button type="button" class="fu-remind${done ? \' is-done\' : \'\'}"',
      '    ${auto}${m.last ? `<span class="fu-reminded">Reminded today ${escapeHTML(at)}'
        + '${m.last.by ? ` by ${escapeHTML(m.last.by)}` : \'\'}</span>` : \'\'}\n'
        + '    <button type="button" class="fu-remind${done ? \' is-done\' : \'\'}"'));
    assert.ok(out.inlineReminded.length,
      `the sentence is back on the row and nothing caught it: ${JSON.stringify(out)}`);
  });

test('MUTATION D — the cap\'s refusal is drawn as visible text again',
  { skip: SKIP }, async () => {
    const out = await sweep((s) => must(s,
      "  const reasonHidden = Boolean(reason) && !sending && m.code === 'capped';",
      '  const reasonHidden = false;'));
    assert.ok(out.inlineReminded.length,
      `"has already been reminded today" is visible again and nothing caught it: ${JSON.stringify(out)}`);
  });

test('MUTATION E — names may break mid-word', { skip: SKIP }, async () => {
  const out = await sweep((s) => {
    /* Paired with the narrow left block, because a word only breaks when it is
       asked to fit somewhere it cannot. */
    let v = must(s, '.fu-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;',
      '.fu-row{display:flex;align-items:center;gap:9px;');
    v = must(v, '.fu-who{flex:1 1 210px;min-width:0;}', '.fu-who{flex:1;min-width:0;}');
    v = must(v, "font-size:12.5px;color:var(--ink);cursor:pointer;display:block;max-width:100%;\n"
      + "  white-space:normal;word-break:normal;overflow-wrap:break-word;line-height:1.35;}",
    "font-size:12.5px;color:var(--ink);cursor:pointer;display:block;max-width:100%;\n"
      + "  white-space:normal;word-break:break-all;line-height:1.35;}");
    return v;
  });
  assert.ok(out.brokenWords.length,
    `a name was broken mid-word and nothing caught it: ${JSON.stringify(out)}`);
});

test('MUTATION F — the dashboard column is widened past what the page can hold',
  { skip: SKIP }, async () => {
    const out = await sweep((s) => must(s, '.ad-wrap{max-width:1320px;', '.ad-wrap{min-width:1500px;max-width:1500px;'));
    assert.ok(out.scroll.length,
      `the column outgrew the page and nothing caught it: ${JSON.stringify(out)}`);
  });
