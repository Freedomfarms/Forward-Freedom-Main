// Historical Claude and ChatGPT imports.
//
// POST without confirm previews an export. POST with confirm: true writes
// the archive. GET lists or reads one owned conversation. DELETE requires
// confirm: true. Ownership is the authenticated user. A user id in the body
// is ignored. Imported transcripts are not CHIEF sessions.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import {
  importExport,
  previewExport,
  removeImportedConversation,
} from "../../server/chief/archive/import.js";
import { PrismaExternalArchive } from "../../server/chief/archive/store.js";
import { PrismaAuditLog } from "../../server/chief/security/audit.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

function textField(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function handleExternalConversations(request, response, deps = {}) {
  applySecurityHeaders(response);
  const limit = deps.enforceRateLimit ?? enforceRateLimit;
  if (!(await limit(request, response, generalApiRateLimit))) return;

  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    response.status(405).json({ error: "GET, POST, or DELETE required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }
  if (!userId) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const store = deps.store ?? new PrismaExternalArchive();
  const audit = deps.audit ?? new PrismaAuditLog();

  if (method === "GET") {
    const id = textField(request.query?.id, 80);
    if (!id) {
      response.status(200).json({ conversations: await store.list(userId) });
      return;
    }
    const conversation = await store.get(userId, id);
    if (!conversation) {
      response.status(404).json({ error: "imported conversation not found" });
      return;
    }
    response.status(200).json({ conversation });
    return;
  }

  const body = request.body ?? {};

  if (method === "DELETE") {
    if (body.confirm !== true) {
      response
        .status(400)
        .json({ error: "confirm must be true to delete an imported conversation" });
      return;
    }
    const id = textField(body.id, 80);
    if (!id) {
      response.status(400).json({ error: "id is required" });
      return;
    }
    const result = await removeImportedConversation(userId, id, { store, audit });
    if (!result.deleted) {
      response.status(404).json({ error: "imported conversation not found" });
      return;
    }
    response.status(200).json(result);
    return;
  }

  const provider = textField(body.provider, 20);
  const filename = textField(body.filename, 200);
  const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
  if (!filename || !/\.(json|zip)$/i.test(filename)) {
    response.status(400).json({ error: "upload a .json or .zip export" });
    return;
  }
  const input = { provider, filename, dataBase64 };
  if (body.confirm === true) {
    const result = await importExport(input, { userId, store, audit });
    if (result.error) {
      response.status(400).json({ error: result.error });
      return;
    }
    response.status(200).json({ mode: "import", provider, ...result });
    return;
  }
  const preview = await previewExport(input);
  if (preview.error) {
    response.status(400).json({ error: preview.error });
    return;
  }
  response.status(200).json({ mode: "preview", ...preview.preview });
}

export default function handler(request, response) {
  return handleExternalConversations(request, response);
}
