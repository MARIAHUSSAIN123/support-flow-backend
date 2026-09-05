// Local development entry point. On Vercel, api/index.js is used instead.
import dotenv from "dotenv";
dotenv.config();

import app from "./src/app.js";
import { connectDB } from "./src/db.js";

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`SupportFlow API running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });
