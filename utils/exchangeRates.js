// Exchange rates for the display currencies.
//
// - Fetched from a free rates service (open.er-api.com, falling back to the ECB
//   rates of api.frankfurter.dev), never from the browser.
// - Cached in memory and in MongoDB (collection "exchangerates") with the time of
//   the last successful update, so a restart or a provider outage keeps working.
// - Stale-while-revalidate: requests get the cached rates at once; a refresh runs in
//   the background when they are older than RATES_TTL_HOURS (default 6).
const ExchangeRate = require("../modules/exchangeRate");
const { BASE_CURRENCY, SUPPORTED_CURRENCIES, currencyDecimals } = require("../config/currency");

const TTL_MS = Math.max(0.25, Number(process.env.RATES_TTL_HOURS) || 6) * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

const PROVIDERS = [
  {
    name: "open.er-api.com",
    url: (base) => `https://open.er-api.com/v6/latest/${base}`,
    parse: (data) => (data?.result === "success" && data.rates
      ? { rates: data.rates, updatedAt: data.time_last_update_unix ? new Date(data.time_last_update_unix * 1000) : null }
      : null),
  },
  {
    name: "frankfurter (ECB)",
    url: (base) => `https://api.frankfurter.dev/v1/latest?base=${base}`,
    parse: (data) => (data?.rates ? { rates: { ...data.rates, [data.base]: 1 }, updatedAt: data.date ? new Date(`${data.date}T16:00:00Z`) : null } : null),
  },
];

let cache = null; // { base, rates: {CODE: number}, provider, providerUpdatedAt, fetchedAt }
let refreshing = null;
let lastFailureAt = 0;
let loadedFromDb = false;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Keep only usable numbers; the base currency is always 1
function cleanRates(rates) {
  const out = { [BASE_CURRENCY]: 1 };
  for (const [code, value] of Object.entries(rates || {})) {
    const n = Number(value);
    if (/^[A-Z]{3}$/.test(code) && Number.isFinite(n) && n > 0) out[code] = n;
  }
  return out;
}

async function loadFromDb() {
  if (loadedFromDb) return;
  loadedFromDb = true;
  try {
    const doc = await ExchangeRate.findOne({ base: BASE_CURRENCY }).lean();
    if (doc && !cache) {
      cache = {
        base: doc.base,
        rates: cleanRates(doc.rates instanceof Map ? Object.fromEntries(doc.rates) : doc.rates),
        provider: doc.provider,
        providerUpdatedAt: doc.providerUpdatedAt,
        fetchedAt: doc.fetchedAt,
      };
    }
  } catch (err) {
    console.warn("Could not read the saved exchange rates:", err.message);
  }
}

// Fetch fresh rates (first provider that answers). On failure the cache stays as it is.
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const errors = [];
    for (const provider of PROVIDERS) {
      try {
        const parsed = provider.parse(await fetchJson(provider.url(BASE_CURRENCY)));
        if (!parsed) throw new Error("unexpected answer");
        const rates = cleanRates(parsed.rates);
        const missing = SUPPORTED_CURRENCIES.filter((code) => !rates[code]);
        // A provider without some supported currencies: keep their last known rates
        if (missing.length && cache?.rates) missing.forEach((code) => { if (cache.rates[code]) rates[code] = cache.rates[code]; });
        cache = { base: BASE_CURRENCY, rates, provider: provider.name, providerUpdatedAt: parsed.updatedAt, fetchedAt: new Date() };
        await ExchangeRate.updateOne(
          { base: BASE_CURRENCY },
          { $set: { rates, provider: provider.name, providerUpdatedAt: parsed.updatedAt, fetchedAt: cache.fetchedAt } },
          { upsert: true }
        ).catch((err) => console.warn("Could not save the exchange rates:", err.message));
        return cache;
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
      }
    }
    lastFailureAt = Date.now();
    console.warn(`Exchange rates update failed (${errors.join("; ")}). Using the cached rates${cache ? ` from ${cache.fetchedAt.toISOString()}` : " - none available yet"}.`);
    return cache;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const isStale = () => !cache || Date.now() - new Date(cache.fetchedAt).getTime() > TTL_MS;

// The current rates. Waits for a fetch only when nothing is cached at all.
async function getRates() {
  await loadFromDb();
  if (!cache) {
    if (Date.now() - lastFailureAt > RETRY_AFTER_FAILURE_MS || !lastFailureAt) await refresh();
  } else if (isStale() && Date.now() - lastFailureAt > RETRY_AFTER_FAILURE_MS) {
    refresh(); // in the background; this request uses the cached rates
  }
  return cache;
}

// Rates of the supported currencies only, for the API
async function getPublicRates() {
  const data = await getRates();
  const rates = {};
  for (const code of SUPPORTED_CURRENCIES) {
    if (code === BASE_CURRENCY) rates[code] = 1;
    else if (data?.rates?.[code]) rates[code] = data.rates[code];
  }
  return {
    base: BASE_CURRENCY,
    rates,
    provider: data?.provider || null,
    providerUpdatedAt: data?.providerUpdatedAt || null,
    updatedAt: data?.fetchedAt || null, // last successful update
    stale: isStale(),
  };
}

// 1 BASE_CURRENCY in `code`, or null when there is no rate for it
async function rateFor(code) {
  if (!code || code === BASE_CURRENCY) return 1;
  const data = await getRates();
  return data?.rates?.[code] || null;
}

// Converts a base-currency amount, rounded to the currency's decimals
function convertAmount(amount, rate, code) {
  const decimals = currencyDecimals(code);
  const factor = 10 ** decimals;
  return Math.round(Number(amount) * rate * factor) / factor;
}

module.exports = { getRates, getPublicRates, rateFor, convertAmount, refresh };
