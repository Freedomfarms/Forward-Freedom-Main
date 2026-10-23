import { JOB_LEASE_MS } from "./constants.js";

export function decideWebhookDelivery(existing, now) {
  if (!existing) return { action: "insert", httpStatus: 200 };
  if (existing.status === "completed") return { action: "ignore", httpStatus: 200 };
  if (existing.status === "pending") return { action: "wake", httpStatus: 200 };
  if (existing.status === "running") {
    const expired =
      !existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime();
    return expired ? { action: "wake", httpStatus: 200 } : { action: "ignore", httpStatus: 200 };
  }
  return { action: "ignore", httpStatus: 200 };
}

export function canClaimJob(job, now) {
  if (!job || job.status === "completed") return false;
  if (job.status === "pending") return true;
  if (job.status !== "running") return false;
  return !job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now.getTime();
}

export function nextJobLease(job, now, leaseMs = JOB_LEASE_MS) {
  return {
    status: "running",
    leaseGeneration: (job.leaseGeneration || 0) + 1,
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
    lastError: null,
  };
}
