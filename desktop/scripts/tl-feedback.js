#!/usr/bin/env electron
/* SUBMIT FEEDBACK, CLICKED IN THE BROWSER THE STUDIO ACTUALLY INSTALLS.
 *
 * tests/tl-feedback.test.js drives this handler in a harness with the three
 * native dialogs passed in throwing. This proves the same thing in a REAL window
 * — Electron 33 / Chromium 130, the browser desktop/src/main.js opens — because
 * "it works in a browser but not in the application" has been the report twice,
 * and both times the cause was window.prompt(), which Electron does not
 * implement: typeof says "function" and calling it throws.
 *
 * What it asserts, on a real asset in TL Approved:
 *
 *   the three buttons are on the stage, Submit Feedback among them
 *   clicking it opens the page's own modal, with a text area and a counter
 *   the confirm button is dead until the feedback is long enough
 *   Cancel sends nothing and the card does not move
 *   confirming moves the card to TL Feedbacks WITHOUT A RELOAD, and the server
 *     agrees when asked afterwards
 *   nothing was logged to the console doing any of it
 *
 *   npm run smoke:feedback            (from desktop/, with MariaDB up)
 *
 * It builds its own studio and its own database on the credentials
 * tests/test-env.js uses, so it needs nothing running first.
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'tl-feedback-fixture.js');
const PASSWORD = 'TlFbWindow-1!';
const SHORT = 'too short';
const GOOD = 'The rim light on the hero reads flat — raise it and re-render the turntable.';

let failures = 0;
const log = (s) => process.stdout.write(s + '\n');
const ok = (label, condition, detail) => {
  if (condition) log(`  ✓ ${label}`);
  else { failures += 1; log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};

/* Chromium otherwise reaches for its component updater and its background
   networking on the way up, and an egress proxy that refuses those hosts makes it
   wait rather than fail. Both are off; everything else is default. */
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TLFB_PASSWORD: PASSWORD },
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

  log(`\nSubmit Feedback in Electron ${process.versions.electron} (Chromium ${process.versions.chrome})`);
  await win.loadURL(fixture.url);
  await wait(1500);
  await step(`(() => {
    document.getElementById('loginEmail').value = ${JSON.stringify(fixture.email)};
    document.getElementById('loginPassword').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('loginBtn').click(); return 'clicked';
  })()`, 'sign in');
  await wait(3500);

  /* The drawer, opened through the page's own function on the real asset — so
     what is measured is the real panel rather than a reconstruction of it. */
  const opened = await step(`
    (async () => {
      setTab('board');
      await render();
      await openDrawer(${JSON.stringify(fixture.asset)});
      await new Promise(r => setTimeout(r, 400));
      const btn = document.getElementById('tlFeedbackBtn');
      const card = (state.assets || []).find(x => x.id === ${JSON.stringify(fixture.asset)});
      return {
        onCd: Boolean(document.getElementById('tlToCdBtn')),
        onClient: Boolean(document.getElementById('tlSendClientBtn')),
        onFeedback: Boolean(btn),
        enabled: Boolean(btn && !btn.disabled),
        status: card && card.status,
        allowed: card && card.feedback_state && card.feedback_state.canSubmit,
        limits: card && card.feedback_state
          && [card.feedback_state.minLength, card.feedback_state.maxLength],
      };
    })()`, 'open the drawer');
  ok('the asset is in TL Approved with the server allowing feedback',
    opened.status === 'tl_approved' && opened.allowed === true, JSON.stringify(opened));
  ok('all three buttons are on the stage, Submit Feedback among them',
    opened.onCd === true && opened.onFeedback === true && opened.enabled === true,
    JSON.stringify(opened));

  /* THE MODAL. Opened by a real click, and the three native dialogs are replaced
     with throwing stubs first — so if this handler reached for one, the page's
     own guard would surface it and the click would not get this far. */
  const asked = await step(`
    (async () => {
      window.prompt = () => { throw new Error('prompt() is not supported.'); };
      window.confirm = () => { throw new Error('confirm() is not supported.'); };
      window.alert = () => { throw new Error('alert() is not supported.'); };
      document.getElementById('tlFeedbackBtn').click();
      await new Promise(r => setTimeout(r, 120));
      const area = document.getElementById('ask_textarea');
      return {
        shown: document.getElementById('askWrap').classList.contains('show'),
        area: area.style.display !== 'none',
        line: document.getElementById('ask_input').style.display === 'none',
        maxlength: area.getAttribute('maxlength'),
        confirmDead: document.getElementById('ask_confirm').disabled,
        counter: document.getElementById('ask_count').textContent,
        title: document.getElementById('ask_title').textContent,
      };
    })()`, 'open the question');
  ok('the page asks in its own modal, with a text area and no native dialog',
    asked.shown === true && asked.area === true && asked.line === true, JSON.stringify(asked));
  ok('and the button is dead with a counter saying what is missing',
    asked.confirmDead === true && /more character/.test(asked.counter || ''),
    JSON.stringify(asked));

  const typed = await step(`
    (async () => {
      const area = document.getElementById('ask_textarea');
      const type = (t) => { area.value = t; area.dispatchEvent(new Event('input', { bubbles:true })); };
      type(${JSON.stringify(SHORT)});
      const short = document.getElementById('ask_confirm').disabled;
      type(${JSON.stringify(GOOD)});
      return { short, long: document.getElementById('ask_confirm').disabled,
               counter: document.getElementById('ask_count').textContent };
    })()`, 'type the feedback');
  ok('too short stays dead, long enough comes alive',
    typed.short === true && typed.long === false, JSON.stringify(typed));

  /* CANCEL FIRST, because "cancel sends nothing" is only worth asserting against
     a live server: the card must still be in TL Approved afterwards. */
  const cancelled = await step(`
    (async () => {
      document.getElementById('ask_cancel').click();
      await new Promise(r => setTimeout(r, 200));
      const fresh = await api('/assets/project/' + ${JSON.stringify(fixture.project)});
      const card = fresh.assets.find(x => x.id === ${JSON.stringify(fixture.asset)});
      return { closed: !document.getElementById('askWrap').classList.contains('show'),
               status: card && card.status };
    })()`, 'cancel');
  ok('Cancel closes the question and sends nothing',
    cancelled.closed === true && cancelled.status === 'tl_approved',
    JSON.stringify(cancelled));

  const sent = await step(`
    (async () => {
      document.getElementById('tlFeedbackBtn').click();
      await new Promise(r => setTimeout(r, 120));
      const area = document.getElementById('ask_textarea');
      area.value = ${JSON.stringify(GOOD)};
      area.dispatchEvent(new Event('input', { bubbles:true }));
      /* NO RELOAD AND NO RENDER: fetch is stubbed out after the one request the
         handler makes, so a card that moved did so from the response rather than
         from a refetch. */
      const real = window.fetch;
      let requests = 0;
      window.fetch = function (url, opts) {
        requests += 1;
        return real.call(this, url, opts);
      };
      await document.getElementById('ask_confirm').click();
      await new Promise(r => setTimeout(r, 400));
      window.fetch = real;
      const card = (state.assets || []).find(x => x.id === ${JSON.stringify(fixture.asset)});
      /* THE COLUMN THE CARD IS NOW DRAWN IN, found by the card rather than by the
         column: .column[data-status] is the board's own markup, and its heading
         is what a person reads. */
      const column = [...document.querySelectorAll('.column')]
        .find(c => (c.textContent || '').includes(${JSON.stringify(fixture.assetCode)}));
      return {
        requests,
        closed: !document.getElementById('askWrap').classList.contains('show'),
        inState: card && card.status,
        routed: Boolean(card && card.routed_to_id),
        column: column ? (column.querySelector('.col-head .title') || {}).textContent : null,
        count: column ? (column.querySelector('.col-head .count') || {}).textContent : null,
      };
    })()`, 'submit the feedback');
  ok('confirming sends exactly one request',
    sent.requests === 1, JSON.stringify(sent));
  ok('the card is in TL Feedbacks and routed, with no reload',
    sent.inState === 'tl_changes_requested' && sent.routed === true && sent.closed === true,
    JSON.stringify(sent));
  ok('and the board has drawn it in the TL Feedbacks column, counted there',
    /TL Feedbacks/i.test(sent.column || '') && Number(sent.count) >= 1, JSON.stringify(sent));

  const server = await step(`
    (async () => {
      const fresh = await api('/assets/project/' + ${JSON.stringify(fixture.project)});
      const card = fresh.assets.find(x => x.id === ${JSON.stringify(fixture.asset)});
      return { status: card && card.status,
               feedback: (card.feedback || []).map(f => f.text).slice(0, 2),
               stillOffered: card.feedback_state && card.feedback_state.canSubmit };
    })()`, 'ask the server');
  ok('the server agrees, and the feedback is stored where the artist reads it',
    server.status === 'tl_changes_requested'
      && (server.feedback || []).some((t) => t === GOOD), JSON.stringify(server));
  ok('and the button is no longer offered, because the stage has moved',
    server.stillOffered === false, JSON.stringify(server));
  ok('the page logged no errors doing any of it', complaints.length === 0,
    complaints.join(' | '));

  clearTimeout(guard);
  stop(fixture.child);
  log(failures ? `\n${failures} failed\n` : '\nall good\n');
  app.exit(failures ? 1 : 0);
});
