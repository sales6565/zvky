/* THE COMPOSER, THE POP-UP, REPLIES AND THE EMOJI PICKER, IN A REAL BROWSER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE SERVER SUITE CANNOT. tests/chat-replies covers what
 * the server decides; this covers the half that only exists on screen — that
 * the box really grows and really stops, that the draft survives a trip through
 * the pop-up, that a skin tone is remembered, that the caret ends up after an
 * inserted emoji, and that every one of those still works with localStorage
 * throwing.
 *
 * THE REAL FUNCTIONS, LIFTED, and the real CSS — the growth cap is a stylesheet
 * rule in `em`, so a fixture with its own styles would be testing its own
 * styles.
 *
 * NO NATIVE DIALOGS. The desktop web view has none, so alert, confirm and
 * prompt throw here and any case that reaches one fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const EMOJI = fs.readFileSync(path.join(__dirname, '..', 'public', 'emoji-data.json'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const SKIP = !chromium ? 'playwright-core is not installed — run `npm install`.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);

/* THE SMALLEST WINDOW THE DESKTOP APP ALLOWS, which is what the layout case
   measures against. Taken from the Electron shell rather than guessed. */
const MIN_WINDOW = (() => {
  try {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    const w = main.match(/minWidth:\s*(\d+)/);
    const h = main.match(/minHeight:\s*(\d+)/);
    if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  } catch { /* no desktop shell in this checkout */ }
  return { width: 1024, height: 700 };
})();

function fixture() {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');

  const cut = (fromText, toText, what) => {
    const from = PAGE.indexOf(fromText);
    const to = PAGE.indexOf(toText, from + 1);
    assert.ok(from !== -1 && to > from, `found ${what} in the page`);
    return PAGE.slice(from, to);
  };

  const quoteBlock = cut('/* THE QUOTE ABOVE A REPLY, from what the SERVER says',
    '/* ---------- drafts, the bigger box, replies and emoji ----------', 'the quote renderer');
  const draftBlock = cut('/* ---------- drafts, the bigger box, replies and emoji ----------',
    '/* ---------- the emoji picker ----------', 'drafts and the pop-up');
  const emojiBlock = cut('/* ---------- the emoji picker ----------',
    '/* HOW LONG THIS FILE HAS LEFT', 'the emoji picker');

  /* NO STUB MAY SHADOW SOMETHING THE LIFTED CODE DECLARES — a `const` beside a
     `function` of the same name in one scope is a SyntaxError that kills the
     whole <script>, so window.__ready is never set and every case dies on a
     thirty-second timeout saying only "Timeout". Checked by name, before a
     browser is launched. */
  const declaredIn = (block) => new Set(
    [...block.matchAll(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1]));
  const FIXTURE_DECLARES = ['escapeHTML', 'showToast', 'chatState', 'renderChat', 'loadChatOlder',
    'sendChatMessage', 'chatMentionHighlight', 'chatBodyHTML', 'chatAttachmentsHTML',
    'chatWhen', 'chatTickHTML', 'chatSize'];
  for (const [label, block] of [['the quote renderer', quoteBlock], ['drafts', draftBlock],
    ['the emoji picker', emojiBlock]]) {
    const clash = FIXTURE_DECLARES.filter((n) => declaredIn(block).has(n));
    assert.deepStrictEqual(clash, [],
      `${label} already declares ${clash.join(', ')} — a stub beside it is a redeclaration, `
      + 'which kills the whole script.');
  }

  return `<!doctype html><html><head><meta charset="UTF-8"><style>${css}</style>
<style>body{margin:0;} .chat-foot{position:relative;padding:8px;}
/* THE THREAD NEEDS A HEIGHT. The picker opens UPWARDS from the composer — over
   the conversation rather than shoving it up the screen — so a fixture whose
   composer sits at the top of the page puts the panel above the viewport,
   where it is real, styled and unclickable. That cost a run. */
#thread{min-height:340px;overflow-y:auto;}</style></head>
<body>
  <div id="toast"></div>
  <div class="modal-wrap" id="chatBigWrap"><div class="modal" style="width:620px;">
    <h2>Write a message</h2><div id="chatBigBody"></div></div></div>
  <div id="thread"></div>
  <div class="chat-foot" id="chatFoot"></div>
  <input type="file" id="chatFile" style="display:none;">
<script>
window.__native = [];
for (const name of ['alert', 'confirm', 'prompt']) {
  window[name] = (...a) => { window.__native.push([name, String(a[0] || '')]); throw new Error('native ' + name); };
}
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
window.__toasts = [];
function showToast(msg){ window.__toasts.push(String(msg)); }

/* THE STATE THE LIFTED CODE READS. Two conversations, so the per-conversation
   draft is a thing that can be told apart from a global one. */
const chatState = {
  conversationId: 'conv-a',
  messages: [],
  hasMore: false,
  files: [],
  picked: [],
  limits: { allowed:'.png', maxBytes: 30000000, hours: 12, maxBody: 4000 },
  features: { replies: true, emojiPicker: true },
};
window.__sent = [];
async function sendChatMessage(opts){
  const from = (opts && opts.from) || 'inline';
  const box = document.getElementById(from === 'big' ? 'chatBigInput' : 'chatInput');
  window.__sent.push({ from, text: box ? box.value : null, reply: (chatReplyGet()||{}).id || null });
  chatDraftSet('');
  chatReplySet(null);
  if (chatBigOpen) chatCloseBig();
  if (box) box.value = '';
}
function chatMentionHighlight(){}
function renderChat(){ window.__paint(); }
window.__olderCalls = 0;
async function loadChatOlder(){
  window.__olderCalls += 1;
  /* The older page the real loader would prepend, so "load until it is found"
     is a thing this fixture can actually do. */
  if (window.__older && window.__older.length) {
    chatState.messages = [window.__older.shift(), ...chatState.messages];
    chatState.hasMore = window.__older.length > 0;
    window.__paint();
  } else { chatState.hasMore = false; }
}
const chatBodyHTML = (b) => escapeHTML(b).replace(/\\n/g, '<br>');
const chatAttachmentsHTML = () => '';
const chatWhen = () => '10:00';
const chatTickHTML = () => '';
const chatSize = (n) => n + 'B';

${quoteBlock}
${draftBlock}
${emojiBlock}

/* The thread and the footer, drawn the way renderChatThread draws them — the
   same markup, so the Reply action, the quote and the composer are the real
   ones. */
window.__paint = () => {
  document.getElementById('thread').innerHTML = chatState.messages.map((m) =>
    \`<div class="chat-msg chat-row" data-msg="\${escapeHTML(m.id)}">
      <div class="chat-bubble">\${chatQuoteHTML(m)}\${m.body ? chatBodyHTML(m.body) : ''}</div>
      \${chatState.features.replies
        ? \`<button class="chat-reply-act" data-chat-reply="\${escapeHTML(m.id)}">Reply</button>\` : ''}
    </div>\`).join('');

  const foot = document.getElementById('chatFoot');
  const draft = (document.getElementById('chatInput') || {}).value || '';
  foot.innerHTML = \`\${chatReplyBarHTML('chatReplyBar')}
    <div class="chat-compose">
      <button class="chat-clip" id="chatClip">&#128206;</button>
      \${chatState.features.emojiPicker
        ? '<button class="chat-clip" id="chatEmoji" aria-expanded="false">\\u263a</button>' : ''}
      <div class="chat-inputwrap">
        <div class="chat-mirror" id="chatInputMirror" aria-hidden="true"></div>
        <textarea id="chatInput" rows="3" placeholder="Write a message…"></textarea>
        <button class="chat-expand" id="chatExpand">&#9974;</button>
      </div>
      <button class="btn btn-sm" id="chatSend">Send</button>
    </div>\`;
  const box = document.getElementById('chatInput');
  const text = draft || chatDraftGet();
  box.value = text;
  chatDraftSet(text);
  chatAutosize(box);
  box.addEventListener('input', () => { chatDraftSet(box.value); chatAutosize(box); });
};

/* The delegated handlers, copied from the page's own click listener — the
   functions are lifted, the wiring is not, so this is the part that has to
   match. tests/chat-replies pins that the page still wires it this way. */
document.addEventListener('click', async (e) => {
  if (e.target.closest('#chatExpand')) { chatOpenBig(); return; }
  const emojiBtn = e.target.closest('#chatEmoji');
  if (emojiBtn) { await chatEmojiToggle('chatInput', emojiBtn); return; }
  const replyTo = e.target.closest('[data-chat-reply]');
  if (replyTo) {
    const message = chatState.messages.find((m) => m.id === replyTo.dataset.chatReply);
    chatReplySet(chatReplyTargetOf(message));
    return;
  }
  if (e.target.closest('[data-chat-reply-cancel]')) { chatReplySet(null); return; }
  const goto = e.target.closest('[data-chat-goto]');
  if (goto) { await chatGoToMessage(goto.dataset.chatGoto); return; }
});
/* CAPTURE, like the page: the panel redraws on every tab change, so by the
   time a click has bubbled the element that was clicked is detached and
   contains() says no. */
document.addEventListener('click', (e) => {
  const panel = document.getElementById('chatEmojiPanel');
  if (panel && !panel.contains(e.target) && !e.target.closest('#chatEmoji, #chatBigEmoji')) {
    chatEmojiClose();
  }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('chatEmojiPanel')) {
    e.preventDefault(); chatEmojiClose(); return;
  }
  if (e.key === 'Escape' && chatBigOpen) { e.preventDefault(); chatCloseBig(); return; }
});

window.__paint();
window.__ready = true;
</script></body></html>`;
}

const open = async (browser, { storage = true, viewport = { width: 1280, height: 900 } } = {}) => {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  /* THE DATA FILE, served from this origin as the real page serves it —
     fulfilled rather than proxied so the suite needs no server, and asserted
     on so "it loaded from here" is a thing this file knows. */
  const asked = [];
  /* SERVED FROM A REAL ORIGIN, not setContent.
   
     setContent leaves the page on about:blank, where a relative fetch of
     /emoji-data.json has nothing to resolve against and fails before any route
     sees it — which cost a run, with every picker case timing out on a panel
     that never filled. So the fixture is served as a page at a routed URL and
     the data file beside it, exactly as the real server serves both. */
  await page.route('http://chat.test/emoji-data.json', (route) => {
    asked.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: EMOJI });
  });
  await page.route('http://chat.test/', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture() });
  });
  if (!storage) {
    /* STORAGE BLOCKED, the way a private window or a locked-down machine
       blocks it: the accessor throws rather than returning null. */
    await page.addInitScript(() => {
      const boom = () => { throw new Error('storage is blocked'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { return { getItem: boom, setItem: boom, removeItem: boom }; },
      });
    });
  }
  await page.goto('http://chat.test/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  return { page, errors, asked };
};

const seedMessages = (page, messages) => page.evaluate((list) => {
  chatState.messages = list;
  window.__paint();
}, messages);

test('the chat composer, in a browser', { skip: SKIP }, async (t) => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  t.after(() => browser.close());

  await t.test('the box starts around three lines and grows to its cap, then scrolls', async () => {
    const { page, errors } = await open(browser);
    const oneLine = await page.evaluate(() => {
      const box = document.getElementById('chatInput');
      const style = getComputedStyle(box);
      /* line-height can compute to the keyword `normal`, which parseFloat
         reads as NaN. Measured instead: one line of this font in this box. */
      const ruler = document.createElement('div');
      ruler.style.cssText = `position:absolute;visibility:hidden;white-space:pre;`
        + `font:${style.font};line-height:${style.lineHeight};`;
      ruler.textContent = 'x';
      document.body.appendChild(ruler);
      const line = ruler.getBoundingClientRect().height;
      ruler.remove();
      return { height: box.getBoundingClientRect().height, line };
    });
    assert.ok(oneLine.height >= oneLine.line * 2.5,
      `it opens at about three lines, not one — ${oneLine.height}px against a ${oneLine.line}px line`);

    /* TWENTY LINES IN. The box must stop growing and start scrolling, or a long
       message pushes the conversation off the screen. */
    const at = async (lines) => {
      await page.fill('#chatInput', Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'));
      return page.evaluate(() => {
        const box = document.getElementById('chatInput');
        return { height: box.getBoundingClientRect().height,
          scrollable: box.scrollHeight > box.clientHeight + 1 };
      });
    };
    const six = await at(6);
    const twenty = await at(20);
    const forty = await at(40);

    assert.ok(six.height > oneLine.height, 'it grows with what is in it');
    /* AND STOPS. Asserted as "twenty lines and forty lines are the same height"
       rather than against the computed max-height, which is a content-box
       figure while the rect is a border-box one — comparing them is comparing
       two different measurements and the difference is the padding. What the
       cap is FOR is that the box stops taking space from the conversation, and
       this is that, measured. */
    assert.ok(Math.abs(forty.height - twenty.height) < 1,
      `it stops growing — twenty lines ${twenty.height}px, forty ${forty.height}px`);
    assert.ok(twenty.height < 300, `and the cap is a sensible one — ${twenty.height}px`);
    assert.ok(twenty.scrollable, 'and it scrolls inside itself past that');
    const grown = twenty;
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('the pop-up opens on the same draft and gives it back', async () => {
    const { page } = await open(browser);
    await page.fill('#chatInput', 'half a sentence');
    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigInput');
    assert.strictEqual(await page.inputValue('#chatBigInput'), 'half a sentence',
      'the pop-up opens on what was being written');

    await page.fill('#chatBigInput', 'half a sentence, and the rest of it');
    await page.click('#chatBigClose');
    await page.waitForFunction(() => !window.chatBigOpen);
    assert.strictEqual(await page.inputValue('#chatInput'), 'half a sentence, and the rest of it',
      'and closing hands it back, including what was added');
    await page.close();
  });

  await t.test('Esc closes the pop-up and keeps the draft', async () => {
    const { page } = await open(browser);
    await page.fill('#chatInput', 'do not lose me');
    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigInput');
    await page.fill('#chatBigInput', 'do not lose me either');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.chatBigOpen);
    assert.strictEqual(await page.inputValue('#chatInput'), 'do not lose me either');
    assert.deepStrictEqual(await page.evaluate(() => window.__native), [],
      'and no native dialog was involved');
    await page.close();
  });

  await t.test('Enter makes a line in the pop-up; Ctrl+Enter sends', async () => {
    const { page } = await open(browser);
    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigInput');
    await page.click('#chatBigInput');
    await page.keyboard.type('first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    assert.strictEqual(await page.inputValue('#chatBigInput'), 'first\nsecond',
      'Enter is a new line here, which is the opposite of the inline box');
    assert.deepStrictEqual(await page.evaluate(() => window.__sent), [], 'and sends nothing');

    await page.keyboard.press('Control+Enter');
    const sent = await page.evaluate(() => window.__sent);
    assert.strictEqual(sent.length, 1, 'Ctrl+Enter sends');
    assert.strictEqual(sent[0].text, 'first\nsecond');
    assert.strictEqual(sent[0].from, 'big');
    /* AND THE HINT SAYS SO, because a key that is the opposite of the one next
       door has to be discoverable. */
    await page.close();
  });

  await t.test('the hint names the sending chord', async () => {
    const { page } = await open(browser);
    await page.click('#chatExpand');
    await page.waitForSelector('.chat-big-hint');
    const hint = await page.textContent('.chat-big-hint');
    assert.match(hint, /new line/i);
    assert.match(hint, /Ctrl/);
    assert.match(hint, /Enter/);
    await page.close();
  });

  await t.test('drafts are per conversation and survive switching', async () => {
    const { page } = await open(browser);
    await page.fill('#chatInput', 'for conversation A');
    await page.evaluate(() => {
      chatState.conversationId = 'conv-b';
      document.getElementById('chatInput').value = '';
      window.__paint();
    });
    assert.strictEqual(await page.inputValue('#chatInput'), '',
      'the other conversation starts empty');
    await page.fill('#chatInput', 'for conversation B');

    await page.evaluate(() => {
      chatState.conversationId = 'conv-a';
      document.getElementById('chatInput').value = '';
      window.__paint();
    });
    assert.strictEqual(await page.inputValue('#chatInput'), 'for conversation A',
      'and coming back finds the first one still there');

    /* SENDING CLEARS ONLY THIS ONE. */
    await page.evaluate(() => sendChatMessage());
    await page.evaluate(() => { document.getElementById('chatInput').value = ''; window.__paint(); });
    assert.strictEqual(await page.inputValue('#chatInput'), '', 'the sent conversation is empty');
    await page.evaluate(() => {
      chatState.conversationId = 'conv-b';
      document.getElementById('chatInput').value = '';
      window.__paint();
    });
    assert.strictEqual(await page.inputValue('#chatInput'), 'for conversation B',
      'and the other one is untouched');
    await page.close();
  });

  await t.test('the counter appears near the limit and never truncates', async () => {
    const { page } = await open(browser);
    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigInput');

    await page.evaluate(() => {
      document.getElementById('chatBigInput').value = 'a'.repeat(3000);
      document.getElementById('chatBigInput').dispatchEvent(new Event('input'));
    });
    assert.strictEqual(await page.textContent('#chatBigCount'), '',
      'nothing at three quarters — a counter on screen from the start is one to ignore');

    await page.evaluate(() => {
      document.getElementById('chatBigInput').value = 'a'.repeat(3700);
      document.getElementById('chatBigInput').dispatchEvent(new Event('input'));
    });
    assert.match(await page.textContent('#chatBigCount'), /3700 \/ 4000/,
      'and it appears within 10% of the limit');

    /* COUNTED BY CODE POINTS. 2100 emoji is 4200 UTF-16 units and 2100
       characters — a counter using .length would be shouting at somebody who
       is barely half way. */
    const shown = await page.evaluate(() => {
      const box = document.getElementById('chatBigInput');
      box.value = '\u{1F600}'.repeat(2100);
      box.dispatchEvent(new Event('input'));
      return { count: document.getElementById('chatBigCount').textContent,
        units: box.value.length, kept: [...box.value].length };
    });
    assert.strictEqual(shown.units, 4200, 'it is over the limit counted the wrong way');
    assert.strictEqual(shown.kept, 2100, 'and under it counted the right way');
    assert.strictEqual(shown.count, '', 'so nothing is said');
    await page.close();
  });

  await t.test('Reply shows the bar, X cancels it, and the sent message carries it', async () => {
    const { page } = await open(browser);
    await seedMessages(page, [{ id: 'm1', body: 'is the blue right?', senderName: 'Ana' }]);

    await page.hover('[data-msg="m1"]');
    await page.click('[data-chat-reply="m1"]');
    await page.waitForSelector('.chat-replybar');
    assert.match(await page.textContent('.chat-replybar .who'), /Replying to Ana/);
    assert.match(await page.textContent('.chat-replybar .snip'), /is the blue right\?/);

    await page.fill('#chatInput', 'yes');
    await page.evaluate(() => sendChatMessage());
    const sent = await page.evaluate(() => window.__sent);
    assert.strictEqual(sent[0].reply, 'm1', 'the reply target goes with the message');

    /* AND THE BAR IS GONE AFTERWARDS, because the next message is not a reply. */
    await page.evaluate(() => window.__paint());
    assert.strictEqual(await page.locator('.chat-replybar').count(), 0);

    // X cancels without sending.
    await page.click('[data-chat-reply="m1"]');
    await page.waitForSelector('.chat-replybar');
    await page.click('[data-chat-reply-cancel]');
    await page.waitForFunction(() => document.querySelectorAll('.chat-replybar').length === 0);
    await page.close();
  });

  await t.test('the reply bar is in the pop-up too', async () => {
    const { page } = await open(browser);
    await seedMessages(page, [{ id: 'm1', body: 'the original', senderName: 'Ana' }]);
    await page.click('[data-chat-reply="m1"]');
    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigReplyBar.chat-replybar');
    assert.match(await page.textContent('#chatBigReplyBar .snip'), /the original/);
    await page.close();
  });

  await t.test('clicking a quote scrolls to the original and flashes it', async () => {
    const { page } = await open(browser);
    await seedMessages(page, [
      { id: 'old', body: 'the original', senderName: 'Ana' },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `pad${i}`, body: `filler ${i}`, senderName: 'Bo' })),
      { id: 'reply', body: 'answering', senderName: 'Bo',
        quote: { id: 'old', available: true, senderName: 'Ana', snippet: 'the original' } },
    ]);
    await page.click('[data-chat-goto="old"]');
    await page.waitForSelector('[data-msg="old"].chat-found');
    assert.ok(await page.locator('[data-msg="old"].chat-found').count(),
      'the original is marked where it is');
    await page.close();
  });

  await t.test('an original further back than what is loaded is fetched until it is found', async () => {
    const { page } = await open(browser);
    await page.evaluate(() => {
      window.__older = [{ id: 'ancient', body: 'from last week', senderName: 'Ana' }];
      chatState.hasMore = true;
      chatState.messages = [{ id: 'reply', body: 'answering', senderName: 'Bo',
        quote: { id: 'ancient', available: true, senderName: 'Ana', snippet: 'from last week' } }];
      window.__paint();
    });
    await page.click('[data-chat-goto="ancient"]');
    await page.waitForSelector('[data-msg="ancient"]');
    assert.ok(await page.evaluate(() => window.__olderCalls) >= 1, 'it loaded an older page');
    await page.close();
  });

  await t.test('an original that cannot be found says so, in-page', async () => {
    const { page } = await open(browser);
    await page.evaluate(() => {
      chatState.hasMore = false;
      chatState.messages = [{ id: 'reply', body: 'answering', senderName: 'Bo',
        quote: { id: 'vanished', available: true, senderName: 'Ana', snippet: 'gone' } }];
      window.__paint();
    });
    await page.click('[data-chat-goto="vanished"]');
    await page.waitForFunction(() => window.__toasts.length > 0);
    assert.match((await page.evaluate(() => window.__toasts))[0], /not available/i);
    assert.deepStrictEqual(await page.evaluate(() => window.__native), []);
    await page.close();
  });

  await t.test('a deleted original renders as deleted and nothing else', async () => {
    const { page } = await open(browser);
    await seedMessages(page, [{ id: 'reply', body: 'answering', senderName: 'Bo',
      quote: { id: 'gone', available: false, senderName: null, snippet: null } }]);
    const quote = await page.textContent('.chat-quote.gone');
    assert.match(quote, /This message was deleted/);
    /* AND IT IS NOT A LINK TO ANYWHERE, because there is nowhere to go. */
    assert.strictEqual(await page.locator('[data-chat-goto="gone"]').count(), 0);
    await page.close();
  });

  await t.test('the emoji picker opens, searches, changes tab, and inserts at the caret', async () => {
    const { page, asked } = await open(browser);
    /* NOTHING IS FETCHED UNTIL IT IS OPENED, which is what makes the 52 KB
       free at page load. */
    assert.deepStrictEqual(asked, [], 'the data is not loaded on page load');

    await page.click('#chatEmoji');
    await page.waitForSelector('#chatEmojiPanel .chat-emoji-one');
    assert.strictEqual(asked.length, 1, 'and is loaded once, when the picker opens');
    assert.match(asked[0], /\/emoji-data\.json$/, 'from this origin');

    const tabs = await page.$$eval('[data-emoji-tab]', (els) => els.map((e) => e.textContent.trim()));
    for (const label of ['Smileys & People', 'Animals & Nature', 'Food & Drink', 'Activities',
      'Travel & Places', 'Objects', 'Symbols', 'Flags']) {
      assert.ok(tabs.includes(label), `the ${label} tab is there — got ${tabs.join(', ')}`);
    }

    // A category tab.
    await page.click('[data-emoji-tab="food"]');
    await page.waitForFunction(() =>
      document.querySelector('[data-emoji-tab="food"]').classList.contains('on'));

    // Search, by name.
    await page.fill('#chatEmojiSearch', 'pizza');
    await page.waitForFunction(() =>
      document.querySelectorAll('#chatEmojiPanel .chat-emoji-one').length > 0
      && document.querySelectorAll('#chatEmojiPanel .chat-emoji-one').length < 20);
    const found = await page.$$eval('#chatEmojiPanel .chat-emoji-one',
      (els) => els.map((e) => e.getAttribute('title')));
    assert.ok(found.some((n) => n.includes('pizza')), `search finds it: ${found.join(', ')}`);

    /* INSERTED AT THE CARET, not appended. The caret is put in the middle of
       the text on purpose — appending would pass a test that only checked the
       emoji was somewhere in the box. */
    await page.fill('#chatInput', 'hello world');
    await page.evaluate(() => {
      const box = document.getElementById('chatInput');
      box.focus();
      box.setSelectionRange(5, 5);
    });
    await page.click('#chatEmojiPanel .chat-emoji-one');
    const after = await page.evaluate(() => {
      const box = document.getElementById('chatInput');
      return { value: box.value, caret: box.selectionStart };
    });
    assert.match(after.value, /^hello.+ world$/, `inserted where the caret was: ${after.value}`);
    assert.ok(after.caret > 5, 'and the caret is after it, so the next pick follows on');

    /* THE PICKER STAYS OPEN, because people pick more than one. */
    assert.ok(await page.locator('#chatEmojiPanel').count(), 'it is still open');
    await page.close();
  });

  await t.test('a skin tone is applied and remembered; a recent is recorded', async () => {
    const { page } = await open(browser);
    await page.click('#chatEmoji');
    await page.waitForSelector('#chatEmojiPanel .chat-emoji-one');

    await page.selectOption('#chatEmojiTone', 'dark');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#chatEmojiPanel .chat-emoji-one[data-tone="1"]')]
        .some((b) => b.textContent.includes('\u{1F3FF}')));
    const toned = await page.$eval('#chatEmojiPanel .chat-emoji-one[data-tone="1"]',
      (b) => b.textContent.trim());
    assert.ok(toned.includes('\u{1F3FF}'), `the dark modifier is applied: ${[...toned].length} code points`);

    await page.click('#chatEmojiPanel .chat-emoji-one[data-tone="1"]');
    const stored = await page.evaluate(() => ({
      tone: JSON.parse(localStorage.getItem('zvky.emoji.tone')),
      recent: JSON.parse(localStorage.getItem('zvky.emoji.recent')),
    }));
    assert.strictEqual(stored.tone, 'dark', 'the tone is remembered');
    assert.ok(Array.isArray(stored.recent) && stored.recent.length === 1, 'and the pick is a recent');
    assert.ok(stored.recent[0].includes('\u{1F3FF}'), 'stored as it was used, tone and all');

    /* AND THE RECENTS ROW IS THERE NEXT TIME. */
    await page.evaluate(() => chatEmojiClose());
    await page.click('#chatEmoji');
    await page.waitForSelector('[data-emoji-tab="recent"]');
    await page.close();
  });

  await t.test('the picker works with localStorage blocked', async () => {
    const { page, errors } = await open(browser, { storage: false });
    await page.click('#chatEmoji');
    await page.waitForSelector('#chatEmojiPanel .chat-emoji-one');

    await page.selectOption('#chatEmojiTone', 'dark');
    await page.fill('#chatInput', '');
    await page.click('#chatEmojiPanel .chat-emoji-one');
    assert.ok((await page.inputValue('#chatInput')).length > 0,
      'an emoji still goes in — all that is lost is the memory of it');
    assert.deepStrictEqual(errors, [], 'and nothing throws');
    await page.close();
  });

  await t.test('Esc and an outside click close the picker', async () => {
    const { page } = await open(browser);
    await page.click('#chatEmoji');
    await page.waitForSelector('#chatEmojiPanel');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('chatEmojiPanel'));

    await page.click('#chatEmoji');
    await page.waitForSelector('#chatEmojiPanel');
    /* A POINT THE PANEL DOES NOT COVER. #thread is behind it — the picker opens
       over the conversation on purpose — so clicking the thread by selector
       hits the panel and Playwright waits for ever. */
    await page.mouse.click(4, 4);
    await page.waitForFunction(() => !document.getElementById('chatEmojiPanel'));
    await page.close();
  });

  await t.test('the picker is in the pop-up as well', async () => {
    const { page } = await open(browser);
    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigEmoji');
    await page.click('#chatBigEmoji');
    await page.waitForSelector('#chatEmojiPanel .chat-emoji-one');
    await page.fill('#chatBigInput', 'in the big box ');
    await page.evaluate(() => {
      const box = document.getElementById('chatBigInput');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    await page.click('#chatEmojiPanel .chat-emoji-one');
    assert.match(await page.inputValue('#chatBigInput'), /^in the big box .+/);
    await page.close();
  });

  await t.test('the layout holds at the smallest window the desktop app allows', async () => {
    const { page, errors } = await open(browser, { viewport: MIN_WINDOW });
    await page.fill('#chatInput', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
    const box = await page.evaluate(() => {
      const el = document.getElementById('chatInput');
      const r = el.getBoundingClientRect();
      return { height: r.height, bottom: r.bottom, right: r.right,
        docWidth: document.documentElement.clientWidth,
        max: parseFloat(getComputedStyle(el).maxHeight) };
    });
    assert.ok(box.height < MIN_WINDOW.height / 2,
      `the box takes less than half the window even full — ${box.height}px of ${MIN_WINDOW.height}px`);
    assert.ok(box.right <= box.docWidth + 1, 'and nothing runs off the side');

    await page.click('#chatExpand');
    await page.waitForSelector('#chatBigInput');
    const modal = await page.evaluate(() => {
      const r = document.querySelector('#chatBigWrap .modal').getBoundingClientRect();
      return { width: r.width, docWidth: document.documentElement.clientWidth,
        sendVisible: Boolean(document.getElementById('chatBigSend').offsetParent) };
    });
    assert.ok(modal.width <= modal.docWidth,
      `the pop-up fits — ${modal.width} in ${modal.docWidth}`);
    assert.ok(modal.sendVisible, 'and Send is on screen');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('the emoji set is this server\'s own file, and not fetched until it is wanted',
    async () => {
    /* TWO PROMISES IN ONE CASE, because they are the same promise from two
       sides: the set is served from here, and it costs the page nothing until
       somebody opens the picker.

       WHY IT MATTERS THAT IT IS LAZY. The file is the biggest single asset on a
       page the whole studio loads every morning, and most of those loads never
       open the picker. Fetching it at startup would spend that on everybody to
       save a few hundred milliseconds for the few.

       WHY IT MATTERS THAT IT IS LOCAL. A CDN would make the chat panel depend
       on a third party being up and would tell that third party who is using
       Forge and when. Neither is a thing to buy with a page of emoji. */
    const { page, asked, errors } = await open(browser);
    assert.deepStrictEqual(asked, [],
      'nothing asked for the emoji set just by loading the page');

    /* AND NOTHING ELSE WAS ASKED FOR EITHER — anything off this origin would
       have had to come from somewhere, and the fixture serves exactly two
       things. Read from the page rather than from the fixture, so a fetch
       written into the page is what is being checked. */
    const offOrigin = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => !u.startsWith('http://chat.test/')));
    assert.deepStrictEqual(offOrigin, [], 'and the page reached no other host to load');

    await page.click('#chatEmoji');
    await page.waitForSelector('.chat-emoji-panel .chat-emoji-grid button');
    assert.deepStrictEqual(asked, ['http://chat.test/emoji-data.json'],
      'opening the picker fetches it, from this origin, once');

    /* A SECOND OPEN DOES NOT FETCH AGAIN. */
    await page.keyboard.press('Escape');
    await page.click('#chatEmoji');
    await page.waitForSelector('.chat-emoji-panel .chat-emoji-grid button');
    assert.strictEqual(asked.length, 1, 'and only once however often it is opened');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('with the switches off, neither control is drawn', async () => {
    const { page } = await open(browser);
    await page.evaluate(() => {
      chatState.features = { replies: false, emojiPicker: false };
      chatState.messages = [{ id: 'm1', body: 'a message', senderName: 'Ana' }];
      window.__paint();
    });
    assert.strictEqual(await page.locator('[data-chat-reply]').count(), 0, 'no Reply action');
    assert.strictEqual(await page.locator('#chatEmoji').count(), 0, 'no emoji button');
    /* AND THE QUOTES ALREADY SENT STILL RENDER, which is the promise the
       switch makes. */
    await page.evaluate(() => {
      chatState.messages = [{ id: 'r', body: 'answering', senderName: 'Bo',
        quote: { id: 'x', available: true, senderName: 'Ana', snippet: 'the original' } }];
      window.__paint();
    });
    assert.match(await page.textContent('.chat-quote .snip'), /the original/);
    await page.close();
  });
});
