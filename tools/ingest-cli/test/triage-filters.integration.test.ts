import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, type IngestBatchSummary, type IngestFileResult } from "../src/ingest.js";

/**
 * BIGDATA-3 date and person filters (answer 5; D102). The case owner chooses them per run; they
 * are recorded on the run; the default is no filter. An object a filter catches is a skip-filter
 * decision that names the filter. Emails are judged by their Date, From, To and Cc headers,
 * every other file by its file date. What a filter cannot judge (an email with no Date, a file
 * with no date) is kept, with the reason. Emails inside a zip are judged when they are reached.
 */
const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `triage_filters_${Date.now()}`);
const ENV_DIR = `${TEST_DIR}-env`;

const eml = (h: { date?: string; from: string; to: string; cc?: string; subject: string }, body: string) =>
  [
    `From: ${h.from}`,
    `To: ${h.to}`,
    ...(h.cc ? [`Cc: ${h.cc}`] : []),
    ...(h.date ? [`Date: ${h.date}`] : []),
    `Subject: ${h.subject}`,
    `Message-ID: <${randomUUID()}@filters.example>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

type Decision = { path: string; stage: string; decision: string; rule: string | null; rule_version: number | null; reason: string | null; filter: Record<string, unknown> | null };

describe("tools/ingest-cli — BIGDATA-3 date and person filters", () => {
  let tenantId: string;
  let userId: string;
  const runs: Record<string, { summary: IngestBatchSummary; flat: IngestFileResult[]; decisions: Decision[]; filters: unknown }> = {};
  const rel = (p: string) => relative(TEST_DIR, p.split("#")[0]!).replace(/\\/g, "/") + (p.includes("#") ? `#${p.split("#").slice(1).join("#")}` : "");

  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };
  /**
   * One workspace and investigation per run, so no run sees another's files: in one workspace a
   * later run would link the earlier run's sources instead of parsing the files again.
   */
  const runWith = async (name: string, filters: Parameters<typeof ingestDirectory>[0]["filters"]) => {
    const inv = randomUUID();
    const ws = randomUUID();
    await q((tx) => tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${ws}, ${tenantId}, ${`Filters ${name}`})`);
    await q((tx) => tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage, created_by) VALUES (${inv}, ${tenantId}, ${ws}, ${name}, 'collecting', ${userId})`);
    const summary = await ingestDirectory({ dir: TEST_DIR, investigationId: inv, tenantId, dbUrl: getDbUrl(), userId, ...(filters ? { filters } : {}) });
    const flat: IngestFileResult[] = [];
    const walk = (r: IngestFileResult) => { flat.push(r); r.childResults?.forEach(walk); };
    summary.results.forEach(walk);
    // Guarded only so that, before BIGDATA-3 existed (no runId), each test failed on its own assertion.
    const decisions = summary.runId ? await q((tx) => tx<Decision[]>`SELECT * FROM ingest_decisions WHERE run_id = ${summary.runId} ORDER BY seq`) : [];
    const run = summary.runId ? await q((tx) => tx<{ filters: unknown }[]>`SELECT filters FROM ingest_runs WHERE id = ${summary.runId}`) : [];
    runs[name] = { summary, flat, decisions, filters: run[0]?.filters };
  };
  const d = (name: string, r: string) => runs[name]!.decisions.find((x) => rel(x.path) === r);
  const status = (name: string, r: string) => runs[name]!.flat.find((x) => rel(x.filePath) === r)?.status;

  beforeAll(async () => {
    mkdirSync(join(TEST_DIR, "mail"), { recursive: true });
    mkdirSync(join(TEST_DIR, "files"), { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "mail", "2019-old.eml"), eml({ date: "Fri, 01 Mar 2019 10:00:00 +0000", from: "Arlo Venn <arlo@acme.example>", to: "bea@beta.example", subject: "Old fake shipment" }, "Fake body of the 2019 message."));
    writeFileSync(join(TEST_DIR, "mail", "2021-in.eml"), eml({ date: "Tue, 15 Jun 2021 09:30:00 +0000", from: "cato@acme.example", to: "dov@beta.example", cc: "Watcher <watch@gamma.example>", subject: "Mid fake shipment" }, "Fake body of the 2021 message."));
    writeFileSync(join(TEST_DIR, "mail", "2023-new.eml"), eml({ date: "Tue, 10 Jan 2023 08:00:00 +0000", from: "Nyra Pell <nyra@delta.example>", to: "eli@beta.example", subject: "New fake shipment" }, "Fake body of the 2023 message."));
    writeFileSync(join(TEST_DIR, "mail", "no-date.eml"), eml({ from: "xan@acme.example", to: "fay@beta.example", subject: "Undated fake note" }, "Fake body of a message with no Date header."));
    writeFileSync(join(TEST_DIR, "files", "old-file.txt"), "Fake file last changed in 2018.");
    writeFileSync(join(TEST_DIR, "files", "new-file.txt"), "Fake file last changed in 2022, a little longer.");
    utimesSync(join(TEST_DIR, "files", "old-file.txt"), new Date("2018-01-01T12:00:00Z"), new Date("2018-01-01T12:00:00Z"));
    utimesSync(join(TEST_DIR, "files", "new-file.txt"), new Date("2022-05-05T12:00:00Z"), new Date("2022-05-05T12:00:00Z"));
    const zip = new AdmZip();
    zip.addFile("2019-in-zip.eml", Buffer.from(eml({ date: "Mon, 04 Feb 2019 11:00:00 +0000", from: "gil@acme.example", to: "hal@beta.example", subject: "Zipped old fake" }, "Fake zipped 2019 body.")));
    zip.addFile("2021-in-zip.eml", Buffer.from(eml({ date: "Wed, 03 Mar 2021 11:00:00 +0000", from: "ivo@omega.example", to: "jem@beta.example", subject: "Zipped mid fake" }, "Fake zipped 2021 body.")));
    zip.writeZip(join(TEST_DIR, "bundle.zip"));
    // mtimes of the mail and zip files are "now", inside every file-date window used below.

    const boot = await bootstrap({
      name: `BIGDATA-3 filters WS ${Date.now()}`,
      investigationName: "BIGDATA-3 filters (unused)",
      email: `bigdata3-filters-${Date.now()}@casefile.test`,
      matter: `bigdata3-filters-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    userId = boot.userId;

    await runWith("none", undefined);
    await runWith("email-date", { emailDateFrom: "2020-01-01", emailDateTo: "2022-12-31" });
    await runWith("file-date", { fileDateFrom: "2020-01-01" });
    await runWith("person", { persons: ["watch@gamma.example", "nyra pell"] });
    await runWith("exclude-person", { excludePersons: ["acme.example"] });
  }, 240_000);

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(ENV_DIR, { recursive: true, force: true });
  });

  it("default: no filter; nothing is skip-filter and the run records no filter", () => {
    expect(runs.none!.filters).toEqual({});
    expect(runs.none!.decisions.filter((x) => x.decision === "skip-filter")).toEqual([]);
    expect(runs.none!.summary.skipped).toBe(0);
  });

  it("email date: emails outside the window are skip-filter with the filter recorded; an email with no Date is kept with the reason; other files are not judged by it", () => {
    expect(runs["email-date"]!.filters).toEqual({ email_date_from: "2020-01-01", email_date_to: "2022-12-31" });
    expect(d("email-date", "mail/2019-old.eml")).toMatchObject({ stage: "triage", decision: "skip-filter", rule: "email-date", rule_version: 1, filter: { email_date_from: "2020-01-01", email_date_to: "2022-12-31", value: "2019-03-01T10:00:00.000Z" } });
    expect(d("email-date", "mail/2023-new.eml")).toMatchObject({ decision: "skip-filter", rule: "email-date" });
    expect(d("email-date", "mail/2021-in.eml")).toMatchObject({ decision: "ingest" });
    expect(d("email-date", "mail/no-date.eml")).toMatchObject({ decision: "ingest", reason: "email date unknown: kept" });
    expect(d("email-date", "files/old-file.txt")).toMatchObject({ decision: "ingest" });
    expect(status("email-date", "mail/2019-old.eml")).toBe("skipped");
    expect(status("email-date", "mail/2021-in.eml")).toBe("indexed");
  });

  it("email date inside a zip: the old email is a skip-filter decision of the ingest stage, the other is ingested", () => {
    expect(d("email-date", "bundle.zip#2019-in-zip.eml")).toMatchObject({ stage: "ingest", decision: "skip-filter", rule: "email-date" });
    expect(status("email-date", "bundle.zip#2019-in-zip.eml")).toBe("skipped");
    expect(status("email-date", "bundle.zip#2021-in-zip.eml")).toBe("indexed");
  });

  it("file date: a file last changed before the window is skip-filter; emails are not judged by file date", () => {
    expect(runs["file-date"]!.filters).toEqual({ file_date_from: "2020-01-01" });
    expect(d("file-date", "files/old-file.txt")).toMatchObject({ decision: "skip-filter", rule: "file-date", filter: { file_date_from: "2020-01-01", value: "2018-01-01T12:00:00.000Z" } });
    expect(d("file-date", "files/new-file.txt")).toMatchObject({ decision: "ingest" });
    expect(d("file-date", "mail/2019-old.eml")).toMatchObject({ decision: "ingest" });
  });

  it("person: only emails with one of the people in From, To or Cc (address, name or part, any case) are kept; other files are not judged by it", () => {
    expect(runs.person!.filters).toEqual({ persons: ["watch@gamma.example", "nyra pell"] });
    expect(d("person", "mail/2021-in.eml")).toMatchObject({ decision: "ingest" }); // Cc
    expect(d("person", "mail/2023-new.eml")).toMatchObject({ decision: "ingest" }); // From, by name
    expect(d("person", "mail/2019-old.eml")).toMatchObject({ decision: "skip-filter", rule: "person", filter: { persons: ["watch@gamma.example", "nyra pell"] } });
    expect(d("person", "mail/no-date.eml")).toMatchObject({ decision: "skip-filter", rule: "person" });
    expect(d("person", "files/old-file.txt")).toMatchObject({ decision: "ingest" });
    expect(d("person", "bundle.zip#2019-in-zip.eml")).toMatchObject({ stage: "ingest", decision: "skip-filter", rule: "person" });
  });

  it("exclude-person: emails with one of the people in From, To or Cc are skip-filter", () => {
    expect(runs["exclude-person"]!.filters).toEqual({ exclude_persons: ["acme.example"] });
    expect(d("exclude-person", "mail/2019-old.eml")).toMatchObject({ decision: "skip-filter", rule: "exclude-person" });
    expect(d("exclude-person", "mail/2021-in.eml")).toMatchObject({ decision: "skip-filter", rule: "exclude-person" });
    expect(d("exclude-person", "mail/no-date.eml")).toMatchObject({ decision: "skip-filter", rule: "exclude-person" });
    expect(d("exclude-person", "mail/2023-new.eml")).toMatchObject({ decision: "ingest" });
    expect(d("exclude-person", "bundle.zip#2021-in-zip.eml")).toBeUndefined(); // ivo@omega.example: ingested, no decision row
    expect(status("exclude-person", "bundle.zip#2021-in-zip.eml")).toBe("indexed");
  });
});
