const express = require("express");
const {
  quoteOrder,
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
  updatePaymentStatus,
} = require("../controllers/orderController");
const { protect, admin } = require("../middleware/auth");
const rateLimit = require("../utils/rateLimit");

const router = express.Router();

const placeOrderLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: "Too many orders from this connection. Please try again later." });
const quoteLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 300 });

router.use(protect); // every order route requires login

router.post("/quote", quoteLimit, quoteOrder);
router.post("/", placeOrderLimit, createOrder);
router.get("/my-orders", getMyOrders); // must stay before "/:id"
router.get("/", admin, getAllOrders);
router.get("/:id", getOrderById);
router.patch("/:id/cancel", cancelOrder);
router.patch("/:id/status", admin, updateOrderStatus);
router.patch("/:id/payment", admin, updatePaymentStatus);

module.exports = router;
