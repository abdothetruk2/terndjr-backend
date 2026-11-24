const express = require("express");
const {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
  updatePaymentStatus,
} = require("../controllers/orderController");
const { protect, admin } = require("../middleware/auth");

const router = express.Router();

router.use(protect); // every order route requires login

router.post("/", createOrder);
router.get("/my-orders", getMyOrders); // must stay before "/:id"
router.get("/", admin, getAllOrders);
router.get("/:id", getOrderById);
router.patch("/:id/cancel", cancelOrder);
router.patch("/:id/status", admin, updateOrderStatus);
router.patch("/:id/payment", admin, updatePaymentStatus);

module.exports = router;
