export const API_VERSION = "1";
const PROBLEM_TITLES = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  409: "Conflict", 413: "Payload Too Large", 422: "Unprocessable Entity",
  429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable",
};
const SENSITIVE_KEYS = /^(?:password(?:Hash)?|authToken|refreshToken|privateKey|secretKey|signedXdr|signature)$/i;

function requestedVersion(request) {
  const explicit = request.headers.get("x-api-version");
  const mediaType = request.headers.get("accept")?.match(/vnd\.eduvault\.v(\d+)\+json/i)?.[1];
  return explicit || mediaType || API_VERSION;
}

function problem({ request, status, code, detail, correlationId, headers }) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/problem+json");
  responseHeaders.set("API-Version", API_VERSION);
  responseHeaders.set("Vary", "X-API-Version, Accept");
  if (correlationId) responseHeaders.set("x-correlation-id", correlationId);
  return Response.json({
    type: `https://eduvault.invalid/problems/${code}`,
    title: PROBLEM_TITLES[status] || "Request Failed",
    status,
    detail,
    instance: new URL(request.url).pathname,
    code,
    correlationId: correlationId || null,
  }, { status, headers: responseHeaders });
}

export function negotiateApiVersion(request, correlationId) {
  const version = requestedVersion(request);
  if (version === API_VERSION) return null;
  return problem({
    request, status: 400, code: "unsupported_api_version", correlationId,
    detail: `API version ${version} is unsupported; use version ${API_VERSION}.`,
  });
}

function assertSafeJson(value, allowedKeys) {
  if (value === null || typeof value !== "object") throw new TypeError("JSON responses must be objects or arrays");
  if (Array.isArray(value)) return value.forEach((child) => assertSafeJson(child, allowedKeys));
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) throw new TypeError(`Response contains sensitive field: ${key}`);
    if (allowedKeys && !allowedKeys.includes(key)) throw new TypeError(`Undocumented response field: ${key}`);
    if (child && typeof child === "object") assertSafeJson(child);
  }
}

export async function enforceApiResponse(response, { request, correlationId, deprecation, responseKeys } = {}) {
  if (!(response instanceof Response)) throw new TypeError("API handlers must return a Response");
  response.headers.set("API-Version", API_VERSION);
  const vary = new Set((response.headers.get("Vary") || "").split(",").map((value) => value.trim()).filter(Boolean));
  response.headers.set("Vary", [...vary, "X-API-Version", "Accept"].join(", "));
  if (deprecation) {
    response.headers.set("Deprecation", "true");
    response.headers.set("Sunset", deprecation.sunset);
    response.headers.set("Link", `<${deprecation.successor}>; rel="successor-version"`);
  }

  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    throw new TypeError("Invalid JSON response");
  }
  if (response.ok) {
    assertSafeJson(payload, responseKeys);
    return response;
  }
  if (payload.type && payload.code && payload.correlationId !== undefined) return response;
  const code = payload.code || (response.status === 400 ? "invalid_request" : `http_${response.status}`);
  return problem({
    request, status: response.status, code, correlationId,
    detail: payload.detail || payload.error || PROBLEM_TITLES[response.status] || "Request failed",
    headers: response.headers,
  });
}

export async function withApiContract(request, options, handler) {
  const correlationId = request.headers.get("x-correlation-id") || crypto.randomUUID();
  const rejected = negotiateApiVersion(request, correlationId);
  if (rejected) return rejected;
  try {
    return await enforceApiResponse(await handler(), { request, correlationId, ...options });
  } catch {
    return problem({ request, status: 500, code: "response_contract_violation", correlationId, detail: "Response violated the API contract." });
  }
}
