// AI triage service.
//
// Default provider: Groq (https://console.groq.com) — free API keys with a
// generous free tier, OpenAI-compatible chat endpoint, fast inference.
// If GROQ_API_KEY is missing, the call fails, or it times out, we fall back
// to a deterministic keyword-based heuristic so ticket creation never
// breaks (per the "AI must not block the workflow" business rule).

const CATEGORY_KEYWORDS = {
  Billing: ["charge", "charged", "refund", "payment", "invoice", "billing", "subscription", "price", "money"],
  Technical: ["bug", "error", "crash", "not working", "broken", "login", "password", "app", "website", "loading"],
  Shipping: ["delivery", "shipment", "package", "order", "tracking", "shipped", "courier", "late"],
  Account: ["account", "profile", "email change", "verify", "verification", "locked", "signup", "register"],
};

const URGENT_KEYWORDS = ["urgent", "immediately", "asap", "twice", "fraud", "unauthorized", "angry", "legal", "cannot access", "down"];

function heuristicTriage(subject, description) {
  const text = `${subject} ${description}`.toLowerCase();

  let bestCategory = "General";
  let bestScore = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.reduce((acc, kw) => (text.includes(kw) ? acc + 1 : acc), 0);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  const urgentHits = URGENT_KEYWORDS.reduce((acc, kw) => (text.includes(kw) ? acc + 1 : acc), 0);
  const priority = urgentHits >= 2 ? "High" : urgentHits === 1 ? "Medium" : "Low";

  const trimmedDesc = description.length > 140 ? description.slice(0, 140).trim() + "..." : description;
  const summary = `Possible ${bestCategory.toLowerCase()} issue: ${trimmedDesc}`;

  return { category: bestCategory, priority, summary, source: "heuristic" };
}

async function callGroq(subject, description) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No GROQ_API_KEY configured");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You are a support ticket triage assistant. Respond ONLY with strict JSON " +
              '(no markdown, no preamble) in this exact shape: {"category": "Billing|Technical|Shipping|Account|General", ' +
              '"priority": "Low|Medium|High", "summary": "one short sentence"}.',
          },
          {
            role: "user",
            content: `Subject: ${subject}\nDescription: ${description}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      category: parsed.category || "General",
      priority: parsed.priority || "Medium",
      summary: parsed.summary || "AI summary unavailable.",
      source: "ai",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function triageTicket(subject, description) {
  try {
    return await callGroq(subject, description);
  } catch (err) {
    // AI failed or timed out — fall back to heuristic so the ticket can
    // still be handled manually, per the hackathon's resilience rule.
    return heuristicTriage(subject, description);
  }
}

// ---------------------------------------------------------------------
// Ticket-aware assistant chatbot.
//
// Lets a customer or agent ask natural-language questions about a specific
// ticket ("what's the status", "how do I get a refund", "summarize this
// for me") without leaving the ticket page. Same Groq provider as triage,
// with the same heuristic fallback contract: never blocks the UI.
// ---------------------------------------------------------------------

function buildTicketContext(ticket) {
  const recentMessages = (ticket.messages || [])
    .slice(-6)
    .map((m) => `${m.senderRole}: ${m.text}`)
    .join("\n") || "No messages yet.";

  return [
    `Ticket ${ticket.ticketNumber}`,
    `Subject: ${ticket.subject}`,
    `Description: ${ticket.description}`,
    `Status: ${ticket.status}`,
    `Category: ${ticket.category}`,
    `Priority: ${ticket.priority}`,
    ticket.resolutionNote ? `Resolution note: ${ticket.resolutionNote}` : null,
    `Recent conversation:\n${recentMessages}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function heuristicChatReply(ticket, message) {
  const text = (message || "").toLowerCase();

  if (/status|update|kya.*ho|kb tak|when/.test(text)) {
    return `This ticket (${ticket.ticketNumber}) is currently "${ticket.status}"${
      ticket.agent ? `, assigned to ${ticket.agent.name || "an agent"}` : ", not yet assigned to an agent"
    }. Priority is ${ticket.priority}.`;
  }
  if (/refund|money|charge|billing/.test(text)) {
    return "For billing or refund questions, an agent needs to review the account directly — please add the details in the message thread below so they show up as soon as an agent picks this up.";
  }
  if (/summar/.test(text)) {
    return `Quick summary: "${ticket.subject}" — ${ticket.description.slice(0, 160)}${
      ticket.description.length > 160 ? "…" : ""
    }`;
  }
  return "I can help with this ticket's status, priority, or a quick summary — an assigned agent will handle anything that needs account-level changes. What would you like to know?";
}

async function callGroqChat(ticket, history, message) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No GROQ_API_KEY configured");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You are SupportFlow's in-app assistant, embedded on a single support ticket's page. " +
              "Answer only using the ticket context you're given — never invent account details, refund " +
              "amounts, or policies you don't have. Keep replies to 2-4 short sentences, friendly and direct. " +
              "If the user writes in Roman Urdu or a mix of Urdu/English, reply the same way. If the question " +
              "needs a human agent (account changes, payments, escalations), say so plainly.\n\n" +
              buildTicketContext(ticket),
          },
          ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: message },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Empty response from Groq");

    return { reply, source: "ai" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function chatAboutTicket(ticket, history, message) {
  try {
    return await callGroqChat(ticket, history, message);
  } catch (err) {
  console.error("AI TRIAGE ERROR:", err);
  return heuristicTriage(subject, description);
}
}