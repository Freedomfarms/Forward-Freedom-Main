import process from "node:process";
import { spawn } from "node:child_process";

const PLACEHOLDER_DATABASE_URL = "postgresql://postgres:password@localhost:5432/forward_freedom";

const environment = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || PLACEHOLDER_DATABASE_URL,
};

const child = spawn("npx", ["prisma", "generate"], {
  stdio: "inherit",
  env: environment,
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
