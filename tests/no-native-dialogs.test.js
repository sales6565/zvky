/* NO NATIVE DIALOG IN THE SERVED PAGE. EVER AGAIN.
 *
 * THE FIFTH REPORT OF THE HOLD BUTTON was not about the permission rule at all:
 * Hold worked in a browser and did NOTHING in the installed desktop
 * application. That application is Electron (desktop/, electron ^33), which
 * loads the studio's own URL in a BrowserWindow — and Electron does not
 * implement window.prompt(). `typeof window.prompt` is "function"; calling it
 * throws `Error: prompt() is not supported.`
 *
 * Hold asked for its optional note with window.prompt(), from inside an async
 * onclick, BEFORE that handler's own try block. So the throw became an
 * unhandled promise rejection: no request, no busy state, no message, one
 * console line nobody was looking at. Resume passed `ask: false`, never reached
 * the prompt, and worked — which is exactly why the report named Hold alone.
 *
 * MEASURED, on Electron 33.4.11 / Chromium 130, running the shipped handler's
 * own shape:
 *
 *     { requestsSent: 0, buttonDisabled: false, errorBoxText: "",
 *       pageSaw: ["unhandledrejection: prompt() is not supported."] }
 *     renderer console: Uncaught (in promise) Error: prompt() is not supported.
 *
 * AND confirm() IS NOT SAFE EITHER, for a different reason: Electron implements
 * it as a native MODAL that blocks the renderer until it is answered. Measured
 * against a window that was not visible, the renderer never came back at all —
 * the executeJavaScript promise simply never settled. The whole application
 * freezes while one is up. That is why the thirty confirm() calls went with the
 * seven prompts rather than being left as "the ones that work".
 *
 * THIS FILE IS THE BUILD FAILING. A native dialog is not a style preference
 * here; it is a control that does nothing in the application the studio
 * actually uses. Every question is asked through openAsk() in the page, and
 * tests/dialog-flow.test.js drives Hold end to end with all three of these
 * overridden to throw.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVED = path.join(__dirname, '..', 'public');
const PAGE = fs.readFileSync(path.join(SERVED, 'index.html'), 'utf8');

/* THE ALLOW-LIST, AND IT IS EMPTY.
 *
 * Left here as the place an exception would have to be argued for rather than
 * added quietly. Every entry needs a reason that survives the question "what
 * does this do in Electron?" — and for all three functions the answer is
 * "throws, or freezes the window", so there is no reason that can.
 */
const ALLOWED = [];

/* Strip what is not code. The three names appear all over this file's comments —
 * and in the one above — because explaining why they are gone requires naming
 * them. A comment is not a call. */
function codeOnly(src) {
  const blank = (m) => ' '.repeat(m[0].length);
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/* A CALL, not a mention. `(?<![\w.$])` keeps `askConfirm(` and `this.alert(`
 * out; the optional `window.` prefix catches the form Hold actually used. */
const callsTo = (name) => new RegExp(`(?<![\\w.$])(?:window\\.)?${name}\\s*\\(`, 'g');

function sitesIn(src, name) {
  const code = codeOnly(src);
  const out = [];
  for (const m of code.matchAll(callsTo(name))) {
    const line = src.slice(0, m.index).split('\n').length;
    const text = src.split('\n')[line - 1].trim();
    if (ALLOWED.some((a) => a.line === text)) continue;
    out.push({ line, text: text.slice(0, 140) });
  }
  return out;
}

test('the served page calls no native dialog', () => {
  const found = [];
  for (const name of ['prompt', 'confirm', 'alert']) {
    for (const site of sitesIn(PAGE, name)) {
      found.push(`public/index.html:${site.line}  ${name}()  ${site.text}`);
    }
  }
  assert.deepStrictEqual(found, [],
    'a native dialog is back in the page. In the installed desktop application '
    + 'prompt() throws and confirm() freezes the window, so this control does '
    + 'nothing there. Ask through openAsk() instead — see the header of this file.');
});

test('every other served file is clean too', () => {
  /* THE PAGE IS NOT THE ONLY THING SERVED. public/native-bridge.js runs on the
     same document, and a dialog in it would fail in exactly the same way — more
     quietly, because it is the file nobody looks at. */
  const others = fs.readdirSync(SERVED)
    .filter((f) => f !== 'index.html' && /\.(?:js|mjs|html)$/i.test(f));
  assert.ok(others.length, 'there is more than one served file, and this test knows it');
  const found = [];
  for (const file of others) {
    const src = fs.readFileSync(path.join(SERVED, file), 'utf8');
    for (const name of ['prompt', 'confirm', 'alert']) {
      for (const site of sitesIn(src, name)) {
        found.push(`public/${file}:${site.line}  ${name}()  ${site.text}`);
      }
    }
  }
  assert.deepStrictEqual(found, []);
});

test('the allow-list is empty, and an entry would have to say why', () => {
  /* NOT A RULE THAT CANNOT BEND — a rule whose bending is visible. If a dialog
     ever has to stay, it goes in ALLOWED with a reason, and this assertion is
     what makes somebody write one. */
  for (const entry of ALLOWED) {
    assert.ok(entry.reason && entry.reason.length > 30,
      `${entry.line} is allowed without a reason worth reading`);
  }
  assert.strictEqual(ALLOWED.length, 0,
    'no native dialog needs to stay: every question has an in-page form');
});

test('there is one way to ask, and it is in the page', () => {
  /* The replacement, asserted so that removing the dialogs cannot be done by
     deleting the questions. */
  assert.match(PAGE, /function openAsk\(\{/, 'the shared dialog exists');
  assert.match(PAGE, /const askConfirm = \(opts\)/, 'and a yes/no form');
  assert.match(PAGE, /const askText = \(opts\)/, 'and a one-line-input form');
  assert.match(PAGE, /<div class="modal-wrap" id="askWrap">/, 'with markup to draw it in');

  /* IT REUSES THE EXISTING COMPONENT rather than inventing a second modal: the
     same .modal-wrap/.modal classes, so it inherits the overlay, the panel and
     every colour token they already read. */
  const markup = PAGE.slice(PAGE.indexOf('id="askWrap"'), PAGE.indexOf('id="modalWrap"'));
  assert.match(markup, /class="modal-wrap"/);
  assert.match(markup, /class="modal"/);
  assert.match(markup, /class="btn btn-ghost" id="ask_cancel"/, 'the existing button classes');
  assert.match(markup, /class="btn btn-brand" id="ask_confirm"/);
  assert.match(markup, /role="dialog" aria-modal="true" aria-labelledby="ask_title"/,
    'and it says what it is to a screen reader');

  /* NO COLOUR OF ITS OWN. tests/theme-literals.test.js enforces this across the
     whole file; said again here because a modal is exactly where somebody
     reaches for a hex. */
  const styles = PAGE.match(/\.ask-message\{[^}]*\}/);
  assert.ok(styles, 'the message has a style');
  assert.ok(!/#[0-9a-fA-F]{3,8}|rgba?\(/.test(styles[0]),
    'and it is written in tokens');
  const danger = PAGE.match(/\.btn-danger-solid\{[^}]*\}/);
  assert.ok(danger && !/#[0-9a-fA-F]{3,8}/.test(danger[0]),
    'and so is the destructive button');
});

test('Enter confirms, Escape cancels, and the listener is bound once', () => {
  const at = PAGE.indexOf("document.addEventListener('keydown', (e)=>{\n  if(!askActive) return;");
  assert.ok(at !== -1, 'the dialog has no keyboard handling');
  const body = PAGE.slice(at, at + 700);
  assert.match(body, /e\.key === 'Escape'/);
  assert.match(body, /askActive\.cancel\(\)/);
  assert.match(body, /e\.key === 'Enter'/);
  assert.match(body, /askActive\.confirm\(\)/);
  /* A TEXTAREA IS THE ONE PLACE ENTER MEANS A NEW LINE. There is no textarea in
     the shared dialog today, and the exception is here so that adding one does
     not quietly make Enter submit a half-written sentence. */
  assert.match(body, /tagName === 'TEXTAREA'/);

  /* BOUND ON THE DOCUMENT, ONCE. A listener added when a question opens is a
     listener left behind when it is answered, and after a dozen questions one
     Escape cancels a dialog that is not on screen. */
  assert.strictEqual((PAGE.match(/if\(!askActive\) return;/g) || []).length, 1,
    'exactly one keydown handler guards on the open question');
});

test('the page-level guard turns a silent throw into something visible', () => {
  /* THE REAL LESSON OF THIS REPORT. The bug was not really prompt(); it was
     that a click handler could throw and the person be told nothing at all.
     Any handler can throw — a missing element, a renamed field, a wrapper that
     does not implement something — so the page now says so. */
  assert.match(PAGE, /window\.addEventListener\('error', \(e\)=>\{/, 'uncaught errors');
  assert.match(PAGE, /window\.addEventListener\('unhandledrejection', \(e\)=>\{/,
    'and the rejection the prompt() throw actually produced');
  assert.match(PAGE, /function reportUnexpected\(what, err\)\{/);
  assert.match(PAGE, /showToast\(`Something went wrong: \$\{message\}`\)/,
    'and it reaches the screen, not only the console');

  /* A FAILED IMAGE IS NOT A HANDLER THROWING. window.onerror fires for those
     too, with no .error, and shouting about one would train people to ignore
     the toast. */
  const guard = PAGE.slice(PAGE.indexOf("window.addEventListener('error'"), PAGE.indexOf("window.addEventListener('unhandledrejection'"));
  assert.match(guard, /if\(!e \|\| !e\.error\) return;/);

  /* AND HOLD'S OWN HANDLER IS WRAPPED, which is the belt to that braces: even
     if the global listener were removed, the click that was reported cannot
     fail silently. */
  assert.match(PAGE, /function guarded\(what, fn\)\{/);
  assert.match(PAGE, /button\.onclick = guarded\(`\$\{path\} on \$\{id\}`, async \(ev\)=>\{/,
    'the Hold and Resume buttons go through it');
});
