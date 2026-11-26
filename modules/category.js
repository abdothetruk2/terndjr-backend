const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({

    // Public numeric id. Sub-categories point to their parent through `parent_id`.
    // Imported categories already have one; new ones get the next free number.
    id: {
        type: Number,
        index: true
    },

    // Numeric `id` of the parent category, null for a top-level category
    parent_id: {
        type: Number,
        default: null
    },

    // Imported categories store a localized name ({ en, de, ar, ... });
    // categories created through the API may use a plain string.
    // (A String type here made Mongoose drop the localized names from every response.)
    name: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
        unique: true
    },

    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },

    // Localized short text shown under the name (imported data)
    subtitle: {
        type: mongoose.Schema.Types.Mixed
    },

    sort_order: {
        type: Number,
        default: 0
    },

    image: {
        type: String
    },

    // Localized text { en, de, ar } (older categories may hold a plain string)
    description: {
        type: mongoose.Schema.Types.Mixed
    },

    // Imported categories use `is_active`, ones created through the API use `isActive`.
    // The API keeps both in sync; a category is shown only when neither is false.
    isActive: {
        type: Boolean,
        default: true
    },

    is_active: {
        type: Boolean
    }

}, { timestamps: true });

module.exports = mongoose.model("Category", categorySchema);
