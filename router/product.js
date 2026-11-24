const express = require("express");
const {
  getAllProducts,
  getFlashProducts,
  getOneProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");
const { protect, admin } = require("../middleware/auth");

const router = express.Router();

// Public
router.get("/", getAllProducts);
router.get("/flash", getFlashProducts); // must stay before "/:id"
router.get("/:id", getOneProduct);

// Admin
router.post("/", protect, admin, createProduct);
router.put("/:id", protect, admin, updateProduct);
router.patch("/:id", protect, admin, updateProduct);
router.delete("/:id", protect, admin, deleteProduct);

module.exports = router;
