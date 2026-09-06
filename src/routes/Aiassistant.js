// Free-form assistant used by the floating chat widget. Reuses the same
// Groq provider as triage. If a ticketId is given, the ticket's subject,
// status and category are included as context so answers are grounded in
// the real ticket instead of generic guesses. Falls back to a canned,
// still-useful reply if the AI call fails — the widget should never look
// broken.

async function callGroq(history, ticketContext) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No GROQ_API_KEY configured");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const systemPrompt = ticketContext
    ? `You are SupportFlow's help assistant, embedded on a customer support ticket page. ` +
      `Answer briefly (2-4 sentences), in a friendly and clear tone. Here is the ticket you are helping with: ` +
      `Ticket ${ticketContext.ticketNumber}, subject "${ticketContext.subject}", status "${ticketContext.status}", ` +
      `category "${ticketContext.category}", priority "${ticketContext.priority}". ` +
      `If asked something unrelated to support tickets, gently redirect to ticket topics.`
    : `You are SupportFlow's help assistant. Answer briefly (2-4 sentences) about how the support ` +
      `ticket system works (creating tickets, AI triage, statuses, agents) in a friendly, clear tone.`;

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
        messages: [{ role: "system", content: systemPrompt }, ...history],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't come up with an answer for that.";
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackReply(ticketContext) {
  if (ticketContext) {
    return (
      `I can't reach the AI service right now, but here's what I can tell you: ticket ${ticketContext.ticketNumber} ` +
      `is currently "${ticketContext.status}", filed under ${ticketContext.category} with ${ticketContext.priority} priority. ` +
      `An agent will follow up here as soon as possible.`
    );
  }
  return (
    "I can't reach the AI service right now. In short: submit a ticket with a subject and description, " +
    "our AI suggests a category/priority for the agent to review, and you'll see status updates and replies " +
    "right here on the ticket page."
  );
}

export async function askAssistant(history, ticketContext) {
  try {
    const reply = await callGroq(history, ticketContext);
    return { reply, source: "ai" };
  } catch (err) {
    return { reply: fallbackReply(ticketContext), source: "fallback" };
  }
}
