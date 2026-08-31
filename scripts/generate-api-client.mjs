/**
 * Generates a typed API client from docs/openapi.yaml (#105).
 *
 * Reuses the same parser check-api-contracts.mjs already uses to validate
 * the spec, so the generated client and the contract check read the
 * document identically — no second parser to drift out of sync with the
 * first. One function per operationId, routed through the existing
 * apiClient fetch wrapper so version headers / error handling stay
 * centralized in one place.
 *
 * `npm run generate:api-client` writes src/lib/api/generated/client.js.
 * `npm run check:generated-client` (wired into CI) regenerates to a temp
 * file and diffs against the committed one, so the client can't silently
 * drift from the spec the way handwritten response casts could.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseOpenApi } from "./check-api-contracts.mjs";

export const GENERATED_CLIENT_PATH = "src/lib/api/generated/client.js";

const HEADER = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by scripts/generate-api-client.mjs from docs/openapi.yaml.
 * Run \`npm run generate:api-client\` after changing the spec.
 * \`npm run check:generated-client\` (CI) fails if this file has drifted
 * from what the spec would generate.
 */

import { apiClient } from "../apiClient.js";
`;

function pathParamNames(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function toPathTemplate(path, params) {
  return params.reduce((template, param) => template.replace(`{${param}}`, "${" + param + "}"), path);
}

function toIdentifier(operationId) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operationId) ? operationId : null;
}

function generateFunction(operation) {
  const { path, method, operationId, block } = operation;
  const name = toIdentifier(operationId);
  if (!name) return null;

  const summary = block.match(/^      summary: (.+)$/m)?.[1] ?? operationId;
  const params = pathParamNames(path);
  const hasBody = !["get", "delete"].includes(method);
  const destructureFields = [...params, ...(hasBody ? ["body"] : []), "query"];
  const template = toPathTemplate(path, params);

  return `/**
 * ${summary}
 * ${method.toUpperCase()} ${path}
 */
export async function ${name}({ ${destructureFields.join(", ")}, ...init } = {}) {
  const path = \`${template}\`;
  const url = query && Object.keys(query).length ? \`\${path}?\${new URLSearchParams(query)}\` : path;
  return apiClient(url, { method: "${method.toUpperCase()}"${hasBody ? ", body" : ""}, ...init });
}`;
}

export function generateClientSource(source) {
  const document = parseOpenApi(source);
  const functions = [...document.operations.values()]
    .map(generateFunction)
    .filter(Boolean);
  return `${HEADER}\n${functions.join("\n\n")}\n`;
}

export function writeGeneratedClient(source, outPath = GENERATED_CLIENT_PATH, root = process.cwd()) {
  const absolute = join(root, outPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, generateClientSource(source));
  return absolute;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readFileSync("docs/openapi.yaml", "utf8");
  const written = writeGeneratedClient(source);
  console.log(`Generated ${written}`);
}
