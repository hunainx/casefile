/* eslint-disable no-console */
/**
 * BIGDATA-1 baseline: today's ingestion (tools/ingest-cli, ingestDirectory) on a fake corpus,
 * against the local Docker stack only (Postgres 127.0.0.1:55432, fake-gcs 127.0.0.1:4443).
 *
 * The ingestion code is not changed. This file runs the real ingestDirectory() and, through
 * vitest module mocks, wraps the functions it calls with timers:
 *   walk   readdirSync            read   readFileSync          hash   computeSha256, sha256OfFile
 *   store  ObjectStore.put, .putFile (BIGDATA-2A: files above the parse limit are streamed)
 *   parse  every parser in document-parsers / pdf-parser
 *   tx     withTenant (one transaction per top-level file)
 * Database time = tx - (store + parse + hash + near-duplicate work inside the transaction). OCR: the
 * ingest has no OCR step, so there is nothing to time.
 * BIGDATA-3: triageDirectory is wrapped too; everything inside it (its hashing and its own
 * transactions) is the "triage" stage, not hash or database. The near-duplicate time is the
 * ingest's own measure (summary.timings.nearDuplicateMs: signatures, LSH lookups, fingerprint rows).
 * After the run, what triage and the near-duplicate rule decided is scored against the manifest. pg_stat_statements (run-baseline.sh loads it) gives the
 * per-query cost; `--cpu-prof` (vitest.config.ts) gives the per-function CPU profile.
 *
 * Environment: BENCH_CORPUS (the fake-corpus output folder), BENCH_OUT (where results go),
 * BENCH_LABEL, BENCH_LIMIT_MINUTES (default 120: after that, remaining files are not started).
 */
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Session } from "node:inspector/promises";

const realFs = createRequire(import.meta.url)("fs") as typeof import("node:fs");

const S = vi.hoisted(() => ({
  measuring: false,
  deadline: Infinity,
  txDepth: 0,
  inTriage: false,
  ms: { walk: 0, read: 0, hash: 0, hash_in_tx: 0, store: 0, store_in_tx: 0, parse: 0, parse_in_tx: 0, tx: 0, triage: 0, triage_tx: 0, triage_hash: 0 } as Record<string, number>,
  calls: { walk: 0, read: 0, hash: 0, store: 0, parse: 0, tx: 0 } as Record<string, number>,
  parsers: {} as Record<string, { ms: number; calls: number }>,
  storeBytes: 0,
}));

class DeadlineError extends Error {}

vi.mock("node:fs", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs")>();
  const timed = <F extends (...a: never[]) => unknown>(stage: "walk" | "read", f: F): F =>
    ((...a: Parameters<F>) => {
      if (!S.measuring) return f(...a);
      const t = performance.now();
      try {
        return f(...a);
      } finally {
        S.ms[stage]! += performance.now() - t;
        S.calls[stage]!++;
      }
    }) as F;
  const readdirSync = timed("walk", m.readdirSync);
  const readFileSync = timed("read", m.readFileSync);
  return { ...m, default: { ...m, readdirSync, readFileSync }, readdirSync, readFileSync };
});

vi.mock("@casefile/storage", async (importOriginal) => {
  const m = await importOriginal<typeof import("@casefile/storage")>();
  const wrapped = new WeakMap<object, unknown>();
  return {
    ...m,
    computeSha256: (b: Uint8Array) => {
      const t = performance.now();
      try {
        return m.computeSha256(b);
      } finally {
        const d = performance.now() - t;
        if (S.measuring && S.inTriage) {
          S.ms.triage_hash! += d;
        } else if (S.measuring) {
          S.ms.hash! += d;
          S.calls.hash!++;
          if (S.txDepth > 0) S.ms.hash_in_tx! += d;
        }
      }
    },
    sha256OfFile: async (path: string) => {
      const t = performance.now();
      try {
        return await m.sha256OfFile(path);
      } finally {
        const d = performance.now() - t;
        if (S.measuring && S.inTriage) {
          S.ms.triage_hash! += d;
        } else if (S.measuring) {
          S.ms.hash! += d;
          S.calls.hash!++;
          if (S.txDepth > 0) S.ms.hash_in_tx! += d;
        }
      }
    },
    getObjectStore: (bucket?: string) => {
      const store = m.getObjectStore(bucket);
      if (!wrapped.has(store)) {
        wrapped.set(
          store,
          new Proxy(store, {
            get(target, prop, recv) {
              const v = Reflect.get(target, prop, recv);
              if ((prop !== "put" && prop !== "putFile") || typeof v !== "function") return v;
              return async (...a: unknown[]) => {
                const t = performance.now();
                try {
                  return await v.apply(target, a);
                } finally {
                  const d = performance.now() - t;
                  if (S.measuring) {
                    S.ms.store! += d;
                    S.calls.store!++;
                    S.storeBytes += prop === "putFile" ? realFs.statSync(a[1] as string).size : (a[1] as Uint8Array).byteLength;
                    if (S.txDepth > 0) S.ms.store_in_tx! += d;
                  }
                }
              };
            },
          }),
        );
      }
      return wrapped.get(store) as ReturnType<typeof m.getObjectStore>;
    },
  };
});

vi.mock("@casefile/db", async (importOriginal) => {
  const m = await importOriginal<typeof import("@casefile/db")>();
  return {
    ...m,
    withTenant: async (...a: Parameters<typeof m.withTenant>) => {
      if (S.measuring && performance.now() > S.deadline) throw new DeadlineError("time limit reached; file not started");
      S.txDepth++;
      const t = performance.now();
      try {
        return await m.withTenant(...a);
      } finally {
        S.txDepth--;
        if (S.measuring && S.txDepth === 0 && S.inTriage) {
          S.ms.triage_tx! += performance.now() - t;
        } else if (S.measuring && S.txDepth === 0) {
          S.ms.tx! += performance.now() - t;
          S.calls.tx!++;
        }
      }
    },
  };
});

const wrapParsers = async (m: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...m };
  for (const [name, f] of Object.entries(m)) {
    if (typeof f !== "function" || !/^(parse|extract)/.test(name)) continue;
    out[name] = async (...a: unknown[]) => {
      const t = performance.now();
      try {
        return await (f as (...x: unknown[]) => unknown)(...a);
      } finally {
        const d = performance.now() - t;
        if (S.measuring) {
          S.ms.parse! += d;
          S.calls.parse!++;
          if (S.txDepth > 0) S.ms.parse_in_tx! += d;
          const p = (S.parsers[name] ??= { ms: 0, calls: 0 });
          p.ms += d;
          p.calls++;
        }
      }
    };
  }
  return out;
};
vi.mock("../../apps/api/src/services/document-parsers.js", async (importOriginal) => wrapParsers(await importOriginal()));
vi.mock("../../apps/api/src/services/pdf-parser.js", async (importOriginal) => wrapParsers(await importOriginal()));
vi.mock("../../tools/ingest-cli/src/triage.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../tools/ingest-cli/src/triage.js")>();
  return {
    ...m,
    triageDirectory: async (...a: Parameters<typeof m.triageDirectory>) => {
      const t = performance.now();
      S.inTriage = true;
      try {
        return await m.triageDirectory(...a);
      } finally {
        S.inTriage = false;
        if (S.measuring) S.ms.triage! += performance.now() - t;
      }
    },
  };
});

const { ingestDirectory } = await import("../../tools/ingest-cli/src/ingest.js");
const { withTenant, createDbClient } = await import("@casefile/db");
const { ensureEmulatorBucket } = await import("@casefile/storage");
type Result = Awaited<ReturnType<typeof ingestDirectory>>["results"][number];

function readManifest(file: string): Record<string, string>[] {
  const lines = realFs.readFileSync(file, "utf8").trimEnd().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pctOf = (x: number, of: number) => `${((100 * x) / Math.max(of, 1)).toFixed(1)}%`;

describe("BIGDATA-1 ingest baseline", () => {
  it("ingests the corpus with today's code and records where the time goes", async () => {
    const corpusRoot = process.env.BENCH_CORPUS!;
    const out = process.env.BENCH_OUT!;
    const label = process.env.BENCH_LABEL ?? "run";
    const limitMin = Number(process.env.BENCH_LIMIT_MINUTES ?? 120);
    const corpus = join(corpusRoot, "corpus");
    expect(realFs.existsSync(corpus), corpus).toBe(true);
    realFs.mkdirSync(out, { recursive: true });
    const lines: string[] = [];
    const say = (s = "") => { lines.push(s); console.log(s); };

    // A fake matter in the local database.
    const T = randomUUID(), WS = randomUUID(), INV = randomUUID(), U = randomUUID();
    const app = createDbClient(process.env.DATABASE_URL!, { max: 1 });
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Baseline Fake Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Baseline WS')`;
      await tx`INSERT INTO users (id, tenant_id, email, name, status) VALUES (${U}, ${T}, 'operator@baseline.example', 'Operator', 'active')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage, created_by) VALUES (${INV}, ${T}, ${WS}, 'Baseline', 'collecting', ${U})`;
    }, app);
    await app.end();
    for (const b of [process.env.GCS_BUCKET_SOURCES!, process.env.GCS_BUCKET_ARTIFACTS!]) await ensureEmulatorBucket(b);

    const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} });
    await owner`SELECT pg_stat_statements_reset()`;

    // CPU profile of the run (10 ms sampling), written to BENCH_OUT/cpuprofile-<label>.cpuprofile.
    const inspector = new Session();
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: 10_000 });
    await inspector.post("Profiler.start");

    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);
    let done = 0;
    const started = performance.now();
    S.deadline = started + limitMin * 60_000;
    S.measuring = true;
    const summary = await ingestDirectory({
      dir: corpus,
      dbUrl: process.env.DATABASE_URL!,
      investigationId: INV,
      tenantId: T,
      userId: U,
      onFileResult: () => {
        done++;
        if (done % 250 === 0) console.log(`  ${done} files, ${sec(performance.now() - started)}`);
      },
    });
    S.measuring = false;
    const wall = performance.now() - started;
    const { profile } = await inspector.post("Profiler.stop");
    realFs.writeFileSync(join(out, `cpuprofile-${label}.cpuprofile`), JSON.stringify(profile));
    inspector.disconnect();
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const maxRssKb = process.resourceUsage().maxRSS;

    // Outcomes, including files inside zips and emails.
    const flat: Result[] = [];
    const walkRes = (r: Result) => { flat.push(r); for (const c of r.childResults ?? []) walkRes(c); };
    summary.results.forEach(walkRes);
    const deadlineHit = summary.results.filter((r) => r.status === "failed" && /time limit reached/.test(r.reason ?? "")).length;
    // BIGDATA-3 reasons name the original or the file: grouped here by the reason's kind.
    const reasonKind = (r?: string) => (r ?? "").replace(/^exact duplicate of .*/, "exact duplicate of <an earlier file>").replace(/^junk file name \(.*\)$/, "junk file name (<a listed name>)");
    const statusCount = (rs: Result[]) => rs.reduce<Record<string, number>>((acc, r) => { const k = r.status === "skipped" ? `skipped (${reasonKind(r.reason)})` : r.status; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
    const topCounts = statusCount(summary.results.filter((r) => !/time limit reached/.test(r.reason ?? "")));
    const allCounts = statusCount(flat.filter((r) => !/time limit reached/.test(r.reason ?? "")));
    const bytesIngested = summary.results.filter((r) => !/time limit reached/.test(r.reason ?? "")).reduce((a, r) => a + r.byteSize, 0);
    const filesIngested = summary.results.length - deadlineHit;

    // Against the manifest: what happened to each kind of top-level file.
    const manifest = readManifest(join(corpusRoot, "fake-corpus-manifest.csv")).filter((r) => !r.container);
    const byRel = new Map(summary.results.map((r) => [relative(corpus, r.filePath).replace(/\\/g, "/"), r]));
    const kindTable: Record<string, Record<string, number>> = {};
    for (const row of manifest) {
      const r = byRel.get(row.path!);
      const status = r ? (r.status === "skipped" ? `skipped: ${reasonKind(r.reason)}` : /time limit reached/.test(r.reason ?? "") ? "not reached (time limit)" : r.status) : "not seen by the walk";
      const k = row.kind!;
      (kindTable[k] ??= {})[status] = (kindTable[k]![status] ?? 0) + 1;
    }

    // BIGDATA-3: what triage and the near-duplicate rule decided, scored against the manifest.
    const fullManifest = readManifest(join(corpusRoot, "fake-corpus-manifest.csv"));
    const shaOfPath = new Map(fullManifest.map((r) => [r.path!, r.sha256!]));
    const toRel = (p: string) => {
      const [f, ...frag] = p.split("#");
      return [relative(corpus, f!).replace(/\\/g, "/"), ...frag].join("#");
    };
    const decRows = await owner<{ path: string; stage: string; decision: string; rule: string | null; duplicate_of_path: string | null }[]>`
      SELECT path, stage, decision, rule, duplicate_of_path FROM ingest_decisions WHERE tenant_id = ${T} AND run_id = ${summary.runId} ORDER BY seq`;
    // The last decision per path wins (an ingest-stage decision supersedes a triage one).
    const decisionOf = new Map<string, { decision: string; rule: string | null; dupOf: string | null; stage: string }>();
    for (const d of decRows) decisionOf.set(toRel(d.path), { decision: d.decision, rule: d.rule, dupOf: d.duplicate_of_path ? toRel(d.duplicate_of_path) : null, stage: d.stage });
    const srcRows = await owner<{ id: string; metadata: unknown; sha256: string }[]>`SELECT id, metadata, sha256 FROM sources WHERE tenant_id = ${T}`;
    const srcByPath = new Map<string, string>();
    const pathBySrc = new Map<string, string>();
    const shaBySrcPath = new Map<string, string>();
    for (const r of srcRows) {
      const m = (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata) as { source_path: string };
      const p = toRel(String(m.source_path));
      if (!srcByPath.has(p)) srcByPath.set(p, r.id);
      pathBySrc.set(r.id, p);
      shaBySrcPath.set(p, r.sha256);
    }
    const fps = await owner<{ source_id: string; near_duplicate_of: string | null; similarity: string | null }[]>`
      SELECT source_id, near_duplicate_of, similarity FROM document_fingerprints WHERE tenant_id = ${T}`;
    const groupOf = new Map<string, string>();
    for (const f of fps) groupOf.set(f.source_id, f.near_duplicate_of ?? f.source_id);
    // The source that holds a path's bytes: its own, or (a skipped exact copy) its original's.
    const sourceFor = (p: string, depth = 0): string | undefined => {
      const own = srcByPath.get(p);
      if (own || depth > 5) return own;
      const d = decisionOf.get(p);
      return d?.decision === "skip-duplicate" && d.dupOf ? sourceFor(d.dupOf, depth + 1) : undefined;
    };
    const decLabel = (d: { decision: string; rule: string | null } | undefined) => (d ? (d.rule ? `${d.decision} (${d.rule})` : d.decision) : "no decision");
    const decisionTable: Record<string, Record<string, number>> = {};
    for (const row of manifest) {
      const k = decLabel(decisionOf.get(row.path!));
      const t = (decisionTable[row.kind!] ??= {});
      t[k] = (t[k] ?? 0) + 1;
    }
    // Junk.
    const junkRows = manifest.filter((r) => r.kind === "junk");
    const junkCaught = junkRows.filter((r) => decisionOf.get(r.path!)?.decision === "skip-junk").length;
    const junkWrong = manifest.filter((r) => r.kind !== "junk" && decisionOf.get(r.path!)?.decision === "skip-junk").map((r) => r.path!);
    // Exact duplicates: the copy set aside, or (it sorted first) the original set aside as a copy of it.
    const dupRows = manifest.filter((r) => r.kind === "duplicate");
    let dupDirect = 0;
    let dupSwapped = 0;
    const dupMissed: string[] = [];
    for (const r of dupRows) {
      const d = decisionOf.get(r.path!);
      const o = decisionOf.get(r.duplicate_of!);
      if (d?.decision === "skip-duplicate") dupDirect++;
      else if (o?.decision === "skip-duplicate") dupSwapped++;
      else dupMissed.push(`${r.path} (${decLabel(d)}; original ${decLabel(o)})`);
    }
    // Anything else set aside as a duplicate must have the same bytes as what it names.
    const dupOthers = manifest.filter((r) => r.kind !== "duplicate" && decisionOf.get(r.path!)?.decision === "skip-duplicate");
    const dupWrong = dupOthers
      .filter((r) => {
        const target = decisionOf.get(r.path!)!.dupOf!;
        return (shaOfPath.get(target) ?? shaBySrcPath.get(target)) !== r.sha256;
      })
      .map((r) => r.path!);
    // Near-duplicates: recall over the manifest's pairs with text; precision over every link made.
    const nearRows = manifest.filter((r) => r.kind === "near_duplicate");
    const nearScans = nearRows.filter((r) => r.needs_ocr === "true");
    const nearText = nearRows.filter((r) => r.needs_ocr !== "true");
    const nearMissed: string[] = [];
    let nearCaught = 0;
    for (const r of nearText) {
      const a = sourceFor(r.path!);
      const b = sourceFor(r.near_duplicate_of!);
      const ga = a ? groupOf.get(a) : undefined;
      const gb = b ? groupOf.get(b) : undefined;
      if (ga && gb && ga === gb) nearCaught++;
      else nearMissed.push(`${r.path} -> ${r.near_duplicate_of} (${a ? (ga ? "fingerprinted" : "no fingerprint") : "not ingested"} / ${b ? (gb ? "fingerprinted" : "no fingerprint") : "not ingested"})`);
    }
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let p = parent.get(x) ?? x;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p)!;
      return p;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    for (const r of manifest) {
      if (r.near_duplicate_of) union(r.path!, r.near_duplicate_of);
      if (r.duplicate_of) union(r.path!, r.duplicate_of);
    }
    const links = fps.filter((f) => f.near_duplicate_of);
    const falseLinks: string[] = [];
    let trueLinks = 0;
    for (const f of links) {
      const a = pathBySrc.get(f.source_id)!;
      const b = pathBySrc.get(f.near_duplicate_of!)!;
      if (find(a) === find(b)) trueLinks++;
      else falseLinks.push(`${f.similarity}  ${a}  ->  ${b}`);
    }
    realFs.writeFileSync(join(out, `near-duplicate-links-not-in-manifest-${label}.txt`), falseLinks.join("\n") + (falseLinks.length ? "\n" : ""));
    realFs.writeFileSync(join(out, `near-duplicate-missed-${label}.txt`), nearMissed.join("\n") + (nearMissed.length ? "\n" : ""));
    const evaluation = {
      decisions_by_kind: decisionTable,
      junk: { manifest: junkRows.length, caught: junkCaught, missed: junkRows.length - junkCaught, wrongly_flagged: junkWrong },
      duplicate: { manifest: dupRows.length, caught_copy_set_aside: dupDirect, caught_original_set_aside_copy_kept: dupSwapped, missed: dupMissed, other_kinds_set_aside_as_copies: dupOthers.length, wrongly_flagged: dupWrong },
      near_duplicate: {
        manifest: nearRows.length,
        scans_no_text_until_ocr: nearScans.length,
        with_text: nearText.length,
        caught: nearCaught,
        missed: nearMissed.length,
        recall: nearText.length ? nearCaught / nearText.length : null,
        links_made: links.length,
        links_in_manifest_family: trueLinks,
        links_not_in_manifest: falseLinks.length,
        precision: links.length ? trueLinks / links.length : null,
      },
    };
    const pc = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
    const evalLines = [
      "Triage and near-duplicates against the manifest (top-level files; the last decision per path)",
      ...Object.entries(decisionTable).sort().map(([k, v]) => `  ${k.padEnd(15)} ${Object.entries(v).sort().map(([s2, n]) => `${s2}: ${n}`).join("; ")}`),
      `  junk:            ${junkRows.length} in the manifest; caught ${junkCaught}; missed ${junkRows.length - junkCaught}; other kinds flagged as junk ${junkWrong.length}${junkWrong.length ? ` (${junkWrong.slice(0, 5).join(", ")})` : ""}`,
      `  duplicate:       ${dupRows.length} in the manifest; caught ${dupDirect + dupSwapped} (${dupDirect} copy set aside, ${dupSwapped} original set aside because its copy sorted first; same bytes either way); missed ${dupMissed.length}`,
      `                   other kinds set aside as copies: ${dupOthers.length}; of those NOT byte-identical to what they name: ${dupWrong.length}`,
      `  near_duplicate:  ${nearRows.length} in the manifest: ${nearScans.length} scans (no text until OCR, BIGDATA-5: not detectable), ${nearText.length} with text`,
      `                   caught ${nearCaught}, missed ${nearMissed.length}: recall ${pc(evaluation.near_duplicate.recall)} at 0.9`,
      `                   links made ${links.length}: ${trueLinks} inside a manifest family, ${falseLinks.length} not: precision ${pc(evaluation.near_duplicate.precision)} (listed in near-duplicate-links-not-in-manifest-${label}.txt)`,
    ];

    // Database after.
    const tables = ["sources", "source_instances", "acquisition_records", "artifacts", "content_documents", "content_blocks", "chunks", "audit_events", "ingest_runs", "ingest_decisions", "document_fingerprints"];
    const rowCounts: Record<string, number> = {};
    for (const t of tables) rowCounts[t] = Number((await owner.unsafe(`SELECT count(*)::bigint AS n FROM ${t}`))[0]!.n);
    const [dbSize] = await owner<{ size: string; bytes: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) AS size, pg_database_size(current_database())::bigint AS bytes`;
    const relSizes = await owner<{ rel: string; size: string }[]>`
      SELECT c.relname AS rel, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`;
    const statements = await owner<{ query: string; calls: string; total_ms: number; mean_ms: number; rows: string }[]>`
      SELECT regexp_replace(query, '\\s+', ' ', 'g') AS query, calls::bigint AS calls,
             round(total_exec_time::numeric, 1)::float8 AS total_ms, round(mean_exec_time::numeric, 3)::float8 AS mean_ms, rows::bigint AS rows
      FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC LIMIT 15`;
    const [stmtTotal] = await owner<{ calls: string; total_ms: number }[]>`
      SELECT sum(calls)::bigint AS calls, round(sum(total_exec_time)::numeric, 1)::float8 AS total_ms
      FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    await owner.end();

    const nearDupMs = summary.timings.nearDuplicateMs;
    const dbMs = S.ms.tx! - S.ms.store_in_tx! - S.ms.parse_in_tx! - S.ms.hash_in_tx! - nearDupMs;
    const accounted = S.ms.walk! + S.ms.read! + (S.ms.hash! - S.ms.hash_in_tx!) + S.ms.tx! + S.ms.triage!;
    const mb = bytesIngested / 1024 / 1024;

    say(`BIGDATA-1 BASELINE: ${label}`);
    say(`corpus ${corpusRoot}`);
    say(`limit ${limitMin} min; ${deadlineHit > 0 ? `TIME LIMIT REACHED: ${deadlineHit} top-level files were not started` : "the whole corpus finished"}`);
    say("");
    say(`Total time          ${sec(wall)}`);
    say(`Top-level files     ${filesIngested} of ${summary.totalFiles} found by the walk (${manifest.length} in the manifest)`);
    say(`Bytes read          ${mb.toFixed(1)} MB`);
    say(`Throughput          ${(filesIngested / (wall / 1000)).toFixed(2)} files/s, ${(mb / (wall / 1000)).toFixed(2)} MB/s (top-level files)`);
    say(`All files incl. zip entries and attachments: ${flat.length - deadlineHit}, ${((flat.length - deadlineHit) / (wall / 1000)).toFixed(2)} files/s`);
    say(`Peak memory         ${(peakRss / 1024 / 1024).toFixed(0)} MB RSS sampled every 200 ms; maxRSS ${(maxRssKb / 1024).toFixed(0)} MB`);
    say("");
    say("Time per stage (wall-clock time spent inside each step; they add up to the total, less 'other')");
    const stage = (name: string, ms: number, calls: number | string) => say(`  ${name.padEnd(26)} ${sec(ms).padStart(10)}  ${pctOf(ms, wall).padStart(6)}   calls ${calls}`);
    stage("walk (readdirSync)", S.ms.walk!, S.calls.walk!);
    stage("triage (whole pass)", S.ms.triage!, `${summary.triage.objects} objects, ${summary.triage.objectsHashed} hashed (${sec(S.ms.triage_hash!)}), its transactions ${sec(S.ms.triage_tx!)}`);
    stage("read (readFileSync)", S.ms.read!, S.calls.read!);
    stage("hash (computeSha256)", S.ms.hash!, S.calls.hash!);
    stage("store (object put)", S.ms.store!, `${S.calls.store} (${(S.storeBytes / 1024 / 1024).toFixed(0)} MB written)`);
    stage("parse (all parsers)", S.ms.parse!, S.calls.parse!);
    stage("near-duplicates", nearDupMs, `${summary.nearDuplicates} documents grouped; signatures, LSH, fingerprint rows`);
    stage("OCR", 0, "0 (the ingest has no OCR step)");
    stage("database (tx - store - parse - hash - near-dup)", dbMs, `${S.calls.tx} transactions (triage's are in triage)`);
    stage("other", wall - accounted, "-");
    say("");
    say("Parsers");
    for (const [n, p] of Object.entries(S.parsers).sort((a, b) => b[1].ms - a[1].ms)) say(`  ${n.padEnd(22)} ${sec(p.ms).padStart(10)}  calls ${p.calls}  mean ${(p.ms / p.calls).toFixed(1)} ms`);
    say("");
    say("Outcomes, top-level files");
    for (const [k, v] of Object.entries(topCounts).sort()) say(`  ${k.padEnd(52)} ${v}`);
    say("Outcomes, all files incl. zip entries and email attachments");
    for (const [k, v] of Object.entries(allCounts).sort()) say(`  ${k.padEnd(52)} ${v}`);
    say("");
    say("What happened to each kind of file in the manifest (top level)");
    for (const [k, v] of Object.entries(kindTable).sort()) say(`  ${k.padEnd(15)} ${Object.entries(v).map(([s, n]) => `${s}: ${n}`).join("; ")}`);
    say("");
    evalLines.forEach((l) => say(l));
    say("");
    say(`Database after      ${dbSize!.size} (${dbSize!.bytes} bytes)`);
    for (const [t, n] of Object.entries(rowCounts)) say(`  ${t.padEnd(22)} ${n} rows`);
    say("Largest tables");
    for (const r of relSizes) say(`  ${r.rel.padEnd(28)} ${r.size}`);
    say("");
    say(`Statements (pg_stat_statements): ${stmtTotal!.calls} calls, ${sec(stmtTotal!.total_ms)} execution time in the server`);
    for (const s of statements) say(`  ${sec(s.total_ms).padStart(9)}  calls ${String(s.calls).padStart(7)}  mean ${s.mean_ms.toFixed(3)} ms  ${s.query.slice(0, 150)}`);

    realFs.writeFileSync(join(out, `baseline-${label}.txt`), lines.join("\n") + "\n");
    realFs.writeFileSync(
      join(out, `baseline-${label}.json`),
      JSON.stringify({ label, corpusRoot, limitMin, wall_ms: wall, deadline_hit: deadlineHit, files: filesIngested, bytes: bytesIngested, run_id: summary.runId, triage: summary.triage, near_duplicates: summary.nearDuplicates, evaluation, stages_ms: { ...S.ms, near_duplicate: nearDupMs, database: dbMs }, calls: S.calls, parsers: S.parsers, peak_rss: peakRss, max_rss_kb: maxRssKb, top_outcomes: topCounts, all_outcomes: allCounts, kind_table: kindTable, row_counts: rowCounts, db_bytes: Number(dbSize!.bytes), statements, statements_total: stmtTotal }, null, 2),
    );
    expect(filesIngested).toBeGreaterThan(0);
  });
});
