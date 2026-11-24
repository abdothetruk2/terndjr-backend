// In-memory limits on failed logins (no extra dependency).
// - 10 failures for one username from one client IP within 15 minutes, or
// - 30 failures from one client IP for any usernames (password spraying),
// block further attempts from that IP for that window (429). A successful
// login clears that username's count.
// Keying by IP + username means one attacker can't lock everybody out, even if
// the IP detection behind a proxy is ever wrong (see "trust proxy" in server.js).
// Counts live in this process only.
const httpError = require("./httpError");

const MAX_PER_ACCOUNT = 10;
const MAX_PER_IP = 30;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> { count, resetAt }

const ipOf = (req) => req.ip || req.socket?.remoteAddress || "unknown";
const accountKey = (req, username) => `${ipOf(req)}|${String(username || "").toLowerCase()}`;
const ipKey = (req) => `${ipOf(req)}|*`;

function blocked(key, max) {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    failures.delete(key);
    return 0;
  }
  return entry.count >= max ? entry.resetAt : 0;
}

function assertAllowed(req, username) {
  const until = blocked(accountKey(req, username), MAX_PER_ACCOUNT) || blocked(ipKey(req), MAX_PER_IP);
  if (until) {
    const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    throw httpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}

function bump(key) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

function recordFailure(req, username) {
  bump(accountKey(req, username));
  bump(ipKey(req));
}

function clear(req, username) {
  failures.delete(accountKey(req, username));
}

// Drop expired entries now and then so the map can't grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
}, WINDOW_MS).unref();

module.exports = { assertAllowed, recordFailure, clear };
