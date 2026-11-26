// The visitor's language for this request (from the Accept-Language header the
// store sends), available anywhere while the request runs. Used to write product
// names into messages in the visitor's language.
const { AsyncLocalStorage } = require("async_hooks");

const LANGUAGES = ["en", "de", "ar", "fr", "es"];
const storage = new AsyncLocalStorage();

function pickLanguage(header) {
  const first = String(header || "").split(",")[0].trim().slice(0, 2).toLowerCase();
  return LANGUAGES.includes(first) ? first : "en";
}

function languageMiddleware(req, res, next) {
  req.lang = pickLanguage(req.headers["accept-language"]);
  storage.run({ lang: req.lang }, next);
}

const currentLanguage = () => storage.getStore()?.lang || "en";

// A localized value ({ en, de, ar } or a plain string) in the request's language,
// falling back to English, then any language
function localizedText(value, lang = currentLanguage()) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value[lang] || value.en || value.de || value.fr || value.es || value.ar || "";
}

module.exports = { LANGUAGES, pickLanguage, languageMiddleware, currentLanguage, localizedText };
