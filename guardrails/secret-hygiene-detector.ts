/**
 * Detector for REQ-M-SEC-017: a secret-shaped environment variable given a string-literal
 * default. Kept separate from the spec so it can be imported without pulling in vitest
 * (e.g. to print what the detector sees in a given file).
 */

export const SECRET_SHAPED = /SECRET|TOKEN|PASSWORD|KEY|DATABASE_URL|CREDENTIAL/;

// process.env.NAME || "…"   process.env.NAME ?? '…'   process.env["NAME"] || `…`
// Whitespace (including a line break) between the operator and the literal is allowed,
// so a fallback cannot hide by wrapping onto the next line.
const FALLBACK_PATTERN = /process\.env(?:\.([A-Z0-9_]+)|\[["']([A-Z0-9_]+)["']\])\s*(?:\|\||\?\?)\s*["'`]/g;

export interface SecretFallbackHit {
  line: number;
  name: string;
}

export function findSecretFallbacks(content: string): SecretFallbackHit[] {
  const hits: SecretFallbackHit[] = [];
  FALLBACK_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FALLBACK_PATTERN.exec(content)) !== null) {
    const name = m[1] ?? m[2] ?? "";
    if (!SECRET_SHAPED.test(name)) continue;
    const line = content.slice(0, m.index).split("\n").length;
    hits.push({ line, name });
  }
  return hits;
}
