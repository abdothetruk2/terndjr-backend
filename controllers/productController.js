const mongoose = require("mongoose");
const Product = require("../modules/product");
const Category = require("../modules/category");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");
const { STOCK_FILTERS } = require("../utils/inventory");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CATEGORY_TAG = "category-request:";

// price/rating are numbers in the imported data but strings when saved through
// the API (see the schema), so convert them before comparing or sorting.
const asNumber = (field) => ({ $convert: { input: field, to: "double", onError: null, onNull: null } });

// GET /api/products?sort=...  (default: by id)
const SORTS = {
  newest: { created_at: -1, id: 1 },
  popular: { reviews_count: -1, _rating: -1, id: 1 },
  rating: { _rating: -1, reviews_count: -1, id: 1 },
  discount: { discount: -1, id: 1 },
  "price-asc": { _price: 1, id: 1 },
  "price-desc": { _price: -1, id: 1 },
};

// Extra sorts for the admin product list (default: newest id first)
const ADMIN_SORTS = {
  ...SORTS,
  "id-desc": { id: -1 },
  "id-asc": { id: 1 },
  updated: { updated_at: -1, id: -1 },
  "name-asc": { "name.en": 1, id: 1 }, // replaced per request language in getAdminProducts
  "stock-asc": { stock: 1, id: 1 },
  "stock-desc": { stock: -1, id: 1 },
  "sold-desc": { sold_count: -1, id: -1 },
};

const round2 = (n) => Math.round(n * 100) / 100;
const IMAGE_PATTERN = /^(https?:\/\/\S+|\/?(media|uploads)\/[\w\-./]+)$/i;
const isCategoryTag = (tag) => typeof tag === "string" && tag.startsWith(CATEGORY_TAG);

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id)) throw httpError(400, "Product id must be a number");
  return id;
}

// Slugs of a category and its sub-categories.
// `value` can be the category slug, numeric id or MongoDB _id.
async function categorySlugs(value) {
  const match = [{ slug: value }];
  if (/^\d+$/.test(value)) match.push({ id: Number(value) });
  if (mongoose.isObjectIdOrHexString(value)) match.push({ _id: value });

  const category = await Category.findOne({ $or: match }).lean();
  if (!category) return []; // unknown category -> no products

  const children = category.id != null
    ? await Category.find({ parent_id: category.id }).select("slug").lean()
    : [];
  return [category, ...children].map((c) => c.slug);
}

// Products belong to a category through the `category` field (set from the admin
// dashboard) or a "category-request:<slug>" tag (imported data).
async function categoryClause(value) {
  const slugs = await categorySlugs(value);
  return {
    $or: [
      { category: { $in: slugs } },
      { tags: { $in: slugs.map((slug) => `${CATEGORY_TAG}${slug}`) } },
    ],
  };
}

// ?translation= on the admin list: products whose name is missing in a language
const TRANSLATED_LANGUAGES = ["de", "ar", "fr", "es"];
const missingIn = (lang) => ({ $or: [{ [`name.${lang}`]: { $exists: false } }, { [`name.${lang}`]: { $in: [null, ""] } }] });
const TRANSLATION_FILTERS = {
  missing: { $or: TRANSLATED_LANGUAGES.map(missingIn) },
  ...Object.fromEntries(TRANSLATED_LANGUAGES.map((lang) => [`missing-${lang}`, missingIn(lang)])),
  complete: Object.fromEntries(TRANSLATED_LANGUAGES.map((lang) => [`name.${lang}`, { $nin: [null, ""] }])),
};

const NO_CATEGORY_CLAUSE = {
  category: { $in: [null, ""] },
  tags: { $not: { $elemMatch: { $regex: `^${CATEGORY_TAG}` } } },
};

// The category slug a product belongs to (field first, then the imported tag)
function categoryOf(doc) {
  if (doc.category) return doc.category;
  if (Array.isArray(doc.tags)) {
    const tag = doc.tags.find(isCategoryTag);
    if (tag) return tag.slice(CATEGORY_TAG.length);
  }
  return null;
}

// Same JSON shape as the public API, plus the resolved `category_slug`
function toAdminJSON(doc) {
  const json = Product.hydrate(doc).toJSON();
  json.category_slug = categoryOf(doc);
  return json;
}

function cleanTags(value) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (value.length > 50 || value.some((tag) => typeof tag !== "string" || tag.length > 500)) {
      throw httpError(400, "tags must be a list of at most 50 texts");
    }
    return value;
  }
  if (v.isPlainObject(value)) {
    if (Object.keys(value).some((key) => key.startsWith("$") || key.includes("."))) {
      throw httpError(400, "tags keys may not start with $ or contain dots");
    }
    return value;
  }
  throw httpError(400, "tags must be a list or an object");
}

const MAX_IMAGES = 12;

// Gallery photos: a list of image paths/URLs (empty strings and repeats dropped)
function cleanImages(value) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, "images must be a list of image paths");
  const list = [];
  for (const item of value) {
    if (typeof item !== "string") throw httpError(400, "images must be a list of image paths");
    const image = item.trim();
    if (!image) continue;
    if (image.length > 1000 || !IMAGE_PATTERN.test(image)) {
      throw httpError(400, "each image must be an http(s) URL or a media/ or uploads/ path");
    }
    if (!list.includes(image)) list.push(image);
  }
  if (list.length > MAX_IMAGES) throw httpError(400, `images can hold at most ${MAX_IMAGES} photos`);
  return list;
}

// Validates a create/update body and returns only known, cleaned fields.
// partial = true for updates (nothing is required).
async function cleanProductInput(body, { partial }) {
  if (body === undefined || body === null) body = {};
  if (!v.isPlainObject(body)) throw httpError(400, "Request body must be a JSON object");
  const out = {};

  const name = v.localized(body.name, "name", { requireEn: !partial, nonEmptyEn: true, max: 200 });
  if (name) out.name = name;
  const description = v.localized(body.description, "description", { max: 5000 });
  if (description) out.description = description;
  if (body.seo !== undefined && body.seo !== null) {
    if (!v.isPlainObject(body.seo)) throw httpError(400, "seo must be an object like { title, description }");
    const seo = {};
    const title = v.localized(body.seo.title, "seo.title", { max: 120 });
    if (title) seo.title = title;
    const metaDescription = v.localized(body.seo.description, "seo.description", { max: 300 });
    if (metaDescription) seo.description = metaDescription;
    if (Object.keys(seo).length) out.seo = seo;
  }

  if (body.slug !== undefined && body.slug !== null && body.slug !== "") out.slug = v.slug(body.slug);
  if (body.sku !== undefined) out.sku = v.text(body.sku, "sku", { max: 64, allowEmpty: true }) ?? "";
  if (body.brand !== undefined) out.brand = v.text(body.brand, "brand", { max: 100, allowEmpty: true }) ?? "";

  const price = v.number(body.price, "price", { required: !partial, min: 0, max: 1000000 });
  if (price !== undefined) out.price = String(round2(price));
  if (body.old_price !== undefined) {
    const oldPrice = v.number(body.old_price, "old_price", { min: 0, max: 1000000 });
    out.old_price = oldPrice === undefined ? null : String(round2(oldPrice));
  }
  if (body.discount !== undefined) {
    out.discount = v.number(body.discount, "discount", { min: 0, max: 100, integer: true }) ?? 0;
  }
  if (body.rating !== undefined) {
    const rating = v.number(body.rating, "rating", { min: 0, max: 5 });
    out.rating = String(rating ?? 0);
  }
  if (body.reviews_count !== undefined) {
    out.reviews_count = v.number(body.reviews_count, "reviews_count", { min: 0, max: 1e9, integer: true }) ?? 0;
  }
  if (body.stock !== undefined) {
    out.stock = v.number(body.stock, "stock", { min: 0, max: 1000000, integer: true }) ?? 0;
  }
  if (body.reward_points !== undefined) {
    out.reward_points = v.number(body.reward_points, "reward_points", { min: 0, max: 1000000, integer: true }) ?? 0;
  }
  if (body.image !== undefined) {
    const image = v.text(body.image, "image", { max: 1000, allowEmpty: true }) ?? "";
    if (image && !IMAGE_PATTERN.test(image)) {
      throw httpError(400, "image must be an http(s) URL or a media/ or uploads/ path");
    }
    out.image = image;
  }
  if (body.images !== undefined) out.images = cleanImages(body.images);
  for (const flag of ["featured", "flash_sale", "is_active", "track_inventory"]) {
    const value = v.boolean(body[flag], flag);
    if (value !== undefined) out[flag] = value;
  }
  if (body.tags !== undefined) out.tags = cleanTags(body.tags);
  if (body.category !== undefined) {
    if (body.category === null || body.category === "") {
      out.category = null;
    } else {
      const slug = v.slug(body.category, "category");
      if (!(await Category.exists({ slug }))) throw httpError(400, `Unknown category: ${slug}`);
      out.category = slug;
    }
  }
  return out;
}

// A free slug based on `base` ("gold-necklace", then "gold-necklace-123")
async function uniqueSlug(base, id) {
  const slug = base || `product-${id}`;
  if (!(await Product.exists({ slug }))) return slug;
  return `${slug}-${id}`;
}

// GET /api/products?brand=&featured=true&search=
//   &category=&discounted=true&maxPrice=&ids=&sort=&page=&limit=
async function getAllProducts(req, res) {
  const { brand, featured, search, category, discounted, maxPrice, ids, sort, page, limit } = req.query;
  const filter = { is_active: { $ne: false } };

  // ?ids=12,15,40 -> only these products (the cart refreshes its prices with it)
  if (ids !== undefined) {
    const list = String(ids).split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 0 || list.length > MAX_LIMIT || list.some((s) => !/^\d{1,12}$/.test(s))) {
      throw httpError(400, `ids must be a comma-separated list of up to ${MAX_LIMIT} product ids`);
    }
    filter.id = { $in: list.map(Number) };
  }
  if (brand) filter.brand = String(brand);
  if (featured !== undefined) filter.featured = featured === "true";
  if (search) {
    // Names in every language, so a German or Arabic word finds the product too
    const rx = new RegExp(v.escapeRegex(String(search).trim()), "i");
    filter.$or = [...v.STORE_LANGUAGES.map((lang) => ({ [`name.${lang}`]: rx })), { brand: rx }];
  }
  if (category) filter.$and = [await categoryClause(String(category))];
  if (discounted === "true") filter.discount = { $gt: 0 };
  if (maxPrice !== undefined && maxPrice !== "") {
    const max = Number(maxPrice);
    if (!Number.isFinite(max)) throw httpError(400, "maxPrice must be a number");
    filter.$expr = { $lte: [asNumber("$price"), max] };
  }

  const pipeline = [
    { $match: filter },
    { $addFields: { _price: asNumber("$price"), _rating: asNumber("$rating") } },
    { $sort: SORTS[sort] || { id: 1 } },
  ];

  // Pagination is opt-in, so clients that don't send page/limit still get the full list.
  // The total number of matches is sent in the X-Total-Count header.
  if (page !== undefined || limit !== undefined) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
    const [count] = await Product.aggregate([{ $match: filter }, { $count: "total" }]);
    res.set("X-Total-Count", String(count?.total ?? 0));
    pipeline.push({ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum });
  }

  pipeline.push({ $project: { _price: 0, _rating: 0 } });
  const docs = await Product.aggregate(pipeline);

  // hydrate() gives the exact same JSON shape as Product.find()
  res.json(docs.map((doc) => Product.hydrate(doc)));
}

// GET /api/products/flash
async function getFlashProducts(req, res) {
  const products = await Product.find({ flash_sale: true, is_active: { $ne: false } }).sort({ id: 1 });
  res.json(products);
}

// GET /api/products/:id   (hidden products are not served to the store)
async function getOneProduct(req, res) {
  const product = await Product.findOne({ id: parseId(req.params.id), is_active: { $ne: false } });
  if (!product) throw httpError(404, "Product not found");
  res.json(product);
}

// GET /api/admin/products?search=&category=&status=&stock=&flag=&sort=&page=&limit=   (admin)
// Includes hidden products. Always paginated; the total is in X-Total-Count.
async function getAdminProducts(req, res) {
  const { search, category } = req.query;
  const status = v.oneOf(req.query.status, "status", ["active", "inactive"]);
  // "none" is the old name of "out"
  const stockParam = req.query.stock === "none" ? "out" : req.query.stock;
  const stock = v.oneOf(stockParam, "stock", Object.keys(STOCK_FILTERS));
  const flag = v.oneOf(req.query.flag, "flag", ["featured", "flash", "discounted"]);
  const translation = v.oneOf(req.query.translation, "translation", Object.keys(TRANSLATION_FILTERS));
  const sort = v.oneOf(req.query.sort, "sort", Object.keys(ADMIN_SORTS));
  const { limit, skip } = v.pagination(req.query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

  const and = [];
  const term = typeof search === "string" ? search.trim() : "";
  if (term) {
    const rx = new RegExp(v.escapeRegex(term), "i");
    const or = [...v.STORE_LANGUAGES.map((lang) => ({ [`name.${lang}`]: rx })), { brand: rx }, { sku: rx }, { slug: rx }];
    if (/^\d+$/.test(term)) or.push({ id: Number(term) });
    and.push({ $or: or });
  }
  if (category === "none") and.push(NO_CATEGORY_CLAUSE);
  else if (category) and.push(await categoryClause(String(category)));
  if (status === "active") and.push({ is_active: { $ne: false } });
  if (status === "inactive") and.push({ is_active: false });
  if (stock) and.push(STOCK_FILTERS[stock]);
  if (flag === "featured") and.push({ featured: true });
  if (flag === "flash") and.push({ flash_sale: true });
  if (flag === "discounted") and.push({ discount: { $gt: 0 } });
  if (translation) and.push(TRANSLATION_FILTERS[translation]);

  const filter = and.length ? { $and: and } : {};
  // "Name A–Z" in the admin's language (English for products without that translation)
  const sortSpec = sort === "name-asc" ? { [`name.${req.lang || "en"}`]: 1, "name.en": 1, id: 1 } : null;
  const [[count], docs] = await Promise.all([
    Product.aggregate([{ $match: filter }, { $count: "total" }]),
    Product.aggregate([
      { $match: filter },
      { $addFields: { _price: asNumber("$price"), _rating: asNumber("$rating") } },
      { $sort: sortSpec || ADMIN_SORTS[sort] || ADMIN_SORTS["id-desc"] },
      { $skip: skip },
      { $limit: limit },
      { $project: { _price: 0, _rating: 0 } },
    ]),
  ]);

  res.set("X-Total-Count", String(count?.total ?? 0));
  res.json(docs.map(toAdminJSON));
}

// GET /api/admin/products/:id   (admin, includes hidden products)
async function getAdminProduct(req, res) {
  const doc = await Product.findOne({ id: parseId(req.params.id) }).lean();
  if (!doc) throw httpError(404, "Product not found");
  res.json(toAdminJSON(doc));
}

// POST /api/products   (admin)
async function createProduct(req, res) {
  const data = await cleanProductInput(req.body, { partial: false });

  // Use the given numeric id, or the next free one
  if (req.body?.id !== undefined) {
    data.id = parseId(req.body.id);
  } else {
    const last = await Product.findOne().sort({ id: -1 }).select("id");
    data.id = (last?.id ?? 0) + 1;
  }

  if (!data.slug) data.slug = await uniqueSlug(v.slugify(data.name.en), data.id);
  if (!data.sku) delete data.sku; // sku is unique when present, so never store an empty one
  if (data.category === null) delete data.category;
  if (data.discount === undefined && data.old_price && Number(data.old_price) > Number(data.price)) {
    data.discount = Math.round((1 - Number(data.price) / Number(data.old_price)) * 100);
  }

  const product = await Product.create(data);
  res.status(201).json(product);
}

// PUT/PATCH /api/products/:id   (admin) — partial update
async function updateProduct(req, res) {
  const id = parseId(req.params.id);
  const data = await cleanProductInput(req.body, { partial: true });
  if (Object.keys(data).length === 0) throw httpError(400, "No valid fields to update");

  const $set = {};
  const $unset = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "name" || key === "description") {
      // Only the languages that were sent; other translations stay untouched
      for (const [lang, translated] of Object.entries(value)) $set[`${key}.${lang}`] = translated;
    } else if (key === "seo") {
      for (const [field, texts] of Object.entries(value)) {
        for (const [lang, translated] of Object.entries(texts)) $set[`seo.${field}.${lang}`] = translated;
      }
    } else if ((key === "sku" || key === "category") && !value) {
      $unset[key] = "";
    } else {
      $set[key] = value;
    }
  }

  // Changing the category: drop the imported "category-request:" tags so the
  // product doesn't also stay in its old category.
  if ("category" in data && !("tags" in data)) {
    const current = await Product.findOne({ id }).select("tags").lean();
    if (!current) throw httpError(404, "Product not found");
    if (Array.isArray(current.tags) && current.tags.some(isCategoryTag)) {
      $set.tags = current.tags.filter((tag) => !isCategoryTag(tag));
    }
  }

  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;

  const product = await Product.findOneAndUpdate({ id }, update, { returnDocument: "after", runValidators: true });
  if (!product) throw httpError(404, "Product not found");
  res.json(product);
}

// DELETE /api/products/:id   (admin)
// Orders keep their own copy of name, price and image, so order history survives.
async function deleteProduct(req, res) {
  const product = await Product.findOneAndDelete({ id: parseId(req.params.id) });
  if (!product) throw httpError(404, "Product not found");
  res.json({ message: "Product deleted", id: product.id });
}

module.exports = {
  getAllProducts,
  getFlashProducts,
  getOneProduct,
  getAdminProducts,
  getAdminProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  categoryOf,
};
