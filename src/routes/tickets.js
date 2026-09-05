import express from "express";
import Ticket from "../models/Ticket.js";
import User from "../models/User.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { generateTicketNumber } from "../utils/generateTicketNumber.js";
import { triageTicket, chatAboutTicket } from "../services/aiTriage.js";

const router = express.Router();
router.use(requireAuth);

function getIO(req) {
  return req.app.get("io");
}

// Customer creates a ticket. AI triage runs immediately; suggestion is
// stored separately from the final fields until an agent reviews it.
router.post("/", requireRole("customer"), async (req, res) => {
  try {
    const { subject, description, category } = req.body;
    if (!subject || !description) {
      return res.status(400).json({ message: "Subject and description are required" });
    }

    const suggestion = await triageTicket(subject, description);

    const ticket = await Ticket.create({
      ticketNumber: generateTicketNumber(),
      subject,
      description,
      customer: req.user.id,
      category: category || suggestion.category,
      priority: suggestion.priority,
      aiSuggestion: suggestion,
      aiReviewed: false,
      status: "New",
    });

    getIO(req)?.emit("ticket:created", { ticketId: ticket._id });

    res.status(201).json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not create ticket", error: err.message });
  }
});

// Customer: list own tickets. Agent: list all (optionally filter by status).
router.get("/", async (req, res) => {
  try {
    const filter = req.user.role === "customer" ? { customer: req.user.id } : {};
    if (req.query.status) filter.status = req.query.status;

    const tickets = await Ticket.find(filter)
      .populate("customer", "name email")
      .populate("agent", "name email")
      .sort({ createdAt: -1 });

    res.json(tickets);
  } catch (err) {
    res.status(500).json({ message: "Could not fetch tickets", error: err.message });
  }
});

// Basic dashboard statistics (agents/admin).
router.get("/stats", requireRole("agent"), async (req, res) => {
  try {
    const [total, byStatus, byPriority] = await Promise.all([
      Ticket.countDocuments(),
      Ticket.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Ticket.aggregate([{ $group: { _id: "$priority", count: { $sum: 1 } } }]),
    ]);
    res.json({ total, byStatus, byPriority });
  } catch (err) {
    res.status(500).json({ message: "Could not fetch stats", error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate("customer", "name email")
      .populate("agent", "name email")
      .populate("messages.sender", "name role");

    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    if (req.user.role === "customer" && String(ticket.customer._id) !== req.user.id) {
      return res.status(403).json({ message: "You can only view your own tickets" });
    }

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not fetch ticket", error: err.message });
  }
});

// AI assistant chat scoped to this one ticket. Stateless on the server —
// the client sends back the short recent history each turn — so there's
// nothing new to migrate on the Ticket model.
router.post("/:id/assistant", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: "A message is required" });
    }

    const ticket = await Ticket.findById(req.params.id)
      .populate("customer", "name email")
      .populate("agent", "name email");

    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    if (req.user.role === "customer" && String(ticket.customer._id) !== req.user.id) {
      return res.status(403).json({ message: "You can only ask about your own tickets" });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
          .slice(-6)
      : [];

    const result = await chatAboutTicket(ticket, safeHistory, message.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Could not reach the assistant", error: err.message });
  }
});

// Agent claims/assigns a ticket to themself.
router.patch("/:id/assign", requireRole("agent"), async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    if (ticket.status === "Resolved") {
      return res.status(400).json({ message: "Resolved tickets cannot be reassigned" });
    }

    ticket.agent = req.user.id;
    if (ticket.status === "New") ticket.status = "Assigned";
    await ticket.save();

    getIO(req)?.to(`ticket:${ticket._id}`).emit("ticket:updated", ticket);
    getIO(req)?.emit("ticket:list-changed");

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not assign ticket", error: err.message });
  }
});

// Agent reviews/edits the AI suggestion and finalizes category/priority.
router.patch("/:id/review-ai", requireRole("agent"), async (req, res) => {
  try {
    const { category, priority, summary } = req.body;
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    if (!["Low", "Medium", "High"].includes(priority)) {
      return res.status(400).json({ message: "Priority must be Low, Medium or High" });
    }

    ticket.category = category || ticket.category;
    ticket.priority = priority || ticket.priority;
    ticket.aiSummary = summary || ticket.aiSuggestion?.summary || "";
    ticket.aiReviewed = true;
    if (ticket.status === "New") ticket.status = "Assigned";
    await ticket.save();

    getIO(req)?.to(`ticket:${ticket._id}`).emit("ticket:updated", ticket);
    getIO(req)?.emit("ticket:list-changed");

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not save AI review", error: err.message });
  }
});

// Add a message to the ticket conversation (customer or assigned agent).
router.post("/:id/messages", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: "Message text is required" });

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    if (req.user.role === "customer" && String(ticket.customer) !== req.user.id) {
      return res.status(403).json({ message: "You can only message your own tickets" });
    }
    if (ticket.status === "Resolved") {
      return res.status(400).json({ message: "This ticket is resolved. Ask the agent to reopen it first." });
    }

    ticket.messages.push({ sender: req.user.id, senderRole: req.user.role, text: text.trim() });
    if (req.user.role === "agent" && ticket.status === "Assigned") ticket.status = "In Progress";
    await ticket.save();

    const populated = await ticket.populate("messages.sender", "name role");

    getIO(req)?.to(`ticket:${ticket._id}`).emit("ticket:message", {
      ticketId: ticket._id,
      message: populated.messages[populated.messages.length - 1],
      status: ticket.status,
    });
    getIO(req)?.emit("ticket:list-changed");

    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: "Could not send message", error: err.message });
  }
});

// Update status (e.g. move to In Progress) — not for resolving, that needs a note.
router.patch("/:id/status", requireRole("agent"), async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ["Assigned", "In Progress"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `Status must be one of: ${allowed.join(", ")}` });
    }

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    if (ticket.status === "Resolved") {
      return res.status(400).json({ message: "Reopen the ticket before changing its status" });
    }

    ticket.status = status;
    await ticket.save();

    getIO(req)?.to(`ticket:${ticket._id}`).emit("ticket:updated", ticket);
    getIO(req)?.emit("ticket:list-changed");

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not update status", error: err.message });
  }
});

// Resolve — requires a resolution note.
router.patch("/:id/resolve", requireRole("agent"), async (req, res) => {
  try {
    const { resolutionNote } = req.body;
    if (!resolutionNote || !resolutionNote.trim()) {
      return res.status(400).json({ message: "A resolution note is required to resolve a ticket" });
    }

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    ticket.status = "Resolved";
    ticket.resolutionNote = resolutionNote.trim();
    ticket.messages.push({ sender: req.user.id, senderRole: "agent", text: `Resolved: ${resolutionNote.trim()}` });
    await ticket.save();

    getIO(req)?.to(`ticket:${ticket._id}`).emit("ticket:updated", ticket);
    getIO(req)?.emit("ticket:list-changed");

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not resolve ticket", error: err.message });
  }
});

// Reopen a resolved ticket.
router.patch("/:id/reopen", requireRole("agent"), async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    ticket.status = "In Progress";
    await ticket.save();

    getIO(req)?.to(`ticket:${ticket._id}`).emit("ticket:updated", ticket);
    getIO(req)?.emit("ticket:list-changed");

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ message: "Could not reopen ticket", error: err.message });
  }
});

export default router;