import { rateLimit } from "express-rate-limit";

function runRateLimit(limiter, request, response) {
  return new Promise((resolve) => {
    limiter(request, response, () => {
      resolve(!response.headersSent);
    });
  });
}

export async function enforceRateLimit(request, response, limiter) {
  return runRateLimit(limiter, request, response);
}

const baseRateLimitOptions = {
  standardHeaders: true,
  legacyHeaders: false,
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
  max: 60,
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
