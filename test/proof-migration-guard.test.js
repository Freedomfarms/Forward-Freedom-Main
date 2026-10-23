import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  isProofMigration,
  listMigrationNames,
  migrationsToWithhold,
  withholdMigrationDirectories,
} from "../scripts/proof-migration-guard.mjs";

test("pending proof migrations are withheld and applied ones stay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-migrations-"));
  const migrations = path.join(root, "migrations");
  fs.mkdirSync(migrations);
  fs.mkdirSync(path.join(migrations, "20250604120000_init"));
  fs.mkdirSync(path.join(migrations, "20261022193000_chief_managed_proof"));
  fs.writeFileSync(
    path.join(migrations, "20261022193000_chief_managed_proof", "migration.sql"),
    "-- proof\n"
  );
  fs.mkdirSync(path.join(migrations, "20261101120000_later"));
  fs.writeFileSync(path.join(migrations, "20261101120000_later", "PROOF_ONLY"), "");
  try {
    const names = listMigrationNames(migrations);
    assert.equal(isProofMigration(migrations, "20250604120000_init"), false);
    assert.equal(isProofMigration(migrations, "20261101120000_later"), true);
    const withheld = migrationsToWithhold({
      migrationsDir: migrations,
      migrationNames: names,
      appliedNames: ["20261022193000_chief_managed_proof"],
      allowProofMigrate: false,
    });
    assert.deepEqual(withheld, ["20261101120000_later"]);
    assert.deepEqual(
      migrationsToWithhold({
        migrationsDir: migrations,
        migrationNames: names,
        appliedNames: [],
        allowProofMigrate: true,
      }),
      []
    );
    const pending = migrationsToWithhold({
      migrationsDir: migrations,
      migrationNames: names,
      appliedNames: [],
      allowProofMigrate: false,
    });
    const restore = withholdMigrationDirectories(migrations, pending, path.join(root, "staging"));
    assert.equal(fs.existsSync(path.join(migrations, "20250604120000_init")), true);
    assert.equal(fs.existsSync(path.join(migrations, "20261022193000_chief_managed_proof")), false);
    restore();
    assert.equal(
      fs.existsSync(path.join(migrations, "20261022193000_chief_managed_proof", "migration.sql")),
      true
    );
    assert.equal(fs.existsSync(path.join(root, "staging")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
