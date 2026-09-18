/* Pasting a screenshot into the message box.
 *
 * A clipboard image arrives on the paste event as a FILE — the same shape the
 * file dialog hands over — so the feature is mostly a matter of recognising it
 * and putting it in the list the paperclip already fills. What is worth
 * testing is everything around that:
 *
 *   IT MUST NOT BYPASS THE UPLOAD RULES. A pasted file has no dialog and no
 *      `accept` attribute in front of it, so the only thing standing between a
 *      GIF and the server is the check below. One function answers for both
 *      ways in, which is what stops them drifting.
 *
 *   THE TYPE DECIDES, NOT THE NAME. Chrome calls every clipboard image
 *      "image.png" whatever it holds. Reading the name first renamed a GIF
 *      into a PNG and walked it past the format check — found in a browser,
 *      pinned here.
 *
 *   PLAIN TEXT MUST BE LEFT ALONE. The whole feature is a no-op unless there
 *      is an image on the clipboard.
 *
 * The functions are lifted out of public/index.html and run here, which is how
 * the other page-logic suites in this repo work — there is no build step and
 * no module system in that file, so the alternative is asserting on its text.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const chatFiles = require('../src/chat-files');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* Pull one top-level function or const out of the page by name. */
function lift(name) {
  const fn = PAGE.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)\\n}\\n`));
  if (fn) return `function ${name}(${fn[1]}\n}`;
  const konst = PAGE.match(new RegExp(`\\nconst ${name} = \\{([\\s\\S]*?)\\n\\};\\n`));
  if (konst) return `const ${name} = {${konst[1]}\n};`;
  throw new Error(`public/index.html has no ${name}`);
}

/* The page's paste helpers, with the two globals they lean on replaced by
   stubs: chatState for the limits the server sent, and showToast for the
   refusals. Everything else in them is self-contained. */
function composer({ allowed = chatFiles.ADVERTISED, maxBytes = chatFiles.MAX_BYTES } = {}) {
  const parts = ['chatExtensionOf', 'chatAllowedExtensions', 'chatFileRefusal',
    'chatKindOfName', 'chatNamePastedImage', 'chatPastedImages'].map(lift);
  parts.unshift(lift('CHAT_PASTE_EXTENSIONS'));
  const build = new Function('chatState', `
    ${parts.join('\n')}
    return { chatFileRefusal, chatPastedImages, chatNamePastedImage, chatKindOfName, chatExtensionOf };
  `);
  return build({ limits: { allowed, maxBytes } });
}

/* A clipboard, as a browser hands one over. */
const clipboard = (entries) => ({
  items: entries.map(([type, file]) => ({
    kind: file ? 'file' : 'string',
    type,
    getAsFile: () => file || null,
  })),
  getData: () => '',
});
const imageFile = (name, type, bytes = 8) => new File([new Uint8Array(bytes)], name, { type });

// --- the rules are the server's, not a second set ----------------------------

test('the composer refuses exactly what the server refuses', () => {
  const { chatFileRefusal } = composer();

  for (const ext of chatFiles.EXTENSIONS) {
    /* .jpeg is real and allowed but is not in the advertised list, which is
       what the browser is given — so it is not expected to pass here. The
       server still takes it; this is a client-side fast no, and being slightly
       stricter than the server costs a person nothing they can see. */
    if (ext === '.jpeg') continue;
    assert.strictEqual(chatFileRefusal(imageFile(`a${ext}`, 'image/png')), null,
      `${ext} is on the server's list and must be allowed here too`);
  }

  for (const ext of ['.gif', '.bmp', '.tiff', '.zip', '.exe', '.pdf', '']) {
    const refusal = chatFileRefusal(imageFile(`a${ext}`, 'image/gif'));
    assert.ok(refusal, `${ext || '(no extension)'} should be refused`);
    assert.match(refusal, /does not carry/);
    assert.match(refusal, /Allowed: /, 'and it says what IS carried');
  }
});

test('the size ceiling is the server\'s number, and the sentence names it', () => {
  const { chatFileRefusal } = composer();
  const max = chatFiles.MAX_BYTES;
  assert.strictEqual(chatFileRefusal(imageFile('ok.png', 'image/png', max)), null, 'exactly the limit is fine');
  const refusal = chatFileRefusal(imageFile('big.png', 'image/png', max + 1));
  assert.match(refusal, /larger than 30MB/);
});

test('the advertised list the page is given is the one the server publishes', () => {
  /* The page does not keep its own copy — it reads chatState.limits.allowed,
     which GET /api/chat sends. This asserts the two ends of that wire agree,
     so a format added to src/chat-files.js reaches the composer without
     anybody editing the page. */
  const { chatFileRefusal } = composer({ allowed: chatFiles.ADVERTISED });
  for (const ext of chatFiles.ADVERTISED.split(',').map((s) => s.trim())) {
    assert.strictEqual(chatFileRefusal(imageFile(`x${ext}`, 'image/png')), null, ext);
  }
});

// --- the type decides, not the name ------------------------------------------

test('THE REGRESSION: a clipboard image is named from its type, not its filename', () => {
  /* Chrome calls every clipboard image "image.png". Believing that name is how
     a GIF became a PNG and slipped past the format check — caught in a real
     browser, and this is what stops it coming back. */
  const { chatNamePastedImage, chatFileRefusal } = composer();

  const lying = chatNamePastedImage(imageFile('image.png', 'image/gif'));
  assert.match(lying.name, /\.gif$/, 'the name follows the bytes, not the browser\'s label');
  assert.ok(chatFileRefusal(lying), 'and it is therefore refused, which is the point');

  const honest = chatNamePastedImage(imageFile('image.png', 'image/png'));
  assert.match(honest.name, /^pasted-\d{8}-\d{6}\.png$/,
    'a real PNG gets a stamped name, so two screenshots a minute apart are told apart');
  assert.strictEqual(chatFileRefusal(honest), null);

  for (const [type, ext] of [['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/svg+xml', '.svg']]) {
    assert.match(chatNamePastedImage(imageFile('image.png', type)).name, new RegExp(`\\${ext}$`), type);
  }
});

test('a pasted image keeps its bytes and its type', () => {
  const { chatNamePastedImage } = composer();
  const original = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', { type: 'image/png' });
  const renamed = chatNamePastedImage(original);
  assert.strictEqual(renamed.size, 4, 'renaming must copy the file, not replace it');
  assert.strictEqual(renamed.type, 'image/png');
});

// --- what counts as a paste worth taking -------------------------------------

test('an image on the clipboard is picked up', () => {
  const { chatPastedImages } = composer();
  const got = chatPastedImages(clipboard([['image/png', imageFile('image.png', 'image/png')]]));
  assert.strictEqual(got.length, 1);
  assert.match(got[0].name, /^pasted-.*\.png$/);
});

test('plain text is not', () => {
  /* The first line of the handler. No image, no interference — which is the
     whole of requirement "don't change normal pasting". */
  const { chatPastedImages } = composer();
  assert.deepStrictEqual(chatPastedImages(clipboard([['text/plain', null]])), []);
  assert.deepStrictEqual(chatPastedImages(clipboard([['text/html', null], ['text/plain', null]])), []);
  assert.deepStrictEqual(chatPastedImages(null), [], 'and a paste with no clipboard at all does not throw');
  assert.deepStrictEqual(chatPastedImages({}), []);
});

test('a non-image file on the clipboard is not treated as one', () => {
  const { chatPastedImages } = composer();
  assert.deepStrictEqual(
    chatPastedImages(clipboard([['application/pdf', imageFile('a.pdf', 'application/pdf')]])), []);
});

test('text copied alongside an image yields the image, and leaves the text', () => {
  /* Copying part of a document gives both. The picture is taken; the words are
     left for the browser to paste, which is what the handler's preventDefault
     rule turns on. */
  const { chatPastedImages } = composer();
  const got = chatPastedImages(clipboard([
    ['text/plain', null],
    ['image/png', imageFile('image.png', 'image/png')],
  ]));
  assert.strictEqual(got.length, 1);
});

test('several images in one paste all come through', () => {
  const { chatPastedImages } = composer();
  const got = chatPastedImages(clipboard([
    ['image/png', imageFile('image.png', 'image/png')],
    ['image/jpeg', imageFile('image.png', 'image/jpeg')],
  ]));
  assert.deepStrictEqual(got.map((f) => f.name.slice(-4)), ['.png', '.jpg']);
});

// --- the composer, as the page wires it --------------------------------------

test('the paste listener is on the message box and nothing else', () => {
  const handler = PAGE.match(/document\.addEventListener\('paste', e=>\{([\s\S]*?)\n\}\);/);
  assert.ok(handler, 'public/index.html has no paste handler');
  assert.match(handler[1], /e\.target\.id !== 'chatInput'/,
    'a paste handler on the document must let every other field alone');
  assert.match(handler[1], /if\(!images\.length\) return;/,
    'and must return before doing anything when there is no image');
});

test('both ways of attaching a file go through one check', () => {
  /* The paperclip and the paste. If either stops calling chatAddFiles() they
     can be given different rules without anybody noticing, which is exactly
     what requirement "apply the same validation" is about. */
  const change = PAGE.match(/if\(e\.target\.id !== 'chatFile'\) return;([\s\S]*?)\n\}\);/);
  assert.ok(change, 'the file input handler is gone');
  assert.match(change[1], /chatAddFiles\(/, 'the paperclip must go through the shared check');

  const paste = PAGE.match(/document\.addEventListener\('paste', e=>\{([\s\S]*?)\n\}\);/);
  assert.match(paste[1], /chatAddFiles\(/, 'and so must the paste');

  assert.match(PAGE, /function chatAddFiles\(files\)\{[\s\S]*?chatFileRefusal\(file\)/,
    'and that check must be the one that reads the rules');
});

test('the attach button is still there, unchanged', () => {
  /* This was to be purely additive. The button, its hidden input and its
     accept list are what "unchanged" means in markup. */
  assert.match(PAGE, /id="chatClip"[^>]*title="Attach a file"/);
  assert.match(PAGE, /<input type="file" id="chatFile" multiple accept="\$\{escapeHTML\(chatFileAccept\(\)\)\}"/);
  assert.match(PAGE, /function chatFileAccept\(\)/);
});

test('one composer serves both kinds of conversation', () => {
  /* Direct and group chat are the same renderChatThread() and the same
     #chatInput, which is why this needed writing once. If the two are ever
     split, the paste handler has to be looked at again — hence the test. */
  const ids = PAGE.match(/id="chatInput"/g) || [];
  assert.strictEqual(ids.length, 1, 'there should be exactly one message box in the page');
  assert.match(PAGE, /function renderChatThread\(head, body, foot\)\{[\s\S]*?const isGroup = conv\.kind === 'group'/,
    'and one renderer that handles both');
});

test('the composer keeps a half-written message across a redraw', () => {
  /* Attaching a file rebuilds the footer, and a rebuilt textarea is an empty
     one — so this used to wipe whatever had been typed. It matters here
     because pasting a picture INTO a sentence redraws for the same reason. */
  const render = PAGE.match(/function renderChatThread\(head, body, foot\)\{([\s\S]*?)\n\}\n/);
  assert.ok(render);
  assert.match(render[1], /const draft = \(document\.getElementById\('chatInput'\) \|\| \{\}\)\.value/,
    'the draft has to be read before foot.innerHTML replaces the box');
  assert.match(render[1], /box\.value = draft/, 'and put back afterwards');
});

test('every preview URL the composer makes is released again', () => {
  /* A session spent pasting screenshots would otherwise hold a copy of each
     one until the tab closed. */
  /* Scoped to each function's OWN body. An unanchored [\s\S]*? runs on past
     the closing brace and finds the call in the next function along, which is
     a test that passes whatever the function it names actually does — this one
     did, until a mutation proved it. */
  const body = (name) => {
    const m = PAGE.match(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `public/index.html has no ${name}`);
    return m[1];
  };
  assert.match(body('chatReleasePreview'), /URL\.revokeObjectURL\(url\)/,
    'the preview URL has to be revoked, not just forgotten');
  for (const caller of ['chatDropFile', 'chatClearFiles']) {
    assert.match(body(caller), /chatReleasePreview/, `${caller} must let go of the preview`);
  }
  assert.match(body('stopChat'), /chatClearFiles\(\)/,
    'and signing out must clear what is left in the composer');
});

test('a picture in the composer is shown as a picture', () => {
  const { chatKindOfName } = composer();
  assert.strictEqual(chatKindOfName('a.png'), 'image');
  assert.strictEqual(chatKindOfName('a.webp'), 'image');
  assert.strictEqual(chatKindOfName('a.mp4'), 'video');
  assert.strictEqual(chatKindOfName('a.mov'), 'video');
  assert.strictEqual(chatKindOfName('a.zip'), 'file');
  /* And it agrees with the server, which decides the same thing for the
     thread. A thumbnail in the composer and a plain row in the message would
     be one file looking like two things. */
  for (const name of ['a.png', 'a.webp', 'a.mp4', 'a.mov', 'a.zip']) {
    assert.strictEqual(chatKindOfName(name), chatFiles.kindOf(name), name);
  }
});

test('an SVG gets no inline preview, for the reason the server will not serve it as a page', () => {
  /* src/chat-files.js calls .svg scriptable and serves it as a download. An
     object URL pointed at an <img> would not run it — scripts never run in an
     img — but the composer follows the same line as the thread rather than
     keeping a second opinion about which formats are safe to render. */
  const preview = PAGE.match(/function chatPreviewURL\(file\)\{([\s\S]*?)\n\}/);
  assert.ok(preview);
  assert.match(preview[1], /=== '\.svg'/, 'the composer must skip the SVG thumbnail');
  assert.ok(chatFiles.isScriptable('a.svg'), 'and the server must still think it scriptable');
});
