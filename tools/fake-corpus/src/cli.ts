/**
 * pnpm fake-corpus --size 1GB --seed 42 [--out <folder>]
 *
 * Writes an invented evidence corpus (see generate.ts) to a folder OUTSIDE the repository;
 * the default is ~/casefile-fake-data/<size>-<seed> (CASEFILE_FAKE_DATA_DIR changes the base).
 * It refuses a folder inside the repository and a folder that is not empty.
 *
 * pnpm fake-corpus --kind mailboxes [--seed 42]            fake MBOX and PST mailboxes (mailboxes.ts)
 * pnpm fake-corpus --kind mbox|pst --size 1GB [--seed 42]   one mailbox of about that size
 * Default folders: ~/casefile-fake-data/mailboxes-<seed>, mbox-<size>-<seed>, pst-<size>-<seed>.
 */
import { resolve } from "node:path";
import { parseArgs } from "../../ingest-cli/src/args.js";
import { formatSummary, generateCorpus, parseSize } from "./generate.js";
import { defaultOutDir } from "./marker.js";
import { formatMailboxSummary, generateMailboxes, type MailboxKind } from "./mailboxes.js";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const sizeLabel = typeof args.size === "string" ? args.size.trim() : "";
  const seedArg = typeof args.seed === "string" ? args.seed.trim() : "42";
  const kind = typeof args.kind === "string" ? args.kind.trim() : "";
  if (kind) {
    if (!["mailboxes", "mbox", "pst"].includes(kind) || !/^\d+$/.test(seedArg) || (kind !== "mailboxes" && !sizeLabel)) {
      console.error("Usage: pnpm fake-corpus --kind mailboxes [--seed 42] [--out <folder>]  |  pnpm fake-corpus --kind mbox|pst --size <1GB|2GB|...> [--seed 42] [--out <folder>]");
      return 2;
    }
    const seed = Number(seedArg);
    const label = kind === "mailboxes" ? "mailboxes" : `${kind}-${sizeLabel.toUpperCase()}`;
    const outDir = resolve(typeof args.out === "string" ? args.out : defaultOutDir(label, seed));
    console.log(`Generating fake ${kind} (seed ${seed}) into ${outDir} ...`);
    const s = await generateMailboxes({
      kind: kind as MailboxKind,
      seed,
      outDir,
      ...(kind === "mailboxes" ? {} : { sizeBytes: parseSize(sizeLabel) }),
      log: (line) => console.log(line),
    });
    console.log(formatMailboxSummary(s, outDir));
    return 0;
  }
  if (!sizeLabel || !/^\d+$/.test(seedArg)) {
    console.error("Usage: pnpm fake-corpus --size <100MB|1GB|10GB|...> [--seed <integer, default 42>] [--out <folder outside the repository>]");
    return 2;
  }
  const seed = Number(seedArg);
  const sizeBytes = parseSize(sizeLabel);
  const outDir = resolve(typeof args.out === "string" ? args.out : defaultOutDir(sizeLabel.toUpperCase(), seed));
  console.log(`Generating ${sizeLabel} of fake documents (seed ${seed}) into ${outDir} ...`);
  let lastReport = 0;
  const summary = await generateCorpus({
    sizeBytes,
    seed,
    outDir,
    onProgress: (bytes, files) => {
      if (bytes - lastReport >= Math.max(sizeBytes / 20, 1)) {
        lastReport = bytes;
        console.log(`  ${((100 * bytes) / sizeBytes).toFixed(0).padStart(3)}%  ${files} files`);
      }
    },
  });
  console.log(formatSummary(summary, outDir));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`fake-corpus: ${(err as Error).message}`);
    process.exit(1);
  },
);
