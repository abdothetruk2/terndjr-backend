// End-to-end API checks against a RUNNING local server.
//
//   npm run dev            (in one terminal)
//   npm run test:api       (in another)
//
// It creates its own "zz-test" accounts, products, categories, coupons, orders,
// uploads and subscribers, and removes all of them at the end (even when a check
// fails). It refuses to run against anything but localhost unless ALLOW_REMOTE=1.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const crypto = require("crypto");
const fs = require("fs");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");

const BASE = (process.env.API_URL || "http://localhost:3000").replace(/\/+$/, "");
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE !== "1") {
  console.error(`Refusing to run against ${BASE}: this test writes data. Set ALLOW_REMOTE=1 to override.`);
  process.exit(1);
}

const User = require("../modules/user");
const Order = require("../modules/order");
const Product = require("../modules/product");
const Category = require("../modules/category");
const Coupon = require("../modules/coupon");
const Subscriber = require("../modules/subscriber");

const rand = crypto.randomBytes(3).toString("hex");
const password = `Zz-${crypto.randomBytes(9).toString("base64url")}`;
const created = { users: [], products: [], categories: [], coupons: [], uploads: [], subscribers: [] };

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`);
  }
}
const section = (title) => console.log(`\n== ${title}`);

async function req(method, url, { token, body, raw, type, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    h["Content-Type"] = type;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + url, { method, headers: h, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function register(name) {
  const r = await req("POST", "/api/auth/register", { body: { username: name, email: `${name}@example.test`, password } });
  if (r.status === 201) created.users.push(name);
  return r;
}
const login = (username) => req("POST", "/api/auth/login", { body: { username, password } });

const address = { fullName: "ZZ Tester", phone: "+49 151 0000000", address: "1 Test Street", city: "Testcity", postalCode: "12345", country: "Germany" };

async function main() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/trendjr");

  // ------------------------------------------------------------------
  section("Accounts & sign-in");
  const adminName = `zz_admin_${rand}`;
  const userName = `zz_user_${rand}`;
  let r = await register(adminName);
  check("register (201)", r.status === 201, JSON.stringify(r.data));
  r = await register(userName);
  let userToken = r.data.token;
  const userId = r.data.user?.id;
  const out = execFileSync("node", ["scripts/createAdmin.js", adminName], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  check("make-admin script promotes the account", /is now an admin/.test(out), out);
  r = await login(adminName);
  check("admin login", r.status === 200 && r.data.user?.role === "admin", JSON.stringify(r.data));
  const adminToken = r.data.token;
  const adminId = r.data.user?.id;
  r = await req("POST", "/api/auth/login", { body: { username: { $ne: null }, password } });
  check("operator object in login refused (400)", r.status === 400);
  r = await req("POST", "/api/auth/login", { body: { username: userName, password: "wrong-password" } });
  check("wrong password (401)", r.status === 401);
  await login(userName); // clears the failed-attempt counter

  // ------------------------------------------------------------------
  section("Authorization");
  r = await req("GET", "/api/admin/stats");
  check("admin API without token (401)", r.status === 401);
  r = await req("GET", "/api/admin/stats", { token: userToken });
  check("admin API as customer (403)", r.status === 403);
  r = await req("POST", "/api/products", { token: userToken, body: { name: "x", price: 1 } });
  check("create product as customer (403)", r.status === 403);
  r = await req("GET", "/api/orders", { token: userToken });
  check("all orders as customer (403)", r.status === 403);

  // ------------------------------------------------------------------
  section("Catalog setup");
  r = await req("POST", "/api/categories", { token: adminToken, body: { name: { en: `ZZ Test Cat ${rand}` } } });
  check("create category", r.status === 201, JSON.stringify(r.data));
  const category = r.data;
  if (category?._id) created.categories.push(category._id);

  const makeProduct = async (extra) => {
    const res = await req("POST", "/api/products", {
      token: adminToken,
      body: { name: { en: `ZZ Test Product ${rand} ${extra.label}` }, price: extra.price ?? 10, category: category.slug, ...extra.body },
    });
    if (res.status === 201) created.products.push(res.data.id);
    return res;
  };
  r = await makeProduct({ label: "tracked", price: 12.5, body: { stock: 3 } });
  check("create product with stock 3", r.status === 201 && r.data.stock === 3, JSON.stringify(r.data));
  const tracked = r.data;
  r = await makeProduct({ label: "untracked", price: 4, body: { stock: 0 } });
  const untracked = r.data;
  check("create product without a stock number", r.status === 201 && untracked.stock === 0);
  r = await makeProduct({ label: "soldout", price: 7, body: { stock: 0, track_inventory: true } });
  const soldOut = r.data;
  check("create tracked product with stock 0", r.status === 201 && soldOut.track_inventory === true);
  r = await makeProduct({ label: "hidden", price: 5, body: { stock: 5, is_active: false } });
  const hidden = r.data;

  r = await req("POST", "/api/products", { token: adminToken, body: { name: { en: "x" }, price: "abc" } });
  check("invalid price refused (400)", r.status === 400);
  r = await req("GET", `/api/products/${hidden.id}`);
  check("hidden product not served to the store (404)", r.status === 404);
  r = await req("GET", `/api/products?ids=${tracked.id},${untracked.id},${hidden.id},999999999`);
  check("?ids= returns only buyable products", r.status === 200 && r.data.length === 2 && r.data.every((p) => [tracked.id, untracked.id].includes(p.id)));
  r = await req("GET", "/api/products?ids=12,abc");
  check("?ids= with a bad id (400)", r.status === 400);
  r = await req("GET", `/api/products?category=${category.slug}&page=1&limit=10`);
  check("category filter finds the new products", r.status === 200 && r.headers.get("x-total-count") === "3", r.headers.get("x-total-count"));

  // ------------------------------------------------------------------
  section("Quote (server prices, nothing reserved)");
  r = await req("POST", "/api/orders/quote", { body: { items: [{ product: tracked.id, quantity: 1 }] } });
  check("quote needs a login (401)", r.status === 401);
  r = await req("POST", "/api/orders/quote", { token: userToken, body: { items: [{ product: tracked.id, quantity: 2 }, { product: untracked.id, quantity: 3 }] } });
  check("quote totals: 2×12.50 + 3×4 = 37", r.status === 200 && r.data.subtotal === 37 && r.data.total === 37 && r.data.ok === true, JSON.stringify(r.data));
  r = await req("POST", "/api/orders/quote", { token: userToken, body: { items: [{ product: tracked.id, quantity: 2 }, { product: tracked.id, quantity: 2 }] } });
  check("repeated lines are merged and checked against stock", r.status === 200 && r.data.ok === false && /Only 3 left/.test(r.data.problems[0]?.message), JSON.stringify(r.data.problems));
  r = await req("POST", "/api/orders/quote", { token: userToken, body: { items: [{ product: soldOut.id, quantity: 1 }, { product: hidden.id, quantity: 1 }] } });
  check("quote flags out-of-stock and hidden products", r.data.ok === false && r.data.problems.length === 2, JSON.stringify(r.data.problems));
  r = await req("POST", "/api/orders/quote", { token: userToken, body: { items: [{ product: tracked.id, quantity: 1 }], couponCode: "NOPE-NOPE" } });
  check("quote reports an invalid coupon", r.data.couponError === "This coupon code is not valid" && r.data.ok === false);
  r = await Product.findOne({ id: tracked.id }).lean();
  check("quote reserved nothing", r.stock === 3 && (r.sold_count ?? 0) === 0);

  // ------------------------------------------------------------------
  section("Placing orders");
  r = await req("POST", "/api/orders", { token: userToken, body: { items: [{ product: tracked.id, quantity: 1 }] } });
  check("order without an address (400)", r.status === 400, JSON.stringify(r.data));
  r = await req("POST", "/api/orders", { token: userToken, body: { items: [{ product: tracked.id, quantity: 1 }], shippingAddress: { ...address, phone: "x" } } });
  check("order with an invalid phone (400)", r.status === 400);
  r = await req("POST", "/api/orders", { token: userToken, body: { items: [{ product: tracked.id, quantity: 1 }], shippingAddress: address, paymentMethod: "card" } });
  check("card payment refused (400)", r.status === 400 && /cash on delivery/i.test(r.data.message));

  r = await req("POST", "/api/coupons", { token: adminToken, body: { code: `ZZ${rand}`.toUpperCase(), type: "percent", value: 10, usageLimit: 1 } });
  check("create coupon", r.status === 201, JSON.stringify(r.data));
  const coupon = r.data;
  if (coupon?._id) created.coupons.push(coupon._id);

  r = await req("POST", "/api/orders", {
    token: userToken,
    body: { items: [{ product: tracked.id, quantity: 2 }, { product: untracked.id, quantity: 5 }], shippingAddress: address, couponCode: coupon.code, notes: "zz-test" },
  });
  check("order placed (201): 2×12.50 + 5×4 = 45, 10% off = 40.50", r.status === 201 && r.data.subtotal === 45 && r.data.discount === 4.5 && r.data.totalPrice === 40.5, JSON.stringify(r.data));
  const order1 = r.data;
  check("order lines keep productId, slug and tracked flag", order1.items?.[0]?.productId === tracked.id && order1.items?.[0]?.tracked === true && order1.items?.[1]?.tracked === false);
  let p = await Product.findOne({ id: tracked.id }).lean();
  check("tracked stock reduced 3 → 1, sold 2, tracking switched on", p.stock === 1 && p.sold_count === 2 && p.track_inventory === true, JSON.stringify({ stock: p.stock, sold: p.sold_count, t: p.track_inventory }));
  p = await Product.findOne({ id: untracked.id }).lean();
  check("untracked stock untouched (0), sold 5", p.stock === 0 && p.sold_count === 5 && p.track_inventory === undefined);
  let c = await Coupon.findById(coupon._id).lean();
  check("coupon used once", c.usedCount === 1);

  r = await req("POST", "/api/orders", { token: userToken, body: { items: [{ product: tracked.id, quantity: 2 }], shippingAddress: address } });
  check("more than the stock left (409)", r.status === 409 && /Only 1 left/.test(r.data.message), JSON.stringify(r.data));
  r = await req("POST", "/api/orders", { token: userToken, body: { items: [{ product: soldOut.id, quantity: 1 }], shippingAddress: address } });
  check("tracked product at 0 (409)", r.status === 409 && /out of stock/.test(r.data.message));
  r = await req("POST", "/api/orders", { token: userToken, body: { items: [{ product: untracked.id, quantity: 1 }, { product: soldOut.id, quantity: 1 }], shippingAddress: address } });
  p = await Product.findOne({ id: untracked.id }).lean();
  check("a failed order reserves nothing (untracked sold count unchanged)", r.status === 409 && p.sold_count === 5);

  // Five orders of 1 at the same time against the last unit: exactly one wins
  const race = await Promise.all(Array.from({ length: 5 }, () => req("POST", "/api/orders", {
    token: userToken,
    body: { items: [{ product: tracked.id, quantity: 1 }], shippingAddress: address },
  })));
  const won = race.filter((x) => x.status === 201);
  p = await Product.findOne({ id: tracked.id }).lean();
  check("concurrent orders never oversell (1 of 5 wins, stock 0)", won.length === 1 && race.filter((x) => x.status === 409).length === 4 && p.stock === 0, race.map((x) => x.status).join(","));
  const order2 = won[0]?.data;

  // ------------------------------------------------------------------
  section("Cancelling gives stock back");
  r = await req("PATCH", `/api/orders/${order1._id}/cancel`, { token: userToken });
  check("customer cancels a pending order", r.status === 200 && r.data.status === "cancelled");
  p = await Product.findOne({ id: tracked.id }).lean();
  check("stock 0 → 2 and sold 3 → 1 after cancelling", p.stock === 2 && p.sold_count === 1, JSON.stringify({ stock: p.stock, sold: p.sold_count }));
  p = await Product.findOne({ id: untracked.id }).lean();
  check("untracked sold count 5 → 0", p.sold_count === 0);
  c = await Coupon.findById(coupon._id).lean();
  check("coupon use given back", c.usedCount === 0);
  r = await req("PATCH", `/api/orders/${order1._id}/cancel`, { token: userToken });
  check("cancelling twice (400)", r.status === 400);
  p = await Product.findOne({ id: tracked.id }).lean();
  check("double cancel didn't restock twice", p.stock === 2);

  r = await req("PATCH", `/api/orders/${order2._id}/status`, { token: adminToken, body: { status: "shipped" } });
  check("admin ships an order", r.status === 200 && r.data.status === "shipped");
  r = await req("PATCH", `/api/orders/${order2._id}/cancel`, { token: userToken });
  check("customer can't cancel a shipped order (400)", r.status === 400);
  r = await req("PATCH", `/api/orders/${order2._id}/status`, { token: adminToken, body: { status: "cancelled" } });
  check("admin cancels a shipped order", r.status === 200 && r.data.status === "cancelled");
  p = await Product.findOne({ id: tracked.id }).lean();
  check("admin cancel restocks (2 → 3)", p.stock === 3 && p.sold_count === 0);
  r = await req("PATCH", `/api/orders/${order2._id}/status`, { token: adminToken, body: { status: "pending" } });
  check("a cancelled order can't be reopened (400)", r.status === 400);

  // ------------------------------------------------------------------
  section("Customer order pages");
  r = await req("GET", "/api/orders/my-orders?page=1&limit=1", { token: userToken });
  check("my-orders paginated", r.status === 200 && r.data.length === 1 && r.headers.get("x-total-count") === "2");
  r = await req("GET", "/api/orders/my-orders?status=cancelled", { token: userToken });
  check("my-orders status filter", r.status === 200 && r.data.length === 2 && r.data.every((o) => o.status === "cancelled"));
  r = await req("GET", `/api/orders/${order1._id}`, { token: adminToken });
  check("admin can open any order", r.status === 200);
  const other = `zz_other_${rand}`;
  r = await register(other);
  const otherToken = r.data.token;
  r = await req("GET", `/api/orders/${order1._id}`, { token: otherToken });
  check("another customer can't open it (403)", r.status === 403);

  // ------------------------------------------------------------------
  section("Profile & saved address");
  r = await req("PATCH", "/api/auth/me", { token: userToken, body: { address: { fullName: "ZZ Tester", street: "1 Test Street", city: "Testcity", country: "Germany" } } });
  check("save delivery address", r.status === 200 && r.data.user.addresses?.[0]?.street === "1 Test Street", JSON.stringify(r.data));
  r = await req("PATCH", "/api/auth/me", { token: userToken, body: { address: { city: { $gt: "" } } } });
  check("address fields must be text (400)", r.status === 400);
  r = await req("POST", "/api/auth/resetPassword", { token: userToken, body: { currentPassword: "wrong", newPassword: "another-pass-123" } });
  check("wrong current password (400)", r.status === 400);

  // ------------------------------------------------------------------
  section("Newsletter");
  const email = `zz.news.${rand}@example.test`;
  created.subscribers.push(email);
  r = await req("POST", "/api/newsletter", { body: { email } });
  check("subscribe (201)", r.status === 201);
  r = await req("POST", "/api/newsletter", { body: { email: email.toUpperCase() } });
  check("subscribing again answers the same (no duplicate)", r.status === 201 && (await Subscriber.countDocuments({ email })) === 1);
  r = await req("POST", "/api/newsletter", { body: { email: "nope" } });
  check("invalid email (400)", r.status === 400);
  r = await req("GET", `/api/admin/subscribers?search=${encodeURIComponent(email)}`, { token: adminToken });
  check("admin lists subscribers", r.status === 200 && r.data.length === 1 && r.headers.get("x-total-count") === "1");
  r = await req("GET", "/api/admin/subscribers", { token: userToken });
  check("customers can't list subscribers (403)", r.status === 403);

  // ------------------------------------------------------------------
  section("Admin regression");
  r = await req("GET", `/api/admin/stats?days=7&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, { token: adminToken });
  check("stats load", r.status === 200 && Array.isArray(r.data.sales) && r.data.sales.length === 7);
  r = await req("GET", `/api/admin/products?search=${encodeURIComponent(`ZZ Test Product ${rand}`)}`, { token: adminToken });
  check("admin product search (incl. hidden)", r.status === 200 && r.data.length === 4, String(r.data.length));
  r = await req("GET", `/api/admin/customers?search=${userName}`, { token: adminToken });
  check("customer list with order stats", r.status === 200 && r.data[0]?.ordersCount === 2);

  // Inventory filters (test products: tracked 3, untracked 0, sold out, hidden 5)
  const stockCount = async (stock) => {
    const res = await req("GET", `/api/admin/products?search=${encodeURIComponent(`ZZ Test Product ${rand}`)}&stock=${stock}`, { token: adminToken });
    return res.status === 200 ? res.data.map((x) => x.id).sort() : res.status;
  };
  const ids = (...list) => list.map((x) => x.id).sort();
  check("stock=out finds the sold-out product", JSON.stringify(await stockCount("out")) === JSON.stringify(ids(soldOut)));
  check("stock=none still means out of stock", JSON.stringify(await stockCount("none")) === JSON.stringify(ids(soldOut)));
  check("stock=untracked finds the product without a stock number", JSON.stringify(await stockCount("untracked")) === JSON.stringify(ids(untracked)));
  check("stock=low finds tracked products with 1-5 left", JSON.stringify(await stockCount("low")) === JSON.stringify(ids(tracked, hidden)));
  check("stock=tracked finds every tracked product", JSON.stringify(await stockCount("tracked")) === JSON.stringify(ids(tracked, soldOut, hidden)));
  check("unknown stock filter (400)", (await stockCount("bogus")) === 400);
  r = await req("GET", "/api/admin/products?sort=sold-desc&limit=50", { token: adminToken });
  check("sort=sold-desc", r.status === 200 && r.data.every((x, i, a) => i === 0 || (a[i - 1].sold_count ?? 0) >= (x.sold_count ?? 0)));
  r = await req("GET", "/api/admin/inventory/summary", { token: adminToken });
  const summary = r.data;
  const totalProducts = await Product.countDocuments();
  check("inventory summary adds up", r.status === 200 && summary.total === totalProducts && summary.tracked + summary.untracked === summary.total
    && summary.inStock + summary.outOfStock === summary.tracked && summary.lowStock <= summary.inStock, JSON.stringify(summary));
  const outAll = await req("GET", "/api/admin/products?stock=out&limit=1", { token: adminToken });
  const untrackedAll = await req("GET", "/api/admin/products?stock=untracked&limit=1", { token: adminToken });
  check("summary counts match the list filters", Number(outAll.headers.get("x-total-count")) === summary.outOfStock && Number(untrackedAll.headers.get("x-total-count")) === summary.untracked);
  r = await req("GET", "/api/admin/inventory/summary", { token: userToken });
  check("customers can't read the inventory summary (403)", r.status === 403);
  r = await req("GET", "/api/admin/stats?days=7", { token: adminToken });
  check("dashboard stats include stock alerts", r.data.totals?.outOfStockProducts === summary.outOfStock && r.data.totals?.lowStockProducts === summary.lowStock && r.data.totals?.untrackedProducts === summary.untracked);
  r = await req("PATCH", `/api/admin/customers/${adminId}`, { token: adminToken, body: { isBlocked: true } });
  check("admin can't block themselves (400)", r.status === 400);
  r = await req("PATCH", `/api/admin/customers/${userId}`, { token: adminToken, body: { isBlocked: true } });
  check("block a customer", r.status === 200 && r.data.isBlocked === true);
  r = await req("GET", "/api/auth/me", { token: userToken });
  check("blocked customer's token refused (403)", r.status === 403);
  r = await req("PATCH", `/api/admin/customers/${userId}`, { token: adminToken, body: { isBlocked: false } });
  check("unblock", r.status === 200 && r.data.isBlocked === false);

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  r = await req("POST", "/api/admin/uploads", { token: adminToken, raw: png, type: "image/png" });
  check("upload an image (201)", r.status === 201 && /^uploads\/[a-f0-9]{32}\.png$/.test(r.data.path), JSON.stringify(r.data));
  if (r.data?.path) created.uploads.push(r.data.path);
  const served = r.data?.path ? await fetch(`${BASE}/${r.data.path}`) : null;
  check("uploaded image is served", served?.status === 200 && served.headers.get("content-type") === "image/png");
  r = await req("POST", "/api/admin/uploads", { token: adminToken, raw: Buffer.from("<svg/>"), type: "image/png" });
  check("fake image refused (415)", r.status === 415);

  // ------------------------------------------------------------------
  section("Imported catalog products (numeric _id)");
  // The imported catalog stores products with numeric _ids instead of ObjectIds
  const importedId = 900000000 + Math.floor(Math.random() * 1000000);
  await Product.collection.insertOne({
    _id: importedId, id: importedId, name: { en: `ZZ Imported ${rand}` }, slug: `zz-imported-${rand}`,
    price: 6, stock: 2, category: category.slug, is_active: true, created_at: new Date(),
  });
  created.products.push(importedId);
  r = await req("POST", "/api/orders/quote", { token: otherToken, body: { items: [{ product: importedId, quantity: 2 }] } });
  check("quote for a product with a numeric _id", r.status === 200 && r.data.ok === true && r.data.subtotal === 12, JSON.stringify(r.data).slice(0, 200));
  r = await req("POST", "/api/orders", { token: otherToken, body: { items: [{ product: importedId, quantity: 1 }], shippingAddress: address } });
  check("order for a product with a numeric _id (201)", r.status === 201 && r.data.items?.[0]?.product === importedId && r.data.items?.[0]?.productId === importedId, JSON.stringify(r.data).slice(0, 300));
  const order3 = r.data;
  p = await Product.collection.findOne({ _id: importedId });
  check("its stock 2 → 1, sold 1, tracking on", p.stock === 1 && p.sold_count === 1 && p.track_inventory === true, JSON.stringify({ stock: p.stock, sold: p.sold_count }));
  r = await req("POST", "/api/orders", { token: otherToken, body: { items: [{ product: importedId, quantity: 2 }], shippingAddress: address } });
  check("more than its stock (409)", r.status === 409 && /Only 1 left/.test(r.data.message), JSON.stringify(r.data));
  r = await req("PATCH", `/api/orders/${order3._id}/cancel`, { token: otherToken });
  p = await Product.collection.findOne({ _id: importedId });
  check("cancelling restocks it (1 → 2, sold 0)", r.status === 200 && p.stock === 2 && p.sold_count === 0, JSON.stringify({ status: r.status, stock: p.stock, sold: p.sold_count }));
}

async function cleanup() {
  section("Cleanup");
  try {
    const users = await User.find({ username: { $in: created.users } }).select("_id").lean();
    const orders = await Order.deleteMany({ user: { $in: users.map((u) => u._id) } });
    const products = await Product.deleteMany({ id: { $in: created.products } });
    const categories = await Category.deleteMany({ _id: { $in: created.categories } });
    const coupons = await Coupon.deleteMany({ _id: { $in: created.coupons } });
    const subscribers = await Subscriber.deleteMany({ email: { $in: created.subscribers } });
    const removedUsers = await User.deleteMany({ username: { $in: created.users } });
    let files = 0;
    for (const upload of created.uploads) {
      const name = path.basename(upload);
      const file = path.join(__dirname, "..", "uploads", name);
      if (fs.existsSync(file)) { fs.unlinkSync(file); files++; }
      if (mongoose.connection.db) {
        const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "uploads" });
        for (const doc of await bucket.find({ filename: name }).toArray()) { await bucket.delete(doc._id); files++; }
      }
    }
    console.log(`  removed ${removedUsers.deletedCount} users, ${orders.deletedCount} orders, ${products.deletedCount} products, ${categories.deletedCount} categories, ${coupons.deletedCount} coupons, ${subscribers.deletedCount} subscribers, ${files} uploads`);
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .catch((err) => {
    failures.push(`aborted: ${err.message}`);
    console.error(err);
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log(`Failed: ${failures.join(" | ")}`);
      process.exitCode = 1;
    }
  });
