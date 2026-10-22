export function drainTarget(env = process.env) {
  if (env.CHIEF_SUPERVISOR_URL) return `${env.CHIEF_SUPERVISOR_URL.replace(/\/$/, "")}/kick`;
  if (env.CHIEF_DRAIN_URL) return env.CHIEF_DRAIN_URL;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}/api/chief/managed/drain`;
  return null;
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
