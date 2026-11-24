const Coupon = require("../modules/coupon");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");

const CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;
const STATUSES = ["active", "inactive", "scheduled", "expired", "used-up"];

async function findCouponOr404(id) {
  v.objectId(id, "coupon id");
  const coupon = await Coupon.findById(id);
  if (!coupon) throw httpError(404, "Coupon not found");
  return coupon;
}

// Validates a create/update body. `current` is the stored coupon (updates only).
function cleanCouponInput(body, { partial, current = null }) {
  if (body === undefined || body === null) body = {};
  if (!v.isPlainObject(body)) throw httpError(400, "Request body must be a JSON object");
  const out = {};

  if (body.code !== undefined || !partial) {
    const code = v.text(body.code, "code", { required: true, max: 32 }).toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      throw httpError(400, "code must be 3-32 characters: letters, numbers, - or _");
    }
    out.code = code;
  }
  if (body.description !== undefined) {
    out.description = v.text(body.description, "description", { max: 300, allowEmpty: true }) ?? "";
  }

  const type = v.oneOf(body.type, "type", ["percent", "fixed"], { required: !partial });
  if (type) out.type = type;
  const finalType = type || current?.type;

  const value = v.number(body.value, "value", { required: !partial, min: 0.01, max: 1000000 });
  if (value !== undefined) out.value = Math.round(value * 100) / 100;
  const finalValue = out.value ?? current?.value;
  if (finalType === "percent" && finalValue > 100) throw httpError(400, "A percent discount can be at most 100");

  const minOrderAmount = v.number(body.minOrderAmount, "minOrderAmount", { min: 0, max: 1000000 });
  if (minOrderAmount !== undefined) out.minOrderAmount = minOrderAmount;
  else if (body.minOrderAmount === null || body.minOrderAmount === "") out.minOrderAmount = 0;

  if (body.maxDiscount !== undefined) {
    out.maxDiscount = v.number(body.maxDiscount, "maxDiscount", { min: 0.01, max: 1000000 }) ?? null;
  }

  for (const field of ["startsAt", "expiresAt"]) {
    const value = v.date(body[field], field);
    if (value !== undefined) out[field] = value;
  }
  const startsAt = out.startsAt !== undefined ? out.startsAt : current?.startsAt;
  const expiresAt = out.expiresAt !== undefined ? out.expiresAt : current?.expiresAt;
  if (startsAt && expiresAt && expiresAt <= startsAt) {
    throw httpError(400, "expiresAt must be after startsAt");
  }

  if (body.usageLimit !== undefined) {
    out.usageLimit = v.number(body.usageLimit, "usageLimit", { min: 1, max: 10000000, integer: true }) ?? null;
  }

  const isActive = v.boolean(body.isActive, "isActive");
  if (isActive !== undefined) out.isActive = isActive;

  return out;
}

// Database filter for a computed status (see Coupon#statusAt)
function statusFilter(status, now = new Date()) {
  const notExpired = { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  const started = { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] };
  const usesLeft = { $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] };
  switch (status) {
    case "inactive":
      return { isActive: false };
    case "expired":
      return { isActive: true, expiresAt: { $ne: null, $lte: now } };
    case "scheduled":
      return { isActive: true, startsAt: { $gt: now }, $and: [notExpired] };
    case "used-up":
      return {
        isActive: true,
        usageLimit: { $ne: null },
        $expr: { $gte: ["$usedCount", "$usageLimit"] },
        $and: [notExpired, started],
      };
    case "active":
      return { isActive: true, $and: [notExpired, started, usesLeft] };
    default:
      return {};
  }
}

// GET /api/coupons?search=&status=&page=&limit=   (admin) — total in X-Total-Count
async function listCoupons(req, res) {
  const status = v.oneOf(req.query.status, "status", STATUSES);
  const { limit, skip } = v.pagination(req.query);

  const filter = { ...statusFilter(status) };
  const term = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (term) {
    const rx = new RegExp(v.escapeRegex(term), "i");
    filter.$and = [...(filter.$and || []), { $or: [{ code: rx }, { description: rx }] }];
  }

  const [total, coupons] = await Promise.all([
    Coupon.countDocuments(filter),
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
  ]);
  res.set("X-Total-Count", String(total));
  res.json(coupons);
}

// GET /api/coupons/:id   (admin)
async function getCoupon(req, res) {
  res.json(await findCouponOr404(req.params.id));
}

// POST /api/coupons   (admin)
async function createCoupon(req, res) {
  const data = cleanCouponInput(req.body, { partial: false });
  if (data.type === "fixed") data.maxDiscount = null;
  if (await Coupon.exists({ code: data.code })) throw httpError(409, "A coupon with this code already exists");
  const coupon = await Coupon.create(data);
  res.status(201).json(coupon);
}

// PUT/PATCH /api/coupons/:id   (admin) — partial update
async function updateCoupon(req, res) {
  const coupon = await findCouponOr404(req.params.id);
  const data = cleanCouponInput(req.body, { partial: true, current: coupon });
  if (Object.keys(data).length === 0) throw httpError(400, "No valid fields to update");
  if (data.code && data.code !== coupon.code && (await Coupon.exists({ code: data.code }))) {
    throw httpError(409, "A coupon with this code already exists");
  }
  if ((data.type || coupon.type) === "fixed") data.maxDiscount = null;

  coupon.set(data);
  await coupon.save();
  res.json(coupon);
}

// DELETE /api/coupons/:id   (admin)
// Orders keep a copy of the coupon they used, so deleting doesn't change them.
async function deleteCoupon(req, res) {
  const coupon = await findCouponOr404(req.params.id);
  await coupon.deleteOne();
  res.json({ message: "Coupon deleted", id: String(coupon._id) });
}

// POST /api/coupons/validate   (any signed-in user)
// Body: { code, subtotal } -> { code, type, value, discount, description }
async function validateCoupon(req, res) {
  const { code, subtotal } = req.body ?? {};
  const cleanCode = v.text(code, "code", { required: true, max: 32 }).toUpperCase();
  const amount = v.number(subtotal, "subtotal", { required: true, min: 0, max: 10000000 });

  const coupon = await Coupon.findOne({ code: cleanCode });
  if (!coupon) throw httpError(404, "This coupon code is not valid");
  const result = coupon.evaluate(amount);
  if (!result.ok) throw httpError(400, result.reason);

  res.json({
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    description: coupon.description,
    discount: result.discount,
  });
}

module.exports = { listCoupons, getCoupon, createCoupon, updateCoupon, deleteCoupon, validateCoupon };
