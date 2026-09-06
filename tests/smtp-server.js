// A real SMTP server, for the tests to send real mail to.
//
// WHY THIS EXISTS RATHER THAN A STUBBED nodemailer. A test that replaces the
// mail library asserts that this codebase called a function it also wrote the
// definition of. It cannot catch a malformed From header, a message with no
// recipient, a body assembled wrongly, or authentication that is sent in a
// shape no server accepts — which are most of the ways email actually breaks.
//
// This speaks enough of RFC 5321 for nodemailer to complete a session against
// it, and keeps what it was given. So the assertions in the suite are about a
// message that was genuinely transmitted, parsed at the other end, and stored:
// its envelope sender, its recipients, its headers and its body.
//
// It does NOT do TLS. The tests configure encryption 'none' and talk to
// 127.0.0.1, which keeps a certificate out of the test setup; what is being
// tested here is this application's behaviour, not nodemailer's TLS.

const net = require('node:net');

/* Start one. Resolves with { port, messages, stop, reset } — `messages` is the
   live array the assertions read. */
function start({ requireAuth = false, user = null, pass = null, failWith = null } = {}) {
  const messages = [];
  const authAttempts = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let envelope = { from: null, to: [] };
    // Which half of the two-step AUTH LOGIN exchange we are in, if any.
    let awaiting = null;

    const send = (line) => socket.write(`${line}\r\n`);
    send('220 test.local ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // DATA mode: everything up to a lone dot is the message.
      while (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) { data += buffer; buffer = ''; return; }
        data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        messages.push({ ...parse(data), envelope: { from: envelope.from, to: [...envelope.to] } });
        data = '';
        envelope = { from: null, to: [] };
        send('250 2.0.0 Ok: queued');
      }

      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        /* The continuation line of AUTH LOGIN, which is a bare base64 token
           rather than a verb — so it has to be handled before the switch. */
        if (awaiting === 'username') {
          authAttempts.push({ stage: 'username', value: Buffer.from(line, 'base64').toString() });
          awaiting = 'password';
          send('334 UGFzc3dvcmQ6');
          continue;
        }
        if (awaiting === 'password') {
          const given = Buffer.from(line, 'base64').toString();
          authAttempts.push({ stage: 'password', value: given });
          awaiting = null;
          const who = authAttempts.filter((a) => a.stage === 'username').pop();
          send(user && (who.value !== user || given !== pass)
            ? '535 5.7.8 Authentication credentials invalid'
            : '235 2.7.0 Authentication successful');
          continue;
        }

        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          send('250-test.local');
          send('250-SIZE 10485760');
          send('250 AUTH LOGIN PLAIN');
        } else if (verb === 'AUTH') {
          const mechanism = (line.split(' ')[1] || '').toUpperCase();
          if (mechanism === 'LOGIN') { awaiting = 'username'; send('334 VXNlcm5hbWU6'); }
          else if (mechanism === 'PLAIN') {
            const token = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0');
            authAttempts.push({ stage: 'plain', value: token[1], password: token[2] });
            send(user && (token[1] !== user || token[2] !== pass)
              ? '535 5.7.8 Authentication credentials invalid'
              : '235 2.7.0 Authentication successful');
          } else send('504 5.5.4 Unrecognized authentication type');
        } else if (verb === 'MAIL') {
          if (requireAuth && !authAttempts.length) { send('530 5.7.0 Authentication required'); continue; }
          if (failWith) { send(failWith); continue; }
          envelope.from = address(line);
          send('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          envelope.to.push(address(line));
          send('250 2.1.5 Ok');
        } else if (verb === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
          // The rest of this chunk may already be message body.
          if (buffer.length) { socket.emit('data', Buffer.alloc(0)); }
        } else if (verb === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
        } else if (verb === 'RSET') {
          envelope = { from: null, to: [] };
          send('250 2.0.0 Ok');
        } else {
          send('250 2.0.0 Ok');
        }
      }
    });

    socket.on('error', () => { /* a client hanging up mid-session is not a test failure */ });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        authAttempts,
        reset() { messages.length = 0; authAttempts.length = 0; },
        stop() { return new Promise((done) => server.close(done)); },
      });
    });
  });
}

// <someone@example.com> out of "MAIL FROM:<someone@example.com>".
function address(line) {
  const m = /<([^>]*)>/.exec(line);
  return m ? m[1] : (line.split(':')[1] || '').trim();
}

/* Headers and body, far enough to assert on.
 *
 * Handles the two encodings nodemailer actually picks for these messages —
 * quoted-printable and base64 — because a subject line asserted against raw
 * bytes would pass or fail on the presence of an accent rather than on
 * anything this codebase decided. */
function parse(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const headerText = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split + 4);

  const headers = {};
  // Unfold: a header continued on the next line starts with whitespace.
  for (const line of headerText.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    headers[line.slice(0, at).toLowerCase()] = decodeWords(line.slice(at + 1).trim());
  }

  return {
    headers,
    subject: headers.subject || '',
    from: headers.from || '',
    to: headers.to || '',
    raw,
    // Every part, decoded and concatenated — enough to search for a sentence.
    body: decodeBody(raw, body),
  };
}

/* =?UTF-8?B?...?= and =?UTF-8?Q?...?= in a header.
 *
 * Decoded through a Buffer rather than String.fromCharCode per byte. An em dash
 * is three bytes of UTF-8, and turning each into its own character produces
 * "â" — which would have made every subject assertion in the suite a test of
 * whether the subject happened to be ASCII.
 *
 * The whitespace between two ADJACENT encoded words is dropped, per RFC 2047:
 * a long subject is split across several of them, and the folding space between
 * is an artefact of the encoding rather than a space in the text. */
function decodeWords(value) {
  return String(value)
    .replace(/(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?[^?]+\?([QqBb])\?([^?]*)\?=/g, (_, kind, text) => (
      kind.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
          text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16))),
          'latin1',
        ).toString('utf8')));
}

function decodeBody(raw, body) {
  const parts = [];
  // Multipart: decode each section by its own transfer encoding.
  const boundary = /boundary="?([^"\r\n;]+)"?/i.exec(raw);
  const chunks = boundary
    ? body.split(`--${boundary[1]}`).slice(1, -1)
    : [`\r\n\r\n${body}`];

  for (const chunk of chunks) {
    const at = chunk.indexOf('\r\n\r\n');
    const head = at === -1 ? '' : chunk.slice(0, at);
    const text = at === -1 ? chunk : chunk.slice(at + 4);
    if (/base64/i.test(head)) parts.push(Buffer.from(text.replace(/\r\n/g, ''), 'base64').toString('utf8'));
    else if (/quoted-printable/i.test(head)) parts.push(unquote(text));
    else parts.push(text);
  }
  return parts.join('\n');
}

/* Quoted-printable, decoded through a Buffer.
 *
 * The same trap as decodeWords above: an em dash is three bytes, and turning
 * each into its own character produces "â" in the body — which would have made
 * every body assertion in the suite a test of whether the text was ASCII. */
function unquote(text) {
  return Buffer.from(
    text.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  ).toString('utf8');
}

module.exports = { start };
