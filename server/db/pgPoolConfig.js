// Builds the node-postgres pool config (connection string + ssl option) that
// server/db/prisma.js and server/db/servicePrisma.js hand to PrismaPg.
//
// Why this exists: `pg` never negotiates TLS unless explicitly told to, so a
// bare Supabase connection string (no `sslmode`) sends a plaintext startup
// packet and the pooler rejects it with "(ESSLREQUIRED) SSL connection is
// required". And when `sslmode` IS present in the URL, pg-connection-string
// interprets it with non-libpq semantics (`require` performs full certificate
// verification against the system trust store, which Supabase's private
// "Supabase Root 2021 CA" chain fails) and silently overrides any `ssl` object
// passed alongside the string. So SSL params are stripped from the URL here
// and translated into an explicit `ssl` option with libpq-equivalent behavior.
//
// Resolution rules:
// - `sslmode=disable`            → no TLS.
// - `sslmode=verify-ca|verify-full` → TLS with certificate verification
//   (against DATABASE_SSL_CA_CERT when provided, else the system trust store).
// - `sslmode=prefer|require|no-verify`, or no `sslmode` on a non-local host
//   → TLS on. Verified against DATABASE_SSL_CA_CERT when provided; otherwise
//   encrypted but unverified (libpq `require` semantics) so managed hosts with
//   private CAs (Supabase) work without shipping their root cert.
// - No `sslmode` on a local host (localhost / loopback / unix socket)
//   → no TLS, so local dev and CI Postgres keep working.
//
// DATABASE_SSL_CA_CERT holds the PEM contents (not a path) of the database
// CA root — for Supabase, the prod-ca-2021.crt downloadable from Database
// Settings → SSL Configuration. Setting it upgrades every TLS connection to
// full verification.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

function readCaCertificate(env) {
  const pem = typeof env.DATABASE_SSL_CA_CERT === "string" ? env.DATABASE_SSL_CA_CERT.trim() : "";
  return pem || null;
}

function resolveSslOption(sslmode, { isLocalHost, caCertificate }) {
  const verified = caCertificate
    ? { rejectUnauthorized: true, ca: caCertificate }
    : { rejectUnauthorized: true };

  switch (sslmode) {
    case "disable":
      return false;
    case "verify-ca":
    case "verify-full":
      return verified;
    case "prefer":
    case "require":
    case "no-verify":
      return caCertificate ? verified : { rejectUnauthorized: false };
    default:
      if (isLocalHost) return undefined;
      return caCertificate ? verified : { rejectUnauthorized: false };
  }
}

export function buildPgPoolConfig(connectionString, env = process.env) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    // Not URL-shaped (e.g. a libpq keyword/value string). Hand it to pg
    // unchanged and let it report its own parse error.
    return { connectionString };
  }

  // When the URL carries file-based TLS params, pg-connection-string builds
  // the ssl object from those files itself — an explicitly configured setup
  // this helper must not second-guess.
  const params = url.searchParams;
  if (params.has("sslcert") || params.has("sslkey") || params.has("sslrootcert")) {
    return { connectionString };
  }

  const sslmode = (params.get("sslmode") || "").trim().toLowerCase();
  const ssl = resolveSslOption(sslmode, {
    isLocalHost: LOCAL_HOSTNAMES.has(url.hostname.toLowerCase()),
    caCertificate: readCaCertificate(env),
  });

  // `sslmode`/`ssl` in the string would override the ssl object below
  // (pg-connection-string wins over sibling config keys), so they must not
  // survive in the URL. When nothing needs stripping, keep the original
  // string byte-for-byte (URL.toString() re-normalizes percent-encoding).
  const hadSslParams = params.has("sslmode") || params.has("ssl");
  params.delete("sslmode");
  params.delete("ssl");
  const outputConnectionString = hadSslParams ? url.toString() : connectionString;

  if (ssl === undefined) {
    return { connectionString: outputConnectionString };
  }

  return { connectionString: outputConnectionString, ssl };
}
