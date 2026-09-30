import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How a generated file is recognised, and where the corpus may and may not be written.
 *
 * Every generated file that has room for it carries MARKER_PREFIX (an email header, a PDF
 * info string, a PNG tEXt chunk, a zip comment, or appended bytes); every output folder holds
 * MARKER_FILE and the manifest. guardrails/no-fake-corpus-in-repo.spec.ts fails if any of these
 * appears inside the repository.
 */
export const MARKER_PREFIX = "casefile-fake-corpus:v1";
export const MARKER_FILE = ".casefile-fake-corpus";
export const MANIFEST_FILE = "fake-corpus-manifest.csv";
export const SUMMARY_FILE = "fake-corpus-summary.json";

export function markerFor(seed: number): string {
  return `${MARKER_PREFIX}:seed-${seed}`;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** True when `path` is the repository or anything inside it (case-insensitive on Windows). */
export function isInsideRepo(path: string, repoRoot = REPO_ROOT): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(repoRoot), norm(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The default output folder: ~/casefile-fake-data/<size>-<seed> (in the home folder, outside any repository).
 * CASEFILE_FAKE_DATA_DIR replaces the base folder.
 */
export function defaultOutDir(sizeLabel: string, seed: number): string {
  return join(fakeDataBase(), `${sizeLabel}-${seed}`);
}

/** The base folder of generated fake data (and of the PST writer's build cache, BIGDATA-3B). */
export function fakeDataBase(): string {
  return (
    process.env.CASEFILE_FAKE_DATA_DIR?.trim() ||
    join(homedir(), "casefile-fake-data")
  );
}
