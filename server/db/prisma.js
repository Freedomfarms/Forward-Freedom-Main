import prismaClientPackage from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    globalScope.__forwardFreedomPrisma = new PrismaClient({ adapter });
  }

  return globalScope.__forwardFreedomPrisma;
}
