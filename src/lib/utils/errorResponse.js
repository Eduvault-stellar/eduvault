/**
 * RFC 7807 Problem Details error response helper.
 *
 * Returns a Response with Content-Type: application/problem+json and a
 * standardized JSON body containing type, title, status, detail, and instance.
 *
 * @param {Object} options
 * @param {number}  options.status   HTTP status code (default 500)
 * @param {string}  options.title    Short, human-readable summary of the problem
 * @param {string}  options.detail   Human-readable explanation of this occurrence
 * @param {string}  options.instance URI that identifies the specific occurrence
 * @param {string}  options.type     URI that identifies the problem type (default "about:blank")
 * @returns {Response}
 */
export function errorResponse({
  status = 500,
  title,
  detail = "",
  instance = "",
  type = "about:blank",
} = {}) {
  const defaultTitles = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
  };

  const payload = {
    type,
    title: title || defaultTitles[status] || "Error",
    status,
    detail,
    instance,
  };

  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}
