import { authenticateRequest, AuthError } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { getServicePrismaClient } from "../../server/db/servicePrisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { respondAgentApiError } from "../../server/agents/apiHelpers.js";

// GET /api/admin/usage — per-user agent usage/cost table for the platform
// admin panel. Gated on User.isAdmin, which is DB-only (no API can set it).
//
// Cross-user aggregation legitimately cannot run inside one user's RLS
// context, so this handler uses the service-role client (BYPASSRLS) — the
// admin gate above is what authorizes the bypass.

function emptyBucket() {
  return { runs: 0, tokens: 0, cost: 0 };
}

function addToBucket(bucket, group) {
  bucket.runs += group._count._all;
  bucket.tokens += (group._sum.tokensInput || 0) + (group._sum.tokensOutput || 0);
  bucket.cost += group._sum.estimatedCostUsd != null ? Number(group._sum.estimatedCostUsd) : 0;
}

function roundCost(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);

    // Admin gate: read the caller's OWN row inside their RLS context. NULL
    // means false (the column deliberately has no default — see schema).
    const caller = await withUserContext(decodedToken.uid, (tx) =>
      tx.user.findUnique({ where: { id: decodedToken.uid }, select: { isAdmin: true } })
    );
    if (caller?.isAdmin !== true) {
      throw new AuthError("Platform admin access is required.", 403);
    }

    const service = getServicePrismaClient();
    if (!service) {
      const error = new Error("Database is not configured for admin reporting.");
      error.status = 503;
      throw error;
    }

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [users, allTimeGroups, thisMonthGroups] = await Promise.all([
      service.user.findMany({
        select: { id: true, email: true, lastLoginAt: true },
        orderBy: { createdAt: "asc" },
      }),
      service.agentRun.groupBy({
        by: ["userId", "agentType"],
        _count: { _all: true },
        _sum: { tokensInput: true, tokensOutput: true, estimatedCostUsd: true },
      }),
      service.agentRun.groupBy({
        by: ["userId"],
        where: { startedAt: { gte: monthStart } },
        _count: { _all: true },
        _sum: { tokensInput: true, tokensOutput: true, estimatedCostUsd: true },
      }),
    ]);

    const byUser = new Map();
    function userStats(userId) {
      if (!byUser.has(userId)) {
        byUser.set(userId, { allTime: emptyBucket(), thisMonth: emptyBucket(), byAgentType: {} });
      }
      return byUser.get(userId);
    }

    for (const group of allTimeGroups) {
      const stats = userStats(group.userId);
      addToBucket(stats.allTime, group);
      if (!stats.byAgentType[group.agentType]) stats.byAgentType[group.agentType] = emptyBucket();
      addToBucket(stats.byAgentType[group.agentType], group);
    }
    for (const group of thisMonthGroups) {
      addToBucket(userStats(group.userId).thisMonth, group);
    }

    const usage = users.map((user) => {
      const stats = byUser.get(user.id) || {
        allTime: emptyBucket(),
        thisMonth: emptyBucket(),
        byAgentType: {},
      };
      return {
        userId: user.id,
        email: user.email,
        lastActive: user.lastLoginAt,
        runsAllTime: stats.allTime.runs,
        runsThisMonth: stats.thisMonth.runs,
        tokensAllTime: stats.allTime.tokens,
        tokensThisMonth: stats.thisMonth.tokens,
        costAllTime: roundCost(stats.allTime.cost),
        costThisMonth: roundCost(stats.thisMonth.cost),
        byAgentType: Object.fromEntries(
          Object.entries(stats.byAgentType).map(([agentType, bucket]) => [
            agentType,
            { runs: bucket.runs, tokens: bucket.tokens, cost: roundCost(bucket.cost) },
          ])
        ),
      };
    });

    return response.status(200).json({ usage });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/admin/usage",
      error,
      "Unable to load platform usage data."
    );
  }
}
