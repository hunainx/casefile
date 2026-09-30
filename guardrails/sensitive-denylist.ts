/**
 * Detector for real-world identifiers that must never ship in this repository:
 * live Supabase project refs, the live GCP project id, the names of real people and
 * matters the codebase was first built against, strings lifted from real case documents,
 * database passwords that leaked, and the names of real Cloud Storage buckets.
 *
 * The denylist is stored as SHA-256 hashes of normalised tokens, not as plaintext.
 * A plaintext denylist in a public repository would publish the very names it exists
 * to keep out. Text is normalised (camelCase and letter/digit boundaries split,
 * lowercased, split on anything that is not [a-z0-9]) and every 1..N-word window on
 * each line is hashed and looked up, so `ACME_REF`, `acmeRef` and `Acme ref`
 * all match the same entry.
 *
 * Also exported: the *.run.app and postgres-with-password patterns used by
 * guardrails/no-shipped-secrets.spec.ts.
 */

import { createHash } from "node:crypto";

export type DenylistKind =
  | "supabase-project-ref"
  | "gcp-project-id"
  | "real-name"
  | "real-case-string"
  | "leaked-password"
  | "real-bucket";

export interface DenylistEntry {
  sha256: string;
  kind: DenylistKind;
  /** Number of normalised words in the entry. */
  words: number;
}

export const DENYLIST: readonly DenylistEntry[] = [
  // Supabase project refs (four live projects)
  { kind: "supabase-project-ref", words: 1, sha256: "d96e90b3aa2ce5c1c8fefe7e63a253f698819b3909b0d2fdb6c9c5740e3704ff" },
  { kind: "supabase-project-ref", words: 1, sha256: "9a4c9a5fa06751841317fa4e3ac3e8d54531009b1a99af65a4a55c849258add6" },
  { kind: "supabase-project-ref", words: 1, sha256: "2398ea69e6a2c0cec211315052dc67b612b70bec4f781b2ccc6277f3359d8461" },
  { kind: "supabase-project-ref", words: 1, sha256: "b1c3657d8068fbba82ceb4152fae9c6867739786cbad42997209dea60f84dd75" },
  // GCP project id
  { kind: "gcp-project-id", words: 12, sha256: "98d2517fc2bfa005c3632956e2e1bddde897fcf2b231779b94d10d8497c79469" },
  // Real people and matter names (camelCase and all-lowercase spellings both listed
  // where normalisation would otherwise split one and not the other)
  { kind: "real-name", words: 1, sha256: "bde93d0afcb3c71f272cc33ac06fa845a38a00b1116b0b94b38fd7b8e9488686" },
  { kind: "real-name", words: 2, sha256: "8dccb47112ce85dfddf479f8893d4dbc1b51f759b03b3119c1fae22e6fc57290" },
  { kind: "real-name", words: 2, sha256: "664af25639c2b24622469a26e4e7afdeb8e51b01828bfaaba11c19c4d2aa6633" },
  { kind: "real-name", words: 2, sha256: "256fef6658a150b67aeeba84f706961f513640783fe13e4575da8bf01de3e6a1" },
  { kind: "real-name", words: 1, sha256: "1d280828eee4d36797947d4f2b5bef845906f7faccf06e91a2db19779cee6cb4" },
  { kind: "real-name", words: 1, sha256: "da7beffa3fe2300dafb2e4b23945d28c12372a7e99bcde29f85cfe03442b4aa2" },
  { kind: "real-name", words: 2, sha256: "44a3697985e5d8b2d3d678b5a193ce7967745e204d8654008f691bc726ceb92d" },
  { kind: "real-name", words: 1, sha256: "d47bcf4e71ce07566832ae226eca995aec213834c69771d3f6228ab7b2e0b525" },
  { kind: "real-name", words: 2, sha256: "0d6bd7285511bf5aa21f95dfb146939f1ae281ceb3b3527f0f4a5500a3f6129a" },
  { kind: "real-name", words: 1, sha256: "4fbf87a1db825d6cca2eef972c88fea3af80a97141a8f2518c9e1c0014041295" },
  { kind: "real-name", words: 2, sha256: "ef7774eefe50d00040b7ce880c01c96b442529a1f56033e01ac45ac494fbc731" },
  { kind: "real-name", words: 1, sha256: "397920f59fe9fb81fb84358f9f222f22a4545c8f90383d44e080f1102c7fae6d" },
  { kind: "real-name", words: 1, sha256: "7c82602500857aa6ed0cf38c4c3e4ec645bdcaa82c00b9155eb08be100c778a9" },
  { kind: "real-name", words: 1, sha256: "6ba5ab4cc77a63b1e79d73878156e3d1c147d5b3e830576e9e11889d8237cc82" },
  // Real Cloud Storage bucket names (a sandbox environment's three buckets). FINAL: the local test buckets were
  // renamed; the legacy buckets' names were taken out of matter.config.ts (they are caught as real-name above).
  { kind: "real-bucket", words: 3, sha256: "6ff7b4088dc885eb0adbdd6b9df390e1f1fed5e74b1c2b4868b86965917f4028" },
  { kind: "real-bucket", words: 3, sha256: "3b7dfcc5d3d0c1879964d4f032a5575a87be6efa73a6669c322f2e2b03137909" },
  { kind: "real-bucket", words: 3, sha256: "74fe07e5ea68115c5f4998233821ac6f847261f2d5d16f205ae2d40cb474a7a2" },
  // Strings lifted from real case documents (the fixture that replaced them keeps the
  // shape with fictional text)
  { kind: "real-case-string", words: 3, sha256: "1500c6c5f0597aa1a5b01c890d39b4b4f70474d7bb052df9da41b2359fcbebbd" },
  // Database passwords that were once committed (raw and URL-encoded forms). Caught here
  // as well as by the connection-string rule because one was embedded on its own, as a
  // detection regex, where no connection string surrounded it.
  { kind: "leaked-password", words: 7, sha256: "f65622ff2e86d38375f84a4e0d8881fc3fad82783dc62bc5be9dc1ee7865b904" },
  { kind: "leaked-password", words: 4, sha256: "8fde9229f0cbbadb066de2aa1f88a81214138e300fcceb8f1f91e8ebead4de40" },
  { kind: "leaked-password", words: 10, sha256: "2e379a21260166ef2ddb984f46cb9c5573526b352a8522e98b4589445c5acde8" },
  { kind: "leaked-password", words: 10, sha256: "4173ac92f43f724edbf240b990260459990bbaa5ec0d5d877165e26d3dfba42d" },
];

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Package-manager integrity digests are random base64 and would produce noise tokens. */
const INTEGRITY_DIGEST = /sha(?:1|256|384|512)-[A-Za-z0-9+/=]{20,}/g;

export function normaliseWords(line: string): string[] {
  return line
    .replace(INTEGRITY_DIGEST, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

export interface DenylistHit {
  line: number;
  kind: DenylistKind;
  sha256: string;
  text: string;
}

const hashCache = new Map<string, string>();
function cachedHash(s: string): string {
  let h = hashCache.get(s);
  if (h === undefined) {
    h = sha256(s);
    hashCache.set(s, h);
  }
  return h;
}

export function findDenylistHits(content: string, denylist: readonly DenylistEntry[] = DENYLIST): DenylistHit[] {
  const byHash = new Map(denylist.map((e) => [e.sha256, e]));
  const windowSizes = [...new Set(denylist.map((e) => e.words))];
  const hits: DenylistHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const words = normaliseWords(lines[i]!);
    for (const n of windowSizes) {
      for (let j = 0; j + n <= words.length; j++) {
        const h = cachedHash(words.slice(j, j + n).join(" "));
        const entry = byHash.get(h);
        if (entry) hits.push({ line: i + 1, kind: entry.kind, sha256: h, text: lines[i]!.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

/** Any Cloud Run hostname, placeholder or not. */
export const RUN_APP_URL = /[A-Za-z0-9<>${}_-][A-Za-z0-9<>${}_.-]*\.run\.app\b/g;

/**
 * postgres:// or postgresql:// with a user:password@host section. The password is
 * acceptable only when it is a placeholder (<...>), an interpolation ($VAR, ${...}),
 * a redaction (***), or the host is loopback — the local Docker stack in
 * infra/compose.yml, whose credentials are public by design.
 */
export const POSTGRES_URL_WITH_PASSWORD = /postgres(?:ql)?:\/\/([^\s:@/"'`]+):([^\s@"'`]*)@([^\s/:"'`?]+)/gi;

export function isAcceptablePostgresPassword(password: string, host: string): boolean {
  if (password.length === 0) return true;
  if (/^<[^>]+>$/.test(password)) return true;
  if (password.startsWith("$")) return true;
  if (/^\*+$/.test(password)) return true;
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase())) return true;
  return false;
}

export function findPostgresPasswordHits(content: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    POSTGRES_URL_WITH_PASSWORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = POSTGRES_URL_WITH_PASSWORD.exec(lines[i]!)) !== null) {
      if (!isAcceptablePostgresPassword(m[2]!, m[3]!)) {
        hits.push({ line: i + 1, text: lines[i]!.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

export function findRunAppHits(content: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    RUN_APP_URL.lastIndex = 0;
    if (RUN_APP_URL.test(lines[i]!)) hits.push({ line: i + 1, text: lines[i]!.trim().slice(0, 200) });
  }
  return hits;
}

/**
 * Credential formats that gitleaks' default rules (v8.28.0) did not report in this repository's history: a Supabase
 * personal access token was committed and went unnoticed (CLEANUP). Each pattern is the format's documented shape.
 * The same rules are in `.gitleaks.toml`, so `gitleaks git` reports them too. A match is reported with its value cut
 * to the first 6 characters: a guardrail must not print the credential it found.
 */
export const KEY_FORMATS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "supabase-access-token", pattern: /\bsbp_[0-9a-f]{40}\b/g },
  { kind: "supabase-secret-key", pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { kind: "google-oauth-access-token", pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { kind: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { kind: "google-service-account-json", pattern: /"type"\s*:\s*"service_account"/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { kind: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { kind: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe-live-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { kind: "casefile-mcp-token", pattern: /\bmcp_sec_[A-Za-z0-9]{32,}\b/g },
];

export interface KeyFormatHit {
  line: number;
  kind: string;
  /** The first 6 characters of the match and its length; never the whole value. */
  redacted: string;
}

export function findKeyFormatHits(content: string): KeyFormatHit[] {
  const hits: KeyFormatHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, pattern } of KEY_FORMATS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(lines[i]!)) !== null) {
        hits.push({ line: i + 1, kind, redacted: `${m[0].slice(0, 6)}… (${m[0].length} chars)` });
      }
    }
  }
  return hits;
}
