import { withUserContext } from "../../db/prisma.js";

function ignorable(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "P2021" ||
    message.includes("not configured") ||
    message.includes("does not exist")
  );
}

export function createMemoryBindingStore() {
  const rows = new Map();
  return {
    async get(userId) {
      return rows.get(userId) || null;
    },
    async save(userId, data) {
      const row = { ...data, userId };
      rows.set(userId, row);
      return row;
    },
  };
}

export function createPrismaBindingStore() {
  return {
    async get(userId) {
      try {
        return await withUserContext(userId, (tx) =>
          tx.chiefManagedBinding.findUnique({ where: { userId } })
        );
      } catch (error) {
        if (ignorable(error)) return null;
        throw error;
      }
    },
    async save(userId, data) {
      try {
        return await withUserContext(userId, (tx) =>
          tx.chiefManagedBinding.upsert({
            where: { userId },
            create: { userId, ...data },
            update: data,
          })
        );
      } catch (error) {
        if (ignorable(error)) return null;
        throw error;
      }
    },
  };
}

export function createPrismaThreadStore() {
  return {
    async save(userId, thread) {
      try {
        return await withUserContext(userId, (tx) =>
          tx.chiefManagedThread.upsert({
            where: { id: thread.id },
            create: {
              id: thread.id,
              userId,
              providerSessionId: thread.providerSessionId || null,
              memoryStoreId: thread.memoryStoreId || null,
              status: thread.status || "active",
            },
            update: {
              providerSessionId: thread.providerSessionId || null,
              memoryStoreId: thread.memoryStoreId || null,
              status: thread.status || "active",
            },
          })
        );
      } catch (error) {
        if (ignorable(error)) return null;
        throw error;
      }
    },
  };
}
