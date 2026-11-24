const Order = require("../modules/order");
const Product = require("../modules/product");
const User = require("../modules/user");
const httpError = require("../utils/httpError");
const { STOCK_COUNT_FIELDS } = require("../utils/inventory");

const PERIODS = [7, 30, 90];
const NOT_CANCELLED = { status: { $ne: "cancelled" } };
const round2 = (n) => Math.round((n || 0) * 100) / 100;

// "Europe/Berlin" etc. Falls back to UTC; rejects anything Intl doesn't know.
function cleanTimeZone(value) {
  if (value === undefined || value === "") return "UTC";
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) {
    throw httpError(400, "tz must be an IANA time zone such as Europe/Berlin");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw httpError(400, "tz must be an IANA time zone such as Europe/Berlin");
  }
  return value;
}

// "YYYY-MM-DD" of `date` in `timeZone`
function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Minutes `timeZone` is ahead of UTC at `date` (e.g. +60 for Berlin in winter)
function offsetMinutes(date, timeZone) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(label || "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === "-" ? -minutes : minutes;
}

// The UTC instant at which day `key` starts in `timeZone`
function startOfDay(key, timeZone) {
  const [y, m, d] = key.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  let ts = utcMidnight - offsetMinutes(new Date(utcMidnight), timeZone) * 60000;
  ts = utcMidnight - offsetMinutes(new Date(ts), timeZone) * 60000; // settle DST edges
  return new Date(ts);
}

// The `days` calendar days ending today, oldest first
function lastDays(days, timeZone) {
  const [y, m, d] = dayKey(new Date(), timeZone).split("-").map(Number);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return keys;
}

// GET /api/admin/stats?days=7|30|90&tz=Europe/Berlin   (admin)
// Every figure is computed from the database; nothing is estimated.
// Revenue = total of orders that are not cancelled.
async function getStats(req, res) {
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  if (!PERIODS.includes(days)) throw httpError(400, `days must be one of: ${PERIODS.join(", ")}`);
  const timeZone = cleanTimeZone(req.query.tz);

  const keys = lastDays(days, timeZone);
  const since = startOfDay(keys[0], timeZone);
  const inPeriod = { createdAt: { $gte: since } };

  const [
    revenueRows,
    ordersByStatusRows,
    productRows,
    customers,
    newCustomers,
    ordersPlaced,
    dailyRows,
    bestSellers,
    recentOrders,
  ] = await Promise.all([
    Order.aggregate([
      { $match: NOT_CANCELLED },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$totalPrice" },
          paidRevenue: { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, "$totalPrice", 0] } },
        },
      },
    ]),
    Order.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Product.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $ne: ["$is_active", false] }, 1, 0] } },
          ...STOCK_COUNT_FIELDS,
        },
      },
    ]),
    User.countDocuments({ role: "user" }),
    User.countDocuments({ role: "user", ...inPeriod }),
    Order.countDocuments(inPeriod), // every order placed in the period, cancelled ones too
    Order.aggregate([
      { $match: { ...NOT_CANCELLED, ...inPeriod } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: timeZone } },
          revenue: { $sum: "$totalPrice" },
          orders: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      { $match: { ...NOT_CANCELLED, ...inPeriod } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product",
          units: { $sum: "$items.quantity" },
          revenue: { $sum: "$items.subtotal" },
          orders: { $sum: 1 },
          name: { $last: "$items.name" },
          image: { $last: "$items.image" },
        },
      },
      { $sort: { units: -1, revenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          pipeline: [{ $project: { id: 1, name: 1, image: 1, is_active: 1 } }],
          as: "product",
        },
      },
    ]),
    Order.find()
      .sort({ createdAt: -1 })
      .limit(6)
      .populate("user", "username email")
      .select("orderNumber user totalPrice status paymentStatus createdAt items.quantity")
      .lean(),
  ]);

  const byDay = new Map(dailyRows.map((row) => [row._id, row]));
  const sales = keys.map((date) => ({
    date,
    revenue: round2(byDay.get(date)?.revenue),
    orders: byDay.get(date)?.orders ?? 0,
  }));
  const periodRevenue = round2(sales.reduce((sum, day) => sum + day.revenue, 0));
  const periodOrders = sales.reduce((sum, day) => sum + day.orders, 0);

  const ordersByStatus = Object.fromEntries(Order.schema.path("status").enumValues.map((s) => [s, 0]));
  for (const row of ordersByStatusRows) ordersByStatus[row._id] = row.n;
  const totalOrders = Object.values(ordersByStatus).reduce((a, b) => a + b, 0);
  const products = productRows[0] || { total: 0, active: 0, tracked: 0, lowStock: 0, outOfStock: 0 };

  res.json({
    range: { days, timeZone, from: keys[0], to: keys[keys.length - 1] },
    totals: {
      revenue: round2(revenueRows[0]?.revenue),
      paidRevenue: round2(revenueRows[0]?.paidRevenue),
      orders: totalOrders,
      pendingOrders: ordersByStatus.pending,
      products: products.total,
      activeProducts: products.active,
      hiddenProducts: products.total - products.active,
      lowStockProducts: products.lowStock,
      outOfStockProducts: products.outOfStock,
      untrackedProducts: products.total - products.tracked,
      customers,
    },
    period: {
      revenue: periodRevenue,
      orders: periodOrders, // not cancelled (same orders as the revenue)
      ordersPlaced,
      averageOrderValue: periodOrders ? round2(periodRevenue / periodOrders) : 0,
      newCustomers,
    },
    ordersByStatus,
    sales,
    bestSellers: bestSellers.map((row) => {
      const product = row.product[0];
      return {
        productId: product?.id ?? null, // numeric id for links; null if the product was deleted
        name: product?.name ?? row.name,
        image: product?.image ?? row.image ?? "",
        isActive: product ? product.is_active !== false : false,
        units: row.units,
        orders: row.orders,
        revenue: round2(row.revenue),
      };
    }),
    recentOrders: recentOrders.map((o) => ({
      _id: o._id,
      orderNumber: o.orderNumber,
      customer: o.user ? { _id: o.user._id, username: o.user.username, email: o.user.email } : null,
      totalPrice: o.totalPrice,
      status: o.status,
      paymentStatus: o.paymentStatus,
      createdAt: o.createdAt,
      itemsCount: (o.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0),
    })),
  });
}

// GET /api/admin/inventory/summary
// Product counts by stock state for the Inventory page (same rules as the store)
async function getInventorySummary(req, res) {
  const [row] = await Product.aggregate([{ $group: { _id: null, total: { $sum: 1 }, ...STOCK_COUNT_FIELDS } }]);
  const summary = row || { total: 0, tracked: 0, outOfStock: 0, lowStock: 0, unitsInStock: 0, unitsSold: 0 };
  res.json({
    total: summary.total,
    tracked: summary.tracked,
    untracked: summary.total - summary.tracked,
    inStock: summary.tracked - summary.outOfStock,
    lowStock: summary.lowStock,
    outOfStock: summary.outOfStock,
    unitsInStock: summary.unitsInStock,
    unitsSold: summary.unitsSold,
  });
}

module.exports = { getStats, getInventorySummary };
