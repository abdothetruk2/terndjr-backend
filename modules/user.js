const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true, // unique: see the index below
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },

    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false, // never returned unless explicitly requested
    },

    phone: {
      type: String,
      default: null,
    },

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    // Saved delivery address(es); the first one pre-fills checkout
    addresses: [
      {
        fullName: String,
        phone: String,
        street: String,
        city: String,
        country: String,
        postalCode: String,
      },
    ],

    isActive: {
      type: Boolean,
      default: false,
    },

    // Set by an admin. A blocked user can't log in and every protected
    // request with their token is refused.
    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Login is by username, so it must be unique. Two old accounts have no username
// (null), which made a plain unique index impossible to build -> duplicates were
// allowed. This index only covers real (string) usernames.
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: "string" } } }
);

module.exports = mongoose.model("User", userSchema);
