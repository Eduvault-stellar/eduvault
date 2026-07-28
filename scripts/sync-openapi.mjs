import { copyFile } from "node:fs/promises";

await copyFile(new URL("../docs/openapi.yaml", import.meta.url), new URL("../public/openapi.yaml", import.meta.url));
