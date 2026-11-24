const express = require("express");
const { subscribe } = require("../controllers/newsletterController");
const rateLimit = require("../utils/rateLimit");

const router = express.Router();

router.post("/", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), subscribe);

module.exports = router;
