const express = require("express");
const { protect, admin } = require("../middleware/auth");
const { getStats } = require("../controllers/adminController");
const { getAdminProducts, getAdminProduct } = require("../controllers/productController");
const { getAdminCategories } = require("../controllers/categoryController");
const { listCustomers, getCustomer, updateCustomer } = require("../controllers/customerController");
const { uploadImage, IMAGE_TYPES, MAX_BYTES } = require("../controllers/uploadController");

const router = express.Router();

// Every route below needs a valid token AND role "admin" (checked on the server,
// from the database, on every request).
router.use(protect, admin);

router.get("/stats", getStats);

router.get("/products", getAdminProducts);
router.get("/products/:id", getAdminProduct);

router.get("/categories", getAdminCategories);

router.get("/customers", listCustomers);
router.get("/customers/:id", getCustomer);
router.patch("/customers/:id", updateCustomer);

// Raw image body (no multipart), parsed only after the admin check above
router.post(
  "/uploads",
  express.raw({ type: Object.keys(IMAGE_TYPES), limit: MAX_BYTES }),
  uploadImage
);

module.exports = router;
