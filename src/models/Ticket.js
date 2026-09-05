import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderRole: { type: String, enum: ["customer", "agent"], required: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

const ticketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: String, required: true, unique: true },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    category: { type: String, default: "General" },
    priority: { type: String, enum: ["Low", "Medium", "High"], default: "Medium" },
    aiSummary: { type: String, default: "" },
    aiSuggestion: {
      category: String,
      priority: String,
      summary: String,
      source: { type: String, enum: ["ai", "heuristic", "failed"], default: "heuristic" },
    },
    aiReviewed: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["New", "Assigned", "In Progress", "Resolved"],
      default: "New",
    },
    resolutionNote: { type: String, default: "" },

    messages: [messageSchema],
  },
  { timestamps: true }
);

export default mongoose.model("Ticket", ticketSchema);
