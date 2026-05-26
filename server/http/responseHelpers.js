/**
 * Security headers applied to every API response.
 * For Express, use Helmet instead (server/index.js).
 * This helper covers Vercel serverless functions.
 */
export function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-XSS-Protection", "0");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Cache-Control", "no-store");
}

/**
 * Returns false and writes a 405 response if the request method is not allowed.
 * Usage: if (!assertMethod(req, res, "GET")) return;
 */
export function assertMethod(request, response, ...allowedMethods) {
  if (!allowedMethods.includes(request.method)) {
    applySecurityHeaders(response);
    response.setHeader("Allow", allowedMethods.join(", "));
    response.status(405).json({ error: true, message: "Method not allowed." });
    return false;
  }
  return true;
}
