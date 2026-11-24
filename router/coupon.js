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

const router = express.Router();

// Any signed-in customer can check a code before placing an order
router.post("/validate", protect, validateCoupon);

// Everything else is admin-only
router.use(protect, admin);
router.get("/", listCoupons);
router.post("/", createCoupon);
router.get("/:id", getCoupon);
router.put("/:id", updateCoupon);
router.patch("/:id", updateCoupon);
router.delete("/:id", deleteCoupon);

module.exports = router;
