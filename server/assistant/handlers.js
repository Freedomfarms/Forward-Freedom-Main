import { authenticateRequest, AuthError } from "../auth/verifyAuth.js";
import { respondInternalError } from "../http/errorHelpers.js";
import { ASSISTANT_TABS, buildAssistantSystemPrompt } from "./knowledge.js";

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_QUESTION_LENGTH = 1000;
const MAX_HISTORY_MESSAGES = 8;

function isAssistantConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function sanitizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  const seen = new Set();
  const result = [];
  for (const action of actions) {
    const tab = typeof action?.tab === "string" ? action.tab.trim() : "";
    if (!ASSISTANT_TABS.includes(tab) || seen.has(tab)) continue;
    seen.add(tab);
    const label = typeof action?.label === "string" && action.label.trim()
      ? action.label.trim()
      : `Open ${tab}`;
    result.push({ label, tab });
    if (result.length >= 2) break;
  }
  return result;
}

function summarizeContext(context = {}) {
  const parts = [];
  if (context.activeTab) parts.push(`Current tab: ${context.activeTab}.`);
  if (context.onboardingProgress?.currentStep?.label) {
    parts.push(`Next setup step: ${context.onboardingProgress.currentStep.label}.`);
  } else if (context.onboardingProgress) {
    parts.push("Setup is complete.");
  }
  if (Number.isFinite(context.accountCount)) parts.push(`Accounts: ${context.accountCount}.`);
  if (Number.isFinite(context.incomeStreamCount)) {
    parts.push(`Income streams: ${context.incomeStreamCount}.`);
  }
  if (Number.isFinite(context.budgetedRowCount)) {
    parts.push(`Budgeted categories: ${context.budgetedRowCount}.`);
  }
  if (Number.isFinite(context.transactionCount)) {
    parts.push(`Transactions: ${context.transactionCount}.`);
  }
  if (Number.isFinite(context.uncategorizedTransactions)) {
    parts.push(`Uncategorized transactions: ${context.uncategorizedTransactions}.`);
  }
  if (Number.isFinite(context.plaidConnectedItemCount)) {
    parts.push(`Connected banks: ${context.plaidConnectedItemCount}.`);
  }
  return parts.join(" ");
}

function buildChatMessages({ question, history, context }) {
  const messages = [{ role: "system", content: buildAssistantSystemPrompt() }];

  const contextSummary = summarizeContext(context);
  if (contextSummary) {
    messages.push({
      role: "system",
      content: `Live workspace context (use only if relevant): ${contextSummary}`,
    });
  }

  if (Array.isArray(history)) {
    for (const entry of history.slice(-MAX_HISTORY_MESSAGES)) {
      const role = entry?.role === "assistant" ? "assistant" : "user";
      const content = typeof entry?.text === "string" ? entry.text.trim() : "";
      if (content) {
        messages.push({ role, content: content.slice(0, MAX_QUESTION_LENGTH) });
      }
    }
  }

  messages.push({ role: "user", content: question });
  return messages;
}

function parseModelReply(rawContent) {
  const fallback = { text: String(rawContent || "").trim(), actions: [] };
  if (!rawContent) return fallback;
  try {
    const parsed = JSON.parse(rawContent);
    const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    if (!text) return fallback;
    return { text, actions: sanitizeActions(parsed.actions) };
  } catch {
    return fallback;
  }
}

async function callLanguageModel(messages) {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const apiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
    });

    if (!apiResponse.ok) {
      const detail = await apiResponse.text().catch(() => "");
      const error = new Error(
        `Language model request failed with status ${apiResponse.status}: ${detail.slice(0, 500)}`
      );
      error.statusCode = apiResponse.status;
      throw error;
    }

    const data = await apiResponse.json();
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleWorkspaceAssistant(request, response) {
  try {
    await authenticateRequest(request);

    if (!isAssistantConfigured()) {
      // The client falls back to the built-in rule-based guide when the LLM is
      // not configured, so this is a normal, non-error response.
      return response.status(200).json({ configured: false, reply: null });
    }

    const body = request.body || {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      return response.status(400).json({ error: true, message: "A question is required." });
    }

    const messages = buildChatMessages({
      question: question.slice(0, MAX_QUESTION_LENGTH),
      history: body.history,
      context: body.context,
    });

    const rawContent = await callLanguageModel(messages);
    const reply = parseModelReply(rawContent);

    if (!reply.text) {
      return response.status(200).json({ configured: true, reply: null });
    }

    return response.status(200).json({ configured: true, reply });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json({ error: true, message: error.message });
    }

    return respondInternalError(
      response,
      "api/assistant",
      error,
      "The AI guide is temporarily unavailable. Please try again."
    );
  }
}
