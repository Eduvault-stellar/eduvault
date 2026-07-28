import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function parseOpenApi(source) {
  const operations = new Map();
  const schemas = new Map();
  let path;
  let operation;
  let inPaths = false;
  let inSchemas = false;
  let schema;

  for (const line of source.split("\n")) {
    if (line === "  schemas:") {
      inSchemas = true;
      schema = null;
      continue;
    }
    if (inSchemas && /^  \S/.test(line)) {
      inSchemas = false;
      schema = null;
    }
    const schemaMatch = line.match(/^    ([A-Za-z]\w*):$/);
    if (inSchemas && schemaMatch) {
      schema = { lines: [] };
      schemas.set(schemaMatch[1], schema);
      continue;
    }
    if (inSchemas && schema) schema.lines.push(line);
    if (line === "paths:") {
      inPaths = true;
      operation = null;
      continue;
    }
    if (!inPaths) continue;
    const pathMatch = line.match(/^  (\/[^:]+):$/);
    if (pathMatch) {
      path = pathMatch[1];
      operation = null;
      continue;
    }
    const methodMatch = line.match(/^    ([a-z]+):$/);
    if (path && methodMatch && METHODS.has(methodMatch[1])) {
      operation = { path, method: methodMatch[1], lines: [] };
      operations.set(`${methodMatch[1].toUpperCase()} ${path}`, operation);
      continue;
    }
    operation?.lines.push(line);
  }

  for (const item of operations.values()) {
    const block = item.lines.join("\n");
    item.operationId = block.match(/^      operationId: (.+)$/m)?.[1];
    item.deprecated = /^      deprecated: true$/m.test(block);
    item.block = block;
  }
  for (const item of schemas.values()) {
    const block = item.lines.join("\n");
    item.required = new Set(block.match(/^      required: \[([^\]]*)\]/m)?.[1].split(",").map((value) => value.trim()) || []);
    item.properties = new Map();
    for (const match of block.matchAll(/^        ([A-Za-z]\w*):([^\n]*)([\s\S]*?)(?=^        [A-Za-z]\w*:|(?![\s\S]))/gm)) {
      const definition = `${match[2]}${match[3]}`;
      item.properties.set(match[1], {
        type: definition.match(/\btype: ([^,}\n]+)/)?.[1]?.trim(),
        values: definition.match(/\benum: \[([^\]]+)\]/)?.[1]?.split(",").map((value) => value.trim()),
      });
    }
  }
  return {
    source,
    operations,
    schemas,
    version: source.match(/^  version: ["']?([^"'\n]+)["']?$/m)?.[1] || "0.0.0",
    baseline: source.match(/^  x-contract-baseline: (.+)$/m)?.[1],
  };
}

export function validateOpenApi(document) {
  const errors = [];
  const ids = new Set();
  if (!document.baseline) errors.push("info.x-contract-baseline is required");
  if (!document.source.includes("support-window-days:")) errors.push("deprecation support window is required");
  for (const [key, operation] of document.operations) {
    const { block, operationId } = operation;
    if (!operationId) errors.push(`${key}: operationId is required`);
    else if (ids.has(operationId)) errors.push(`${key}: duplicate operationId ${operationId}`);
    else ids.add(operationId);
    for (const field of ["security:", "x-api-version:", "x-idempotency:", "x-pagination:", "x-example:", "responses:", "default:"]) {
      if (!block.includes(field)) errors.push(`${key}: ${field.slice(0, -1)} is required`);
    }
    if (!block.includes("#/components/responses/Problem")) errors.push(`${key}: problem response is required`);
    if (!["get", "delete"].includes(operation.method) && !block.includes("requestBody:")) {
      errors.push(`${key}: typed requestBody is required`);
    }
    if (operation.deprecated) {
      for (const field of ["x-sunset:", "x-successor:", "x-removal-version:"]) {
        if (!block.includes(field)) errors.push(`${key}: deprecated operation requires ${field.slice(0, -1)}`);
      }
    }
  }
  return errors;
}

export function findBreakingChanges(base, current) {
  if (!base.baseline) return [];
  const changes = [];
  for (const [key, oldOperation] of base.operations) {
    const next = current.operations.get(key);
    if (!next) changes.push(`${key} was removed`);
    else if (oldOperation.operationId !== next.operationId) changes.push(`${key} changed operationId`);
    else {
      const oldStatuses = [...oldOperation.block.matchAll(/^        "(2\d\d)":/gm)].map((match) => match[1]);
      for (const status of oldStatuses) {
        if (!next.block.includes(`        "${status}":`)) changes.push(`${key} removed response ${status}`);
      }
    }
  }
  for (const [name, oldSchema] of base.schemas) {
    const next = current.schemas.get(name);
    if (!next) {
      changes.push(`schema ${name} was removed`);
      continue;
    }
    for (const required of next.required) {
      if (!oldSchema.required.has(required)) changes.push(`schema ${name} made ${required} required`);
    }
    for (const [property, oldDefinition] of oldSchema.properties) {
      const definition = next.properties.get(property);
      if (!definition) changes.push(`schema ${name} removed ${property}`);
      else if (oldDefinition.type !== definition.type) changes.push(`schema ${name}.${property} changed type`);
      else if (oldDefinition.values?.some((value) => !definition.values?.includes(value))) {
        changes.push(`schema ${name}.${property} narrowed enum`);
      }
    }
  }
  const major = (version) => Number(version.split(".")[0]);
  if (changes.length && major(current.version) > major(base.version) && current.source.includes("x-migration:")) return [];
  return changes;
}

export function validateProviders(document, root = process.cwd()) {
  const errors = [];
  for (const [key, { path, method }] of document.operations) {
    const route = join(root, "src/app", path.replaceAll(/\{([^}]+)\}/g, "[$1]"), "route.js");
    if (!existsSync(route)) {
      errors.push(`${key}: provider route is missing`);
      continue;
    }
    const source = readFileSync(route, "utf8");
    const name = method.toUpperCase();
    if (!new RegExp(`export (?:async function|const) ${name}\\b`).test(source)) {
      errors.push(`${key}: provider does not export ${name}`);
    }
  }
  return errors;
}

export function validateServiceConsumers(document, root = process.cwd()) {
  const documented = [...document.operations.values()].map(({ path }) => path);
  const errors = [];
  for (const file of readdirSync(join(root, "src/services")).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(join(root, "src/services", file), "utf8");
    for (const match of source.matchAll(/[`'"](\/api\/[^?`'"]+)/g)) {
      const path = match[1].replace(/\$\{[^}]+\}/g, "{id}");
      const provider = join(root, "src/app", path.replaceAll(/\{([^}]+)\}/g, "[$1]"), "route.js");
      if (existsSync(provider) && !documented.includes(path)) errors.push(`${file}: undocumented consumer path ${path}`);
    }
  }
  return errors;
}

export function validateRepository(source, root = process.cwd()) {
  const document = parseOpenApi(source);
  return [...validateOpenApi(document), ...validateProviders(document, root), ...validateServiceConsumers(document, root)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readFileSync("docs/openapi.yaml", "utf8");
  const document = parseOpenApi(source);
  const errors = validateRepository(source);
  if (process.env.API_CONTRACT_BASE_FILE) {
    try {
      const base = readFileSync(process.env.API_CONTRACT_BASE_FILE, "utf8");
      errors.push(...findBreakingChanges(parseOpenApi(base), document));
    } catch {
      errors.push(`Cannot read API contract from ${process.env.API_CONTRACT_BASE_FILE}`);
    }
  }
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`API contract valid: ${document.operations.size} operations`);
  }
}
