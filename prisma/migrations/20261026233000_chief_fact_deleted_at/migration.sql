-- A forgotten chief_fact stays. Recovery and a later import of the same
-- sentence do not recreate it. The existing unique (userId, dedupeKey) holds
-- the tombstone. Nullable so existing rows remain live.

ALTER TABLE "chief_fact" ADD COLUMN "deletedAt" TIMESTAMP(3);
