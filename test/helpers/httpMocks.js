// Minimal request/response doubles matching the surface the api/*.js handlers
// use on both Vercel and Express.

export function createRequest({
  method = "GET",
  headers = {},
  query = {},
  params = {},
  body,
} = {}) {
  return { method, headers, query, params, ...(body !== undefined ? { body } : {}) };
}

export function createResponse() {
  const response = {
    statusCode: null,
    body: undefined,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[name];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return response;
}
