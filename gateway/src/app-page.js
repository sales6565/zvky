/* The office link window: the page that exists because of the browser spike.
 *
 * WHAT THE SPIKE FOUND. Current Chromium (141 measured; Chrome and Edge share
 * the engine) refuses a fetch from a page on a PUBLIC address — which Forge, on
 * GoDaddy, always is — to a gateway on a PRIVATE address, until the user
 * answers a Local Network Access permission prompt. It refuses it by hanging:
 * no error, no console line, nothing on the wire. An iframe served from the
 * gateway is gated the same way. A TOP-LEVEL navigation is not gated at all,
 * and neither is a page talking to its OWN origin.
 *
 * So this is a top-level window served by the gateway. Its fetches are
 * same-origin and private-to-private, which no browser gates, and it relays
 * between the Forge tab and the gateway over postMessage — which is not a
 * network request and is not gated either. File bytes travel as Blob slices
 * through structured clone, straight from the Forge page's JavaScript into this
 * page's JavaScript and out to the LAN. They never touch GoDaddy.
 *
 * It holds NO credential. Every request carries a token Forge minted seconds
 * earlier for one operation on one path, so this window is a courier, not a
 * key. And it only ever speaks to the one origin the gateway is configured for:
 * a message from anywhere else is dropped without being read.
 *
 * On the desktop app (Electron 33 / Chromium 130) and on a browser where IT has
 * set LocalNetworkAccessAllowedForUrls, the Forge page talks to the gateway
 * directly and this window is never opened.
 */

const escapeHtml = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function html({ forgeOrigin }) {
  const origin = escapeHtml(forgeOrigin || '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Office file link</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; padding: 22px 24px; line-height: 1.5; }
  h1 { font-size: 15px; margin: 0 0 6px; letter-spacing: .02em; text-transform: uppercase; opacity: .7; }
  p { margin: 0 0 10px; font-size: 14px; }
  .state { font-weight: 600; }
  .quiet { opacity: .65; font-size: 13px; }
  code { font-size: 12px; }
</style></head>
<body>
  <h1>Office file link</h1>
  <p class="state" id="state">Connecting to the Forge tab…</p>
  <p class="quiet">Keep this window open while you browse or upload office files.
     It carries the files between your browser and the office file server, and
     nothing is stored here — no files, and no password or token: each request
     is permitted separately by Forge for a few seconds at a time. You can close
     it when you are done; an upload in progress will pause and carry on when
     you reopen it.</p>
  <p class="quiet" id="count"></p>
<script>
(function () {
  var FORGE = ${JSON.stringify(String(forgeOrigin || ''))};
  var state = document.getElementById('state');
  var count = document.getElementById('count');
  var served = 0;

  function say(text) { state.textContent = text; }
  function tick() { served += 1; count.textContent = served + (served === 1 ? ' request served' : ' requests served'); }

  /* Same-origin, so no CORS and no Local Network Access gate. The token rides
     in the Authorization header rather than the URL wherever it can, so it does
     not end up in this window's history. */
  function call(msg) {
    var init = { method: msg.method || 'GET', headers: {} };
    if (msg.token) init.headers.Authorization = 'Bearer ' + msg.token;
    if (msg.body !== undefined && msg.body !== null) {
      if (msg.body instanceof Blob || msg.body instanceof ArrayBuffer) {
        init.body = msg.body;
        init.headers['Content-Type'] = 'application/octet-stream';
      } else {
        init.body = JSON.stringify(msg.body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    return fetch(msg.path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  window.addEventListener('message', function (e) {
    /* TWO CHECKS, BOTH REQUIRED.
     *
     * The ORIGIN must be the one Forge is configured at — exact, not a suffix
     * match — so no other page can drive this relay.
     *
     * And the SOURCE must be the window that opened this one. Without that, any
     * page at Forge's origin could reach a relay somebody left open in another
     * tab; with it, only the tab that opened it can. A relay with neither check
     * is a file server with a postMessage API. */
    if (!FORGE || e.origin !== FORGE) return;
    var opener = window.opener || (window.parent !== window ? window.parent : null);
    if (opener && e.source && e.source !== opener) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object' || msg.channel !== 'forge-gateway') return;
    if (msg.kind === 'ping') { reply(msg.id, { status: 200, ok: true, data: { ok: true } }); return; }
    if (typeof msg.path !== 'string' || msg.path.charAt(0) !== '/') {
      reply(msg.id, { status: 400, ok: false, data: { error: 'bad path' } });
      return;
    }
    say('Connected to Forge.');
    call(msg).then(function (out) { tick(); reply(msg.id, out); })
      .catch(function (err) { reply(msg.id, { status: 0, ok: false, data: { error: String(err && err.message || err) } }); });
  });

  function reply(id, out) {
    var to = window.opener || (window.parent !== window ? window.parent : null);
    if (!to) return;
    to.postMessage({ channel: 'forge-gateway', id: id, reply: true, status: out.status, ok: out.ok, data: out.data }, FORGE);
  }

  var to = window.opener || (window.parent !== window ? window.parent : null);
  if (to && FORGE) {
    to.postMessage({ channel: 'forge-gateway', ready: true, origin: location.origin }, FORGE);
    say('Connected to Forge.');
  } else {
    say('Open this from the Server tab in Forge.');
  }
  window.addEventListener('beforeunload', function () {
    if (to && FORGE) to.postMessage({ channel: 'forge-gateway', closing: true }, FORGE);
  });
}());
</script>
</body></html>`;
}

module.exports = { html, escapeHtml };
