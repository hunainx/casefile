import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { getDbUrl } from "@casefile/db";
import { verifyTenantAuditChain } from "@casefile/audit";
import { getGcsStorageClient } from "@casefile/storage";
import { enqueueDirectory, ingestDirectory } from "../src/ingest.js";
import { newMatter, q, keptSkipped, nearDuplicateLinks, type Matter } from "./helpers/run-outcomes.js";

/**
 * BIGDATA-4 resume (DEV-038; plan section 16): worker processes are killed (not stopped cleanly) in
 * the middle of a run, one of them in the middle of a mailbox part; new workers take the run up again
 * (`pnpm ingest:resume`), and the run finishes with nothing missed and nothing doubled: the same kept
 * and skipped objects as a run that was never stopped, one source per path, one source.admit audit
 * row per source, one bucket object generation per stored object, and an audit chain that verifies.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = join(process.cwd(), ".tmp-test-fixtures", `resume_${Date.now()}`);
const WORKER = join(REPO, "tools", "ingest-cli", "src", "worker.ts");
const RESUME = join(REPO, "tools", "ingest-cli", "src", "resume.ts");

function writeCorpus(dir: string): void {
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, "mail"), { recursive: true });
  for (let i = 0; i < 30; i++) writeFileSync(join(dir, "notes", `note-${String(i).padStart(2, "0")}.txt`), `Fake note ${i}: the fake barge ${i} left the fake quay at dawn with ${i * 3} fake crates.\n`);
  const zip = new AdmZip();
  for (let i = 0; i < 5; i++) zip.addFile(`inside/entry-${i}.txt`, Buffer.from(`Fake zip entry ${i}: fake contents ${i}.\n`));
  zip.addFile("inside/note-copy.txt", Buffer.from("Fake note 3: the fake barge 3 left the fake quay at dawn with 9 fake crates.\n"));
  zip.writeZip(join(dir, "bundle.zip"));
  let mbox = "";
  for (let i = 0; i < 160; i++) {
    const n = i % 40 === 39 ? i - 20 : i; // every 40th message is an earlier one again (a duplicate)
    const attachment = `Fake attachment ${n % 25}: ${"fake ledger line with numbers 12345 67890 ".repeat(200)}\n`;
    mbox += [
      `From sender-${n}@fake.test Tue Mar  2 09:00:00 2021`,
      `From: sender-${n}@fake.test`, "To: reader@fake.test", `Subject: Fake message ${n}`, "Date: Tue, 2 Mar 2021 09:00:00 +0000",
      `Message-ID: <resume-${n}@fake.test>`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="r-${n}"`, "",
      `--r-${n}`, "Content-Type: text/plain; charset=utf-8", "", `Fake body of message ${n}.`,
      `--r-${n}`, `Content-Type: text/plain; name="ledger-${n % 25}.txt"`, `Content-Disposition: attachment; filename="ledger-${n % 25}.txt"`, "", attachment,
      `--r-${n}--`, "", "",
    ].join("\n");
  }
  writeFileSync(join(dir, "mail", "big.mbox"), mbox);
}

const PARTS = { mboxBytes: 64 * 1024, pstMessages: 50 };

function startWorker(m: Matter, runId: string, name: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", WORKER, "--run", runId, "--name", name], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: getDbUrl(), MATTER_TENANT_ID: m.tenantId, INGEST_LEASE_SECONDS: "3", NODE_ENV: "development", VITEST: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null || c.signalCode !== null ? r(c.exitCode) : c.once("exit", (code) => r(code))));

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("tools/ingest-cli — BIGDATA-4 resume after workers are killed", () => {
  const cleanDir = join(BASE, "clean");
  const killedDir = join(BASE, "killed");
  let clean: Matter;
  let killed: Matter;
  let runId = "";
  let atKill: { done: number; midPart: number; leased: number } = { done: 0, midPart: 0, leased: 0 };
  let resumeOutput = "";

  beforeAll(async () => {
    writeCorpus(cleanDir);
    writeCorpus(killedDir);
    clean = await newMatter("clean", BASE);
    await ingestDirectory({ dir: cleanDir, investigationId: clean.investigationId, tenantId: clean.tenantId, userId: clean.userId, mailboxParts: PARTS });

    killed = await newMatter("killed", BASE);
    runId = (await enqueueDirectory({ dir: killedDir, investigationId: killed.investigationId, tenantId: killed.tenantId, userId: killed.userId, mailboxParts: PARTS })).runId;
    const workers = [startWorker(killed, runId, "w1"), startWorker(killed, runId, "w2"), startWorker(killed, runId, "w3")];
    const logs = workers.map(() => [] as string[]);
    workers.forEach((w, i) => {
      w.stdout!.on("data", (d) => logs[i]!.push(String(d)));
      w.stderr!.on("data", (d) => logs[i]!.push(String(d)));
    });
    // Kill every worker (TerminateProcess: no clean stop) once some items are done and a mailbox
    // part is written only in part.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const s = await q(killed.tenantId, (tx) => tx<{ done: number; mid_part: number; leased: number }[]>`
        SELECT count(*) FILTER (WHERE state = 'done')::int AS done,
               count(*) FILTER (WHERE kind = 'mailbox-part' AND progress > 0 AND progress < entries)::int AS mid_part,
               count(*) FILTER (WHERE leased_by IS NOT NULL AND state <> 'done')::int AS leased
        FROM ingest_work WHERE run_id = ${runId}`);
      if ((s[0]!.done >= 5 && s[0]!.mid_part >= 1) || Date.now() > deadline) {
        for (const w of workers) w.kill("SIGKILL");
        atKill = { done: s[0]!.done, midPart: s[0]!.mid_part, leased: s[0]!.leased };
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await Promise.all(workers.map(exited));
    // Start again: `pnpm ingest:resume --run <id> --workers 2` starts two new worker processes.
    const resume = spawn(process.execPath, ["--import", "tsx", RESUME, "--run", runId, "--workers", "2"], {
      cwd: REPO,
      env: { ...process.env, DATABASE_URL: getDbUrl(), MATTER_TENANT_ID: killed.tenantId, INGEST_LEASE_SECONDS: "3", NODE_ENV: "development", VITEST: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    resume.stdout!.on("data", (d) => out.push(String(d)));
    resume.stderr!.on("data", (d) => out.push(String(d)));
    const code = await exited(resume);
    resumeOutput = out.join("");
    expect(code, resumeOutput).toBe(0);
  }, 240_000);

  it("the workers really were killed in the middle: items done, a mailbox part half written, items still leased", () => {
    expect(atKill.done).toBeGreaterThanOrEqual(5);
    expect(atKill.midPart).toBeGreaterThanOrEqual(1);
    expect(atKill.leased).toBeGreaterThanOrEqual(1);
  });

  it("after the resume the run kept and skipped exactly what a run that was never stopped did", async () => {
    const k = await keptSkipped(killed, killedDir);
    expect(k.length).toBeGreaterThan(150);
    expect(k).toEqual(await keptSkipped(clean, cleanDir));
    expect(await nearDuplicateLinks(killed, killedDir)).toEqual(await nearDuplicateLinks(clean, cleanDir));
    expect(resumeOutput).toContain("finished");
  });

  it("nothing is doubled: one source per path, one admit audit row per source, one decision per skipped path, one bucket generation per object", async () => {
    const doubled = await q(killed.tenantId, (tx) => tx<{ what: string; n: number }[]>`
      SELECT 'paths with two sources' AS what, count(*)::int AS n FROM (SELECT metadata->>'source_path' FROM sources WHERE tenant_id = ${killed.tenantId} GROUP BY 1 HAVING count(*) > 1) x
      UNION ALL SELECT 'sources without exactly one admit row', count(*)::int FROM sources s WHERE s.tenant_id = ${killed.tenantId}
        AND (SELECT count(*) FROM audit_events a WHERE a.tenant_id = s.tenant_id AND a.action = 'source.admit' AND a.object_id::text = s.id::text) <> 1
      UNION ALL SELECT 'paths with two ingest-stage decisions', count(*)::int FROM (SELECT path FROM ingest_decisions WHERE tenant_id = ${killed.tenantId} AND stage = 'ingest' GROUP BY path HAVING count(*) > 1) y
      UNION ALL SELECT 'mailbox read rows', count(*)::int FROM audit_events WHERE tenant_id = ${killed.tenantId} AND action = 'source.mailbox_read'`);
    expect(Object.fromEntries(doubled.map((d) => [d.what, d.n]))).toEqual({
      "paths with two sources": 0,
      "sources without exactly one admit row": 0,
      "paths with two ingest-stage decisions": 0,
      "mailbox read rows": 1,
    });
    const storage = await getGcsStorageClient();
    const [files] = await storage.bucket(process.env.GCS_BUCKET_SOURCES!).getFiles({ prefix: `${killed.tenantId}/`, versions: true });
    const perName = new Map<string, number>();
    for (const f of files) perName.set(f.name, (perName.get(f.name) ?? 0) + 1);
    expect([...perName.values()].filter((n) => n > 1)).toEqual([]);
    const stored = await q(killed.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(DISTINCT storage_uri)::int AS n FROM sources WHERE tenant_id = ${killed.tenantId}`);
    expect(perName.size).toBe(stored[0]!.n);
    const chain = await q(killed.tenantId, (tx) => verifyTenantAuditChain(tx, killed.tenantId));
    expect(chain.valid).toBe(true);
  });
});
