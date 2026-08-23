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

// For artist submissions on the review workflow
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — animation/art files can be large
  fileFilter: extensionFilter(REVIEW_EXTENSIONS),
});

// For bulk asset-list imports (CSV / Excel)
const uploadImport = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // spreadsheets are small; 20MB is generous
  fileFilter: extensionFilter(IMPORT_EXTENSIONS),
});

module.exports = { upload, uploadImport, UPLOAD_DIR, REVIEW_EXTENSIONS, IMPORT_EXTENSIONS };
