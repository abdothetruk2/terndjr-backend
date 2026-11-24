const jwt = require("jsonwebtoken");
const User = require("../modules/user");
const httpError = require("../utils/httpError");

// Requires a valid "Authorization: Bearer <token>" header.
// Attaches the authenticated user document (without password) to req.user.
async function protect(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw httpError(401, "Not authorized, no token");
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw httpError(401, "Not authorized, invalid or expired token");
  }

  const user = await User.findById(decoded.id).select("-password");
  if (!user) throw httpError(401, "Not authorized, user no longer exists");
  if (user.isBlocked) throw httpError(403, "This account has been blocked");

  req.user = user;
  next();
}

// Must be used after `protect`. The role is read from the database on every
// request (see `protect`), never from the token or the client.
function admin(req, res, next) {
  if (req.user?.role !== "admin") {
    throw httpError(403, "Admin access only");
  }
  next();
}

module.exports = { protect, admin };
