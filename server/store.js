import { promises as fs } from "fs";
import path from "path";

const STORE_PATH = path.resolve(process.cwd(), ".plaid-store.json");

function buildDefaultStore() {
  return {
    users: {},
  };
}

export async function readPlaidStore() {
  try {
    const contents = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" ? parsed : buildDefaultStore();
  } catch (error) {
    if (error.code === "ENOENT") {
      return buildDefaultStore();
    }

    throw error;
  }
}

export async function writePlaidStore(store) {
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

export function ensurePlaidUserStore(store, userId) {
  if (!store.users[userId]) {
    store.users[userId] = {
      items: {},
    };
  }

  return store.users[userId];
}
