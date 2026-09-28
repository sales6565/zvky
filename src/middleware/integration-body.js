/* The raw bytes of an integration request, kept for the signature check.
 *
 * WHY THIS EXISTS AT ALL. express.json() is mounted globally in server.js and
 * consumes the request stream — by the time any route or middleware runs, the
 * body is a parsed object and the bytes that were actually sent are gone. An
 * HMAC over a re-serialized object is not an HMAC over what arrived: key order,
 * whitespace and number formatting all survive the round trip differently, so
 * a signature computed by the caller would fail against it for reasons nobody
 * could debug.
 *
 * WHY NOT express.json({ verify }). That is the usual answer and it is global:
 * it would attach a raw buffer to every request in the application, including
 * every upload and every page of the studio's own traffic, to serve one path.
 * This is mounted on /api/integration alone and ahead of the global parser, so
 * NO OTHER ROUTE'S BODY PARSING CHANGES IN ANY WAY.
 *
 * HOW THE HANDOFF WORKS. express.raw() sets req._body = true once it has read
 * the stream, and every body-parser — including the global express.json()
 * mounted after this — returns immediately when it sees that flag. So the
 * global parser does not run on this path, does not re-read a consumed stream,
 * and does not overwrite what is set below.
 *
 * WHAT THE ROUTE THEN GETS is an ordinary parsed JSON body, because that is
 * what every route in this codebase expects. The parse happens here, after the
 * bytes are safely kept.
 */

const express = require('express');

const LIMIT = process.env.INTEGRATION_BODY_LIMIT || '1mb';

const capture = express.raw({ type: '*/*', limit: LIMIT });

function parse(req, res, next) {
  /* Buffer, empty buffer, or nothing at all: a GET carries no body and must not
     be treated as a malformed one. */
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  req.rawBody = raw ? raw.toString('utf8') : '';

  if (!req.rawBody) {
    // An empty body is an empty object, which is what express.json() would have
    // produced. The signature still covers the empty string.
    req.body = {};
    return next();
  }
  try {
    req.body = JSON.parse(req.rawBody);
  } catch (err) {
    /* Refused here rather than left as a Buffer for a route to trip over.
       Deliberately AHEAD of the signature check in the chain order: a body that
       is not JSON cannot be acted on whatever it is signed with, and saying
       "that is not JSON" is more use than "the signature does not match". */
    return res.status(400).json({
      error: 'The request body is not valid JSON.',
      detail: err.message,
    });
  }
  return next();
}

module.exports = { capture, parse, LIMIT };
