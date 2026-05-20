import prismaClientPackage from "@prisma/client";

const { PrismaClient } = prismaClientPackage;

const globalScope = globalThis;

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPrismaClient() {
  if (!isDatabaseConfigured()) {
    return null;
  }

  if (!globalScope.__forwardFreedomPrisma) {
    globalScope.__forwardFreedomPrisma = new PrismaClient();
  }

  return globalScope.__forwardFreedomPrisma;
}
