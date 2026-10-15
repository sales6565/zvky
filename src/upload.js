const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Local disk storage — fine for a single server. For real production hosting
// with multiple instances, swap this for an S3-compatible bucket (the rest
// of the code only cares about the returned file_path/URL, so that's a
// contained change).
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

// What artists can actually submit for review: standard image formats,
// layered PSDs, Spine's rigging export formats, and After Effects project
// files. Extend this list as the studio's pipeline grows.
const REVIEW_EXTENSIONS = [
  '.psd', '.jpg', '.jpeg', '.png', '.gif', '.tiff', '.tif',
  '.json', '.atlas', '.skel',   // Spine (skeleton/atlas/data)
  '.aep', '.aet',               // After Effects project / template
];
const IMPORT_EXTENSIONS = ['.csv', '.xls', '.xlsx'];

function extensionFilter(allowed) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    // Tagged as a client error: the caller sent the wrong sort of file, which
    // is not a fault in the server and should not be reported as one.
    const err = new Error(`Unsupported file type "${ext || '(none)'}". Allowed: ${allowed.join(', ')}`);
    err.status = 400;
    cb(err);
  };
}

/* THE WORK-FILE PARSER IS GONE.
 *
 * There used to be a second multer here — 200 MB, the REVIEW_EXTENSIONS list —
 * for artist submissions arriving as multipart bodies and landing in ./uploads
 * on this server. The office file server replaced it: the bytes go from the
 * person's browser to a machine in the studio and never reach this host.
 *
 * It is DELETED rather than left unused, because an unused parser is one
 * require away from being used again. The route that had it now refuses a
 * multipart body with 410 (src/middleware/no-file-bodies.js), and a test
 * asserts no route in this application mounts a file parser for work files.
 *
 * REVIEW_EXTENSIONS stays: it is still the studio's list of what counts as a
 * reviewable file and it is read by the Server tab's own rules and by the
 * legacy download path.
 */

// For bulk asset-list imports (CSV / Excel)
const uploadImport = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // spreadsheets are small; 20MB is generous
  fileFilter: extensionFilter(IMPORT_EXTENSIONS),
});

module.exports = { uploadImport, UPLOAD_DIR, REVIEW_EXTENSIONS, IMPORT_EXTENSIONS };
