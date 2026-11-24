const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    // What the customer types at checkout, stored upper-case (e.g. "WELCOME10")
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    // percent: `value`% off the subtotal · fixed: `value` off the subtotal
    type: {
      type: String,
      enum: ["percent", "fixed"],
      required: true,
    },

    value: {
      type: Number,
      required: true,
      min: 0,
    },

    // Subtotal needed before the coupon can be used (0 = no minimum)
    minOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Upper limit for a percent discount (null = no limit)
    maxDiscount: {
      type: Number,
      default: null,
    },

    startsAt: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      default: null,
    },

    // Total number of orders that may use the coupon (null = unlimited)
    usageLimit: {
      type: Number,
      default: null,
    },

    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const round2 = (n) => Math.round(n * 100) / 100;

// "active" | "inactive" | "scheduled" | "expired" | "used-up"
couponSchema.methods.statusAt = function statusAt(now = new Date()) {
  if (!this.isActive) return "inactive";
  if (this.expiresAt && this.expiresAt <= now) return "expired";
  if (this.startsAt && this.startsAt > now) return "scheduled";
  if (this.usageLimit != null && this.usedCount >= this.usageLimit) return "used-up";
  return "active";
};

// Checks the coupon against an order subtotal.
// Returns { ok: true, discount } or { ok: false, reason }.
couponSchema.methods.evaluate = function evaluate(subtotal, now = new Date()) {
  const status = this.statusAt(now);
  const reasons = {
    inactive: "This coupon is not active",
    expired: "This coupon has expired",
    scheduled: "This coupon is not valid yet",
    "used-up": "This coupon has reached its usage limit",
  };
  if (status !== "active") return { ok: false, reason: reasons[status] };

  if (subtotal < (this.minOrderAmount || 0)) {
    return { ok: false, reason: `This coupon needs an order of at least ${this.minOrderAmount.toFixed(2)}` };
  }

  let discount = this.type === "percent" ? (subtotal * this.value) / 100 : this.value;
  if (this.type === "percent" && this.maxDiscount != null) discount = Math.min(discount, this.maxDiscount);
  discount = round2(Math.min(discount, subtotal));
  return { ok: true, discount };
};

couponSchema.set("toJSON", {
  virtuals: false,
  transform(doc, ret) {
    ret.status = doc.statusAt();
    return ret;
  },
});

module.exports = mongoose.model("Coupon", couponSchema);
