import http from "node:http";

import { bearerMatches, readBearer } from "./secret.js";
import { redactSecrets } from "./redact.js";

// Returns 202 before onKick finishes. The client may disconnect. onKick keeps
// running in this process. This is safe only while the process stays up. A
// serverless function must not use this pattern.

export function createKickServer({ host = "127.0.0.1", port = 0, secret, onKick, onError }) {
  const server = http.createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || request.url !== "/kick") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!bearerMatches(readBearer(request), secret)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: false }));
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
    Promise.resolve()
      .then(() => onKick())
      .catch((error) => {
        if (onError) onError(redactSecrets(error.message));
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host,
        port: typeof address === "object" && address ? address.port : port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
