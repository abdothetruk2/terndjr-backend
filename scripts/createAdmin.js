// Gives an existing account admin access (and unblocks it).
//
//   npm run make-admin -- <username or email>
//
// Register the account on the website first, then run this once. After that,
// more admins can be added from the dashboard (Customers > Make admin).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const User = require("../modules/user");

async function main() {
  const login = (process.argv[2] || "").trim();
  if (!login) {
    console.error("Usage: npm run make-admin -- <username or email>");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/trendjr");
  try {
    const user = await User.findOne({ $or: [{ username: login }, { email: login.toLowerCase() }] });
    if (!user) {
      console.error(`No account found with username or email "${login}". Register it on the website first.`);
      process.exitCode = 1;
      return;
    }
    await User.updateOne({ _id: user._id }, { $set: { role: "admin", isBlocked: false } });
    console.log(`"${user.username || user.email}" is now an admin. Sign in again to open /admin.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
