// Writes only personality.md. Other workspace files are left as they are.

import { PERSONALITY_MEMORY_PATH } from "../../../src/utils/chiefPersonality.js";

function memoryPath(item) {
  return String(item?.path || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export async function syncPersonalityMemory(client, memoryStoreId, guidance) {
  if (!client || !memoryStoreId || typeof guidance !== "string") return { updated: false };
  const listed = (await client.listMemories(memoryStoreId)) || [];
  const match = listed.find((item) => memoryPath(item) === PERSONALITY_MEMORY_PATH);
  if (match && match.content === guidance) return { updated: false, id: match.id || null };
  if (match?.id && typeof client.updateMemory === "function") {
    await client.updateMemory(memoryStoreId, match.id, { content: guidance });
    return { updated: true, id: match.id };
  }
  try {
    const created = await client.createMemory(memoryStoreId, {
      path: `/${PERSONALITY_MEMORY_PATH}`,
      content: guidance,
    });
    return { updated: true, id: created?.id || null };
  } catch (error) {
    if (error?.status !== 409) throw error;
    return { updated: false, id: match?.id || null };
  }
}
