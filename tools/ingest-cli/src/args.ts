import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Lightweight .env parser that explicitly loads and overrides variables from .env file.
 */
export function loadEnv(envPath = ".env"): void {
  const fullPath = resolve(process.cwd(), envPath);
  if (!existsSync(fullPath)) return;
  try {
    const content = readFileSync(fullPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch {
    void 0;
  }
}

/**
 * Lightweight CLI argument parser for ingest tools.
 */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        if (k) args[k] = v ?? true;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}
