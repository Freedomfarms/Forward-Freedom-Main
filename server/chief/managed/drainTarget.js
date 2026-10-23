export function drainTarget(env = process.env) {
  if (env.CHIEF_SUPERVISOR_URL) return `${env.CHIEF_SUPERVISOR_URL.replace(/\/$/, "")}/kick`;
  if (env.CHIEF_DRAIN_URL) return env.CHIEF_DRAIN_URL;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}/api/chief/managed/drain`;
  return null;
}

export async function acknowledgeSupervisor(env = process.env, fetchImpl = fetch) {
  if (!env.CHIEF_SUPERVISOR_URL) return { accepted: false, reason: "supervisor_url_required" };
  const url = drainTarget(env);
  if (!url || !env.CHIEF_DRAIN_SECRET)
    return { accepted: false, reason: "supervisor_not_configured" };
  const downstream = await fetchImpl(url, { method: "POST", headers: drainHeaders(0, env) });
  const payload = await downstream.json().catch(() => ({}));
  const accepted = downstream.status === 202 && payload.accepted === true;
  return { accepted, reason: accepted ? null : "dispatch_not_acknowledged" };
}

export function drainHeaders(depth, env = process.env) {
  const headers = {
    authorization: `Bearer ${env.CHIEF_DRAIN_SECRET || ""}`,
    "content-type": "application/json",
    "x-chief-chain-depth": String(depth),
    "x-chief-actor": "self_post",
  };
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  return headers;
}
