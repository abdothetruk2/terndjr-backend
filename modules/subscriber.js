const mongoose = require("mongoose");

// Newsletter sign-ups from the store footer
const subscriberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },

    // Where the sign-up came from (e.g. "footer")
    source: {
      type: String,
      default: "footer",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Subscriber", subscriberSchema);
