import dotenv from "dotenv";
dotenv.config();

import app from "../src/app.js";
import { connectDB } from "../src/db.js";

const CLIENT_URL = process.env.CLIENT_URL || "*";

export default async function handler(req, res) {
  try {
    await connectDB();
    return app(req, res);
  } catch (err) {
    // If the database connection itself fails (e.g. a slow cold start),
    // make sure the browser still gets a normal JSON response with CORS
    // headers instead of a raw network failure that looks like a CORS
    // error in the console.
    console.error("DB connection failed:", err.message);
    res.setHeader("Access-Control-Allow-Origin", CLIENT_URL);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(503).json({
      message: "The server is waking up — please try again in a few seconds.",
    });
  }
}
