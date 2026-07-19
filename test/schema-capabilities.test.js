import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getSchemaCapabilities,
  resetSchemaCapabilitiesCache,
} from "../server/db/schemaCapabilities.js";

// getSchemaCapabilities must only treat missing-column failures as
// "encryption not migrated". Permission denied (the failure mode after
// switching DATABASE_URL to freedom_app without grants) must propagate so the
// request surfaces a 42501 diagnostic instead of silently falling back to the
// legacy plaintext `state` column path.

beforeEach(() => {
  resetSchemaCapabilitiesCache();
});

function prismaWithQuery(impl) {
  return { $queryRaw: (...args) => impl(...args) };
}

test("probe success → encryptionColumns true", async () => {
  const caps = await getSchemaCapabilities(prismaWithQuery(async () => []));
  assert.deepEqual(caps, { encryptionColumns: true });
});

test("missing-column probe → encryptionColumns false (compat path)", async () => {
  const caps = await getSchemaCapabilities(
    prismaWithQuery(async () => {
      const error = new Error('column "stateCiphertext" does not exist');
      error.code = "42703";
      throw error;
    })
  );
  assert.deepEqual(caps, { encryptionColumns: false });
});

test("permission denied on the probe is NOT cached as no-encryption", async () => {
  await assert.rejects(
    () =>
      getSchemaCapabilities(
        prismaWithQuery(async () => {
          const error = new Error("permission denied for table WorkspaceSnapshot");
          error.code = "42501";
          throw error;
        })
      ),
    (thrown) => {
      assert.equal(thrown.code, "42501");
      return true;
    }
  );
});
