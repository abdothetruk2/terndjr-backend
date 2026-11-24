const express = require("express");
const { register, login, logout, me, updateMe, resetPassword } = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const rateLimit = require("../utils/rateLimit");

const router = express.Router();

// New accounts per client IP (failed logins have their own limiter in the controller)
router.post("/register", rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: "Too many new accounts from this connection. Please try again later." }), register);
router.post("/login", login);
router.post("/logout", protect, logout);
router.get("/me", protect, me);
router.patch("/me", protect, updateMe);
router.post("/resetPassword", protect, resetPassword);

module.exports = router;
