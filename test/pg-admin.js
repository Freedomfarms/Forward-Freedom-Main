import { spawnSync } from "node:child_process";

// Admin psql/createdb target for database-backed tests.
//
// The connection follows DATABASE_URL (host, port, and the postgres password).
// CI publishes Postgres over TCP. A laptop that still uses the historical
// Unix socket leaves DATABASE_URL unset or points host at that socket, and
// the fallback stays /tmp port 5433.

function userinfo(user, password) {
  const name = encodeURIComponent(user);
  if (!password) return name;
  return `${name}:${encodeURIComponent(password)}`;
}

export function readAdminTarget(env = process.env) {
  const raw = env.ADMIN_DATABASE_URL || env.DATABASE_URL || env.DIRECT_URL || "";
  let host = env.TEST_PG_HOST || "";
  let port = env.TEST_PG_PORT || "";
  let password = env.TEST_PG_PASSWORD || "";
  if (raw) {
    try {
      const url = new URL(raw);
      const socketHost = url.searchParams.get("host");
      if (!env.TEST_PG_HOST) host = socketHost || url.hostname || host;
      if (!port) port = url.port || "";
      const role = decodeURIComponent(url.username || "");
      if (!password && (!role || role === "postgres")) {
        password = decodeURIComponent(url.password || "");
      }
    } catch {
      // An unparseable URL keeps the socket fallback below.
    }
  }
  if (!host) host = "/tmp";
  if (!port) port = host.startsWith("/") ? "5433" : "5432";
  return {
    host,
    port: String(port),
    user: env.TEST_PG_USER || "postgres",
    password,
  };
}

export function databaseUrlFor(admin, database, options = {}) {
  const role = options.user || admin.user;
  const secret = Object.prototype.hasOwnProperty.call(options, "password")
    ? options.password
    : admin.password;
  const auth = userinfo(role, secret);
  const name = encodeURIComponent(database);
  if (admin.host.startsWith("/")) {
    return `postgresql://${auth}@/${name}?host=${encodeURIComponent(admin.host)}&port=${admin.port}`;
  }
  return `postgresql://${auth}@${admin.host}:${admin.port}/${name}`;
}

function spawnEnv(admin, { user } = {}) {
  const env = { ...process.env };
  const sameRole = !user || user === admin.user;
  if (sameRole && admin.password) env.PGPASSWORD = admin.password;
  else delete env.PGPASSWORD;
  return env;
}

export function runPsql(admin, { user, database, args }) {
  return spawnSync(
    "psql",
    ["-h", admin.host, "-p", admin.port, "-U", user || admin.user, "-d", database, ...args],
    { encoding: "utf8", env: spawnEnv(admin, { user }) }
  );
}

export function runCreatedb(admin, database) {
  return spawnSync(
    "createdb",
    ["-h", admin.host, "-p", admin.port, "-U", admin.user, database],
    { encoding: "utf8", env: spawnEnv(admin) }
  );
}
