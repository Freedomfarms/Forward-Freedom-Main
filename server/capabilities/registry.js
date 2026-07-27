// ─────────────────────────────────────────────────────────────────────────────
// Platform capability registry — authoritative control-plane inventory.
//
// The CEO may only claim completion for capabilities listed here as available.
// Unavailable entries are first-class facts (not prompt suggestions): native
// social connectors, brokerage trading, etc. are explicitly registered as
// unavailable so the Brain cannot invent them.
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITY_STATUS = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

/**
 * @typedef {object} PlatformCapability
 * @property {string} id
 * @property {"available"|"unavailable"} status
 * @property {string} description
 * @property {string[]} tools
 * @property {string[]} permissions
 * @property {string[]} supported_platforms
 * @property {string[]} [agentTypes]
 * @property {string} [reason]
 */

/** @type {Readonly<Record<string, PlatformCapability>>} */
export const PLATFORM_CAPABILITIES = Object.freeze({
  finance_aggregates: Object.freeze({
    id: "finance_aggregates",
    status: CAPABILITY_STATUS.AVAILABLE,
    description:
      "Read-only financial aggregates (balances by account type, category spend totals, transaction counts) from connected bank data. Surfaced in the CEO world-model context and via the finance specialist agent. No direct get_* callable tools.",
    // No imaginary get_accounts / get_transactions_summary / get_budget_status tools.
    tools: Object.freeze([]),
    permissions: Object.freeze(["READ_ONLY"]),
    supported_platforms: Object.freeze(["plaid"]),
    agentTypes: Object.freeze(["finance"]),
  }),
  web_research: Object.freeze({
    id: "web_research",
    status: CAPABILITY_STATUS.AVAILABLE,
    description:
      "Read-only public web research and summarization via provider web search.",
    tools: Object.freeze(["web_search"]),
    permissions: Object.freeze(["READ_ONLY"]),
    supported_platforms: Object.freeze(["public_web"]),
    agentTypes: Object.freeze(["research"]),
  }),
  reminders: Object.freeze({
    id: "reminders",
    status: CAPABILITY_STATUS.AVAILABLE,
    description:
      "In-app reminders via the reminders specialist agent (run_agent). Optional email after runs when email delivery is enabled.",
    // Reminder creation is not a standalone Brain tool — it runs through the specialist.
    tools: Object.freeze(["run_agent"]),
    permissions: Object.freeze(["READ_ONLY", "DRAFT_ONLY"]),
    supported_platforms: Object.freeze(["in_app", "email"]),
    agentTypes: Object.freeze(["reminders"]),
  }),
  email_delivery: Object.freeze({
    id: "email_delivery",
    status: CAPABILITY_STATUS.AVAILABLE,
    description:
      "Email the user after an agent run when enabled on the agent (create_agent/update_agent emailDelivery → toolAccess.email).",
    tools: Object.freeze(["create_agent", "update_agent"]),
    permissions: Object.freeze(["email"]),
    supported_platforms: Object.freeze(["email"]),
  }),
  scheduling: Object.freeze({
    id: "scheduling",
    status: CAPABILITY_STATUS.AVAILABLE,
    description:
      "Cron-backed agent schedules in the user's local timezone via create_agent / update_agent schedule fields.",
    tools: Object.freeze(["create_agent", "update_agent"]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze(["cron"]),
  }),
  daily_digest: Object.freeze({
    id: "daily_digest",
    status: CAPABILITY_STATUS.AVAILABLE,
    description: "Daily Digest content on the Freedom OS home surface.",
    tools: Object.freeze(["update_digest"]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze(["freedom_os_home"]),
  }),
  social_media_monitoring: Object.freeze({
    id: "social_media_monitoring",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description:
      "Native monitoring of social posts (Instagram, TikTok, X, LinkedIn APIs).",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason:
      "No social platform connectors are connected. Public web search is not a native social feed.",
  }),
  stock_trading: Object.freeze({
    id: "stock_trading",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description: "Brokerage order placement / stock trading execution.",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason:
      "No brokerage or trading connector is connected. Finance agents are read-only aggregates only.",
  }),
  crypto_trading: Object.freeze({
    id: "crypto_trading",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description: "Crypto exchange trading (e.g. Coinbase order execution).",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason: "No crypto exchange trading connector is connected.",
  }),
  linkedin_connector: Object.freeze({
    id: "linkedin_connector",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description: "Native LinkedIn API connector for posts and hiring signals.",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason: "LinkedIn connector is not connected.",
  }),
  x_connector: Object.freeze({
    id: "x_connector",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description: "Native X (Twitter) API connector for posts and timelines.",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason: "X connector is not connected.",
  }),
  instagram_connector: Object.freeze({
    id: "instagram_connector",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description: "Native Instagram API connector for posts and stories.",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason: "Instagram connector is not connected.",
  }),
  tiktok_connector: Object.freeze({
    id: "tiktok_connector",
    status: CAPABILITY_STATUS.UNAVAILABLE,
    description: "Native TikTok API connector for posts and videos.",
    tools: Object.freeze([]),
    permissions: Object.freeze([]),
    supported_platforms: Object.freeze([]),
    reason: "TikTok connector is not connected.",
  }),
});

export function listCapabilities() {
  return Object.values(PLATFORM_CAPABILITIES).map((cap) => ({ ...cap }));
}

export function getCapability(id) {
  const key = String(id || "").trim();
  return PLATFORM_CAPABILITIES[key] ? { ...PLATFORM_CAPABILITIES[key] } : null;
}

export function isCapabilityAvailable(id) {
  return getCapability(id)?.status === CAPABILITY_STATUS.AVAILABLE;
}

const SOCIAL_PLATFORM_TO_CAPABILITY = Object.freeze({
  X: "x_connector",
  Twitter: "x_connector",
  LinkedIn: "linkedin_connector",
  Instagram: "instagram_connector",
  TikTok: "tiktok_connector",
});

/**
 * Infer required platform capabilities from user text / mission context.
 * Returns capability ids the mission depends on (not merely related to).
 */
export function resolveRequiredCapabilities({
  message = "",
  platforms = [],
  missionKind = null,
  tentativeAgentType = null,
} = {}) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const required = new Set();

  const wantsSocial =
    /\b(social media|social.?intel|instagram|tiktok|linkedin|\bx\b|twitter)\b/i.test(
      text
    ) ||
    (Array.isArray(platforms) && platforms.length > 0);

  const wantsNativeSocialFeed =
    wantsSocial &&
    /\b(monitor|track|watch|review|posts?|feed|timeline|stories?)\b/i.test(text);

  if (wantsNativeSocialFeed || wantsSocial) {
    // Native social monitoring is always required when the user names platforms
    // or asks for social-media monitoring — web research is a limited substitute,
    // not a fulfillment of the native capability.
    required.add("social_media_monitoring");
    const platformList = platforms.length
      ? platforms
      : detectPlatformNames(text);
    for (const platform of platformList) {
      const capId = SOCIAL_PLATFORM_TO_CAPABILITY[platform];
      if (capId) required.add(capId);
    }
  }

  if (
    /\b(stock trading|trade stocks?|trading agent|brokerage|place (?:an )?order|buy and sell stocks?)\b/i.test(
      lower
    ) ||
    (/\b(trading agent|trade for me|auto[- ]?trad)/i.test(lower) &&
      /\b(stock|equity|equities|shares?)\b/i.test(lower))
  ) {
    required.add("stock_trading");
  }

  if (
    /\b(coinbase|crypto trading|trade crypto|bitcoin trading|buy (?:and )?sell (?:btc|eth|crypto))\b/i.test(
      lower
    )
  ) {
    required.add("crypto_trading");
  }

  if (/\b(email me|send (?:me )?email|email delivery)\b/i.test(lower)) {
    required.add("email_delivery");
  }

  if (
    /\b(every|daily|weekly|monday|tuesday|wednesday|thursday|friday|schedule|recurring|weekday)\b/i.test(
      lower
    )
  ) {
    required.add("scheduling");
  }

  if (tentativeAgentType === "finance" || /\b(portfolio|budget|cash flow)\b/i.test(lower)) {
    if (!required.has("stock_trading") && !required.has("crypto_trading")) {
      required.add("finance_aggregates");
    }
  }

  if (
    tentativeAgentType === "research" ||
    (missionKind === "create" &&
      /\b(competitor|supplier|research|news|digest)\b/i.test(lower) &&
      !required.has("social_media_monitoring"))
  ) {
    required.add("web_research");
  }

  if (tentativeAgentType === "reminders") {
    required.add("reminders");
  }

  return [...required];
}

/**
 * Assess whether required capabilities are actually available.
 * @returns {{
 *   required: string[],
 *   available: PlatformCapability[],
 *   unavailable: PlatformCapability[],
 *   allAvailable: boolean,
 *   blockers: string[],
 * }}
 */
export function assessCapabilities(requiredIds = []) {
  const required = [...new Set((requiredIds || []).map(String).filter(Boolean))];
  const available = [];
  const unavailable = [];
  const blockers = [];

  for (const id of required) {
    const cap = getCapability(id);
    if (!cap) {
      unavailable.push({
        id,
        status: CAPABILITY_STATUS.UNAVAILABLE,
        description: `Unknown capability "${id}".`,
        tools: [],
        permissions: [],
        supported_platforms: [],
        reason: `Capability "${id}" is not registered.`,
      });
      blockers.push(`Capability "${id}" is not registered.`);
      continue;
    }
    if (cap.status === CAPABILITY_STATUS.AVAILABLE) {
      available.push(cap);
    } else {
      unavailable.push(cap);
      blockers.push(cap.reason || `Capability "${cap.id}" is unavailable.`);
    }
  }

  return {
    required,
    available,
    unavailable,
    allAvailable: unavailable.length === 0,
    blockers,
  };
}

/** Detect social platform names mentioned in free text. */
export function detectPlatformNames(text) {
  const platforms = [];
  if (/\b(twitter|\bx\b)\b/i.test(text)) platforms.push("X");
  if (/\blinkedin\b/i.test(text)) platforms.push("LinkedIn");
  if (/\binstagram\b/i.test(text)) platforms.push("Instagram");
  if (/\btiktok\b/i.test(text)) platforms.push("TikTok");
  return platforms;
}

/**
 * Render the registry for the Situation Brief (authoritative data, not advice).
 */
export function renderCapabilityRegistry(capabilities = listCapabilities()) {
  const lines = [];
  for (const cap of capabilities) {
    const platforms = cap.supported_platforms?.length
      ? cap.supported_platforms.join(", ")
      : "(none)";
    const tools = cap.tools?.length ? cap.tools.join(", ") : "(none)";
    const permissions = cap.permissions?.length
      ? cap.permissions.join(", ")
      : "(none)";
    lines.push(
      [
        `- id: ${cap.id}`,
        `  status: ${cap.status}`,
        `  tools: [${tools}]`,
        `  permissions: [${permissions}]`,
        `  supported_platforms: [${platforms}]`,
        cap.reason ? `  reason: ${cap.reason}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return lines.length
    ? lines.join("\n")
    : "(no platform capabilities registered)";
}
