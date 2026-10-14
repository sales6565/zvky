/* BUILDING AN RFC 2822 MESSAGE BY HAND, because the Gmail API takes one.
 *
 * users.messages.send does not take a `to` and a `subject`; it takes `raw`, a
 * base64url-encoded message, and whatever is in those bytes is what the
 * recipient gets. nodemailer used to build this for us. So everything it did
 * quietly — folding headers, encoding a subject that is not ASCII, assembling
 * a multipart body, generating a Message-ID — has to be done here and has to be
 * done right, because there is no library left to be forgiving.
 *
 * ---------------------------------------------------------------------------
 * HEADER INJECTION IS THE WHOLE REASON THIS FILE IS CAREFUL.
 *
 * A header ends at a CRLF. So a subject containing one does not produce a
 * strange-looking subject — it produces a new header, chosen by whoever supplied
 * the text. Every string that reaches a header position in this application has
 * passed through a person: an asset name, somebody's own name, a note typed into
 * a feedback box. `header()` below REFUSES a value containing CR or LF rather
 * than stripping it, because a rejected message is a bug report and a silently
 * stripped one is a message somebody tampered with that nobody notices.
 *
 * ---------------------------------------------------------------------------
 * UTF-8, AND WHY THE SUBJECT IS ENCODED EVEN WHEN IT LOOKS FINE.
 *
 * A header is ASCII by the standard. "Priya Nair" survives being sent raw;
 * "Priyā" and "₹12,000" and a curly quote do not — they arrive as mojibake, or
 * the message is rejected. RFC 2047 is the way out: the text is base64'd and
 * labelled with its charset, which is what `encodedWord()` does. It is applied
 * ONLY when the text is not plain ASCII, so an ordinary English subject stays
 * readable in a raw message and in a mail client's "show original".
 *
 * THE SAME GOES FOR A DISPLAY NAME. "ZVKY FORGE" is fine as it stands;
 * a studio that renames itself with an accent would otherwise be garbled in
 * every From line it sends.
 */
const crypto = require('node:crypto');

/* Gmail refuses a message over 35 MB (its documented limit is 25 MB for the
 * message proper; the API's own cap on the base64 payload is 35 MB). This
 * application sends short notifications with no attachments, so the cap here is
 * a guard against a runaway template rather than a real limit — a megabyte of
 * notification is already a bug, and failing it with a sentence beats a 413 from
 * Google with no context. Configurable so a studio that one day attaches a PDF
 * is not editing code. */
/* A FUNCTION, not a constant, for the reason gmail-transport.js spells out: a
   module-level env read depends on require order. */
const maxBytes = () => Number(process.env.EMAIL_MAX_BYTES || 1024 * 1024);

/* An address, as strictly as is useful.
 *
 * NOT a full RFC 5322 parser — those accept quoted local parts with spaces in
 * them, which no studio has ever typed into a user record, and accepting more
 * than this would mean accepting things the header builder would then have to
 * quote. One @, no whitespace, no CR or LF, something either side, a dot in the
 * domain. The failures this really has to catch are an empty string, a name
 * where an address should be, and an injected newline. */
const ADDRESS = /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/;

function isAddress(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text.length <= 254 && ADDRESS.test(text);
}

/* CR or LF anywhere in a header value, by any spelling.
 *
 * Checked on the raw string before anything is encoded, and that order matters:
 * encoding a newline into an RFC 2047 word would HIDE it from this check while
 * still decoding to a newline in some clients. */
const hasBreak = (value) => /[\r\n]/.test(String(value === undefined || value === null ? '' : value));

const isAscii = (value) => !/[^\x20-\x7E]/.test(String(value || ''));

/* RFC 2047, base64 flavour. Split so no encoded word exceeds 75 characters,
   which is the standard's limit and which some clients enforce. */
function encodedWord(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (isAscii(value)) return value;
  /* Chunked on CHARACTERS, not bytes, then encoded — so a multi-byte character
     is never split across two encoded words, which would produce two invalid
     words rather than one valid pair. 18 characters of UTF-8 is at most 72
     bytes, which base64s to 96... too long, so chunk smaller: 10 characters is
     at most 40 bytes -> 56 base64 chars, plus the 12-character wrapper = 68. */
  const out = [];
  const chars = [...value];
  for (let i = 0; i < chars.length; i += 10) {
    const chunk = chars.slice(i, i + 10).join('');
    out.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }
  return out.join(' ');
}

/* One header line. Throws on a value that would break out of it.
 *
 * THE BREAK CHECK HAPPENS ON THE RAW VALUE, BEFORE ANY ENCODING, and the order
 * is the whole of the protection. The first version of this file encoded the
 * subject first and checked the result — and a subject containing CRLF is not
 * ASCII, so it went through RFC 2047, which base64'd the newline INTO the
 * encoded word where this check could not see it. The header then looked
 * perfectly well-formed and decoded, in a client, to two headers. Its own unit
 * test caught it; the comment above encodedWord() had predicted it and the code
 * had done it anyway.
 *
 * So `encode` is applied HERE, after the check, and no caller encodes first.
 *
 * The error names the header but does NOT quote the value back — a subject built
 * from somebody's note could carry anything, and an error message is a thing
 * that gets logged. */
function header(name, value, encode = (v) => v) {
  if (hasBreak(name) || hasBreak(value)) {
    const err = new Error(`The ${name} header contained a line break, which is not allowed.`);
    err.permanent = true;
    err.field = name;
    throw err;
  }
  return `${name}: ${encode(value)}`;
}

/* A display name and address, as one header value.
 *
 * The name is encoded when it needs to be and QUOTED when it does not: a comma
 * in an unquoted display name reads as a second recipient to a strict parser,
 * which is how "Studio, ZVKY <x@y>" becomes mail to a domain called "ZVKY". An
 * encoded word must NOT be quoted — the quotes would become part of the decoded
 * text — so the two cases are built differently on purpose. */
function addressHeader(name, address) {
  const clean = String(address || '').trim();
  if (!name) return clean;
  const label = String(name).trim();
  if (!label) return clean;
  if (isAscii(label)) return `"${label.replace(/["\\]/g, '')}" <${clean}>`;
  return `${encodedWord(label)} <${clean}>`;
}

/* A unique Message-ID, and the domain it is stamped with.
 *
 * The domain half must be one we own — a Message-ID claiming somebody else's
 * domain is the kind of thing a spam filter notices — so it is taken from the
 * sender's own address. The local half is random rather than sequential: a
 * guessable Message-ID leaks how much mail a studio sends.
 *
 * WHY IT IS SET AT ALL, when Gmail would supply one: because the brief's
 * at-least-once problem needs it. A send whose response is lost has to be
 * recognisable on the next attempt, and our own id is the only thing that is
 * the same across both attempts — see the duplicate check in
 * src/gmail-transport.js. */
function messageId(fromAddress) {
  const domain = String(fromAddress || '').split('@')[1] || 'localhost';
  return `<${Date.now().toString(36)}.${crypto.randomBytes(12).toString('hex')}@${domain}>`;
}

/* Quoted-printable would be the polite encoding for a body; base64 is the
 * reliable one. A body built from somebody's typed note can contain anything,
 * and the failure mode of hand-rolled quoted-printable is a line over 998
 * characters, which is a malformed message. Base64 cannot be malformed. */
function base64Body(text) {
  const encoded = Buffer.from(String(text === undefined || text === null ? '' : text), 'utf8')
    .toString('base64');
  return (encoded.match(/.{1,76}/g) || ['']).join('\r\n');
}

/* THE MESSAGE.
 *
 * `from` is the AUTHENTICATED mailbox and nothing else. Gmail rewrites a From
 * that is not the sending account (or a verified alias), so accepting one here
 * would mean building a message whose From we know will be replaced — a lie to
 * whoever reads the code and a confusing arrival for whoever gets the mail. The
 * caller passes a display name; the address comes from the transport.
 */
function build({ from, fromName, to, subject, text, html, replyTo, inReplyTo } = {}) {
  if (!isAddress(from)) {
    const err = new Error('The sender address is not a valid email address.');
    err.permanent = true;
    err.field = 'from';
    throw err;
  }
  if (!isAddress(to)) {
    /* PERMANENT, not temporary: no amount of retrying turns a malformed address
       into a deliverable one. This is the classification that stops one bad
       user record burning six attempts an hour apart. */
    const err = new Error('That recipient is not a valid email address.');
    err.permanent = true;
    err.field = 'to';
    throw err;
  }
  if (replyTo !== undefined && replyTo !== null && replyTo !== '' && !isAddress(replyTo)) {
    const err = new Error('The Reply-To address is not a valid email address.');
    err.permanent = true;
    err.field = 'replyTo';
    throw err;
  }

  const id = inReplyTo || messageId(from);
  const boundary = `=_zvky_${crypto.randomBytes(16).toString('hex')}`;
  const plain = String(text === undefined || text === null ? '' : text);
  const rich = String(html === undefined || html === null ? '' : html);

  /* THE DISPLAY NAME IS CHECKED ON ITS OWN, before it is folded into an address
     header — addressHeader() encodes, so a break in the name would otherwise be
     hidden inside an encoded word exactly as the subject's was. */
  if (hasBreak(fromName)) {
    const err = new Error('The From display name contained a line break, which is not allowed.');
    err.permanent = true;
    err.field = 'fromName';
    throw err;
  }

  /* THE RAW VALUES GO IN; the encoder is the third argument. See header(). */
  const headers = [
    header('From', from, () => addressHeader(fromName, from)),
    header('To', to),
    header('Subject', subject === undefined || subject === null ? '' : subject, encodedWord),
    header('Message-ID', id),
    header('Date', new Date().toUTCString()),
    header('MIME-Version', '1.0'),
  ];
  if (replyTo) headers.push(header('Reply-To', replyTo));

  let body;
  if (rich) {
    /* multipart/alternative, plain FIRST. The order is the standard's meaning
       of "alternative": a client shows the LAST part it understands, so the
       richest version goes last. Getting this backwards sends everybody the
       plain text. */
    headers.push(header('Content-Type', `multipart/alternative; boundary="${boundary}"`));
    body = [
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(plain),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(rich),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push(header('Content-Type', 'text/plain; charset="UTF-8"'));
    headers.push(header('Content-Transfer-Encoding', 'base64'));
    body = `\r\n${base64Body(plain)}\r\n`;
  }

  const raw = headers.join('\r\n') + body;
  const bytes = Buffer.byteLength(raw, 'utf8');
  const limit = maxBytes();
  if (bytes > limit) {
    const err = new Error(`That message is ${bytes} bytes; the limit is ${limit}.`);
    err.permanent = true;
    err.field = 'body';
    throw err;
  }

  return { raw, messageId: id, bytes };
}

/* base64url, which is what the API wants: the URL alphabet and no padding.
   Gmail accepts standard base64 too, but the documented form is this one and a
   message that round-trips through a URL-safe encoder cannot be corrupted by a
   proxy that treats + as a space. */
const toBase64Url = (raw) => Buffer.from(raw, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (value) => Buffer.from(
  String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

module.exports = {
  build, toBase64Url, fromBase64Url, messageId, encodedWord, addressHeader,
  isAddress, hasBreak, header, maxBytes,
};
