// Display currencies: country detection, supported currencies, exchange rates and conversion.
// Product prices stay in the base currency in the database; these endpoints only convert.
const httpError = require("../utils/httpError");
const v = require("../utils/validate");
const {
  BASE_CURRENCY, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, COUNTRY_CURRENCY,
  currencyDecimals, currencyForCountry, isSupportedCurrency,
} = require("../config/currency");
const { getPublicRates, rateFor, convertAmount, refresh } = require("../utils/exchangeRates");
const { detectCountry } = require("../utils/geo");

const currencyList = (rates) => SUPPORTED_CURRENCIES
  .filter((code) => rates[code]) // only currencies we can convert to right now
  .map((code) => ({ code, decimals: currencyDecimals(code) }));

// GET /api/currency  - everything the store needs at start-up in one request
async function getCurrencyConfig(req, res) {
  const rates = await getPublicRates();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ ...rates, default: DEFAULT_CURRENCY, currencies: currencyList(rates.rates) });
}

// GET /api/currency/currencies
async function getCurrencies(req, res) {
  const rates = await getPublicRates();
  res.json({ base: BASE_CURRENCY, default: DEFAULT_CURRENCY, currencies: currencyList(rates.rates), countries: COUNTRY_CURRENCY });
}

// GET /api/currency/rates
async function getExchangeRates(req, res) {
  res.set("Cache-Control", "public, max-age=300");
  res.json(await getPublicRates());
}

// GET /api/currency/detect  -> { country, currency, source }
async function detectCurrency(req, res) {
  const { country, source } = await detectCountry(req);
  const mapped = currencyForCountry(country);
  const rate = mapped ? await rateFor(mapped) : null;
  res.set("Cache-Control", "private, no-store");
  res.json({
    country,
    currency: mapped && rate ? mapped : DEFAULT_CURRENCY,
    source: mapped && rate ? source : "default",
  });
}

// GET /api/currency/convert?amount=10&to=EGP[&from=USD]
async function convert(req, res) {
  const amount = v.number(req.query.amount, "amount", { required: true, min: 0, max: 1e9 });
  const to = String(req.query.to || "").toUpperCase();
  const from = String(req.query.from || BASE_CURRENCY).toUpperCase();
  if (!isSupportedCurrency(to)) throw httpError(400, `to must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
  if (!isSupportedCurrency(from)) throw httpError(400, `from must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
  const [rateTo, rateFrom] = await Promise.all([rateFor(to), rateFor(from)]);
  if (!rateTo || !rateFrom) throw httpError(503, "Exchange rates are not available right now");
  const rate = rateTo / rateFrom;
  const rates = await getPublicRates();
  res.json({ amount, from, to, rate, converted: convertAmount(amount, rate, to), updatedAt: rates.updatedAt });
}

// POST /api/admin/currency/refresh  (admin) - fetch new rates now
async function refreshRates(req, res) {
  await refresh();
  res.json(await getPublicRates());
}

module.exports = { getCurrencyConfig, getCurrencies, getExchangeRates, detectCurrency, convert, refreshRates };
