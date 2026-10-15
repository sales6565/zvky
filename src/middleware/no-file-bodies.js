/* THE WORK-FILE ROUTES STOP TAKING FILES.
 *
 * Artist submissions used to arrive here as multipart bodies and land in
 * ./uploads on the application server. The office file server replaces that
 * entirely: the bytes now go from the person's browser to a machine in the
 * studio, and this server never sees them — no body, no proxy, no temporary
 * file, no cache.
 *
 * SO THE PARSER IS GONE, NOT GUARDED. multer is no longer mounted on those
 * routes, which is the actual guarantee: a route with no parser cannot write a
 * file even if somebody later deletes the check below. This middleware is the
 * second half — it recognises a multipart body arriving at a route that used to
 * accept one and answers 410 Gone with a sentence saying where files go now.
 *
 * WHY 410 AND NOT 400. Gone is the one status that means "this used to be here
 * and will not come back", which is exactly the situation: an old desktop build
 * or a bookmarked form is not malformed, it is out of date, and the person
 * holding it needs to be told that rather than told they did something wrong.
 *
 * THE REST OF THE REQUEST STILL WORKS. Submitting is a LINK plus a description
 * and has been for some time; only the optional file attachment is gone. So
 * this refuses a request that carries a FILE and lets every other submission
 * through untouched.
 */
const MESSAGE = 'Files are no longer uploaded to this server. '
  + 'Open the Server tab and copy the file to the office file server, then submit the link. '
  + 'If you cannot see the Server tab, ask an admin to switch it on and grant you access.';

function isMultipart(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  return type.includes('multipart/form-data');
}

function refuseFileBody(req, res, next) {
  if (!isMultipart(req)) return next();
  /* Nothing is read from the stream — not into memory, not to disk. The
     response is sent and the socket is left to the client, which is the whole
     point: a 40 GB body must not be drained through shared hosting to produce
     an error message. */
  res.status(410).json({ error: MESSAGE, code: 'files_moved' });
  return undefined;
}

module.exports = { refuseFileBody, isMultipart, MESSAGE };
