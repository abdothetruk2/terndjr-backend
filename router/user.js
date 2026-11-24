const express = require("express");
const { register, login, logout, me, updateMe, resetPassword } = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", protect, logout);
router.get("/me", protect, me);
router.patch("/me", protect, updateMe);
router.post("/resetPassword", protect, resetPassword);

module.exports = router;
