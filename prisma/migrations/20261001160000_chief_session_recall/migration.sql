-- Sanitized search projection on the existing chief_session row.
-- The encrypted checkpoint remains the transcript. This column is not a
-- second message store. Search stays owner-scoped by "userId" plus RLS.

ALTER TABLE "chief_session" ADD COLUMN IF NOT EXISTS "recallDocument" TEXT;

CREATE INDEX IF NOT EXISTS "chief_session_recall_document_fts_idx"
  ON "chief_session"
  USING GIN (to_tsvector('simple', coalesce("recallDocument", '')));
