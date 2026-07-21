import crypto from "crypto";

// In-memory Prisma-transaction stand-in for agent unit tests. Implements the
// small subset of the client API the server/agents modules use, and records
// every call (table, method, args) so tests can assert on query shapes (e.g.
// that the finance agent never SELECTs merchant columns).

function operatorMatch(value, condition) {
  if ("gte" in condition && !(value >= condition.gte)) return false;
  if ("lte" in condition && !(value <= condition.lte)) return false;
  if ("gt" in condition && !(value > condition.gt)) return false;
  if ("lt" in condition && !(value < condition.lt)) return false;
  if ("not" in condition) {
    if (condition.not === null) {
      if (value == null) return false;
    } else if (value === condition.not) {
      return false;
    }
  }
  if ("in" in condition && !condition.in.includes(value)) return false;
  return true;
}

function matchesWhere(row, where = {}) {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    const value = row[key] === undefined ? null : row[key];
    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date) &&
      !Array.isArray(condition)
    ) {
      if (!operatorMatch(value, condition)) return false;
      continue;
    }
    if (condition === null) {
      if (value !== null) return false;
    } else if (condition instanceof Date || value instanceof Date) {
      if (new Date(value).getTime() !== new Date(condition).getTime()) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const [[field, direction]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const left = a[field] instanceof Date ? a[field].getTime() : a[field];
    const right = b[field] instanceof Date ? b[field].getTime() : b[field];
    if (left === right) return 0;
    const cmp = left < right ? -1 : 1;
    return direction === "desc" ? -cmp : cmp;
  });
}

const TABLES = [
  "user",
  "agentConfig",
  "ceoAgentConfig",
  "agentConversation",
  "agentRun",
  "agentChatMessage",
  "ceoDocument",
  "notification",
  "transaction",
  "account",
];

export function createFakeDb(seed = {}) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, []]));
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((row) => ({ ...row }));
  }
  const calls = [];

  function modelDelegate(table) {
    const rows = () => tables[table];
    return {
      async findFirst(args = {}) {
        calls.push({ table, method: "findFirst", args });
        const match = rows().find((row) => matchesWhere(row, args.where));
        return match ? { ...match } : null;
      },
      async findUnique(args = {}) {
        calls.push({ table, method: "findUnique", args });
        const match = rows().find((row) => matchesWhere(row, args.where));
        return match ? { ...match } : null;
      },
      async findMany(args = {}) {
        calls.push({ table, method: "findMany", args });
        let matched = rows().filter((row) => matchesWhere(row, args.where));
        matched = sortRows(matched, args.orderBy);
        if (Array.isArray(args.distinct) && args.distinct.length) {
          const seen = new Set();
          matched = matched.filter((row) => {
            const key = JSON.stringify(args.distinct.map((field) => row[field]));
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (args.take != null) matched = matched.slice(0, args.take);
        return matched.map((row) => ({ ...row }));
      },
      async count(args = {}) {
        calls.push({ table, method: "count", args });
        return rows().filter((row) => matchesWhere(row, args.where)).length;
      },
      async upsert(args = {}) {
        calls.push({ table, method: "upsert", args });
        const row = rows().find((candidate) => matchesWhere(candidate, args.where));
        if (row) {
          Object.assign(row, args.update);
          return { ...row };
        }
        const created = { id: crypto.randomUUID(), createdAt: new Date(), ...args.create };
        rows().push(created);
        return { ...created };
      },
      async create(args = {}) {
        calls.push({ table, method: "create", args });
        const now = new Date();
        const row = {
          id: crypto.randomUUID(),
          createdAt: now,
          ...(table === "agentRun" ? { startedAt: now, status: "RUNNING" } : {}),
          ...(table === "agentConversation"
            ? { updatedAt: now, isSystem: false, archivedAt: null, title: null }
            : {}),
          ...args.data,
        };
        rows().push(row);
        return { ...row };
      },
      async update(args = {}) {
        calls.push({ table, method: "update", args });
        const row = rows().find((candidate) => matchesWhere(candidate, args.where));
        if (!row) throw new Error(`fakeAgentDb: no ${table} row matches ${JSON.stringify(args.where)}`);
        Object.assign(row, args.data);
        return { ...row };
      },
      async delete(args = {}) {
        calls.push({ table, method: "delete", args });
        const index = rows().findIndex((candidate) => matchesWhere(candidate, args.where));
        if (index < 0) throw new Error(`fakeAgentDb: no ${table} row matches ${JSON.stringify(args.where)}`);
        const [removed] = rows().splice(index, 1);
        return { ...removed };
      },
    };
  }

  const tx = Object.fromEntries(TABLES.map((table) => [table, modelDelegate(table)]));
  return { tx, tables, calls };
}
