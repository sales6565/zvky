#!/usr/bin/env electron
/* THE START-OF-DAY BANNER AND THE TOP-BAR TIMER, IN THE BROWSER THE STUDIO
 * ACTUALLY INSTALLS.
 *
 * tests/start-of-day.test.js drives the state and the rules; this proves the
 * screen in a REAL window — Electron 33 / Chromium 130, the browser
 * desktop/src/main.js opens — because "it works in a browser but not in the
 * application" has been the report twice, and both times the cause was
 * window.prompt(), which Electron does not implement: typeof says "function"
 * and calling it throws. The three dialogs are replaced with throwing stubs
 * before anything is clicked, so a handler that reached for one would surface
 * it here.
 *
 * What it asserts, against a real studio whose clock opened ninety minutes ago:
 *
 *   the banner is on screen, naming the number of tasks assigned
 *   the top bar says "No timer running", in words and not only in a colour
 *   Start begins the task through the ordinary route
 *   the banner then disappears and the top bar turns to running, WITH NO RELOAD
 *   the elapsed figure ticks, and the pill opens the task
 *   with the previous-day timesheet rule on, Start is replaced by the reason
 *     and a link to the Time Sheet
 *   nothing was logged to the console doing any of it
 *
 *   npm run smoke:startday            (from desktop/, with MariaDB up)
 *
 * It builds its own studio and its own database on the credentials
 * tests/test-env.js uses, so it needs nothing running first.
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'start-of-day-fixture.js');
const PASSWORD = 'StartDayWindow-1!';

let failures = 0;
const log = (s) => process.stdout.write(s + '\n');
const ok = (label, condition, detail) => {
  if (condition) log(`  ✓ ${label}`);
  else { failures += 1; log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};

app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');

/* The fixture and the server it started, together: the server is its CHILD, so
   killing the fixture alone leaves a server holding a port and a database. */
function stop(child) {
  if (!child || child.killed) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function seed() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SOD_PASSWORD: PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
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
  const guard = setTimeout(() => { log('TIMED OUT'); app.exit(2); }, 300000);
  let fixture;
  try { fixture = await seed(); }
  catch (err) { log('could not build the studio: ' + (err && err.message)); app.exit(2); return; }

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

  log(`\nStart of day in Electron ${process.versions.electron} (Chromium ${process.versions.chrome})`);
  await win.loadURL(fixture.origin);
  await wait(1500);

  /* THE NATIVE DIALOGS GO FIRST, before the sign-in click — so every step after
     this point is running against a page for which calling one is fatal. */
  await step(`(() => {
    window.prompt = () => { throw new Error('prompt() is not supported.'); };
    window.confirm = () => { throw new Error('confirm() is not supported.'); };
    window.alert = () => { throw new Error('alert() is not supported.'); };
    document.getElementById('loginEmail').value = 'ana@sodw.test';
    document.getElementById('loginPassword').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('loginBtn').click(); return 'clicked';
  })()`, 'sign in');
  await wait(4000);

  const arrived = await step(`
    (() => {
      const banner = document.querySelector('.day-banner');
      const pill = document.getElementById('timerPill');
      return {
        banner: Boolean(banner),
        head: banner && banner.querySelector('.db-head') && banner.querySelector('.db-head').textContent,
        starts: banner ? banner.querySelectorAll('[data-db-start]').length : 0,
        hasSnooze: banner ? Boolean(banner.querySelector('[data-db-snooze]')) : false,
        pillShown: pill && !pill.hidden,
        pillTag: pill && pill.tagName,
        pillWords: pill && pill.textContent,
        pillClass: pill && pill.className,
        state: DAY_STATE && DAY_STATE.state,
        count: DAY_STATE && DAY_STATE.assignedCount,
      };
    })()`, 'read the first screen');
  ok('the banner is on screen, naming the number of tasks assigned',
    arrived.banner === true && /You have 2 tasks assigned/.test(arrived.head || ''),
    JSON.stringify(arrived));
  ok('with one Start per task and a way to dismiss it',
    arrived.starts === 2 && arrived.hasSnooze === true, JSON.stringify(arrived));
  ok('the top bar is a real button saying "No timer running" in words',
    arrived.pillShown === true && arrived.pillTag === 'BUTTON'
      && /No timer running/.test(arrived.pillWords || '')
      && /is-idle/.test(arrived.pillClass || ''),
    JSON.stringify(arrived));

  /* THE SNOOZE, AND THAT IT COMES BACK. Done before the Start, because starting
     ends the banner's day. */
  const snoozed = await step(`
    (async () => {
      document.querySelector('[data-db-snooze]').click();
      await new Promise(r => setTimeout(r, 150));
      const gone = !document.querySelector('.day-banner');
      /* THE STORED VALUE IS AN INSTANT, so winding it into the past is exactly
         what the snooze running out looks like — no clock is faked. */
      const key = Object.keys(localStorage).find(k => k.startsWith('zvky_day_snooze_'));
      localStorage.setItem(key, String(Date.now() - 1000));
      paintDayBanner();
      return { gone, back: Boolean(document.querySelector('.day-banner')), key };
    })()`, 'dismiss and come back');
  ok('dismissing hides it, and it returns when the snooze runs out',
    snoozed.gone === true && snoozed.back === true, JSON.stringify(snoozed));

  /* START, THROUGH THE BANNER'S OWN BUTTON. No reload: what moves is the state
     the next /auth/me carries, which startFromBanner forces. */
  const started = await step(`
    (async () => {
      const before = location.href;
      document.querySelector('[data-db-start]').click();
      await new Promise(r => setTimeout(r, 4000));
      const pill = document.getElementById('timerPill');
      const first = pill.querySelector('.tmr-time') && pill.querySelector('.tmr-time').textContent;
      await new Promise(r => setTimeout(r, 2200));
      const later = pill.querySelector('.tmr-time') && pill.querySelector('.tmr-time').textContent;
      return {
        sameDocument: before === location.href,
        banner: Boolean(document.querySelector('.day-banner')),
        state: DAY_STATE && DAY_STATE.state,
        asset: DAY_STATE && DAY_STATE.running && DAY_STATE.running.name,
        ticking: DAY_STATE && DAY_STATE.running && DAY_STATE.running.ticking,
        pillClass: pill.className,
        pillWords: pill.textContent,
        first, later,
      };
    })()`, 'start from the banner');
  ok('Start begins the task and the banner disappears, with no reload',
    started.sameDocument === true && started.banner === false
      && started.state === 'running', JSON.stringify(started));
  ok('the top bar turns to running and names the asset',
    /is-running/.test(started.pillClass || '') && started.asset === 'Hero Overdue'
      && /Hero Overdue|CH-/.test(started.pillWords || ''), JSON.stringify(started));
  ok('and the elapsed figure ticks each second',
    Boolean(started.first) && Boolean(started.later) && started.first !== started.later,
    JSON.stringify({ first: started.first, later: started.later }));

  /* CLICKING IT OPENS THE TASK, through the application's own navigation. */
  const opened = await step(`
    (async () => {
      document.getElementById('timerPill').click();
      await new Promise(r => setTimeout(r, 2500));
      return { view: state.view, drawer: document.getElementById('drawer').classList.contains('show'),
               open: state.openAssetId };
    })()`, 'click the pill');
  ok('clicking the indicator opens the running task',
    opened.drawer === true && opened.open === fixture.first, JSON.stringify(opened));

  /* AND THE BLOCKED VARIANT. The previous-day timesheet rule is switched on by
     the root account and the artist's clock put down, so the banner is due again
     — and this time Start is replaced by the reason and a link. */
  const blocked = await step(`
    (async () => {
      await fetch('/api/assets/' + ${JSON.stringify(fixture.first)} + '/hold', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ${JSON.stringify(fixture.anaToken)} }, body: '{}' });
      await fetch('/api/admin/settings/timesheet', { method: 'PUT',
        headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ${JSON.stringify(fixture.rootToken)} },
        body: JSON.stringify({ requirePreviousDay: true }) });
      /* The held round means she HAS started today, so the banner stays away on
         merit — which is why this case reads the state's own blocked field and
         the variant the server picked rather than the banner's presence. */
      permissionsCheckedAt = 0;
      await refreshPermissions();
      return {
        state: DAY_STATE && DAY_STATE.state,
        blocked: DAY_STATE && DAY_STATE.blocked && DAY_STATE.blocked.message,
        label: DAY_STATE && DAY_STATE.blocked && DAY_STATE.blocked.dateLabel,
        startedToday: DAY_STATE && DAY_STATE.startedToday,
      };
    })()`, 'switch on the timesheet rule');
  ok('the state carries the gate\'s own reason, naming the day that is owed',
    typeof blocked.blocked === 'string' && /Fill your timesheet for/.test(blocked.blocked)
      && Boolean(blocked.label), JSON.stringify(blocked));
  ok('and the held round reads as having started today, so no banner is due',
    blocked.startedToday === true && blocked.state === 'held', JSON.stringify(blocked));

  /* THE BLOCKED BANNER ITSELF, drawn from a state with the gate set — asserted
     against the real renderer rather than against a reconstruction of it. */
  const drawn = await step(`
    (() => {
      const was = DAY_STATE;
      DAY_STATE = { ...was, state:'idle', running:null, startedToday:false,
        assignedCount: 1, tasks: [{ assetId:'x', code:'CH-001', name:'Hero', status:'assigned',
          statusLabel:'Assigned', dueDate:null, overdue:false }],
        banner: { ...was.banner, show:true, variant:'blocked' } };
      paintDayBanner();
      const b = document.querySelector('.day-banner');
      const out = { why: b && b.querySelector('.db-why') && b.querySelector('.db-why').textContent,
                    fix: b ? b.querySelectorAll('[data-db-fix]').length : 0,
                    starts: b ? b.querySelectorAll('[data-db-start]').length : 0 };
      DAY_STATE = was; paintDayBanner();
      return out;
    })()`, 'draw the blocked banner');
  ok('the blocked banner shows the reason and a link instead of Start',
    /Fill your timesheet for/.test(drawn.why || '') && drawn.fix === 1 && drawn.starts === 0,
    JSON.stringify(drawn));

  ok('nothing was logged to the console doing any of it',
    complaints.length === 0, complaints.join(' | '));

  clearTimeout(guard);
  log(failures ? `\n${failures} failed` : '\nall good');
  stop(fixture.child);
  app.exit(failures ? 1 : 0);
});
