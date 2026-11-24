const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({

  // Customer
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  // Generated automatically (see pre("validate") hook below)
  orderNumber: {
    type: String,
    unique: true
  },

  // Products snapshot
  items: [
    {
      // The product's _id as stored: imported catalog products have numeric
      // _ids, products created in the admin have ObjectIds
      product: {
        type: mongoose.Schema.Types.Mixed,
        ref: "Product",
        required: true
      },

      // Public numeric id and slug at order time (for links from the order pages)
      productId: Number,
      slug: String,

      // Whether this line reserved stock (so cancelling gives exactly that back)
      tracked: { type: Boolean, default: false },

      name: {
        type: mongoose.Schema.Types.Mixed,
        required: true
      },

      sku: String,

      image: String,

      price: {
        type: Number,
        required: true
      },

      quantity: {
        type: Number,
        required: true,
        min: 1
      },

      subtotal: {
        type: Number,
        required: true
      }
    }
  ],

  // Shipping
  shippingAddress: {
    fullName: String,
    phone: String,
    country: String,
    city: String,
    address: String,
    postalCode: String
  },

  // Financial
  subtotal: {
    type: Number,
    required: true
  },

  shippingFee: {
    type: Number,
    default: 0
  },

  discount: {
    type: Number,
    default: 0
  },

  // Coupon applied to this order (a snapshot: the coupon itself may change later)
  coupon: {
    code: String,
    type: { type: String },
    value: Number
  },

  totalPrice: {
    type: Number,
    required: true
  },

  // Payment
  paymentMethod: {
    type: String,
    enum: ["cash", "card"],
    default: "cash"
  },

  paymentStatus: {
    type: String,
    enum: ["pending", "paid", "failed", "refunded"],
    default: "pending"
  },

  // Order status
  status: {
    type: String,
    enum: [
      "pending",
      "confirmed",
      "processing",
      "shipped",
      "delivered",
      "cancelled"
    ],
    default: "pending"
  },

  notes: String,

  cancelledAt: Date

}, {
  timestamps: true
});

orderSchema.pre("validate", function () {
  if (!this.orderNumber) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.orderNumber = `ORD-${date}-${rand}`;
  }
});

module.exports = mongoose.model("Order", orderSchema);
