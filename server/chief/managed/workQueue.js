import { getServicePrismaClient } from "../../db/servicePrisma.js";

// Cross-user claim for the CHIEF managed drain. Same class of bypass as the
// scheduler tick: the cron has no Firebase user until the job row names one.
// Chat turns themselves use withUserContext.

const LEASE_MS = 90_000;

function ignorable(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "P2021" ||
    message.includes("not configured") ||
    message.includes("does not exist") ||
    message.includes("Cannot read properties of undefined")
  );
}

export function createMemoryWorkQueue() {
  const rows = new Map();
  return {
    rows,
    async enqueue({ userId, threadId }) {
      for (const row of rows.values()) {
        if (
          row.userId === userId &&
          row.threadId === threadId &&
          (row.status === "queued" || row.status === "running")
        ) {
          return row;
        }
      }
      const id = `work-${rows.size + 1}`;
      const row = {
        id,
        userId,
        threadId,
        status: "queued",
        leaseGeneration: 0,
        leaseUntil: null,
      };
      rows.set(id, row);
      return row;
    },
    async listDue(now, limit = 2) {
      const due = [];
      for (const row of rows.values()) {
        if (due.length >= limit) break;
        const expired = !row.leaseUntil || row.leaseUntil <= now;
        const open = row.status === "queued" || (row.status === "running" && expired);
        if (!open) continue;
        due.push({ ...row });
      }
      return due;
    },
    async claimThread({ userId, threadId, now = new Date() }) {
      for (const row of rows.values()) {
        if (row.userId !== userId || row.threadId !== threadId) continue;
        if (row.status !== "queued" && row.status !== "running") continue;
        const fresh = row.status === "running" && row.leaseUntil && row.leaseUntil > now;
        if (fresh) return null;
        row.status = "running";
        row.leaseGeneration += 1;
        row.leaseUntil = new Date(now.getTime() + LEASE_MS);
        return { ...row };
      }
      return { missing: true };
    },
    async claimDue(now, limit = 2) {
      const claimed = [];
      for (const row of rows.values()) {
        if (claimed.length >= limit) break;
        const expired = row.leaseUntil && row.leaseUntil < now;
        const open = row.status === "queued" || (row.status === "running" && expired);
        if (!open) continue;
        row.status = "running";
        row.leaseGeneration += 1;
        row.leaseUntil = new Date(now.getTime() + LEASE_MS);
        claimed.push({ ...row });
      }
      return claimed;
    },
    async complete(job) {
      const row = rows.get(job.id);
      if (!row || row.leaseGeneration !== job.leaseGeneration) return false;
      row.status = "succeeded";
      row.leaseUntil = null;
      return true;
    },
    async release(job) {
      const row = rows.get(job.id);
      if (!row || row.leaseGeneration !== job.leaseGeneration) return false;
      row.status = "queued";
      row.leaseUntil = null;
      return true;
    },
  };
}

function service() {
  return getServicePrismaClient();
}

export function createPrismaWorkQueue() {
  return {
    async enqueue({ userId, threadId }) {
      const client = service();
      if (!client?.chiefManagedWork) return null;
      try {
        const open = await client.chiefManagedWork.findFirst({
          where: { userId, threadId, status: { in: ["queued", "running"] } },
        });
        if (open) return open;
        return await client.chiefManagedWork.create({
          data: { userId, threadId, status: "queued" },
        });
      } catch (error) {
        if (error?.code === "P2002") {
          return client.chiefManagedWork.findFirst({
            where: { userId, threadId, status: { in: ["queued", "running"] } },
          });
        }
        if (ignorable(error)) return null;
        throw error;
      }
    },
    async listDue(now, limit = 2) {
      const client = service();
      if (!client?.chiefManagedWork) return [];
      try {
        return await client.chiefManagedWork.findMany({
          where: {
            OR: [{ status: "queued" }, { status: "running", leaseUntil: { lt: now } }],
          },
          orderBy: { createdAt: "asc" },
          take: limit,
        });
      } catch (error) {
        if (ignorable(error)) return [];
        throw error;
      }
    },
    async claimThread({ userId, threadId, now = new Date() }) {
      const client = service();
      if (!client?.chiefManagedWork) return { missing: true };
      try {
        const open = await client.chiefManagedWork.findFirst({
          where: { userId, threadId, status: { in: ["queued", "running"] } },
        });
        if (!open) return { missing: true };
        const fresh = open.status === "running" && open.leaseUntil && open.leaseUntil > now;
        if (fresh) return null;
        const next = open.leaseGeneration + 1;
        const updated = await client.chiefManagedWork.updateMany({
          where: { id: open.id, leaseGeneration: open.leaseGeneration },
          data: {
            status: "running",
            leaseGeneration: next,
            leaseUntil: new Date(now.getTime() + LEASE_MS),
          },
        });
        if (updated.count !== 1) return null;
        return { ...open, leaseGeneration: next, status: "running" };
      } catch (error) {
        if (ignorable(error)) return { missing: true };
        throw error;
      }
    },
    async claimDue(now, limit = 2) {
      const client = service();
      if (!client?.chiefManagedWork) return [];
      try {
        const rows = await client.chiefManagedWork.findMany({
          where: {
            OR: [{ status: "queued" }, { status: "running", leaseUntil: { lt: now } }],
          },
          orderBy: { createdAt: "asc" },
          take: limit,
        });
        const claimed = [];
        for (const row of rows) {
          const next = row.leaseGeneration + 1;
          const updated = await client.chiefManagedWork.updateMany({
            where: { id: row.id, leaseGeneration: row.leaseGeneration },
            data: {
              status: "running",
              leaseGeneration: next,
              leaseUntil: new Date(now.getTime() + LEASE_MS),
            },
          });
          if (updated.count === 1)
            claimed.push({ ...row, leaseGeneration: next, status: "running" });
        }
        return claimed;
      } catch (error) {
        if (ignorable(error)) return [];
        throw error;
      }
    },
    async complete(job) {
      const client = service();
      if (!client?.chiefManagedWork) return false;
      try {
        const updated = await client.chiefManagedWork.updateMany({
          where: { id: job.id, leaseGeneration: job.leaseGeneration },
          data: { status: "succeeded", leaseUntil: null },
        });
        return updated.count === 1;
      } catch (error) {
        if (ignorable(error)) return false;
        throw error;
      }
    },
    async release(job) {
      const client = service();
      if (!client?.chiefManagedWork) return false;
      try {
        const updated = await client.chiefManagedWork.updateMany({
          where: { id: job.id, leaseGeneration: job.leaseGeneration },
          data: { status: "queued", leaseUntil: null },
        });
        return updated.count === 1;
      } catch (error) {
        if (ignorable(error)) return false;
        throw error;
      }
    },
  };
}
