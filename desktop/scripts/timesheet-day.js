#!/usr/bin/env electron
/* THE ADD LINE FORM'S DAY FIGURE, IN THE BROWSER THE STUDIO ACTUALLY INSTALLS.
 *
 * tests/timesheet-working-day.test.js proves the arithmetic and drives the page
 * in a harness. This one proves the same three claims in a REAL window —
 * Electron 33 / Chromium 130, the browser desktop/src/main.js opens — because
 * the last two reports of this feature were both "it works in a browser but not
 * in the application", and a harness cannot tell you that.
 *
 * The acceptance example from the brief, seeded through the real API:
 *
 *   one asset, one person, started 6:00 PM on 8 Oct, finished 11:00 AM on 9 Oct,
 *   studio hours 9:30 AM - 7:00 PM with lunch 1:00 - 2:00 PM
 *
 *     day 1 (8 Oct)  must read  1 h       (18:00 -> 19:00)
 *     day 2 (9 Oct)  must read  1 h 30 m  (09:30 -> 11:00)
 *
 * and never 6 h / 11 h (a midnight split), never 17 h (wall clock), never the
 * asset's 2 h 30 m total.
 *
 * Third claim: a SLOW reply for day 1 must never overwrite day 2's number. The
 * race is run with a real fetch held open past the second request, not simulated.
 *
 *   npm run smoke:timesheet            (from desktop/, with MariaDB up)
 *
 * It boots its own server and its own database on the test credentials
 * tests/test-env.js uses, so it needs nothing running first.
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'timesheet-day-fixture.js');
const PASSWORD = 'TsWindow-1!';

let failures = 0;
const log = (s) => process.stdout.write(s + '\n');
const ok = (label, condition, detail) => {
  if (condition) log(`  ✓ ${label}`);
  else { failures += 1; log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};

/* Chromium otherwise reaches for its component updater and its background
   networking on the way up, and an egress proxy that refuses those hosts makes
   it wait rather than fail. Both are off; everything else is default. */
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');

/* The studio is built by the other half of this test, as plain Node. See the
   comment at the top of timesheet-day-fixture.js for why it cannot be built
   here: under Electron process.execPath is the Electron binary, and
   tests/helpers.js starts the server with it. ELECTRON_RUN_AS_NODE makes that
   same binary behave as Node, which is how the child — and the server the child
   starts — both come up as servers rather than as more windows. */
/* The fixture and the server it started, together. */
function stop(child) {
  if (!child || child.killed) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function seed() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TS_PASSWORD: PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
      /* Its own process group, because the server is its CHILD: killing the
         fixture alone leaves a server holding a port and a database. The group
         takes both down together. */
      detached: true,
    });
    let out = '';
    let err = '';
    const give = setTimeout(() => {
      stop(child);
      reject(new Error('the studio took longer than two minutes to build\n' + err.slice(-800)));
    }, 120000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.startsWith('READY '));
      if (!line) return;
      clearTimeout(give);
      resolve({ ...JSON.parse(line.slice(6)), child });
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => {
      clearTimeout(give);
      reject(new Error(`the studio exited with ${code}\n${err.slice(-800)}`));
    });
  });
}

app.on('ready', async () => {
  /* Building the studio runs the whole startup migration against a fresh
     database, which is the slow part; the window itself takes seconds. */
  const guard = setTimeout(() => { log('TIMED OUT'); app.exit(2); }, 300000);
  let fixture;
  try { fixture = await seed(); }
  catch (err) { log('could not build the studio: ' + (err && err.message)); app.exit(2); return; }
  const DAY1 = fixture.day1;
  const DAY2 = fixture.day2;

  const win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const complaints = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (/Security Warning/.test(message)) return;
    if (level >= 2) complaints.push(message.slice(0, 200));
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = async (source, label) => {
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(source),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 30000)),
      ]);
    } catch (err) { return { FAILED: `${label}: ${err && err.message}` }; }
  };

  log(`\nThe Add line form in Electron ${process.versions.electron} (Chromium ${process.versions.chrome})`);
  await win.loadURL(fixture.url);
  await wait(1500);
  await step(`(() => {
    document.getElementById('loginEmail').value = ${JSON.stringify(fixture.email)};
    document.getElementById('loginPassword').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('loginBtn').click(); return 'clicked';
  })()`, 'sign in');
  await wait(3500);

  /* The form, opened through the page's own functions and with the pickers
     walked the way a person walks them — client, then project, then asset, each
     one dispatching the change event the page listens for. Reconstructing the
     form would measure the reconstruction. */
  const opened = await step(`
    (async () => {
      setTab('timesheet');
      await render();
      await openTimesheetLine(${JSON.stringify(DAY1)});
      await new Promise(r => setTimeout(r, 400));
      const fire = (id, value) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      fire('tl_client', ${JSON.stringify(fixture.client)});
      await new Promise(r => setTimeout(r, 700));
      fire('tl_project', ${JSON.stringify(fixture.project)});
      await new Promise(r => setTimeout(r, 700));
      const sel = document.getElementById('tl_asset');
      return { shown: document.getElementById('timesheetLineWrap').classList.contains('show'),
               day: tlDay,
               assets: sel ? [...sel.options].map(o => o.value) : [] };
    })()`, 'open the form');
  ok('the form opens on day 1 with the asset in the picker',
    opened.shown === true && opened.day === DAY1
      && Array.isArray(opened.assets) && opened.assets.includes(fixture.asset),
    JSON.stringify(opened));

  const pick = (day) => step(`
    (async () => {
      tlDay = ${JSON.stringify(day)};
      document.getElementById('tl_day').textContent = ${JSON.stringify(day)};
      const sel = document.getElementById('tl_asset');
      sel.value = ${JSON.stringify(fixture.asset)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      await tlSuggest();
      return { note: document.getElementById('tl_suggest').textContent,
               hours: document.getElementById('tl_hours').value };
    })()`, `select the asset on ${day}`);

  const first = await pick(DAY1);
  ok('day 1 reads 1 h, and the field is pre-filled with 1',
    /\b1 h\b/.test(first.note || '') && !/1 h 30/.test(first.note || '')
      && first.hours === '1', JSON.stringify(first));
  ok('day 1 is not a midnight split, a wall clock, or the asset total',
    !/(6 h|6\.1|11 h|17 h|2 h 30)/.test(first.note || ''), JSON.stringify(first));

  const second = await pick(DAY2);
  ok('day 2 reads 1 h 30 m, and the field is pre-filled with 1.5',
    /1 h 30 m/.test(second.note || '') && second.hours === '1.5',
    JSON.stringify(second));

  /* The stale guard, with a real reply held open. Day 1's request is parked,
     day 2's is allowed through, and then day 1's is released: the sentence and
     the field must both still be day 2's. */
  const race = await step(`
    (async () => {
      const real = window.fetch;
      let release = null;
      window.fetch = function (url, opts) {
        const p = real.call(this, url, opts);
        if (String(url).includes('date=${DAY1}')) {
          return new Promise((res) => { release = () => p.then(res); });
        }
        return p;
      };
      tlDay = ${JSON.stringify(DAY1)};
      document.getElementById('tl_asset').value = ${JSON.stringify(fixture.asset)};
      const slow = tlSuggest();
      await new Promise(r => setTimeout(r, 60));
      tlDay = ${JSON.stringify(DAY2)};
      await tlSuggest();
      const settled = { note: document.getElementById('tl_suggest').textContent,
                        hours: document.getElementById('tl_hours').value };
      if (release) release();
      await new Promise(r => setTimeout(r, 900));
      window.fetch = real;
      await slow.catch(() => {});
      return { settled,
               afterStale: { note: document.getElementById('tl_suggest').textContent,
                             hours: document.getElementById('tl_hours').value } };
    })()`, 'the race');
  const settled = race.settled || {};
  const afterStale = race.afterStale || {};
  ok('day 2 wins while day 1 is still in flight',
    /1 h 30 m/.test(settled.note || '') && settled.hours === '1.5',
    JSON.stringify(race));
  ok("day 1's late reply never overwrites day 2",
    /1 h 30 m/.test(afterStale.note || '') && afterStale.hours === '1.5',
    JSON.stringify(race));
  ok('the page logged no errors doing any of it', complaints.length === 0,
    complaints.join(' | '));

  clearTimeout(guard);
  stop(fixture.child);
  log(failures ? `\n${failures} failed\n` : '\nall good\n');
  app.exit(failures ? 1 : 0);
});
