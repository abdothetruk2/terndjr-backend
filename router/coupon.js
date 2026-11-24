const express = require("express");
const {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
} = require("../controllers/couponController");
const { protect, admin } = require("../middleware/auth");
const rateLimit = require("../utils/rateLimit");

const router = express.Router();

// Any signed-in customer can check a code before placing an order
// (limited, so codes can't be guessed by trying thousands of them)
router.post("/validate", protect, rateLimit({ windowMs: 10 * 60 * 1000, max: 40, message: "Too many coupon attempts. Please wait a few minutes." }), validateCoupon);

// Everything else is admin-only
router.use(protect, admin);
router.get("/", listCoupons);
router.post("/", createCoupon);
router.get("/:id", getCoupon);
router.put("/:id", updateCoupon);
router.patch("/:id", updateCoupon);
router.delete("/:id", deleteCoupon);

module.exports = router;
