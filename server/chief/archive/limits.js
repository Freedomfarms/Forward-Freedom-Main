// Upload bounds for historical Claude and ChatGPT exports.
//
// The serverless body ceiling is 4.5 MB. Base64 JSON needs headroom under
// that, so the decoded file stops at 3 MB. Uncompressed ZIP output has its
// own cap so a small compressed archive cannot expand without a limit.

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
export const MAX_ZIP_ENTRIES_READ = 20;
export const MAX_CONVERSATIONS = 500;
export const MAX_MESSAGES_PER_CONVERSATION = 4_000;
export const MAX_BLOCK_CHARS = 100_000;
export const MAX_TITLE_CHARS = 300;
export const RECALL_DOCUMENT_MAX = 2_000;
export const MAX_LIST = 100;
// Retrieval decrypts this many messages. Search never decrypts transcripts.
export const ARCHIVE_EXCERPT_MESSAGES = 40;
