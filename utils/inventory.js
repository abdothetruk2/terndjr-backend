// Stock rules shared by the order, product and admin code.
//
// A product's stock is "tracked" when orders are limited by `stock` and reduce it.
// - track_inventory: true / false  -> set explicitly (admin Inventory page or product form)
// - track_inventory unset          -> tracked only when the product has a stock number (> 0).
//   Imported products without a stock number (stock 0, e.g. the jewelry with
//   tags.stock_status "not-specified") stay for sale without a limit.
// Reserving stock for an order also sets track_inventory: true, so a product that
// sells out stays "out of stock" instead of silently becoming untracked.
const LOW_STOCK = 5; // tracked products with 1..LOW_STOCK units left are "low"

function isTracked(product) {
  if (typeof product?.track_inventory === "boolean") return product.track_inventory;
  return Number(product?.stock) > 0;
}

// Units a customer can buy right now (Infinity when stock isn't tracked)
function availableQuantity(product) {
  if (!isTracked(product)) return Infinity;
  return Math.max(0, Math.floor(Number(product?.stock) || 0));
}

// --- The same rules as database filters (admin product lists, Inventory page) ---
const NOT_SET = { $nin: [true, false] }; // track_inventory missing or null
const TRACKED_FILTER = {
  $or: [{ track_inventory: true }, { track_inventory: NOT_SET, stock: { $gt: 0 } }],
};
const UNTRACKED_FILTER = {
  $or: [{ track_inventory: false }, { track_inventory: NOT_SET, stock: { $not: { $gt: 0 } } }],
};
const IN_STOCK_FILTER = { track_inventory: { $ne: false }, stock: { $gt: 0 } };
const LOW_STOCK_FILTER = { track_inventory: { $ne: false }, stock: { $gt: 0, $lte: LOW_STOCK } };
const OUT_OF_STOCK_FILTER = { track_inventory: true, stock: { $not: { $gt: 0 } } };

// ?stock= values of the admin product list
const STOCK_FILTERS = {
  in: IN_STOCK_FILTER,
  low: LOW_STOCK_FILTER,
  out: OUT_OF_STOCK_FILTER,
  untracked: UNTRACKED_FILTER,
  tracked: TRACKED_FILTER,
};

// --- And as aggregation expressions (counts for the dashboard and Inventory page) ---
const IS_TRACKED_EXPR = {
  $or: [
    { $eq: ["$track_inventory", true] },
    { $and: [{ $ne: ["$track_inventory", false] }, { $gt: ["$stock", 0] }] },
  ],
};
const countIf = (expr) => ({ $sum: { $cond: [expr, 1, 0] } });

// $group fields: tracked, outOfStock, lowStock, unitsInStock, unitsSold
const STOCK_COUNT_FIELDS = {
  tracked: countIf(IS_TRACKED_EXPR),
  outOfStock: countIf({ $and: [{ $eq: ["$track_inventory", true] }, { $not: [{ $gt: ["$stock", 0] }] }] }),
  lowStock: countIf({ $and: [IS_TRACKED_EXPR, { $gt: ["$stock", 0] }, { $lte: ["$stock", LOW_STOCK] }] }),
  unitsInStock: { $sum: { $cond: [{ $and: [IS_TRACKED_EXPR, { $gt: ["$stock", 0] }] }, "$stock", 0] } },
  unitsSold: { $sum: { $ifNull: ["$sold_count", 0] } },
};

module.exports = {
  LOW_STOCK,
  isTracked,
  availableQuantity,
  TRACKED_FILTER,
  UNTRACKED_FILTER,
  IN_STOCK_FILTER,
  LOW_STOCK_FILTER,
  OUT_OF_STOCK_FILTER,
  STOCK_FILTERS,
  STOCK_COUNT_FIELDS,
};
