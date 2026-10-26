// Postgres owns guarded workspace files and accepted facts. An Anthropic
// memory store is a working copy. Recovery writes that copy again. It does
// not resurrect a deleted file, drop a trusted fact, or overwrite a row whose
// hash changed after the turn started.

import { withUserContext } from "../../db/prisma.js";
import { decrypt, encrypt } from "../../security/envelope.js";
import { REQUIRED_WORKSPACE_PATHS } from "../managed/constants.js";
import { sha256Text } from "../managed/memoryStore.js";
import { planSync } from "../managed/ownership.js";
import { workspaceDocuments } from "../managed/productionAgent.js";
import { workspaceFileName } from "../managed/workspaceGuard.js";

export const ACCEPTED_FACTS_PATH = "memory/accepted-facts.md";

const GUARDED = new Set(REQUIRED_WORKSPACE_PATHS);

function assertGuarded(path) {
  if (!GUARDED.has(path)) {
    const error = new Error("workspace path is not guarded");
    error.code = "workspace_path";
    throw error;
  }
}

export function acceptedFacts(facts, now = new Date()) {
  return (facts || [])
    .filter((fact) => {
      if (!fact || fact.deletedAt || fact.forgotten) return false;
      if (fact.trustTier !== "TRUSTED" && fact.trustTier !== "AUTO") return false;
      if (typeof fact.content !== "string" || fact.content.length === 0) return false;
      if (fact.expiresAt && new Date(fact.expiresAt).getTime() <= now.getTime()) return false;
      return true;
    })
    .sort((left, right) => {
      const trust = Number(right.trustTier === "TRUSTED") - Number(left.trustTier === "TRUSTED");
      if (trust) return trust;
      return String(left.id || "").localeCompare(String(right.id || ""));
    });
}

export function acceptedFactsDocument(facts, now = new Date()) {
  const rows = acceptedFacts(facts, now);
  const lines = [
    "# Accepted facts",
    "",
    "Postgres is the authority for these facts. This file is working context.",
    "A fact removed in Postgres stays removed. Trusted facts stay trusted.",
    "",
    "## Trusted",
  ];
  for (const fact of rows) {
    if (fact.trustTier === "TRUSTED") lines.push(`- ${fact.content}`);
  }
  lines.push("", "## Accepted");
  for (const fact of rows) {
    if (fact.trustTier === "AUTO") lines.push(`- ${fact.content}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function recoveryDocuments({ documents = [], facts = [], now = new Date() } = {}) {
  const byPath = new Map((documents || []).map((doc) => [doc.path, doc]));
  const templates = new Map(
    workspaceDocuments()
      .filter((doc) => GUARDED.has(doc.path))
      .map((doc) => [doc.path, doc.content])
  );
  const files = [];
  const bootstrap = [];
  for (const path of REQUIRED_WORKSPACE_PATHS) {
    const row = byPath.get(path);
    if (row?.deletedAt) continue;
    if (row) {
      files.push({
        path,
        content: row.content,
        contentSha256: row.contentSha256 || sha256Text(row.content),
        source: "postgres",
      });
      continue;
    }
    const content = templates.get(path) || "";
    files.push({
      path,
      content,
      contentSha256: sha256Text(content),
      source: "template",
    });
    bootstrap.push(path);
  }
  const content = acceptedFactsDocument(facts, now);
  files.push({
    path: ACCEPTED_FACTS_PATH,
    content,
    contentSha256: sha256Text(content),
    source: "facts",
  });
  return { files, bootstrap };
}

export function decideDocumentWrite({ current = null, op, expectedSha256 = null }) {
  if (op === "insert") {
    if (!current) return { action: "insert" };
    return { action: "conflict", currentSha256: current.contentSha256 };
  }
  if (op === "update" && current && current.contentSha256 === expectedSha256) {
    return { action: "update" };
  }
  if (op === "delete" && current && current.contentSha256 === expectedSha256) {
    if (current.deletedAt) return { action: "already_deleted" };
    return { action: "delete" };
  }
  return { action: "conflict", currentSha256: current?.contentSha256 || null };
}

function project(row, content, conflictContent = row.conflictContent ?? null) {
  return {
    path: row.path,
    content,
    contentSha256: row.contentSha256,
    revision: row.revision,
    deletedAt: row.deletedAt || null,
    conflictContent,
    conflictSha256: row.conflictSha256 || null,
    userId: row.userId,
  };
}

export function createMemoryWorkspaceDocumentStore() {
  const rows = new Map();
  const keyFor = (userId, path) => `${userId}\0${path}`;
  return {
    async list(userId) {
      return [...rows.values()]
        .filter((row) => row.userId === userId)
        .map((row) => project(row, row.content));
    },
    async insertIfAbsent({ userId, path, content }) {
      assertGuarded(path);
      const key = keyFor(userId, path);
      const existing = rows.get(key);
      if (existing) return { inserted: false, document: project(existing, existing.content) };
      const row = {
        userId,
        path,
        content: String(content),
        contentSha256: sha256Text(content),
        revision: 1,
        deletedAt: null,
        conflictContent: null,
        conflictSha256: null,
      };
      rows.set(key, row);
      return { inserted: true, document: project(row, row.content) };
    },
    async applyWrite({ userId, path, content, contentSha256, expectedSha256 = null, op }) {
      assertGuarded(path);
      const key = keyFor(userId, path);
      const current = rows.get(key) || null;
      const decision = decideDocumentWrite({ current, op, expectedSha256 });
      if (decision.action === "conflict") return { ok: false, conflict: true, path, ...decision };
      if (decision.action === "already_deleted") return { ok: true, path, op: "delete" };
      if (decision.action === "insert") {
        const row = {
          userId,
          path,
          content: String(content),
          contentSha256: contentSha256 || sha256Text(content),
          revision: 1,
          deletedAt: null,
          conflictContent: null,
          conflictSha256: null,
        };
        rows.set(key, row);
        return { ok: true, path, op };
      }
      if (decision.action === "update") {
        current.content = String(content);
        current.contentSha256 = contentSha256 || sha256Text(content);
        current.revision += 1;
        current.deletedAt = null;
        current.conflictContent = null;
        current.conflictSha256 = null;
        return { ok: true, path, op };
      }
      current.deletedAt = new Date();
      current.revision += 1;
      return { ok: true, path, op: "delete" };
    },
    async preserveConflict({ userId, path, content }) {
      assertGuarded(path);
      const current = rows.get(keyFor(userId, path)) || null;
      if (!current || typeof content !== "string" || content.length === 0) {
        return { preserved: false, path };
      }
      const hash = sha256Text(content);
      if (current.contentSha256 === hash) return { preserved: false, path };
      current.conflictContent = content;
      current.conflictSha256 = hash;
      return { preserved: true, path, currentSha256: current.contentSha256 };
    },
  };
}

export function createPrismaWorkspaceDocumentStore({
  withUser = withUserContext,
  seal = encrypt,
  open = decrypt,
} = {}) {
  return {
    async list(userId) {
      const rows = await withUser(userId, (tx) =>
        tx.chiefWorkspaceDocument.findMany({ where: { userId } })
      );
      return rows.map((row) =>
        project(
          row,
          open(row.contentCiphertext) || "",
          row.conflictCiphertext ? open(row.conflictCiphertext) || "" : null
        )
      );
    },
    async insertIfAbsent({ userId, path, content }) {
      assertGuarded(path);
      return withUser(userId, async (tx) => {
        const existing = await tx.chiefWorkspaceDocument.findUnique({
          where: { userId_path: { userId, path } },
        });
        if (existing) {
          return {
            inserted: false,
            document: project(existing, open(existing.contentCiphertext) || ""),
          };
        }
        const created = await tx.chiefWorkspaceDocument.create({
          data: {
            userId,
            path,
            revision: 1,
            contentSha256: sha256Text(content),
            contentCiphertext: seal(String(content)),
          },
        });
        return { inserted: true, document: project(created, String(content)) };
      });
    },
    async applyWrite({ userId, path, content, contentSha256, expectedSha256 = null, op }) {
      assertGuarded(path);
      return withUser(userId, async (tx) => {
        const current = await tx.chiefWorkspaceDocument.findUnique({
          where: { userId_path: { userId, path } },
        });
        const decision = decideDocumentWrite({ current, op, expectedSha256 });
        if (decision.action === "conflict") return { ok: false, conflict: true, path, ...decision };
        if (decision.action === "already_deleted") return { ok: true, path, op: "delete" };
        const hash = contentSha256 || sha256Text(content);
        if (decision.action === "insert") {
          await tx.chiefWorkspaceDocument.create({
            data: {
              userId,
              path,
              revision: 1,
              contentSha256: hash,
              contentCiphertext: seal(String(content)),
            },
          });
          return { ok: true, path, op };
        }
        if (decision.action === "update") {
          await tx.chiefWorkspaceDocument.update({
            where: { id: current.id },
            data: {
              contentSha256: hash,
              contentCiphertext: seal(String(content)),
              conflictCiphertext: null,
              conflictSha256: null,
              revision: { increment: 1 },
              deletedAt: null,
            },
          });
          return { ok: true, path, op };
        }
        await tx.chiefWorkspaceDocument.update({
          where: { id: current.id },
          data: { deletedAt: new Date(), revision: { increment: 1 } },
        });
        return { ok: true, path, op: "delete" };
      });
    },
    async preserveConflict({ userId, path, content }) {
      assertGuarded(path);
      if (typeof content !== "string" || content.length === 0) return { preserved: false, path };
      return withUser(userId, async (tx) => {
        const current = await tx.chiefWorkspaceDocument.findUnique({
          where: { userId_path: { userId, path } },
        });
        const hash = sha256Text(content);
        if (!current || current.contentSha256 === hash) return { preserved: false, path };
        await tx.chiefWorkspaceDocument.update({
          where: { id: current.id },
          data: { conflictCiphertext: seal(content), conflictSha256: hash },
        });
        return { preserved: true, path, currentSha256: current.contentSha256 };
      });
    },
  };
}

function memoryPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

export async function commitGuardedDocuments({ store, userId, baseHashes = {}, memories = [] }) {
  const incoming = [];
  for (const item of memories || []) {
    const path = workspaceFileName(memoryPath(item?.path));
    if (!path) continue;
    if (typeof item?.content !== "string") {
      if (baseHashes[path]) {
        incoming.push({ path, content: "", contentSha256: baseHashes[path] });
      }
      continue;
    }
    incoming.push({ path, content: item.content, contentSha256: sha256Text(item.content) });
  }
  const liveDocuments = (await store.list(userId)).filter((doc) => GUARDED.has(doc.path));
  const plan = planSync({
    baseHashes,
    liveDocuments,
    incoming,
    listOk: true,
  });
  const applied = [];
  for (const write of plan.writes) {
    applied.push(await store.applyWrite({ userId, ...write }));
  }
  for (const deletion of plan.deletes) {
    applied.push(
      await store.applyWrite({
        userId,
        path: deletion.path,
        content: "",
        expectedSha256: deletion.expectedSha256,
        op: "delete",
      })
    );
  }
  const preserved = [];
  for (const item of plan.conflicts) {
    if (typeof item.rejectedContent !== "string" || item.rejectedContent.length === 0) continue;
    preserved.push(
      await store.preserveConflict({
        userId,
        path: item.path,
        content: item.rejectedContent,
      })
    );
  }
  return { ...plan, applied, preserved };
}

export function guardedMemoryFiles(plan) {
  if (!plan?.files) return workspaceDocuments();
  const selected = plan.files.filter((doc) => doc.path !== ACCEPTED_FACTS_PATH);
  for (const doc of workspaceDocuments()) {
    if (GUARDED.has(doc.path)) continue;
    selected.push(doc);
  }
  return selected;
}

export async function publishWorkingFile(
  client,
  memoryStoreId,
  { path, content, previousSha = null, force = false, listed = null } = {}
) {
  const memories = Array.isArray(listed)
    ? listed
    : (await client.listMemories(memoryStoreId)) || [];
  const current = memories.find((item) => memoryPath(item?.path) === path);
  const nextSha = sha256Text(content);
  if (!current) {
    try {
      await client.createMemory(memoryStoreId, { path: `/${path}`, content });
      return { written: true, preserved: false, sha: nextSha };
    } catch (error) {
      if (error?.status === 409) return { written: false, preserved: true, sha: previousSha };
      throw error;
    }
  }
  const liveSha =
    typeof current.content === "string"
      ? sha256Text(current.content)
      : current.content_sha256 || null;
  if (liveSha === nextSha) return { written: false, preserved: false, sha: liveSha };
  if (!force && (!previousSha || liveSha !== previousSha)) {
    return { written: false, preserved: true, sha: liveSha };
  }
  const preconditionSha = current.content_sha256;
  if (
    typeof client.updateMemory !== "function" ||
    typeof preconditionSha !== "string" ||
    preconditionSha.length !== 64
  ) {
    return { written: false, preserved: true, sha: liveSha };
  }
  try {
    await client.updateMemory(memoryStoreId, current.id, {
      content,
      precondition: { type: "content_sha256", content_sha256: preconditionSha },
    });
    return { written: true, preserved: false, sha: nextSha };
  } catch (error) {
    if (error?.status === 409) return { written: false, preserved: true, sha: liveSha };
    throw error;
  }
}
