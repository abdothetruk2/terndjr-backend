const mongoose = require("mongoose");
const Order = require("../modules/order");
const Product = require("../modules/product");
const User = require("../modules/user");
const Coupon = require("../modules/coupon");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");

const ORDER_STATUSES = Order.schema.path("status").enumValues;
const PAYMENT_STATUSES = Order.schema.path("paymentStatus").enumValues;
const CANCELLABLE = ["pending", "confirmed"];
const MAX_ITEMS = 100;
const MAX_QUANTITY = 1000;

const round2 = (n) => Math.round(n * 100) / 100;

// Reserves one use of a coupon for this order, or throws 400 with the reason.
// The usage counter is increased atomically, so a limited coupon can't be
// over-used by orders placed at the same moment.
async function reserveCoupon(rawCode, subtotal) {
  if (typeof rawCode !== "string") throw httpError(400, "couponCode must be text");
  const code = rawCode.trim().toUpperCase();
  const coupon = await Coupon.findOne({ code });
  if (!coupon) throw httpError(400, "This coupon code is not valid");

  const result = coupon.evaluate(subtotal);
  if (!result.ok) throw httpError(400, result.reason);

  const reserved = await Coupon.findOneAndUpdate(
    {
      _id: coupon._id,
      isActive: true,
      $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
    },
    { $inc: { usedCount: 1 } },
    { returnDocument: "after" }
  );
  if (!reserved) throw httpError(400, "This coupon has reached its usage limit");

  return { coupon: reserved, discount: result.discount };
}

async function findOrderOr404(id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(400, "Invalid order id");
  const order = await Order.findById(id);
  if (!order) throw httpError(404, "Order not found");
  return order;
}

function assertOwnerOrAdmin(order, user) {
  if (user.role !== "admin" && !order.user.equals(user._id)) {
    throw httpError(403, "Not allowed to access this order");
  }
}

// POST /api/orders
// Body: { items: [{ product: <numeric id or _id>, quantity }], shippingAddress, paymentMethod, notes, couponCode? }
// Prices and the coupon discount are always calculated here, never taken from the client.
async function createOrder(req, res) {
  const { items, shippingAddress, paymentMethod, notes, couponCode } = req.body ?? {};

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, "Order must contain at least one item");
  }
  if (items.length > MAX_ITEMS) throw httpError(400, `An order can contain at most ${MAX_ITEMS} items`);

  const orderItems = [];
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw httpError(400, "Each item needs a positive integer quantity");
    }
    if (quantity > MAX_QUANTITY) throw httpError(400, `Quantity can be at most ${MAX_QUANTITY} per item`);

    const ref = item?.product;
    const isObjectId = typeof ref === "string" && /^[a-f\d]{24}$/i.test(ref);
    if (!isObjectId && !Number.isInteger(Number(ref))) {
      throw httpError(400, `Invalid product reference: ${ref}`);
    }
    const query = isObjectId ? { _id: ref } : { id: Number(ref) };
    const product = await Product.findOne(query);

    if (!product || product.is_active === false) {
      throw httpError(400, `Product ${ref} is not available`);
    }

    const price = Number(product.price);
    if (!Number.isFinite(price)) throw httpError(500, `Product ${product.id} has an invalid price`);

    orderItems.push({
      product: product._id,
      name: product.name,
      sku: product.sku,
      image: product.image,
      price,
      quantity,
      subtotal: round2(price * quantity),
    });
  }

  const subtotal = round2(orderItems.reduce((sum, i) => sum + i.subtotal, 0));
  const shippingFee = 0;

  let discount = 0;
  let coupon = null;
  if (couponCode !== undefined && couponCode !== null && couponCode !== "") {
    ({ coupon, discount } = await reserveCoupon(couponCode, subtotal));
  }

  let order;
  try {
    order = await Order.create({
      user: req.user._id,
      items: orderItems,
      shippingAddress,
      paymentMethod,
      notes,
      subtotal,
      shippingFee,
      discount,
      coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value } : undefined,
      totalPrice: Math.max(0, round2(subtotal + shippingFee - discount)),
    });
  } catch (err) {
    // The order wasn't saved: give the reserved coupon use back
    if (coupon) await Coupon.updateOne({ _id: coupon._id, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
    throw err;
  }

  res.status(201).json(order);
}

// GET /api/orders/my-orders
async function getMyOrders(req, res) {
  const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json(orders);
}

// GET /api/orders/:id
async function getOrderById(req, res) {
  const order = await findOrderOr404(req.params.id);
  assertOwnerOrAdmin(order, req.user);
  res.json(order);
}

// PATCH /api/orders/:id/cancel
async function cancelOrder(req, res) {
  const order = await findOrderOr404(req.params.id);
  assertOwnerOrAdmin(order, req.user);

  if (!CANCELLABLE.includes(order.status)) {
    throw httpError(400, `Order cannot be cancelled when status is "${order.status}"`);
  }

  order.status = "cancelled";
  order.cancelledAt = new Date();
  await order.save();
  res.json(order);
}

// GET /api/orders   (admin)
// Optional: ?status= &paymentStatus= &search= (order number, customer, name, phone)
//           &from= &to= (YYYY-MM-DD, inclusive) &page= &limit=
// Pagination is opt-in like the product list; with it, the total is in X-Total-Count.
async function getAllOrders(req, res) {
  const { search, page, limit } = req.query;
  const filter = {};

  const status = v.oneOf(req.query.status, "status", ORDER_STATUSES);
  if (status) filter.status = status;
  const paymentStatus = v.oneOf(req.query.paymentStatus, "paymentStatus", PAYMENT_STATUSES);
  if (paymentStatus) filter.paymentStatus = paymentStatus;

  const from = v.date(req.query.from, "from");
  const to = v.date(req.query.to, "to");
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) {
      // A plain date means "until the end of that day"
      const end = new Date(to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) end.setUTCDate(end.getUTCDate() + 1);
      filter.createdAt.$lt = end;
    }
  }

  const term = typeof search === "string" ? search.trim() : "";
  if (term) {
    const rx = new RegExp(v.escapeRegex(term), "i");
    const users = await User.find({ $or: [{ username: rx }, { email: rx }] }).select("_id").limit(500).lean();
    filter.$or = [
      { orderNumber: rx },
      { "shippingAddress.fullName": rx },
      { "shippingAddress.phone": rx },
      { user: { $in: users.map((u) => u._id) } },
    ];
  }

  const query = Order.find(filter).populate("user", "username email").sort({ createdAt: -1 });

  if (page !== undefined || limit !== undefined) {
    const { limit: limitNum, skip } = v.pagination(req.query);
    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      query.skip(skip).limit(limitNum),
    ]);
    res.set("X-Total-Count", String(total));
    return res.json(orders);
  }

  res.json(await query);
}

// PATCH /api/orders/:id/status   (admin)
async function updateOrderStatus(req, res) {
  const { status } = req.body ?? {};
  if (!ORDER_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${ORDER_STATUSES.join(", ")}`);
  }

  const order = await findOrderOr404(req.params.id);
  order.status = status;
  if (status === "cancelled" && !order.cancelledAt) order.cancelledAt = new Date();
  await order.save();
  res.json(order);
}

// PATCH /api/orders/:id/payment   (admin)
async function updatePaymentStatus(req, res) {
  const { paymentStatus } = req.body ?? {};
  if (!PAYMENT_STATUSES.includes(paymentStatus)) {
    throw httpError(400, `paymentStatus must be one of: ${PAYMENT_STATUSES.join(", ")}`);
  }

  const order = await findOrderOr404(req.params.id);
  order.paymentStatus = paymentStatus;
  await order.save();
  res.json(order);
}

module.exports = {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
  updatePaymentStatus,
};
