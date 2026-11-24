const mongoose = require("mongoose");

const localizedText = {
  de: String,
  en: String,
  ar: String,
};

const productSchema = new mongoose.Schema(
  {
    // Public numeric id used by the frontend (/api/products/:id)
    id: { type: Number, required: true, unique: true, index: true },

    slug: { type: String, required: true, unique: true, trim: true },

    sku: { type: String, unique: true, sparse: true, trim: true },

    brand: String,

    name: localizedText,

    description: localizedText,

    // Stored as strings to match the imported data (e.g. "4.99")
    price: { type: String, required: true },

    old_price: { type: String, default: null },

    discount: Number,

    rating: String,

    reviews_count: { type: Number, default: 0 },

    stock: { type: Number, default: 0, min: 0 },

    // true: orders are limited by `stock` and reduce it; false: sold without a
    // stock limit. Unset: tracked only when stock > 0 (see utils/inventory.js).
    track_inventory: { type: Boolean },

    // Units sold in orders that were not cancelled (kept up to date by the order code)
    sold_count: { type: Number, default: 0, min: 0 },

    image: String,

    // Extra gallery photos shown after `image` on the product page (same path
    // formats as `image`). Left unset on products that have only one photo.
    images: { type: [String], default: undefined },

    // Category slug set from the admin dashboard. Imported products are linked
    // through "category-request:<slug>" entries in `tags` instead; the product
    // list filter matches either.
    category: { type: String, index: true },

    // Imported data uses two shapes: an array of strings (with the
    // "category-request:<slug>" entries) or an object with import details
    // ({ source_type, import_batch, stock_status, ... }). Mixed keeps both
    // (a fixed object type silently dropped the arrays on save).
    tags: { type: mongoose.Schema.Types.Mixed },

    featured: { type: Boolean, default: false },

    flash_sale: { type: Boolean, default: false },

    reward_points: { type: Number, default: 0 },

    is_active: { type: Boolean, default: true },
  },
  {
    // Keep the snake_case field names used by the imported data
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

module.exports = mongoose.model("Product", productSchema);
