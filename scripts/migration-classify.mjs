// Default-deny classification for Prisma migration SQL.
//
// The parser is pgsql-parser (libpg_query). Semicolon splitting is not used
// and is not a fallback. A parse error, an empty or comment-only file, or a
// node type outside the additive allowlist denies the file.
//
// CREATE INDEX, CREATE UNIQUE INDEX, and ADD CONSTRAINT … FOREIGN KEY are
// additive only when that same migration creates the table. The same
// statements on a table that already exists are authorization-required.
// ENABLE and FORCE ROW LEVEL SECURITY, the user_isolation policy on "userId",
// and the conditional freedom_app / freedom_service DML grants are additive
// only for a table that same migration creates. The same statements on an
// existing table, or any other policy or DO block, are denied.
// A history-manifest match may be replayed. A changed byte is denied.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "pgsql-parser";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HISTORY_MANIFEST_PATH = path.join(HERE, "migration-history-manifest.json");

const CLASS_RANK = {
  historical: 0,
  additive: 0,
  "authorization-required": 1,
  denied: 2,
};

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadHistoryManifest(manifestPath = HISTORY_MANIFEST_PATH) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed.files !== "object" || parsed.files === null) {
    throw new Error("migration history manifest is unreadable");
  }
  return parsed;
}

export function authorizationCommand(migrationName, digest) {
  return `node scripts/prisma-migrate-deploy.mjs --authorize ${migrationName} --sha256 ${digest}`;
}

function result(classification, reason, extra = {}) {
  return { class: classification, reason, ...extra };
}

function worse(left, right) {
  return (CLASS_RANK[right.class] ?? 2) > (CLASS_RANK[left.class] ?? 2) ? right : left;
}

function stringValue(node) {
  return node?.String?.sval ?? null;
}

function typeName(typeNameNodes) {
  const parts = (typeNameNodes || []).map(stringValue).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function isAllowedDefault(expr) {
  if (!expr || typeof expr !== "object") return false;
  if (expr.A_Const) return true;
  if (expr.SQLValueFunction?.op === "SVFOP_CURRENT_TIMESTAMP") return true;
  if (expr.TypeCast) return isAllowedDefault(expr.TypeCast.arg);
  if (expr.FuncCall) {
    const names = (expr.FuncCall.funcname || []).map(stringValue).filter(Boolean);
    const name = names[names.length - 1];
    if (expr.FuncCall.args && expr.FuncCall.args.length > 0) return false;
    return name === "now" || name === "gen_random_uuid";
  }
  return false;
}

function columnAllowed(columnDef, { inNewTable = false } = {}) {
  if (!columnDef?.colname) return result("denied", "add_column");
  const constraints = columnDef.constraints || [];
  let notNull = false;
  const defaults = [];
  let outcome = result("additive", "column");
  for (const entry of constraints) {
    const kind = entry?.Constraint?.contype;
    if (kind === "CONSTR_NOTNULL") notNull = true;
    else if (kind === "CONSTR_DEFAULT") defaults.push(entry.Constraint);
    else if (kind === "CONSTR_NULL") continue;
    else if (kind === "CONSTR_PRIMARY" || kind === "CONSTR_UNIQUE") {
      outcome = worse(
        outcome,
        inNewTable
          ? result("additive", "table_constraint")
          : result("authorization-required", "operational_risk")
      );
    } else return result("denied", "column_constraint");
  }
  if (!notNull) {
    if (defaults.some((item) => !isAllowedDefault(item.raw_expr))) {
      return result("denied", "default_expression");
    }
    return worse(outcome, result("additive", "nullable_column"));
  }
  if (defaults.length !== 1 || !isAllowedDefault(defaults[0].raw_expr)) {
    return result("denied", "non_null_default");
  }
  return worse(outcome, result("additive", "non_null_constant_default"));
}

function tableConstraintAllowed(constraint) {
  const kind = constraint?.contype;
  if (kind === "CONSTR_PRIMARY" || kind === "CONSTR_UNIQUE" || kind === "CONSTR_FOREIGN") {
    return result("additive", "table_constraint");
  }
  return result("denied", kind ? `constraint_${kind}` : "constraint_unknown");
}

function relationName(relation) {
  if (!relation?.relname) return null;
  if (relation.schemaname && relation.schemaname !== "public") return null;
  return relation.relname;
}

function isUserIsolationExpr(expr) {
  const op = expr?.A_Expr;
  if (!op || op.kind !== "AEXPR_OP") return false;
  if (op.name?.[0]?.String?.sval !== "=") return false;
  const fields = op.lexpr?.ColumnRef?.fields;
  if (fields?.length !== 1 || fields[0]?.String?.sval !== "userId") return false;
  const call = op.rexpr?.FuncCall;
  if (call?.funcname?.[0]?.String?.sval !== "current_setting") return false;
  const args = call.args || [];
  if (args.length !== 2) return false;
  if (args[0]?.A_Const?.sval?.sval !== "app.current_user_id") return false;
  return args[1]?.A_Const?.boolval?.boolval === true;
}

function policyOnNewTable(node, context) {
  const table = relationName(node.table);
  if (!table || !context.createdTables.has(table)) return result("denied", "policy_existing_table");
  if (node.policy_name !== "user_isolation") return result("denied", "policy_name");
  if (node.cmd_name !== "all" || node.permissive !== true) return result("denied", "policy_shape");
  if (!isUserIsolationExpr(node.qual) || !isUserIsolationExpr(node.with_check)) {
    return result("denied", "policy_expression");
  }
  return result("additive", "user_isolation_on_new_table");
}

function runtimeGrantsAllowed(body, createdTables) {
  let text = String(body || "").trim();
  if (!/^BEGIN\b/.test(text) || !/END\s*$/.test(text)) return false;
  text = text.replace(/^BEGIN/, "").replace(/END\s*$/, "");
  const pattern =
    /\s*IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = '(freedom_app|freedom_service)'\) THEN\s+GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "([A-Za-z_][A-Za-z0-9_]*)" TO \1;\s+END IF;\s*/g;
  let saw = false;
  text = text.replace(pattern, (full, _role, table) => {
    if (!createdTables.has(table)) return full;
    saw = true;
    return "";
  });
  return saw && text.trim() === "";
}

function doStmtAllowed(node, context) {
  const body = node.args?.find((entry) => entry?.DefElem?.defname === "as")?.DefElem?.arg?.String
    ?.sval;
  if (!runtimeGrantsAllowed(body, context.createdTables)) {
    return result("denied", "do_block");
  }
  return result("additive", "runtime_grants_on_new_table");
}

function indexOnTable(table, { baseTables, createdTables }) {
  if (!table) return result("denied", "table_unknown");
  if (createdTables.has(table)) return result("additive", "index_on_new_table");
  if (baseTables.has(table)) {
    return result("authorization-required", "operational_risk");
  }
  return result("denied", "table_unknown");
}

function createdNames(stmts) {
  const tables = new Set();
  const types = new Set();
  for (const entry of stmts) {
    const stmt = entry?.stmt;
    if (!stmt) continue;
    if (stmt.CreateStmt) {
      const name = relationName(stmt.CreateStmt.relation);
      if (name) tables.add(name);
    }
    if (stmt.CreateEnumStmt) {
      const name = typeName(stmt.CreateEnumStmt.typeName);
      if (name) types.add(name);
    }
  }
  return { tables, types };
}

function classifyNode(stmt, context) {
  const key = stmt ? Object.keys(stmt)[0] : null;
  const node = key ? stmt[key] : null;
  if (key === "CreateSchemaStmt") {
    if (node.if_not_exists === true && typeof node.schemaname === "string" && node.schemaname) {
      return result("additive", "create_schema");
    }
    return result("denied", "create_schema");
  }
  if (key === "CreateEnumStmt") {
    const name = typeName(node.typeName);
    if (!name) return result("denied", "create_type");
    if (context.baseTypes.has(name)) return result("denied", "type_exists");
    return result("additive", "create_type");
  }
  if (key === "CreateStmt") {
    const name = relationName(node.relation);
    if (!name) return result("denied", "create_table");
    if (context.baseTables.has(name)) return result("denied", "table_exists");
    let outcome = result("additive", "create_table");
    for (const element of node.tableElts || []) {
      if (element.ColumnDef) {
        outcome = worse(outcome, columnAllowed(element.ColumnDef, { inNewTable: true }));
      } else if (element.Constraint)
        outcome = worse(outcome, tableConstraintAllowed(element.Constraint));
      else outcome = worse(outcome, result("denied", "create_table_element"));
    }
    return outcome;
  }
  if (key === "IndexStmt") {
    if (node.concurrent === true) return result("denied", "create_index_concurrently");
    return indexOnTable(relationName(node.relation), context);
  }
  if (key === "CreatePolicyStmt") return policyOnNewTable(node, context);
  if (key === "DoStmt") return doStmtAllowed(node, context);
  if (key === "AlterTableStmt") {
    const table = relationName(node.relation);
    if (!table) return result("denied", "alter_table");
    if (!context.baseTables.has(table) && !context.createdTables.has(table)) {
      return result("denied", "table_unknown");
    }
    const commands = node.cmds || [];
    if (commands.length === 0) return result("denied", "alter_table_empty");
    let outcome = result("additive", "alter_table");
    for (const command of commands) {
      const alter = command?.AlterTableCmd;
      const subtype = alter?.subtype;
      if (subtype === "AT_AddColumn") {
        outcome = worse(outcome, columnAllowed(alter.def?.ColumnDef));
        continue;
      }
      if (subtype === "AT_AddConstraint" && alter.def?.Constraint?.contype === "CONSTR_FOREIGN") {
        outcome = worse(outcome, indexOnTable(table, context));
        continue;
      }
      if (
        (subtype === "AT_EnableRowSecurity" || subtype === "AT_ForceRowSecurity") &&
        context.createdTables.has(table)
      ) {
        outcome = worse(outcome, result("additive", "row_security_on_new_table"));
        continue;
      }
      outcome = worse(outcome, result("denied", subtype || "alter_table"));
    }
    return outcome;
  }
  return result("denied", key || "unrecognized");
}

export async function classifySql(sql, { baseTables = new Set(), baseTypes = new Set() } = {}) {
  const text = typeof sql === "string" ? sql : "";
  if (text.trim() === "") return result("denied", "empty");
  let parsed;
  try {
    parsed = await parse(text);
  } catch (error) {
    return result("denied", "parse_error", {
      detail: String(error?.message || "parse_error").slice(0, 200),
    });
  }
  const stmts = parsed?.stmts || [];
  if (stmts.length === 0) return result("denied", "comment_only");
  const created = createdNames(stmts);
  const createdTables = new Set([...created.tables].filter((name) => !baseTables.has(name)));
  const context = { baseTables, baseTypes, createdTables };
  let outcome = result("additive", "allowlist");
  const statements = [];
  for (const entry of stmts) {
    const node = entry?.stmt;
    if (!node) {
      const denied = result("denied", "unrecognized");
      statements.push(denied);
      outcome = worse(outcome, denied);
      continue;
    }
    const classified = classifyNode(node, context);
    statements.push({ class: classified.class, reason: classified.reason });
    outcome = worse(outcome, classified);
  }
  return { ...outcome, statements };
}

export async function classifyMigrationBytes(bytes, options = {}) {
  const digest = sha256(bytes);
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes ?? "");
  if (options.manifestSha) {
    if (digest !== options.manifestSha) {
      return result("denied", "history_manifest_mismatch", { sha256: digest });
    }
    return result("historical", "manifest_match", { sha256: digest });
  }
  const classified = await classifySql(text, options);
  return { ...classified, sha256: digest };
}

export function listMigrationDirectories(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function relationsInFile(bytes) {
  try {
    const parsed = await parse(bytes.toString("utf8"));
    return createdNames(parsed?.stmts || []);
  } catch {
    return { tables: new Set(), types: new Set() };
  }
}

export async function classifyMigrationTree({
  migrationsDir,
  manifest = loadHistoryManifest(),
  names = null,
} = {}) {
  const directory = migrationsDir || path.resolve("prisma/migrations");
  const allNames = listMigrationDirectories(directory);
  const selected = new Set(names || allNames);
  const tables = new Set();
  const types = new Set();
  const files = [];
  for (const name of allNames) {
    const sqlPath = path.join(directory, name, "migration.sql");
    const bytes = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath) : null;
    if (selected.has(name)) {
      if (!bytes) {
        files.push({
          name,
          ...result("denied", "missing_sql"),
          sha256: null,
          command: null,
        });
        continue;
      }
      const manifestSha = Object.prototype.hasOwnProperty.call(manifest.files, name)
        ? manifest.files[name]
        : null;
      const classified = await classifyMigrationBytes(bytes, {
        manifestSha,
        baseTables: tables,
        baseTypes: types,
      });
      files.push({
        name,
        ...classified,
        command:
          classified.class === "additive" || classified.class === "historical"
            ? null
            : authorizationCommand(name, classified.sha256),
      });
    }
    if (!bytes) continue;
    const manifestSha = manifest.files[name];
    if (manifestSha && sha256(bytes) !== manifestSha) continue;
    const created = await relationsInFile(bytes);
    for (const table of created.tables) tables.add(table);
    for (const type of created.types) types.add(type);
  }
  const blocked = files.find((file) => file.class !== "additive" && file.class !== "historical");
  return { files, blocked: blocked || null };
}

export function automaticMigrate(files) {
  const fresh = (files || []).filter((file) => file.class !== "historical");
  if (fresh.length === 0) return "yes";
  return fresh.every((file) => file.class === "additive") ? "yes" : "no";
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const tree = await classifyMigrationTree();
  for (const file of tree.files) {
    if (file.class === "historical") continue;
    process.stdout.write(`${file.name} ${file.class} ${file.sha256 || ""} ${file.command || ""}\n`);
  }
  if (tree.blocked) {
    process.stderr.write(
      `[migration-classify] blocked ${tree.blocked.name} ${tree.blocked.class}\n`
    );
    process.exit(1);
  }
  process.stdout.write("[migration-classify] additive\n");
}
