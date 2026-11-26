const express = require("express");
const {
  getCurrencyConfig, getCurrencies, getExchangeRates, detectCurrency, convert,
} = require("../controllers/currencyController");
const rateLimit = require("../utils/rateLimit");

const router = express.Router();

router.get("/", getCurrencyConfig);
router.get("/currencies", getCurrencies);
router.get("/rates", getExchangeRates);
router.get("/convert", convert);
// Country lookups call an outside service: limit them per visitor
router.get("/detect", rateLimit({ windowMs: 60 * 1000, max: 30 }), detectCurrency);

module.exports = router;
