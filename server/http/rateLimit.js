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

function getClientIp(request) {
  const forwarded = readHeader(request, "x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = readHeader(request, "x-real-ip");
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return request.ip || request.socket?.remoteAddress || "127.0.0.1";
}

function runRateLimit(limiter, request, response) {
  // Fail open on any limiter/store error. A throwing limiter (e.g. an
  // unexpected forwarded-IP format from a particular edge/proxy) must never
  // turn into an opaque 500 that blocks all linking; that would surface to the
  // client as a generic, non-JSON failure with no diagnosable message.
  return new Promise((resolve) => {
    try {
      const result = limiter(request, response, (error) => {
        if (error) {
          resolve(true);
          return;
        }
        resolve(!response.headersSent);
      });

      if (result && typeof result.catch === "function") {
        result.catch(() => resolve(true));
      }
    } catch {
      resolve(true);
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

export const plaidWebhookRateLimit = rateLimit({
  ...baseRateLimitOptions,
  windowMs: 60 * 1000,
  max: 120,
});
