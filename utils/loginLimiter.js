// In-memory limit on failed logins per client IP (no extra dependency).
// After MAX_FAILURES failed attempts within WINDOW_MS, further logins from that
// IP get 429 until the window has passed. A successful login clears the count.
// Note: counts live in this process only; behind a proxy set app "trust proxy"
// so req.ip is the real client address.
const httpError = require("./httpError");

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, resetAt }

function keyFor(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function assertAllowed(req) {
  const entry = failures.get(keyFor(req));
  if (!entry) return;
  if (entry.resetAt <= Date.now()) {
    failures.delete(keyFor(req));
    return;
  }
  if (entry.count >= MAX_FAILURES) {
    const minutes = Math.ceil((entry.resetAt - Date.now()) / 60000);
    throw httpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}

function recordFailure(req) {
  const key = keyFor(req);
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

function clear(req) {
  failures.delete(keyFor(req));
}

// Drop expired entries now and then so the map can't grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
}, WINDOW_MS).unref();

module.exports = { assertAllowed, recordFailure, clear };
