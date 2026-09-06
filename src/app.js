import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import ticketRoutes from "./routes/tickets.js";
import assistantRoutes from "./routes/assistant.js";import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import ticketRoutes from "./routes/tickets.js";

const app = express();

const CLIENT_URL = process.env.CLIENT_URL || "*";

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use("/api/auth", authRoutes);
app.use("/api/tickets", ticketRoutes);

app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

export default app;

const app = express();

const CLIENT_URL = process.env.CLIENT_URL || "*";

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use("/api/account", authRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/assistant", assistantRoutes);

app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

export default app;
