import { ipKeyGenerator, rateLimit } from "express-rate-limit";

function readHeader(request, name) {
  const headers = request.headers || {};
  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

// Forwarded-IP headers are only trustworthy when a proxy we control sets them
// (Vercel always does). A directly exposed Express server must key on the
// socket address instead — otherwise every rate limit is bypassable by
// rotating X-Forwarded-For. Self-hosted deployments sitting behind a trusted
// reverse proxy (nginx, a load balancer) should set FFF_TRUST_PROXY=1 so users
// are limited per client IP rather than sharing the proxy's bucket.
const TRUST_PROXY_HEADERS =
  Boolean(process.env.VERCEL) || /^(1|true|yes)$/i.test(String(process.env.FFF_TRUST_PROXY || ""));

function getClientIp(request) {
  if (TRUST_PROXY_HEADERS) {
    const forwarded = readHeader(request, "x-forwarded-for");
    if (typeof forwarded === "string" && forwarded.trim()) {
      // Use the RIGHTMOST entry: it is the one appended by the trusted proxy
      // directly in front of us. Leftmost entries are attacker-controlled — a
      // client can send "X-Forwarded-For: 1.2.3.4" and the proxy appends the
      // real address, producing "1.2.3.4, <real-ip>".
      const entries = forwarded
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.length) {
        return entries[entries.length - 1];
      }
    }

    const realIp = readHeader(request, "x-real-ip");
    if (typeof realIp === "string" && realIp.trim()) {
      return realIp.trim();
    }
  }

  return request.ip || request.socket?.remoteAddress || "127.0.0.1";
}

function respondLimiterUnavailable(response, error) {
  console.error("[rate-limit] limiter error — failing closed with 503:", error);
  if (!response.headersSent) {
    response.status(503).json({
      error: true,
      message: "Service temporarily unavailable. Please try again shortly.",
    });
  }
}

function runRateLimit(limiter, request, response) {
  // Fail CLOSED on any limiter/store error. If the limiter (or its backing
  // store) is broken, silently disabling rate limits would leave every
  // endpoint unthrottled — unacceptable for a fintech API. Reject with 503
  // so the outage is visible and traffic stays bounded.
  return new Promise((resolve) => {
    try {
      const result = limiter(request, response, (error) => {
        if (error) {
          respondLimiterUnavailable(response, error);
          resolve(false);
          return;
        }
        resolve(!response.headersSent);
      });

      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          respondLimiterUnavailable(response, error);
          resolve(false);
        });
      }
    } catch (error) {
      respondLimiterUnavailable(response, error);
      resolve(false);
    }
  });
}

export async function enforceRateLimit(request, response, limiter) {
  return runRateLimit(limiter, request, response);
}

const baseRateLimitOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
    forwardedHeader: false,
  },
  keyGenerator: (request) => ipKeyGenerator(getClientIp(request)),
  handler: (request, response) => {
    response.status(429).json({
      error: true,
      message: "Too many requests. Please try again later.",
    });
  },
};

export const generalApiRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 120,
});

export const workspaceWriteRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 240,
});

export const plaidLinkRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: true, message: "Too many link-token requests. Please try again later." },
});

export const plaidExchangeRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: true, message: "Too many token exchange requests. Please try again later." },
});

export const plaidSyncRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: true, message: "Too many sync requests. Please try again later." },
});

// LLM-backed agent endpoints (chat, digest regeneration): each request can
// cost real model tokens, so they get a tighter budget than the general API.
export const agentLlmRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: true, message: "Too many agent requests. Please try again in a few minutes." },
});

// Manual agent-run triggers are the most expensive single action (full agent
// run + profile extraction), so they are capped hardest: 10 per hour.
export const agentRunRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: true, message: "Too many manual runs. Please try again later." },
});

export const plaidWebhookRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 60 * 1000,
  max: 120,
});

// App-wide backstop for the self-hosted Express server (server/index.js). Each
// route handler still enforces its own stricter limit; this separate instance
// only bounds aggregate per-IP traffic and any future route mounted without a
// handler-level limiter. The ceiling sits above the sum of legitimate per-route
// allowances (general 120 + workspace writes 240 + sync/link/exchange) so it
// never throttles a real client before the per-route limits do.
export const expressServerBackstopRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 600,
});
