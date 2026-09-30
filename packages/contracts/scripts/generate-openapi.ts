import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const doc = generateOpenApiDocument();
const targetPath = resolve(__dirname, "../openapi.json");
writeFileSync(targetPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");

