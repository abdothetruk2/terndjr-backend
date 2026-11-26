const mongoose = require("mongoose");
const Order = require("../modules/order");
const Product = require("../modules/product");
const User = require("../modules/user");
const Coupon = require("../modules/coupon");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");
const { isTracked } = require("../utils/inventory");

const ORDER_STATUSES = Order.schema.path("status").enumValues;
const PAYMENT_STATUSES = Order.schema.path("paymentStatus").enumValues;
const CANCELLABLE = ["pending", "confirmed"];
const MAX_ITEMS = 100;
const MAX_QUANTITY = 1000;
const SHIPPING_FEE = 0; // the store promises free shipping on every order
const PHONE_PATTERN = /^[+\d][\d\s()./-]{3,29}$/;

const round2 = (n) => Math.round(n * 100) / 100;
const { localizedText } = require("../utils/lang");
const { BASE_CURRENCY, isSupportedCurrency } = require("../config/currency");
const { rateFor, convertAmount, getPublicRates } = require("../utils/exchangeRates");

// The quote in the customer's display currency, computed here from the server's own
// exchange rate (never from amounts sent by the browser). Each unit price is converted
// and rounded first, so line totals and the order total add up exactly.
// Returns null for the base currency or when no rate is available (base amounts apply).
async function displayAmounts(quote, currency) {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!code || code === BASE_CURRENCY || !isSupportedCurrency(code)) return null;
  const rate = await rateFor(code);
  if (!rate) return null;
  const conv = (amount) => convertAmount(amount, rate, code);
  const items = quote.lines.map((line) => {
    const price = conv(line.price);
    return { product: line.product?.id ?? line.ref, price, subtotal: line.available ? Math.round(price * line.quantity * 1e6) / 1e6 : 0 };
  });
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 1e6) / 1e6;
  const shippingFee = conv(quote.shippingFee);
  const discount = Math.min(conv(quote.discount), subtotal);
  const { updatedAt } = await getPublicRates();
  return {
    code,
    rate,
    ratesUpdatedAt: updatedAt,
    items,
    subtotal,
    shippingFee,
    discount,
    total: Math.max(0, Math.round((subtotal + shippingFee - discount) * 1e6) / 1e6),
  };
}
// The product name in the shopper's language (Accept-Language), English as fallback
const englishName = (name) => localizedText(name) || "This product";

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

// ---------------------------------------------------------------------------
// Pricing (shared by POST /orders/quote and POST /orders)
// ---------------------------------------------------------------------------

// Validates the requested items and loads their products in one query.
// Repeated products are merged so stock is checked against the total quantity.
// Every line comes back priced from the database; a line that can't be bought
// has `problem` set ("no longer available", "only 2 left", "out of stock").
async function loadLines(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, "Order must contain at least one item");
  }
  if (items.length > MAX_ITEMS) throw httpError(400, `An order can contain at most ${MAX_ITEMS} items`);

  const wanted = [];
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw httpError(400, "Each item needs a positive integer quantity");
    }
    if (quantity > MAX_QUANTITY) throw httpError(400, `Quantity can be at most ${MAX_QUANTITY} per item`);

    const ref = item?.product;
    if (typeof ref === "string" && /^[a-f\d]{24}$/i.test(ref)) wanted.push({ _id: ref, quantity });
    else if ((typeof ref === "number" || typeof ref === "string") && /^\d{1,12}$/.test(String(ref))) {
      wanted.push({ id: Number(ref), quantity });
    } else throw httpError(400, `Invalid product reference: ${ref}`);
  }

  const numericIds = wanted.filter((w) => w.id !== undefined).map((w) => w.id);
  const objectIds = wanted.filter((w) => w._id).map((w) => w._id);
  // lean: keeps the raw _id. Imported catalog products have numeric _ids, which a
  // Mongoose document (whose _id is an ObjectId path) would silently drop.
  const products = await Product.find({
    $or: [
      ...(numericIds.length ? [{ id: { $in: numericIds } }] : []),
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  }).lean();
  const byId = new Map(products.map((p) => [p.id, p]));
  const byObjectId = new Map(products.map((p) => [String(p._id), p]));

  const merged = new Map();
  for (const w of wanted) {
    const product = w.id !== undefined ? byId.get(w.id) : byObjectId.get(String(w._id));
    const ref = w.id ?? w._id;
    const key = product ? String(product._id) : `missing:${ref}`;
    const entry = merged.get(key);
    if (entry) entry.quantity += w.quantity;
    else merged.set(key, { product, ref, quantity: w.quantity });
  }

  return [...merged.values()].map(({ product, ref, quantity }) => {
    if (quantity > MAX_QUANTITY) throw httpError(400, `Quantity can be at most ${MAX_QUANTITY} per item`);
    if (!product || product.is_active === false) {
      return { ref, quantity, price: 0, subtotal: 0, available: false, code: "unavailable", problem: "This product is no longer available" };
    }
    const price = Number(product.price);
    if (!Number.isFinite(price)) throw httpError(500, `Product ${product.id} has an invalid price`);

    const title = englishName(product.name);
    const tracked = isTracked(product);
    const stock = Math.max(0, Math.floor(Number(product.stock) || 0));
    let problem = null;
    if (tracked && stock < quantity) problem = stock > 0 ? `Only ${stock} left of ${title}` : `${title} is out of stock`;

    return {
      _id: product._id,
      product,
      ref,
      title,
      quantity,
      price,
      subtotal: round2(price * quantity),
      tracked,
      stock,
      available: !problem,
      code: problem ? "stock" : null,
      problem,
    };
  });
}

// Lines + totals + coupon check. Nothing is written.
async function buildQuote(items, couponCode) {
  const lines = await loadLines(items);
  const subtotal = round2(lines.reduce((sum, line) => sum + (line.available ? line.subtotal : 0), 0));

  let coupon = null;
  let discount = 0;
  let couponError = null;
  if (couponCode !== undefined && couponCode !== null && couponCode !== "") {
    if (typeof couponCode !== "string") throw httpError(400, "couponCode must be text");
    const doc = await Coupon.findOne({ code: couponCode.trim().toUpperCase() });
    if (!doc) couponError = "This coupon code is not valid";
    else {
      const result = doc.evaluate(subtotal);
      if (result.ok) {
        coupon = doc;
        discount = result.discount;
      } else couponError = result.reason;
    }
  }

  const problems = lines.filter((line) => line.problem).map((line) => ({ product: line.product?.id ?? line.ref, code: line.code, message: line.problem }));
  return {
    lines,
    problems,
    subtotal,
    shippingFee: SHIPPING_FEE,
    discount,
    coupon,
    couponError,
    total: Math.max(0, round2(subtotal + SHIPPING_FEE - discount)),
  };
}

// ---------------------------------------------------------------------------
// Stock and coupon reservations
// ---------------------------------------------------------------------------

// Products are found by their public numeric id: it is unique and the same type
// for every product, while _id is a number for imported catalog products and an
// ObjectId for products created in the admin. Old order lines without productId
// fall back to the raw _id (used on the raw collection, so it is never cast).
function productFilter(line) {
  const id = line.productId ?? line.product?.id;
  return id !== undefined && id !== null ? { id: Number(id) } : { _id: line._id };
}

// Runs an undo step without letting its own failure hide the original error
async function rollback(label, undo) {
  try {
    await undo();
  } catch (err) {
    console.error(`${label} failed while undoing an order:`, err);
  }
}

// Takes the stock for tracked lines (atomically: never below 0) and counts the
// sale. If any line can't be reserved, everything reserved so far is given back.
async function reserveStock(lines) {
  const done = [];
  try {
    for (const line of lines) {
      const filter = productFilter(line);
      if (line.tracked) {
        const result = await Product.collection.updateOne(
          { ...filter, stock: { $gte: line.quantity } },
          { $inc: { stock: -line.quantity, sold_count: line.quantity }, $set: { track_inventory: true } }
        );
        if (result.modifiedCount !== 1) {
          const fresh = await Product.collection.findOne(filter, { projection: { stock: 1 } });
          const left = Math.max(0, Number(fresh?.stock) || 0);
          throw httpError(409, left > 0 ? `Only ${left} left of ${line.title}` : `${line.title} is out of stock`);
        }
      } else {
        const result = await Product.collection.updateOne(filter, { $inc: { sold_count: line.quantity } });
        if (result.matchedCount !== 1) throw httpError(409, `${line.title} is no longer available`);
      }
      done.push(line);
    }
  } catch (err) {
    await rollback("Stock release", () => releaseStock(done));
    throw err;
  }
}

// Gives back stock (tracked lines) and un-counts the sale. Uses an update
// pipeline on the raw collection so sold_count never drops below 0.
async function releaseStock(lines) {
  await Promise.all(lines.map((line) => {
    const set = { sold_count: { $max: [0, { $subtract: [{ $ifNull: ["$sold_count", 0] }, line.quantity] }] } };
    if (line.tracked) set.stock = { $add: [{ $ifNull: ["$stock", 0] }, line.quantity] };
    return Product.collection.updateOne(productFilter(line), [{ $set: set }]);
  }));
}

// One more use of the coupon, unless its limit was reached meanwhile
async function reserveCouponUse(coupon) {
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
  return reserved;
}

function releaseCouponUse(code) {
  return Coupon.updateOne({ code, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

// Cancels the order once (even if two requests race) and gives back its stock,
// sold counts and coupon use. Returns the cancelled order, or null if it was
// already cancelled or no longer in one of `fromStatuses`.
async function cancelAndRestock(order, fromStatuses) {
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: { $in: fromStatuses } },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!updated) return null;
  await releaseStock(updated.items.map((item) => ({
    productId: item.productId,
    _id: item.product,
    quantity: item.quantity,
    tracked: item.tracked === true,
  })));
  if (updated.coupon?.code) await releaseCouponUse(updated.coupon.code);
  return updated;
}

function cleanShippingAddress(value) {
  if (!v.isPlainObject(value)) throw httpError(400, "Please enter a delivery address");
  const phone = v.text(value.phone, "Phone", { required: true, max: 30 });
  if (!PHONE_PATTERN.test(phone)) throw httpError(400, "Please enter a valid phone number");
  return {
    fullName: v.text(value.fullName, "Full name", { required: true, max: 100 }),
    phone,
    address: v.text(value.address, "Street address", { required: true, max: 200 }),
    city: v.text(value.city, "City", { required: true, max: 100 }),
    postalCode: v.text(value.postalCode, "Postal code", { max: 20 }) ?? "",
    country: v.text(value.country, "Country", { required: true, max: 60 }),
  };
}

// Order line as sent to the browser by the quote endpoint
function quoteLineJSON(line) {
  return {
    product: line.product?.id ?? line.ref,
    slug: line.product?.slug ?? null,
    name: line.product?.name ?? null,
    image: line.product?.image ?? null,
    price: line.price,
    quantity: line.quantity,
    subtotal: line.subtotal,
    tracked: Boolean(line.tracked),
    stock: line.tracked ? line.stock : null,
    available: line.available,
    problem: line.problem,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/orders/quote
// Body: { items: [{ product, quantity }], couponCode? } -> server prices, stock and totals.
// Nothing is reserved; the checkout page shows this before the order is placed.
async function quoteOrder(req, res) {
  const { items, couponCode, currency } = req.body ?? {};
  const quote = await buildQuote(items, couponCode);
  const display = await displayAmounts(quote, currency);
  res.json({
    currency: BASE_CURRENCY, // the amounts below
    display, // the same quote in the customer's currency (null = base currency)
    items: quote.lines.map(quoteLineJSON),
    subtotal: quote.subtotal,
    shippingFee: quote.shippingFee,
    discount: quote.discount,
    total: quote.total,
    coupon: quote.coupon
      ? { code: quote.coupon.code, type: quote.coupon.type, value: quote.coupon.value, description: quote.coupon.description }
      : null,
    couponError: quote.couponError,
    problems: quote.problems,
    ok: quote.problems.length === 0 && !quote.couponError,
  });
}

// POST /api/orders
// Body: { items: [{ product: <numeric id or _id>, quantity }], shippingAddress, paymentMethod?, notes?, couponCode? }
// Prices, stock and the coupon discount are always checked here, never taken from the client.
async function createOrder(req, res) {
  const { items, shippingAddress, paymentMethod, notes, couponCode, currency } = req.body ?? {};

  const address = cleanShippingAddress(shippingAddress);
  if (paymentMethod !== undefined && paymentMethod !== "cash") {
    throw httpError(400, "Card payments aren't available yet. Please choose cash on delivery.");
  }
  const cleanNotes = v.text(notes, "Notes", { max: 500 }) ?? "";

  const quote = await buildQuote(items, couponCode);
  if (quote.problems.length) {
    const first = quote.problems[0];
    throw httpError(first.code === "stock" ? 409 : 400, first.message);
  }
  if (quote.couponError) throw httpError(400, quote.couponError);
  const display = await displayAmounts(quote, currency);

  await reserveStock(quote.lines);
  let coupon = null;
  try {
    if (quote.coupon) coupon = await reserveCouponUse(quote.coupon);
    const order = await Order.create({
      user: req.user._id,
      items: quote.lines.map((line) => ({
        product: line._id,
        productId: line.product.id,
        slug: line.product.slug,
        tracked: line.tracked,
        name: line.product.name,
        sku: line.product.sku,
        image: line.product.image,
        price: line.price,
        quantity: line.quantity,
        subtotal: line.subtotal,
      })),
      shippingAddress: address,
      paymentMethod: "cash",
      notes: cleanNotes,
      subtotal: quote.subtotal,
      shippingFee: quote.shippingFee,
      discount: quote.discount,
      coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value } : undefined,
      totalPrice: quote.total,
      currency: display
        ? {
          code: display.code,
          rate: display.rate,
          ratesUpdatedAt: display.ratesUpdatedAt,
          subtotal: display.subtotal,
          shippingFee: display.shippingFee,
          discount: display.discount,
          total: display.total,
        }
        : undefined,
    });
    res.status(201).json(order);
  } catch (err) {
    // The order wasn't saved: give the stock and the coupon use back
    await rollback("Stock release", () => releaseStock(quote.lines));
    if (coupon) await rollback("Coupon release", () => releaseCouponUse(coupon.code));
    throw err;
  }
}

// GET /api/orders/my-orders?status=&page=&limit=
// Pagination is opt-in (total in X-Total-Count); newest first.
async function getMyOrders(req, res) {
  const filter = { user: req.user._id };
  const status = v.oneOf(req.query.status, "status", ORDER_STATUSES);
  if (status) filter.status = status;

  const query = Order.find(filter).sort({ createdAt: -1 });
  if (req.query.page !== undefined || req.query.limit !== undefined) {
    const { limit, skip } = v.pagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const [total, orders] = await Promise.all([Order.countDocuments(filter), query.skip(skip).limit(limit)]);
    res.set("X-Total-Count", String(total));
    return res.json(orders);
  }
  res.json(await query);
}

// GET /api/orders/:id
async function getOrderById(req, res) {
  const order = await findOrderOr404(req.params.id);
  assertOwnerOrAdmin(order, req.user);
  res.json(order);
}

// PATCH /api/orders/:id/cancel   (owner or admin, while pending/confirmed)
async function cancelOrder(req, res) {
  const order = await findOrderOr404(req.params.id);
  assertOwnerOrAdmin(order, req.user);

  if (!CANCELLABLE.includes(order.status)) {
    throw httpError(400, `Order cannot be cancelled when status is "${order.status}"`);
  }

  const cancelled = await cancelAndRestock(order, CANCELLABLE);
  if (!cancelled) throw httpError(409, "This order changed meanwhile. Please reload it.");
  res.json(cancelled);
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
// Cancelling gives the stock back; a cancelled order can't be reopened.
async function updateOrderStatus(req, res) {
  const { status } = req.body ?? {};
  if (!ORDER_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${ORDER_STATUSES.join(", ")}`);
  }

  const order = await findOrderOr404(req.params.id);
  if (order.status === status) return res.json(order);
  if (order.status === "cancelled") {
    throw httpError(400, "A cancelled order can't be reopened. The customer can place a new order.");
  }

  if (status === "cancelled") {
    const cancelled = await cancelAndRestock(order, ORDER_STATUSES.filter((s) => s !== "cancelled"));
    return res.json(cancelled ?? (await Order.findById(order._id)));
  }

  order.status = status;
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
  quoteOrder,
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
  updatePaymentStatus,
};
