import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma CLI commands (migrate deploy/dev, db push, etc.) need a direct,
// unpooled connection to run schema changes — a pgbouncer/Supavisor
// transaction-mode pooler (the connection app runtime should use for
// scalability) doesn't support the prepared statements/advisory locks
// Migrate relies on, and will hang or fail. Prefer DIRECT_URL for the CLI
// when it's set, falling back to DATABASE_URL for setups (e.g. local dev)
// that only configure one connection string.
const migrationsDatabaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationsDatabaseUrl,
  },
});
