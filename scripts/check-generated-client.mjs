/**
 * CI drift gate for the generated API client (#105): regenerates
 * src/lib/api/generated/client.js from the current docs/openapi.yaml into a
 * temp file and diffs it against what's committed. A spec change without a
 * matching `npm run generate:api-client` fails CI here — the other half of
 * "CI fails when generated artifacts... drift" that check-api-contracts.mjs
 * (spec-vs-route drift) doesn't cover.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateClientSource, GENERATED_CLIENT_PATH } from "./generate-api-client.mjs";

export function checkGeneratedClient(root = process.cwd()) {
  const source = readFileSync(join(root, "docs/openapi.yaml"), "utf8");
  const expected = generateClientSource(source);
  let committed;
  try {
    committed = readFileSync(join(root, GENERATED_CLIENT_PATH), "utf8");
  } catch {
    return [`${GENERATED_CLIENT_PATH} does not exist — run \`npm run generate:api-client\``];
  }
  if (committed !== expected) {
    return [`${GENERATED_CLIENT_PATH} is out of date with docs/openapi.yaml — run \`npm run generate:api-client\` and commit the result`];
  }
  return [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkGeneratedClient();
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Generated API client is up to date.");
  }
}
