const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const httpError = require("../utils/httpError");

// Uploaded images are stored here and served at /uploads/<file> (see server.js)
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const MAX_BYTES = 5 * 1024 * 1024;

// Allowed Content-Types -> file extension. SVG is deliberately not allowed
// (it can carry scripts).
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Detects the real image type from the file's first bytes
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

// POST /api/admin/uploads   (admin)
// The request body is the image itself, sent with its Content-Type
// (e.g. image/jpeg), max 5 MB.  ->  201 { path, url, size, type }
// Save `path` (e.g. "uploads/3f9c...e1.jpg") in a product or category `image`.
async function uploadImage(req, res) {
  const type = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) throw httpError(415, "Only JPEG, PNG, WebP or GIF images can be uploaded");

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw httpError(400, "No image was received");
  if (sniffImage(body) !== ext) throw httpError(415, "The file is not a valid JPEG, PNG, WebP or GIF image");

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), body, { flag: "wx" });

  res.status(201).json({
    path: `uploads/${name}`,
    url: `${req.protocol}://${req.get("host")}/uploads/${name}`,
    size: body.length,
    type,
  });
}

module.exports = { uploadImage, UPLOAD_DIR, IMAGE_TYPES, MAX_BYTES };
