const mongoose = require("mongoose");

// The last exchange rates that were fetched successfully (one document per base
// currency). Used when the rates service is down and after a server restart.
const exchangeRateSchema = new mongoose.Schema({
  base: { type: String, required: true, unique: true },
  // { EUR: 0.91, EGP: 54.2, ... } - 1 unit of `base` in each currency
  rates: { type: Map, of: Number, required: true },
  provider: String,
  // When the provider says these rates were published
  providerUpdatedAt: Date,
  // When we last fetched them successfully
  fetchedAt: { type: Date, required: true },
}, { timestamps: true });

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);
