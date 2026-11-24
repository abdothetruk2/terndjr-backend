const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const User = require("../modules/user");
const httpError = require("../utils/httpError");
const loginLimiter = require("../utils/loginLimiter");

const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores everything after 72 bytes
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

// Credentials must be plain strings. An object such as { "$ne": null } would
// otherwise reach the database query as an operator (NoSQL injection).
function assertStrings(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw httpError(400, `${name} must be text`);
    }
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1h" }
  );
}

// Strip sensitive fields before sending a user to the client
function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role,
    addresses: user.addresses,
  };
}

// POST /api/auth/register
async function register(req, res) {
  const { username, email, password, phone } = req.body ?? {};
  assertStrings({ username, email, password, phone });

  if (!username || !email || !password) {
    throw httpError(400, "username, email and password are required");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  // Clear 409 messages (the unique indexes are the final safety net)
  if (await User.exists({ username })) throw httpError(409, "Username is already taken");
  if (await User.exists({ email: String(email).toLowerCase().trim() })) {
    throw httpError(409, "An account with this email already exists");
  }

  // Only whitelisted fields are accepted, so a client can't register as admin
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({
    username,
    email,
    phone,
    password: hashedPassword,
    isActive: true,
  });

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}

// POST /api/auth/login
async function login(req, res) {
  const { username, password } = req.body ?? {};
  assertStrings({ username, password });

  if (!username || !password) {
    throw httpError(400, "username and password are required");
  }

  loginLimiter.assertAllowed(req);

  const user = await User.findOne({ username }).select("+password");

  // Same message for both cases so attackers can't discover valid usernames
  if (!user || !(await bcrypt.compare(password, user.password))) {
    loginLimiter.recordFailure(req);
    throw httpError(401, "Invalid username or password");
  }
  loginLimiter.clear(req);

  if (user.isBlocked) throw httpError(403, "This account has been blocked");

  user.isActive = true;
  await user.save();

  res.json({ token: signToken(user), user: publicUser(user) });
}

// POST /api/auth/logout   (protected)
async function logout(req, res) {
  await User.updateOne({ _id: req.user._id }, { $set: { isActive: false } });
  res.json({ message: "Logged out" });
}

// GET /api/auth/me   (protected)
async function me(req, res) {
  res.json({ user: publicUser(req.user) });
}

// PATCH /api/auth/me   (protected)
// Updates the logged-in user's own contact details: { email?, phone? }
async function updateMe(req, res) {
  const { email, phone } = req.body ?? {};
  assertStrings({ email, phone });

  const updates = {};
  if (email !== undefined) {
    const clean = String(email ?? "").toLowerCase().trim();
    if (!EMAIL_PATTERN.test(clean) || clean.length > 254) throw httpError(400, "Please enter a valid email address");
    if (await User.exists({ email: clean, _id: { $ne: req.user._id } })) {
      throw httpError(409, "An account with this email already exists");
    }
    updates.email = clean;
  }
  if (phone !== undefined) {
    const clean = String(phone ?? "").trim();
    if (clean.length > 30) throw httpError(400, "Phone must be at most 30 characters");
    if (clean && !/^[+\d][\d\s()./-]{3,29}$/.test(clean)) throw httpError(400, "Please enter a valid phone number");
    updates.phone = clean || null;
  }
  if (Object.keys(updates).length === 0) throw httpError(400, "No valid fields to update");

  const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { returnDocument: "after", runValidators: true });
  res.json({ user: publicUser(user) });
}

// POST /api/auth/resetPassword   (protected)
// Changes the logged-in user's password; requires the current password.
async function resetPassword(req, res) {
  const { currentPassword, newPassword } = req.body ?? {};
  assertStrings({ currentPassword, newPassword });

  if (!currentPassword || !newPassword) {
    throw httpError(400, "currentPassword and newPassword are required");
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  const user = await User.findById(req.user._id).select("+password");
  // 400, not 401: the session itself is valid, only the typed password is wrong
  // (a 401 makes the frontend sign the user out).
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    throw httpError(400, "Current password is incorrect");
  }

  user.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await user.save();

  res.json({ message: "Password updated" });
}

module.exports = { register, login, logout, me, updateMe, resetPassword };
