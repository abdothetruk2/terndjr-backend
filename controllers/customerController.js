const User = require("../modules/user");
const Order = require("../modules/order");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  "name-asc": { username: 1 },
};

// Fields an admin may see. Never the password (it is select:false anyway).
function customerJSON(user, stats) {
  return {
    _id: user._id,
    username: user.username ?? null,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    isBlocked: Boolean(user.isBlocked),
    addresses: user.addresses ?? [],
    createdAt: user.createdAt ?? null,
    ordersCount: stats?.ordersCount ?? 0,
    totalSpent: Math.round((stats?.totalSpent ?? 0) * 100) / 100,
    lastOrderAt: stats?.lastOrderAt ?? null,
  };
}

// { userId -> { ordersCount, totalSpent, lastOrderAt } }; cancelled orders don't count as spent
async function orderStats(userIds) {
  if (userIds.length === 0) return new Map();
  const rows = await Order.aggregate([
    { $match: { user: { $in: userIds } } },
    {
      $group: {
        _id: "$user",
        ordersCount: { $sum: 1 },
        totalSpent: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 0, "$totalPrice"] } },
        lastOrderAt: { $max: "$createdAt" },
      },
    },
  ]);
  return new Map(rows.map((row) => [String(row._id), row]));
}

// GET /api/admin/customers?search=&role=&status=&sort=&page=&limit=   (admin)
async function listCustomers(req, res) {
  const role = v.oneOf(req.query.role, "role", ["user", "admin"]);
  const status = v.oneOf(req.query.status, "status", ["active", "blocked"]);
  const sort = v.oneOf(req.query.sort, "sort", Object.keys(SORTS));
  const { limit, skip } = v.pagination(req.query);

  const filter = {};
  if (role) filter.role = role;
  if (status === "blocked") filter.isBlocked = true;
  if (status === "active") filter.isBlocked = { $ne: true };
  const term = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (term) {
    const rx = new RegExp(v.escapeRegex(term), "i");
    filter.$or = [{ username: rx }, { email: rx }, { phone: rx }];
  }

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort(SORTS[sort] || SORTS.newest).skip(skip).limit(limit).lean(),
  ]);
  const stats = await orderStats(users.map((u) => u._id));

  res.set("X-Total-Count", String(total));
  res.json(users.map((u) => customerJSON(u, stats.get(String(u._id)))));
}

// GET /api/admin/customers/:id   (admin) — profile, totals and the latest 10 orders
async function getCustomer(req, res) {
  v.objectId(req.params.id, "customer id");
  const user = await User.findById(req.params.id).lean();
  if (!user) throw httpError(404, "Customer not found");

  const [stats, recentOrders] = await Promise.all([
    orderStats([user._id]),
    Order.find({ user: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("orderNumber totalPrice status paymentStatus createdAt items.quantity")
      .lean(),
  ]);

  res.json({
    ...customerJSON(user, stats.get(String(user._id))),
    recentOrders: recentOrders.map((o) => ({
      _id: o._id,
      orderNumber: o.orderNumber,
      totalPrice: o.totalPrice,
      status: o.status,
      paymentStatus: o.paymentStatus,
      createdAt: o.createdAt,
      itemsCount: (o.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0),
    })),
  });
}

// PATCH /api/admin/customers/:id   (admin)
// Body: { role?: "user" | "admin", isBlocked?: boolean }
async function updateCustomer(req, res) {
  v.objectId(req.params.id, "customer id");
  const body = req.body ?? {};
  const role = v.oneOf(body.role, "role", ["user", "admin"]);
  const isBlocked = v.boolean(body.isBlocked, "isBlocked");
  if (role === undefined && isBlocked === undefined) throw httpError(400, "No valid fields to update");

  const user = await User.findById(req.params.id);
  if (!user) throw httpError(404, "Customer not found");

  const isSelf = user._id.equals(req.user._id);
  if (isSelf && role !== undefined && role !== user.role) throw httpError(400, "You can't change your own role");
  if (isSelf && isBlocked) throw httpError(400, "You can't block your own account");

  // Never leave the shop without an active admin
  const losesAdmin = user.role === "admin" && (role === "user" || isBlocked === true);
  if (losesAdmin) {
    const otherAdmins = await User.countDocuments({ role: "admin", isBlocked: { $ne: true }, _id: { $ne: user._id } });
    if (otherAdmins === 0) throw httpError(400, "This is the only active admin. Make someone else an admin first.");
  }

  if (role !== undefined) user.role = role;
  if (isBlocked !== undefined) user.isBlocked = isBlocked;
  // Old accounts may miss fields the schema now requires; only validate what changed
  await user.save({ validateModifiedOnly: true });

  const stats = await orderStats([user._id]);
  res.json(customerJSON(user.toObject(), stats.get(String(user._id))));
}

module.exports = { listCustomers, getCustomer, updateCustomer };
