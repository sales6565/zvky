/* Saving what somebody sent you.
 *
 * Every attachment in a thread now carries its own download control. A file
 * row always had one — the filename was the link — and a picture had none at
 * all: the only way to keep a screenshot somebody sent was the browser's own
 * right-click menu, which on a blob-backed <img> saves it under a name like
 * "f4c2a1e8-...". Now there is a button, and it saves the file under the name
 * it was sent with.
 *
 * THREE THINGS THIS FILE EXISTS TO STOP:
 *
 *   The button and the picture becoming one control. They are siblings inside
 *      a wrapper, never nested, so a click on one can never read as a click on
 *      the other. Nothing hangs off the image today; the day an expand-to-full
 *      -screen does, this is what keeps the two apart.
 *
 *   A download that is not the original. There is one stored file per
 *      attachment and one route that serves it — the same URL the thread
 *      displays from. No thumbnail is made anywhere, so "full quality" is a
 *      property of the design rather than a thing to remember; this holds the
 *      two readers to the same endpoint.
 *
 *   An expired attachment growing a button. The bytes are deleted after twelve
 *      hours and the server stops offering a url; a button there would be one
 *      that only ever reports a failure.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const chatFiles = require('../src/chat-files');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function lift(name) {
  const m = PAGE.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)\\n}\\n`));
  assert.ok(m, `public/index.html has no ${name}`);
  return `function ${name}(${m[1]}\n}`;
}

/* chatAttachmentsHTML and its helper, with the two globals they lean on
   stubbed: escapeHTML, and the limits the server sent. */
function renderer() {
  const build = new Function('chatState', `
    const escapeHTML = (s) => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    ${lift('chatAttachmentsHTML')}
    ${lift('chatDownloadButton')}
    ${lift('chatSize')}
    return { chatAttachmentsHTML, chatDownloadButton };
  `);
  return build({ limits: { hours: chatFiles.HOURS } });
}

const attachment = (over = {}) => ({
  id: 'att-1',
  fileName: 'brief-v2.png',
  byteSize: 2048,
  mime: 'image/png',
  expired: false,
  kind: 'image',
  url: '/api/chat/attachments/att-1',
  downloadOnly: false,
  ...over,
});
const render = (list) => renderer().chatAttachmentsHTML({ attachments: list });

// --- every kind of attachment gets one ---------------------------------------

test('a picture carries a download button', () => {
  const html = render([attachment()]);
  assert.match(html, /class="chat-dl"/);
  assert.match(html, /data-download="att-1"/);
  assert.match(html, /data-name="brief-v2\.png"/, 'carrying the name it should be saved under');
});

test('a video carries one too', () => {
  const html = render([attachment({ kind: 'video', fileName: 'take-03.mp4', mime: 'video/mp4' })]);
  assert.match(html, /<video/);
  assert.match(html, /class="chat-dl"/);
});

test('a plain file row carries one, beside the name it already linked', () => {
  const html = render([attachment({ kind: 'file', fileName: 'notes.mp4', downloadOnly: false })]);
  assert.match(html, /class="chat-file"/);
  assert.match(html, /class="chat-dl"/);
  /* The filename stays a link. It worked before this change and people will
     have learned it; the button is an addition, not a replacement. */
  assert.match(html, /<a data-download="att-1" data-name="notes\.mp4">/);
});

test('and so does one the server will only ever hand over as a download', () => {
  /* An .svg can carry a script, so src/chat-files.js marks it downloadOnly and
     the thread shows it as a row rather than rendering it. It is still a file
     somebody may want to keep. */
  const a = attachment({ fileName: 'diagram.svg', kind: 'image', downloadOnly: true });
  const html = render([a]);
  assert.match(html, /class="chat-file"/, 'shown as a row, not rendered');
  assert.match(html, /class="chat-dl"/, 'and still savable');
  assert.ok(chatFiles.isScriptable('diagram.svg'), 'and the server still thinks it scriptable');
});

test('an expired attachment does not', () => {
  /* Nothing to fetch: the sweep has deleted the bytes and shape() withholds
     the url. A button here would be a button that can only fail. */
  const html = render([attachment({ expired: true, url: null })]);
  assert.match(html, /no longer available/);
  assert.ok(!/chat-dl/.test(html), 'an expired attachment must not offer a download');
});

test('an attachment with no url does not either', () => {
  /* Belt to the braces above: shape() withholds the url the moment isExpired()
     is true, so this is the same condition read from the other end. */
  const html = render([attachment({ url: null })]);
  assert.ok(!/chat-dl/.test(html));
});

test('several attachments each get their own', () => {
  const html = render([
    attachment({ id: 'a', fileName: 'one.png' }),
    attachment({ id: 'b', fileName: 'two.png' }),
    attachment({ id: 'c', fileName: 'three.mp4', kind: 'video' }),
  ]);
  assert.strictEqual((html.match(/class="chat-dl"/g) || []).length, 3);
  for (const id of ['a', 'b', 'c']) assert.match(html, new RegExp(`data-download="${id}"`));
});

// --- the two controls cannot be mistaken for each other -----------------------

test('THE ISOLATION: the button is never inside the thing it downloads', () => {
  /* The guarantee is structural, not a matter of stopPropagation: an <img>
     cannot contain a button, and the wrapper carries no data-attach, so
     closest('[data-attach]') from the button finds nothing. Anything hung off
     the media later cannot see a click on the button. */
  const html = render([attachment()]);
  const media = html.match(/<img data-attach="att-1"[^>]*>/);
  assert.ok(media, 'the picture should still be an <img data-attach>');
  assert.ok(!/data-download/.test(media[0]), 'the media element must not itself be a download target');

  const button = html.match(/<button[^>]*class="chat-dl"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(button, 'the control should be a real button, so the keyboard reaches it');
  assert.ok(!/data-attach/.test(button[0]), 'and must not be a display target');

  assert.ok(html.indexOf(media[0]) < html.indexOf(button[0]),
    'siblings in the wrapper, picture first');
  assert.match(html, /<div class="chat-media">[\s\S]*?<img [^>]*>\s*<button/,
    'and the wrapper holds both rather than one holding the other');
});

test('the click handler answers a download before anything else could', () => {
  /* There is no expand-to-full-screen on a chat picture today — worth stating,
     because the brief asked to preserve one. If one is added, it will be
     another branch in this same delegated handler, and the download branch
     has to keep winning for a click on the button. */
  const handler = PAGE.match(/const dl = e\.target\.closest\('\[data-download\]'\);\n([^\n]*)/);
  assert.ok(handler, 'the download branch is gone');
  assert.match(handler[1], /downloadChatAttachment/);

  const before = PAGE.indexOf("const dl = e.target.closest('[data-download]')");
  const attach = PAGE.indexOf("e.target.closest('[data-attach]')");
  assert.ok(attach === -1 || attach > before,
    'a handler on the media must not be able to swallow a click meant for the button');
});

// --- what it downloads --------------------------------------------------------

test('the download reads the same route the thread displays from', () => {
  /* Which is what makes "the original, not a compressed copy" true. If these
     two ever point somewhere different, one of them is showing or saving
     something that is not the stored file. */
  const display = PAGE.match(/async function loadChatAttachment\(el\)\{([\s\S]*?)\n\}/);
  const save = PAGE.match(/async function downloadChatAttachment\(id, name\)\{([\s\S]*?)\n\}/);
  assert.ok(display && save);
  const route = /\$\{API_BASE\}\/chat\/attachments\/\$\{encodeURIComponent\((?:id)\)\}/;
  assert.match(display[1], route);
  assert.match(save[1], route);
});

test('there is no second, smaller copy of a chat picture anywhere', () => {
  /* The requirement said "not a compressed thumbnail version, if thumbnails
     are used". They are not: one upload, one stored file, one route. Asserted
     rather than assumed, because a thumbnail added later would quietly make
     the download the wrong bytes. */
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-files.js'), 'utf8');
  /* One row per upload names ONE file on disk, and forDownload() serves that
     one. A resized copy would need a second stored name to live under, so the
     absence of one is the check worth making — the word "thumbnail" appears in
     a comment there about an unrelated pipeline and proves nothing either
     way. */
  assert.strictEqual((store.match(/stored_name/g) || []).length > 0, true);
  assert.ok(!/stored_name_\w+|thumb_name|preview_name/.test(store),
    'a second stored file has appeared — the download must still take the original');
  const deps = require('../package.json').dependencies || {};
  for (const lib of ['sharp', 'jimp', 'gm', 'imagemagick', 'canvas']) {
    assert.ok(!deps[lib], `${lib} is installed — check no chat attachment is being resized`);
  }
  assert.match(PAGE, /max-height:190px/,
    'the thread shrinks pictures with CSS, which is what keeps the file itself whole');
});

test('the saved file keeps the name it was sent with', () => {
  const html = render([attachment({ fileName: 'Concept — final (v3).png' })]);
  assert.match(html, /data-name="Concept — final \(v3\)\.png"/);
  const save = PAGE.match(/async function downloadChatAttachment\(id, name\)\{([\s\S]*?)\n\}/);
  assert.match(save[1], /a\.download = name \|\| 'file'/);
});

test('a name with markup in it cannot become markup', () => {
  /* The filename comes from whoever uploaded it. It reaches three attributes
     on this button. */
  const html = render([attachment({ fileName: '"><img src=x onerror=alert(1)>.png' })]);
  /* The payload's own words survive as TEXT, which is right — what must not
     survive is the punctuation that would let them out of the attribute. So
     the check is on the characters, not on the string: no bare quote can
     close data-name, and no bare angle bracket can start a tag. */
  assert.match(html, /data-name="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\.png"/,
    'every dangerous character has to arrive escaped');
  assert.strictEqual((html.match(/<img /g) || []).length, 1,
    'the filename must not have produced a second <img>');
  assert.strictEqual((html.match(/<button/g) || []).length, 1);
});

// --- one renderer, both kinds of conversation ---------------------------------

test('one renderer serves direct and group threads alike', () => {
  /* renderChatThread builds every message the same way whatever the
     conversation is; isGroup only decides whether a sender's name is shown.
     So this was written once. */
  assert.strictEqual((PAGE.match(/function chatAttachmentsHTML\(/g) || []).length, 1);
  assert.match(PAGE, /\$\{chatAttachmentsHTML\(m\)\}/);
  const thread = PAGE.match(/function renderChatThread\(head, body, foot\)\{([\s\S]*?)\n\}\n/);
  assert.match(thread[1], /const isGroup = conv\.kind === 'group'/);
  assert.match(thread[1], /chatAttachmentsHTML\(m\)/,
    'and the same call renders attachments for both');
});

test('nothing about the button depends on who is looking', () => {
  /* Sender and recipient see the same markup; the server's membership check in
     forDownload() is what decides who may actually fetch the bytes. A button
     drawn only for the sender would be a permission decision made in the
     browser, which is the wrong place for one. */
  const fn = PAGE.match(/function chatDownloadButton\(a\)\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.ok(!/currentUser|senderId|\bmine\b/.test(fn[1]),
    `the button must not branch on who is reading: ${fn[1]}`);

  const mine = render([attachment()]);
  assert.strictEqual(mine, render([attachment()]), 'the same attachment renders the same for anybody');
});

// --- and it is actually visible ----------------------------------------------

test('the button can be seen, on a mouse and without one', () => {
  /* Hover-reveal keeps a dense thread clean, but a hover-only control is
     invisible on a phone and unreachable from a keyboard. Both have their own
     rule. */
  assert.match(PAGE, /\.chat-media:hover \.chat-dl\{opacity:1;\}/);
  assert.match(PAGE, /@media \(hover: none\)\{ \.chat-dl\{opacity:1;\} \}/,
    'a touch screen has no hover, so the button must simply be there');
  assert.match(PAGE, /\.chat-dl:focus-visible\{opacity:1/,
    'and tabbing to it must show it');
  assert.match(PAGE, /\.chat-file \.chat-dl\{position:static;opacity:1/,
    'on a file row there is no picture to keep clear, so it is always shown');
});

test('it is labelled for a screen reader, by file', () => {
  const html = render([attachment({ fileName: 'storyboard.png' })]);
  assert.match(html, /aria-label="Download storyboard\.png"/);
  assert.match(html, /title="Download storyboard\.png"/);
  /* Three pictures in one bubble, each labelled "Download", would tell a
     screen reader nothing about which. */
  const many = render([attachment({ id: 'a', fileName: 'one.png' }), attachment({ id: 'b', fileName: 'two.png' })]);
  assert.match(many, /aria-label="Download one\.png"/);
  assert.match(many, /aria-label="Download two\.png"/);
});
