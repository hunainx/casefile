import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { verifyTenantAuditChain } from "@casefile/audit";
import { ingestDirectory, type IngestBatchSummary } from "../src/ingest.js";
import type { WorkItemView } from "../src/queue.js";
import { newMatter, q, keptSkipped, nearDuplicateLinks, type Matter } from "./helpers/run-outcomes.js";

/**
 * BIGDATA-4 (plan section 16): which copy is kept does not depend on the number of workers or on
 * timing. The rule: the copy that comes first in the run's reading order is kept (top-level objects in
 * path order; inside an object, the object, then its entries, attachments or messages in the
 * container's own order). Near-duplicates join the most similar first document before them in that order.
 *
 * The corpus has copies that triage cannot see (inside zips, attachments, mailbox messages) and
 * near-duplicates across items. It is ingested once with 1 worker and once with 4 workers whose
 * timing is made as bad as possible: the first item's discovery is slowed down, so every later item
 * is ready first; and the items holding two copies of one thing are held and released together, so
 * they are handled at the same moment. Both runs must keep exactly the same copies and group the same
 * near-duplicates, and one kept + one decision must come out of every race.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = join(process.cwd(), ".tmp-test-fixtures", `parallel_${Date.now()}`);
const T_ATTACHMENT = "Fake attachment: the fake warehouse ledger for the fake quarter, carried in several emails.\n";
const S_SHARED = "Fake shared note: the same fake bytes are in a zip, in a folder and in another folder.\n";

const WORDS = "harbour ledger barge quay crate invoice manifest tariff cargo pallet freight berth tide anchor rope sail keel mast deck hull".split(" ");
function nearText(changes: Array<[number, string]>): string {
  const words = Array.from({ length: 320 }, (_, i) => `${WORDS[(i * 7 + (i >> 3)) % WORDS.length]}${i % 13}`);
  for (const [at, w] of changes) words[at] = w;
  return `Fake long memo. ${words.join(" ")}.\n`;
}

function eml(id: string, subject: string, attachment?: { name: string; text: string }): string {
  const head = [`From: sender-${id}@fake.test`, `To: reader@fake.test`, `Subject: ${subject}`, `Date: Mon, 1 Mar 2021 10:00:0${id.length % 10} +0000`, `Message-ID: <${id}@fake.test>`, "MIME-Version: 1.0"];
  if (!attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", `Fake body of ${subject}.`, ""].join("\r\n");
  return [
    ...head, `Content-Type: multipart/mixed; boundary="b-${id}"`, "",
    `--b-${id}`, "Content-Type: text/plain; charset=utf-8", "", `Fake body of ${subject}.`,
    `--b-${id}`, `Content-Type: text/plain; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`, "", attachment.text,
    `--b-${id}--`, "",
  ].join("\r\n");
}

/** Twelve messages; message 9 is message 2 again (the same message twice), message 5 carries the attachment. */
function mbox(): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const n = i === 9 ? 2 : i;
    offsets.push(Buffer.byteLength(text));
    const body = eml(`mbox-${n}`, `Fake mbox message ${n}`, n === 5 ? { name: "att.txt", text: T_ATTACHMENT } : undefined).replace(/\r\n/g, "\n");
    text += `From sender-mbox-${n}@fake.test Mon Mar  1 10:00:00 2021\n${body}${"Fake padding line so each message is longer than one part.\n".repeat(6)}\n`;
  }
  return { text, offsets };
}

/** Writes the corpus into `dir` (the same bytes every time). */
function writeCorpus(dir: string): { mboxOffsets: number[] } {
  for (const d of ["a-first", "b-middle", "c-mailboxes", "d-last"]) mkdirSync(join(dir, d), { recursive: true });
  const zip = new AdmZip();
  zip.addFile("shared.txt", Buffer.from(S_SHARED));
  zip.addFile("report.eml", Buffer.from(eml("zip-report", "Fake report", { name: "att.txt", text: T_ATTACHMENT })));
  zip.addFile("near-1.txt", Buffer.from(nearText([])));
  zip.writeZip(join(dir, "a-first", "bundle.zip"));
  writeFileSync(join(dir, "b-middle", "copy-of-shared.txt"), S_SHARED);
  writeFileSync(join(dir, "b-middle", "mail-2.eml"), eml("mail-2", "Fake second mail", { name: "att.txt", text: T_ATTACHMENT }));
  writeFileSync(join(dir, "b-middle", "near-2.txt"), nearText([[100, "changedword"]]));
  const m = mbox();
  writeFileSync(join(dir, "c-mailboxes", "box.mbox"), m.text);
  copyFileSync(join(REPO, "test-corpus", "mailbox.pst"), join(dir, "c-mailboxes", "mailbox.pst"));
  writeFileSync(join(dir, "d-last", "shared-again.txt"), S_SHARED);
  writeFileSync(join(dir, "d-last", "near-3.txt"), nearText([[40, "otherword"], [250, "thirdword"]]));
  return { mboxOffsets: m.offsets };
}

const PARTS = { pstMessages: 1, mboxBytes: 256 };

/** Holds each named group of items at `beforeWrite` until all of the group has arrived, then lets them go together. */
function barriers(groups: Record<string, (item: WorkItemView) => boolean>, sizes: Record<string, number>) {
  const arrived: Record<string, number> = {};
  const met: Record<string, boolean> = {};
  const release: Record<string, () => void> = {};
  const gates: Record<string, Promise<void>> = {};
  for (const g of Object.keys(groups)) {
    arrived[g] = 0;
    met[g] = false;
    gates[g] = new Promise<void>((r) => (release[g] = r));
  }
  return {
    met,
    beforeWrite: async (item: WorkItemView) => {
      for (const [g, match] of Object.entries(groups)) {
        if (!match(item)) continue;
        arrived[g]! += 1;
        if (arrived[g] === sizes[g]) {
          met[g] = true;
          release[g]!();
        }
        await Promise.race([gates[g], new Promise((r) => setTimeout(r, 30_000))]);
      }
    },
  };
}

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("tools/ingest-cli — BIGDATA-4 many workers keep the same copies as one", () => {
  const one = join(BASE, "one-worker");
  const four = join(BASE, "four-workers");
  let m1: Matter;
  let m4: Matter;
  let s1: IngestBatchSummary;
  let s4: IngestBatchSummary;
  let offsets: number[] = [];
  let gate: ReturnType<typeof barriers>;
  const inPart = (item: WorkItemView, offset: number) => item.kind === "mailbox-part" && item.file_name === "box.mbox" && Number(item.spec.start) <= offset && offset < Number(item.spec.end);

  beforeAll(async () => {
    offsets = writeCorpus(one).mboxOffsets;
    writeCorpus(four);
    m1 = await newMatter("one", BASE);
    m4 = await newMatter("four", BASE);
    s1 = await ingestDirectory({ dir: one, investigationId: m1.investigationId, tenantId: m1.tenantId, userId: m1.userId, mailboxParts: PARTS });
    gate = barriers(
      {
        firstFour: (i) => i.kind === "file" && ["bundle.zip", "copy-of-shared.txt", "mail-2.eml", "near-2.txt"].includes(i.file_name),
        mboxDuplicates: (i) => inPart(i, offsets[1]!) || inPart(i, offsets[8]!),
        pstDrafts: (i) => i.kind === "mailbox-part" && i.file_name === "mailbox.pst" && JSON.stringify(i.spec.folder) === JSON.stringify(["Drafts"]),
      },
      { firstFour: 4, mboxDuplicates: 2, pstDrafts: 2 },
    );
    s4 = await ingestDirectory({
      dir: four, investigationId: m4.investigationId, tenantId: m4.tenantId, userId: m4.userId, mailboxParts: PARTS, workers: 4,
      workerHooks: {
        afterDiscover: async (item) => {
          if (item.file_name === "bundle.zip") await new Promise((r) => setTimeout(r, 1500));
        },
        beforeWrite: gate.beforeWrite,
      },
    });
  }, 240_000);

  it("the 4-worker run keeps and skips exactly what the 1-worker run does, and groups the same near-duplicates", async () => {
    const k1 = await keptSkipped(m1, one);
    const k4 = await keptSkipped(m4, four);
    expect(k1.length).toBeGreaterThan(35);
    expect(k4).toEqual(k1);
    expect(await nearDuplicateLinks(m4, four)).toEqual(await nearDuplicateLinks(m1, one));
    expect(s4.failed).toBe(0);
    expect(s1.failed).toBe(0);
  });

  it("the copy first in reading order is the one kept (the rule, checked on the copies triage cannot see)", async () => {
    const k4 = await keptSkipped(m4, four);
    const mboxMsg = (i: number) => `c-mailboxes/box.mbox#mailbox:offset:${offsets[i]}`;
    for (const line of [
      "a-first/bundle.zip#shared.txt\tkept indexed",
      "b-middle/copy-of-shared.txt\tskip-duplicate exact-duplicate of a-first/bundle.zip#shared.txt",
      "d-last/shared-again.txt\tskip-duplicate exact-duplicate of b-middle/copy-of-shared.txt",
      "a-first/bundle.zip#report.eml#attachment:att.txt\tkept indexed",
      "b-middle/mail-2.eml#attachment:att.txt\tskip-duplicate exact-duplicate of a-first/bundle.zip#report.eml#attachment:att.txt",
      `${mboxMsg(4)}#attachment:att.txt\tskip-duplicate exact-duplicate of a-first/bundle.zip#report.eml#attachment:att.txt`,
      `${mboxMsg(1)}\tkept indexed`,
      `${mboxMsg(8)}\tskip-duplicate message-duplicate of ${mboxMsg(1)}`,
    ]) expect(k4).toContain(line);
    const near = await nearDuplicateLinks(m4, four);
    expect(near.map((l) => l.replace(/ \(.*\)$/, ""))).toEqual([
      "b-middle/near-2.txt -> a-first/bundle.zip#near-1.txt",
      "d-last/near-3.txt -> a-first/bundle.zip#near-1.txt",
    ]);
  });

  it("items holding copies of one thing, handled at the same moment by different workers, end as one kept + one decision", async () => {
    expect(gate.met).toEqual({ firstFour: true, mboxDuplicates: true, pstDrafts: true });
    const counts = await q(m4.tenantId, (tx) => tx<{ what: string; n: number }[]>`
      SELECT 'attachment sources' AS what, count(*)::int AS n FROM sources WHERE tenant_id = ${m4.tenantId} AND sha256 = encode(sha256(${Buffer.from(T_ATTACHMENT)}), 'hex')
      UNION ALL SELECT 'attachment duplicate decisions', count(*)::int FROM ingest_decisions WHERE tenant_id = ${m4.tenantId} AND decision = 'skip-duplicate' AND path LIKE '%#attachment:att.txt'
      UNION ALL SELECT 'shared sources', count(*)::int FROM sources WHERE tenant_id = ${m4.tenantId} AND sha256 = encode(sha256(${Buffer.from(S_SHARED)}), 'hex')
      UNION ALL SELECT 'message-duplicate decisions', count(*)::int FROM ingest_decisions WHERE tenant_id = ${m4.tenantId} AND rule = 'message-duplicate'`);
    expect(Object.fromEntries(counts.map((c) => [c.what, c.n]))).toEqual({
      "attachment sources": 1,
      "attachment duplicate decisions": 2,
      "shared sources": 1,
      "message-duplicate decisions": 2, // the MBOX's message 9, and the PST's second copy of its draft
    });
    const pstDraftLines = (await keptSkipped(m4, four)).filter((l) => l.includes("mailbox.pst#mailbox:Drafts/"));
    expect(pstDraftLines.filter((l) => l.includes("\tkept"))).toHaveLength(1);
    expect(pstDraftLines.filter((l) => l.includes("skip-duplicate message-duplicate"))).toHaveLength(1);
  });

  it("the database refuses a second kept copy of the same bytes in one run, even from two sequencers at once", async () => {
    const app1 = createDbClient(getDbUrl(), { max: 1 });
    const app2 = createDbClient(getDbUrl(), { max: 1 });
    try {
      // Two undecided nodes holding the same (fake) bytes, in one run; two transactions at once each
      // decide "ingest" for one of them, as two sequencers would if the sequencer's lock failed.
      const fakeSha = "b4".repeat(32);
      const ids = await withTenant(m4.tenantId, async (tx) => {
        const w = (await tx<{ id: string; run_id: string; investigation_id: string }[]>`
          SELECT id, run_id, investigation_id FROM ingest_work WHERE tenant_id = ${m4.tenantId} AND file_name = 'near-2.txt'`)[0]!;
        const made = [];
        for (const index of [900, 901]) {
          made.push((await tx<{ id: string }[]>`
            INSERT INTO ingest_nodes (tenant_id, investigation_id, run_id, work_id, node_index, depth, path, file_name, byte_size, sha256, kind)
            VALUES (${m4.tenantId}, ${w.investigation_id}, ${w.run_id}, ${w.id}, ${index}, 1, ${`race-copy-${index}`}, ${`race-copy-${index}.txt`}, 10, ${fakeSha}, 'file')
            RETURNING id`)[0]!.id);
        }
        return made;
      }, app1);
      const decide = (c: typeof app1, id: string) => withTenant(m4.tenantId, (tx) => tx`UPDATE ingest_nodes SET decision = 'ingest' WHERE id = ${id}`, c);
      const results = await Promise.allSettled([decide(app1, ids[0]!), decide(app2, ids[1]!)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(refused).toHaveLength(1);
      expect(String(refused[0]!.reason)).toContain("uq_ingest_nodes_kept_sha256");
      const kept = await withTenant(m4.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ingest_nodes WHERE sha256 = ${fakeSha} AND decision = 'ingest'`, app1);
      expect(kept[0]!.n).toBe(1);
    } finally {
      await Promise.all([app1.end(), app2.end()]);
    }
  });

  it("the audit chain verifies after the 4-worker run and records the same source events as the 1-worker run", async () => {
    const chain = await q(m4.tenantId, (tx) => verifyTenantAuditChain(tx, m4.tenantId));
    expect(chain.valid).toBe(true);
    const events = (m: Matter) => q(m.tenantId, async (tx) => (await tx<{ e: string }[]>`
      SELECT action || ' ' || object_display || ' ' || coalesce(after->>'status', '') || ' ' || coalesce(after->>'sha256', '') || ' ' || coalesce(after->>'decision', '') AS e
      FROM audit_events WHERE tenant_id = ${m.tenantId} AND action LIKE 'source.%'`).map((r) => r.e).sort());
    expect(await events(m4)).toEqual(await events(m1));
  });

  it("the near-duplicate index is in the database: one LSH row per fingerprinted document, and its band keys under its group", async () => {
    const rows = await q(m4.tenantId, (tx) => tx<{ fingerprints: number; lsh: number; bands: number; missing: number; extra: number }[]>`
      SELECT (SELECT count(*)::int FROM document_fingerprints WHERE tenant_id = ${m4.tenantId}) AS fingerprints,
             (SELECT count(*)::int FROM document_lsh WHERE tenant_id = ${m4.tenantId}) AS lsh,
             (SELECT min(cardinality(bands))::int FROM document_lsh WHERE tenant_id = ${m4.tenantId}) AS bands,
             (SELECT count(*)::int FROM document_lsh l, unnest(l.bands) AS k(band_key)
               WHERE l.tenant_id = ${m4.tenantId} AND NOT EXISTS (SELECT 1 FROM document_lsh_bands b WHERE b.tenant_id = l.tenant_id
                 AND b.investigation_id = l.investigation_id AND b.band_key = k.band_key AND b.root_source_id = l.root_source_id)) AS missing,
             (SELECT count(*)::int FROM document_lsh_bands b WHERE b.tenant_id = ${m4.tenantId} AND NOT EXISTS (SELECT 1 FROM document_lsh l
                 WHERE l.tenant_id = b.tenant_id AND l.investigation_id = b.investigation_id AND l.root_source_id = b.root_source_id AND b.band_key = ANY(l.bands))) AS extra`);
    expect(rows[0]!.fingerprints).toBeGreaterThan(20);
    expect(rows[0]!.lsh).toBe(rows[0]!.fingerprints);
    expect(rows[0]!.bands).toBe(32);
    expect(rows[0]!.missing).toBe(0);
    expect(rows[0]!.extra).toBe(0);
  });

  it("an earlier run's fingerprints without an LSH row (written before migration 0031) are indexed when a later run needs them", async () => {
    const dir = join(BASE, "old-index");
    mkdirSync(join(dir, "first"), { recursive: true });
    writeFileSync(join(dir, "first", "near-1.txt"), nearText([]));
    const m = await newMatter("old-index", BASE);
    await ingestDirectory({ dir: join(dir, "first"), investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    // As a matter ingested by BIGDATA-3 code: its fingerprint exists, its LSH row does not.
    const owner = createDbClient(process.env.DATABASE_URL_TEST_OWNER!, { max: 1 });
    try {
      await owner`DELETE FROM document_lsh_bands WHERE tenant_id = ${m.tenantId}`;
      await owner`DELETE FROM document_lsh WHERE tenant_id = ${m.tenantId}`;
    } finally {
      await owner.end();
    }
    mkdirSync(join(dir, "second"), { recursive: true });
    writeFileSync(join(dir, "second", "near-2.txt"), nearText([[100, "changedword"]]));
    await ingestDirectory({ dir: join(dir, "second"), investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    expect((await nearDuplicateLinks(m, dir)).map((l) => l.replace(/ \(.*\)$/, ""))).toEqual(["second/near-2.txt -> first/near-1.txt"]);
    const lsh = await q(m.tenantId, (tx) => tx<{ n: number; groups: number }[]>`
      SELECT (SELECT count(*)::int FROM document_lsh WHERE tenant_id = ${m.tenantId}) AS n,
             (SELECT count(DISTINCT root_source_id)::int FROM document_lsh_bands WHERE tenant_id = ${m.tenantId}) AS groups`);
    expect(lsh[0]).toEqual({ n: 2, groups: 1 });
  });
});
