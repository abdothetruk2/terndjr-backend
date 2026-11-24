const Subscriber = require("../modules/subscriber");
const httpError = require("../utils/httpError");
const v = require("../utils/validate");

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

// POST /api/newsletter   (public)  Body: { email }
// Always answers the same way for new and existing addresses, so the form
// can't be used to find out who is subscribed.
async function subscribe(req, res) {
  const email = v.text(req.body?.email, "email", { required: true, max: 254 }).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw httpError(400, "Please enter a valid email address");

  await Subscriber.updateOne(
    { email },
    { $setOnInsert: { email, source: "footer" } },
    { upsert: true }
  );
  res.status(201).json({ message: "Thanks! You're on the list." });
}

// GET /api/admin/subscribers?search=&page=&limit=   (admin) — total in X-Total-Count
async function listSubscribers(req, res) {
  const { limit, skip } = v.pagination(req.query, { defaultLimit: 20, maxLimit: 200 });
  const term = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const filter = term ? { email: new RegExp(v.escapeRegex(term), "i") } : {};

  const [total, subscribers] = await Promise.all([
    Subscriber.countDocuments(filter),
    Subscriber.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.set("X-Total-Count", String(total));
  res.json(subscribers);
}

// DELETE /api/admin/subscribers/:id   (admin)
async function deleteSubscriber(req, res) {
  v.objectId(req.params.id, "subscriber id");
  const removed = await Subscriber.findByIdAndDelete(req.params.id);
  if (!removed) throw httpError(404, "Subscriber not found");
  res.json({ message: "Subscriber removed", id: String(removed._id) });
}

module.exports = { subscribe, listSubscribers, deleteSubscriber };
