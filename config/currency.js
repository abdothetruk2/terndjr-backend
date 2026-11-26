// Currencies the store can show prices in, and which currency a visitor's country uses.
//
// Product prices are stored in BASE_CURRENCY (USD) and never change; other
// currencies are only a display conversion using cached exchange rates.
//
// Everything here can be changed without code edits through .env:
//   BASE_CURRENCY=USD
//   SUPPORTED_CURRENCIES=USD,EUR,GBP,EGP,SAR,AED          (replaces the list below)
//   COUNTRY_CURRENCY_MAP={"MA":"MAD","TN":"TND"}          (JSON, merged over the map below)
//   DEFAULT_CURRENCY=USD                                   (unknown country / no rates)

const parseList = (value) => String(value || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const BASE_CURRENCY = (process.env.BASE_CURRENCY || "USD").toUpperCase();

const DEFAULT_SUPPORTED = ["USD", "EUR", "GBP", "EGP", "SAR", "AED", "KWD", "QAR", "CHF", "TRY", "CAD", "AUD", "XOF", "XAF"];

// CFA francs (no decimals): West African XOF and Central African XAF
const XOF_COUNTRIES = ["BJ", "BF", "CI", "GW", "ML", "NE", "SN", "TG"];
const XAF_COUNTRIES = ["CM", "CF", "TD", "CG", "GQ", "GA"];

const EURO_COUNTRIES = ["AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES",
  "MC", "SM", "VA", "AD", "ME", "XK"];

const DEFAULT_COUNTRY_MAP = {
  ...Object.fromEntries(EURO_COUNTRIES.map((c) => [c, "EUR"])),
  ...Object.fromEntries(XOF_COUNTRIES.map((c) => [c, "XOF"])),
  ...Object.fromEntries(XAF_COUNTRIES.map((c) => [c, "XAF"])),
  US: "USD", PR: "USD", EC: "USD", SV: "USD", PA: "USD",
  GB: "GBP", IM: "GBP", JE: "GBP", GG: "GBP",
  EG: "EGP",
  SA: "SAR",
  AE: "AED",
  KW: "KWD",
  QA: "QAR",
  CH: "CHF", LI: "CHF",
  TR: "TRY",
  CA: "CAD",
  AU: "AUD",
};

function parseMap(value) {
  if (!value) return {};
  try {
    const map = JSON.parse(value);
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()]));
  } catch {
    console.warn("COUNTRY_CURRENCY_MAP is not valid JSON - using the built-in map");
    return {};
  }
}

const SUPPORTED_CURRENCIES = (() => {
  const list = parseList(process.env.SUPPORTED_CURRENCIES);
  const out = list.length ? list : DEFAULT_SUPPORTED;
  return out.includes(BASE_CURRENCY) ? out : [BASE_CURRENCY, ...out];
})();

const COUNTRY_CURRENCY = { ...DEFAULT_COUNTRY_MAP, ...parseMap(process.env.COUNTRY_CURRENCY_MAP) };

const DEFAULT_CURRENCY = (() => {
  const code = (process.env.DEFAULT_CURRENCY || BASE_CURRENCY).toUpperCase();
  return SUPPORTED_CURRENCIES.includes(code) ? code : BASE_CURRENCY;
})();

// Decimals used for rounding converted prices (same rule as the browser's Intl)
function currencyDecimals(code) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

function currencyForCountry(country) {
  const code = COUNTRY_CURRENCY[String(country || "").toUpperCase()];
  return code && SUPPORTED_CURRENCIES.includes(code) ? code : null;
}

const isSupportedCurrency = (code) => SUPPORTED_CURRENCIES.includes(String(code || "").toUpperCase());

module.exports = {
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  COUNTRY_CURRENCY,
  DEFAULT_CURRENCY,
  currencyDecimals,
  currencyForCountry,
  isSupportedCurrency,
};
