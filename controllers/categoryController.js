const mongoose = require("mongoose");
const Category = require("../modules/category");
const Product = require("../modules/product");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");

const CATEGORY_TAG = "category-request:";
const IMAGE_PATTERN = /^(https?:\/\/\S+|\/?(media|uploads)\/[\w\-./]+)$/i;

function checkId(id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(400, "Invalid category id");
}

const isActive = (c) => c.isActive !== false && c.is_active !== false;

// English name, whether the category stores a plain string or { en, de, ... }
const englishName = (name) => (typeof name === "string" ? name : name?.en || "");

// Validates a create/update body. `current` is the stored category (updates only).
async function cleanCategoryInput(body, { partial, current = null }) {
  if (body === undefined || body === null) body = {};
  if (!v.isPlainObject(body)) throw httpError(400, "Request body must be a JSON object");
  const out = {};

  const name = v.localized(body.name, "name", { requireEn: !partial, nonEmptyEn: true, max: 100 });
  if (name) {
    if (name.en) {
      const rx = new RegExp(`^${v.escapeRegex(name.en)}$`, "i");
      const clash = await Category.exists({
        $or: [{ "name.en": rx }, { name: rx }],
        ...(current ? { _id: { $ne: current._id } } : {}),
      });
      if (clash) throw httpError(409, "A category with this name already exists");
    }
    out.name = name;
  }

  if (body.slug !== undefined && body.slug !== null && body.slug !== "") {
    out.slug = v.slug(body.slug);
    if (!current || out.slug !== current.slug) {
      if (await Category.exists({ slug: out.slug })) throw httpError(409, "A category with this slug already exists");
    }
  }

  // Localized texts ({ en, de, ar } or a plain string = English)
  if (body.description !== undefined && body.description !== null) {
    out.description = v.localized(body.description, "description", { max: 1000 });
  }
  if (body.subtitle !== undefined && body.subtitle !== null) {
    out.subtitle = v.localized(body.subtitle, "subtitle", { max: 200 });
  }
  if (body.image !== undefined) {
    const image = v.text(body.image, "image", { max: 1000, allowEmpty: true }) ?? "";
    if (image && !IMAGE_PATTERN.test(image)) {
      throw httpError(400, "image must be an http(s) URL or a media/ or uploads/ path");
    }
    out.image = image;
  }

  const active = v.boolean(body.isActive ?? body.is_active, "isActive");
  if (active !== undefined) out.isActive = active;

  const sortOrder = v.number(body.sort_order, "sort_order", { min: -100000, max: 100000, integer: true });
  if (sortOrder !== undefined) out.sort_order = sortOrder;

  if (body.parent_id !== undefined) {
    if (body.parent_id === null || body.parent_id === "") {
      out.parent_id = null;
    } else {
      const parentId = v.number(body.parent_id, "parent_id", { integer: true, min: 0 });
      if (current && current.id === parentId) throw httpError(400, "A category can't be its own parent");
      const parent = await Category.findOne({ id: parentId }).lean();
      if (!parent) throw httpError(400, "Parent category not found");
      if (parent.parent_id != null) throw httpError(400, "Sub-categories can't have sub-categories of their own");
      if (current && current.id != null && (await Category.exists({ parent_id: current.id }))) {
        throw httpError(400, "This category has sub-categories, so it must stay a top-level category");
      }
      out.parent_id = parentId;
    }
  }

  return out;
}

// GET /api/categories            (?counts=true adds productCount: visible products,
// sub-categories counted on their own; the store adds children to their parent)
async function getCategories(req, res) {
  // Imported categories use `is_active`, ones created through the API use `isActive`
  const query = Category.find({
    is_active: { $ne: false },
    isActive: { $ne: false },
  }).sort({ name: 1 });

  if (req.query.counts === "true") {
    const [categories, counts] = await Promise.all([query, productCounts({ visibleOnly: true })]);
    return res.json(categories.map((c) => ({ ...c.toJSON(), productCount: counts.get(c.slug) || 0 })));
  }
  res.json(await query);
}

// GET /api/categories/:id
async function getCategory(req, res) {
  checkId(req.params.id);
  const category = await Category.findById(req.params.id);
  if (!category) throw httpError(404, "Category not found");
  res.json(category);
}

// Products per category slug, through the `category` field or the imported
// "category-request:<slug>" tag. visibleOnly: count only products shown in the store.
async function productCounts({ visibleOnly = false } = {}) {
  const visible = visibleOnly ? { is_active: { $ne: false } } : {};
  const [tagCounts, fieldCounts] = await Promise.all([
    Product.aggregate([
      { $match: { ...visible, tags: { $type: "array" } } },
      { $unwind: "$tags" },
      { $match: { tags: { $regex: `^${CATEGORY_TAG}` } } },
      { $group: { _id: "$tags", n: { $sum: 1 } } },
    ]),
    Product.aggregate([
      { $match: { ...visible, category: { $nin: [null, ""] } } },
      { $group: { _id: "$category", n: { $sum: 1 } } },
    ]),
  ]);

  const counts = new Map();
  for (const { _id, n } of tagCounts) {
    const slug = _id.slice(CATEGORY_TAG.length);
    counts.set(slug, (counts.get(slug) || 0) + n);
  }
  for (const { _id, n } of fieldCounts) counts.set(_id, (counts.get(_id) || 0) + n);
  return counts;
}

// GET /api/admin/categories   (admin)
// Every category (hidden ones too) with its number of products.
async function getAdminCategories(req, res) {
  const [categories, counts] = await Promise.all([
    Category.find().sort({ sort_order: 1, slug: 1 }).lean(),
    productCounts(),
  ]);
  res.json(categories.map((c) => ({ ...c, isActive: isActive(c), productCount: counts.get(c.slug) || 0 })));
}

// POST /api/categories   (admin)
async function createCategory(req, res) {
  const data = await cleanCategoryInput(req.body, { partial: false });

  // Store only the languages that were filled in
  const filled = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value));
  data.name = filled(data.name);
  if (data.description) data.description = filled(data.description);
  if (data.subtitle) data.subtitle = filled(data.subtitle);
  if (!data.slug) {
    data.slug = v.slugify(data.name.en);
    if (!data.slug) throw httpError(400, "slug is required");
    if (await Category.exists({ slug: data.slug })) throw httpError(409, "A category with this slug already exists");
  }

  const last = await Category.findOne({ id: { $ne: null } }).sort({ id: -1 }).select("id").lean();
  data.id = (last?.id ?? 0) + 1;
  data.isActive = data.isActive ?? true;
  data.is_active = data.isActive;
  if (data.parent_id === undefined) data.parent_id = null;

  const category = await Category.create(data);
  res.status(201).json(category);
}

// PUT/PATCH /api/categories/:id   (admin) — partial update
async function updateCategory(req, res) {
  checkId(req.params.id);
  const current = await Category.findById(req.params.id).lean();
  if (!current) throw httpError(404, "Category not found");

  const data = await cleanCategoryInput(req.body, { partial: true, current });
  if (Object.keys(data).length === 0) throw httpError(400, "No valid fields to update");

  const $set = { ...data };
  if (data.name) {
    // Merge with the stored translations (fr, tr, ... stay); an empty
    // translation removes that language, English always stays.
    const merged = typeof current.name === "string" ? { en: current.name } : { ...(current.name || {}) };
    for (const [lang, value] of Object.entries(data.name)) {
      if (value) merged[lang] = value;
      else if (lang !== "en") delete merged[lang];
    }
    if (!merged.en) merged.en = englishName(current.name);
    $set.name = merged;
  }
  // Description / subtitle: merge the sent languages into the stored ones
  // (an empty text removes that language; a plain stored string counts as English)
  for (const key of ["description", "subtitle"]) {
    if (!data[key]) continue;
    const stored = current[key];
    const merged = typeof stored === "string" ? (stored ? { en: stored } : {}) : { ...(stored || {}) };
    for (const [lang, value] of Object.entries(data[key])) {
      if (value) merged[lang] = value;
      else delete merged[lang];
    }
    $set[key] = merged;
  }
  if ("isActive" in data) $set.is_active = data.isActive; // keep both flags in sync

  const category = await Category.findByIdAndUpdate(current._id, { $set }, { returnDocument: "after", runValidators: true });

  // A new slug: move the products that pointed at the old one
  if (data.slug && data.slug !== current.slug) {
    await Promise.all([
      Product.updateMany({ category: current.slug }, { $set: { category: data.slug } }),
      Product.updateMany(
        { tags: `${CATEGORY_TAG}${current.slug}` },
        { $set: { "tags.$": `${CATEGORY_TAG}${data.slug}` } }
      ),
    ]);
  }

  res.json(category);
}

// DELETE /api/categories/:id   (admin)
// Refused while sub-categories or products still use the category (409).
async function deleteCategory(req, res) {
  checkId(req.params.id);
  const category = await Category.findById(req.params.id).lean();
  if (!category) throw httpError(404, "Category not found");

  const children = category.id != null ? await Category.countDocuments({ parent_id: category.id }) : 0;
  if (children) {
    throw httpError(409, `Move or delete its ${children} sub-categor${children === 1 ? "y" : "ies"} first`);
  }
  const products = await Product.countDocuments({
    $or: [{ category: category.slug }, { tags: `${CATEGORY_TAG}${category.slug}` }],
  });
  if (products) {
    throw httpError(
      409,
      `${products} product${products === 1 ? " is" : "s are"} in this category. Move ${products === 1 ? "it" : "them"} to another category, or hide the category instead.`
    );
  }

  await Category.deleteOne({ _id: category._id });
  res.json({ message: "Category deleted", id: String(category._id) });
}

module.exports = {
  getCategories,
  getCategory,
  getAdminCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
