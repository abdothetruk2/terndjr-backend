require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");

const authRoutes = require("./router/user");
const productRoutes = require("./router/product");
const orderRoutes = require("./router/order");
const categoryRoutes = require("./router/category");
const couponRoutes = require("./router/coupon");
const adminRoutes = require("./router/admin");
const { UPLOAD_DIR } = require("./controllers/uploadController");
const cors = require("cors");
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/trendjr";

// Frontend origins allowed to call the API (comma-separated CORS_ORIGIN in .env)
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set in .env");
  process.exit(1);
}

const app = express();

app.use(cors({
  origin: CORS_ORIGINS,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  credentials: true,
  exposedHeaders: ["X-Total-Count"], // lets the frontend read the total of a paginated list
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/admin", adminRoutes);

// Images uploaded from the admin dashboard (POST /api/admin/uploads)
app.use("/uploads", express.static(UPLOAD_DIR, {
  index: false,
  maxAge: "30d",
  immutable: true, // file names are random and never reused
  setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff"),
}));

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
});

// Central error handler (Express 5 forwards async errors here)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || "Server error";

  if (err.name === "ValidationError") status = 400;
  if (err.name === "CastError") {
    status = 400;
    message = `Invalid ${err.path}`;
  }
  if (err.code === 11000) {
    status = 409;
    message = `Duplicate value for: ${Object.keys(err.keyValue || {}).join(", ")}`;
  }
  if (err.type === "entity.too.large") message = "The upload is too large (max 5 MB)";
  if (err.type === "entity.parse.failed") message = "The request body is not valid JSON";

  if (status >= 500) {
    console.error(err);
    message = "Server error"; // never send internal details to the client
  }
  res.status(status).json({ message });
});

async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }
}

start();
