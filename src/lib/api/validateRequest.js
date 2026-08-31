/**
 * Runtime request validation (#105): parses a request body against a Zod
 * schema and reports failures in the same Problem shape `contract.js`
 * already uses for every other error response, so pagination and
 * validation errors share one documented shape end to end.
 */

import { problem } from "./contract.js";

/**
 * @param {Request} request
 * @param {import("zod").ZodTypeAny} schema
 * @param {{ correlationId?: string }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, response: Response }>}
 */
export async function validateRequestBody(request, schema, { correlationId } = {}) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      response: problem({ request, status: 400, code: "invalid_request", detail, correlationId }),
    };
  }

  return { ok: true, data: result.data };
}
