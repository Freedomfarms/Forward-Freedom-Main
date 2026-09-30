// CHIEF knowledge-graph reads and explicit links for the KG tools.
//
// PORT/ADAPT of the OpenJarvis KG entity/relation records onto
// chief_knowledge_entity and chief_knowledge_relation. Semantic auto-links,
// embeddings, and the consolidation job are not this module. Relation origin
// is always EXPLICIT.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";

export class MemoryGraphStore {
  constructor() {
    this.entities = [];
    this.relations = [];
  }

  async upsertEntity({ userId, name, entityType = null }) {
    const existing = this.entities.find((row) => row.userId === userId && row.name === name);
    if (existing) return { ...existing };
    const row = { id: randomUUID(), userId, name, entityType };
    this.entities.push(row);
    return { ...row };
  }

  async link({
    userId,
    sourceName,
    targetName,
    relationType,
    sourceType = null,
    targetType = null,
  }) {
    const source = await this.upsertEntity({ userId, name: sourceName, entityType: sourceType });
    const target = await this.upsertEntity({ userId, name: targetName, entityType: targetType });
    const existing = this.relations.find(
      (row) =>
        row.userId === userId &&
        row.sourceEntityId === source.id &&
        row.targetEntityId === target.id &&
        row.relationType === relationType
    );
    if (existing) return { relation: { ...existing }, source, target };
    const relation = {
      id: randomUUID(),
      userId,
      sourceEntityId: source.id,
      targetEntityId: target.id,
      relationType,
      origin: "EXPLICIT",
    };
    this.relations.push(relation);
    return { relation: { ...relation }, source, target };
  }

  async lookup({ userId, name }) {
    const entity = this.entities.find((row) => row.userId === userId && row.name === name) ?? null;
    if (!entity) return { entity: null, relations: [] };
    const relations = this.relations
      .filter(
        (row) =>
          row.userId === userId &&
          (row.sourceEntityId === entity.id || row.targetEntityId === entity.id)
      )
      .map((row) => ({ ...row }));
    return { entity: { ...entity }, relations };
  }
}

export class PrismaGraphStore {
  constructor({ withUser = withUserContext } = {}) {
    this._withUser = withUser;
  }

  async upsertEntity({ userId, name, entityType = null }) {
    return this._withUser(userId, async (tx) => {
      const existing = await tx.chiefKnowledgeEntity.findUnique({
        where: { userId_name: { userId, name } },
      });
      if (existing) return existing;
      return tx.chiefKnowledgeEntity.create({
        data: { userId, name, entityType },
      });
    });
  }

  async link({
    userId,
    sourceName,
    targetName,
    relationType,
    sourceType = null,
    targetType = null,
  }) {
    return this._withUser(userId, async (tx) => {
      const source = await upsert(tx, userId, sourceName, sourceType);
      const target = await upsert(tx, userId, targetName, targetType);
      const existing = await tx.chiefKnowledgeRelation.findUnique({
        where: {
          userId_sourceEntityId_targetEntityId_relationType: {
            userId,
            sourceEntityId: source.id,
            targetEntityId: target.id,
            relationType,
          },
        },
      });
      const relation =
        existing ??
        (await tx.chiefKnowledgeRelation.create({
          data: {
            userId,
            sourceEntityId: source.id,
            targetEntityId: target.id,
            relationType,
            origin: "EXPLICIT",
          },
        }));
      return { relation, source, target };
    });
  }

  async lookup({ userId, name }) {
    return this._withUser(userId, async (tx) => {
      const entity = await tx.chiefKnowledgeEntity.findUnique({
        where: { userId_name: { userId, name } },
      });
      if (!entity) return { entity: null, relations: [] };
      const relations = await tx.chiefKnowledgeRelation.findMany({
        where: {
          userId,
          OR: [{ sourceEntityId: entity.id }, { targetEntityId: entity.id }],
        },
      });
      return { entity, relations };
    });
  }
}

async function upsert(tx, userId, name, entityType) {
  const existing = await tx.chiefKnowledgeEntity.findUnique({
    where: { userId_name: { userId, name } },
  });
  if (existing) return existing;
  return tx.chiefKnowledgeEntity.create({ data: { userId, name, entityType } });
}
