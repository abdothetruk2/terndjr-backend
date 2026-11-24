// Small input-validation helpers shared by the controllers.
// Each helper returns the cleaned value or throws a 400 error with a readable message.
const mongoose = require("mongoose");
const httpError = require("./httpError");

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "Gold Necklace 40cm" -> "gold-necklace-40cm"
function slugify(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value, field, { required = false, max = 200, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw httpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw httpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw httpError(400, `${field} is required`);
    return allowEmpty ? "" : undefined;
  }
  if (trimmed.length > max) throw httpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

function number(value, field, { required = false, min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw httpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value === "boolean" || Array.isArray(value) || isPlainObject(value)) {
    throw httpError(400, `${field} must be a number`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
  if (integer && !Number.isInteger(n)) throw httpError(400, `${field} must be a whole number`);
  if (n < min) throw httpError(400, `${field} must be at least ${min}`);
  if (n > max) throw httpError(400, `${field} must be at most ${max}`);
  return n;
}

function boolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw httpError(400, `${field} must be true or false`);
}

function date(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") throw httpError(400, `${field} must be a date`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${field} must be a valid date`);
  return d;
}

function oneOf(value, field, allowed, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw httpError(400, `${field} is required`);
    return undefined;
  }
  if (!allowed.includes(value)) throw httpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  return value;
}

function slug(value, field = "slug", { required = false } = {}) {
  const s = text(value, field, { required, max: 120 });
  if (s === undefined) return undefined;
  const lower = s.toLowerCase();
  if (!SLUG_PATTERN.test(lower)) {
    throw httpError(400, `${field} may only contain lowercase letters, numbers and single hyphens`);
  }
  return lower;
}

// Localized text: a plain string (treated as English) or { en, de, ar }.
// Returns only the languages that were sent: { en: "...", de: "" } etc.
// requireEn: English must be present and non-empty (create).
// nonEmptyEn: English may be omitted, but if it is sent it can't be empty (update).
function localized(value, field, { languages = ["en", "de", "ar"], requireEn = false, nonEmptyEn = false, max = 200 } = {}) {
  if (value === undefined) {
    if (requireEn) throw httpError(400, `${field} (English) is required`);
    return undefined;
  }
  if (typeof value === "string") value = { en: value };
  if (!isPlainObject(value)) throw httpError(400, `${field} must be text or an object like { en, de, ar }`);

  const out = {};
  for (const lang of languages) {
    if (value[lang] === undefined || value[lang] === null) continue;
    out[lang] = text(value[lang], `${field} (${lang})`, { max, allowEmpty: true }) ?? "";
  }
  if (requireEn && !out.en) throw httpError(400, `${field} (English) is required`);
  if (nonEmptyEn && out.en === "") throw httpError(400, `${field} (English) cannot be empty`);
  return out;
}

function objectId(value, field = "id") {
  if (!mongoose.isValidObjectId(value)) throw httpError(400, `Invalid ${field}`);
  return value;
}

// ?page=&limit= -> { page, limit, skip }
function pagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = {
  isPlainObject,
  escapeRegex,
  slugify,
  SLUG_PATTERN,
  text,
  number,
  boolean,
  date,
  oneOf,
  slug,
  localized,
  objectId,
  pagination,
};
