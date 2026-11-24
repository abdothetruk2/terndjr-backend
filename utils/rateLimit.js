// Small in-memory rate limiter (no extra dependency).
// rateLimit({ windowMs, max }) -> Express middleware that allows `max` requests per
// client IP within `windowMs`, then answers 429 until the window has passed.
// Counts live in this process only (they reset when the server restarts).
// Behind a proxy (Render), server.js sets "trust proxy" so req.ip is the client.
const httpError = require("./httpError");

function rateLimit({ windowMs, max, message = "Too many requests. Please wait a moment and try again." }) {
  const hits = new Map(); // ip -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return function limiter(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(httpError(429, message));
    }
    next();
  };
}

module.exports = rateLimit;
