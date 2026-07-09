import prismaClientPackage from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const { PrismaClient, Prisma } = prismaClientPackage;

// Re-exported so writers can set JSON columns to SQL NULL (Prisma.DbNull) when
// migrating plaintext values to their encrypted counterparts.
export { Prisma };

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
