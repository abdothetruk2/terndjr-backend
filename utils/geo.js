// Visitor country from the request: a country header set by the hosting proxy/CDN
// (Cloudflare, Vercel, CloudFront, App Engine) when present, otherwise an IP lookup
// (api.country.is, then ipapi.co). Results are cached per IP for a day.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const TIMEOUT_MS = 3000;
const cache = new Map(); // ip -> { country, at }

const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-appengine-country", "x-country-code"];

const PROVIDERS = [
  { name: "country.is", url: (ip) => `https://api.country.is/${encodeURIComponent(ip)}`, parse: async (res) => (await res.json())?.country },
  { name: "ipapi.co", url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/country/`, parse: async (res) => (await res.text()).trim() },
];

const validCountry = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : null;
};

// Loopback / private / link-local addresses can't be located
function isPublicIp(ip) {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return false;
  if (ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)) return false;
  return true;
}

async function lookupIp(ip) {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.country;
  for (const provider of PROVIDERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(provider.url(ip), { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const country = validCountry(await provider.parse(res));
      if (country) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(ip, { country, at: Date.now() });
        return country;
      }
    } catch {
      // try the next provider
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Outside production, ?ip=<address> tests a visitor from somewhere else
const allowIpOverride = () => process.env.NODE_ENV !== "production" && !process.env.RENDER;

async function detectCountry(req) {
  for (const header of COUNTRY_HEADERS) {
    const country = validCountry(req.headers[header]);
    if (country) return { country, source: "header" };
  }
  const override = allowIpOverride() && typeof req.query.ip === "string" ? req.query.ip.trim().slice(0, 64) : "";
  const ip = override || req.ip;
  if (!isPublicIp(ip)) return { country: null, source: "local" };
  const country = await lookupIp(ip);
  return { country, source: country ? "ip-lookup" : "unknown" };
}

module.exports = { detectCountry };
