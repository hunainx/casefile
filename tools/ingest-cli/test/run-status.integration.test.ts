import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDbUrl } from "@casefile/db";
import { handleMatterStatus } from "@casefile/mcp";
import { enqueueDirectory, ingestDirectory } from "../src/ingest.js";
import { runWorker } from "../src/worker.js";
import { getRunStatus, formatRunStatus, type RunStatus } from "../src/run-status.js";
import { newMatter, q, type Matter } from "./helpers/run-outcomes.js";

/**
 * BIGDATA-4 progress (plan section 16, E): `pnpm ingest:status --run <id>` gives, while a run goes and
 * after it: files and bytes done and left, messages read, the rate, an estimate of the time left, failed
 * items with their reasons, what each worker is doing, and the kept/skipped counts. matter_status adds a
 * short `ingest_run` block (state, done/left, failures) while the run is unfinished or has failed items,
 * and nothing for a run that finished cleanly (its output is unchanged then).
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = join(process.cwd(), ".tmp-test-fixtures", `run-status_${Date.now()}`);

function writeCorpus(dir: string, n: number): void {
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, "notes", `note-${String(i).padStart(2, "0")}.txt`), `Fake status note ${i}: ${"fake words ".repeat(50 + i)}\n`);
  writeFileSync(join(dir, "notes", "Thumbs.db"), "fake junk");
}

const matterStatus = (m: Matter) => q(m.tenantId, (tx) => handleMatterStatus(tx, { tenantId: m.tenantId, investigationId: m.investigationId, userId: m.userId, roles: ["lead_inv"] }));

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("tools/ingest-cli — BIGDATA-4 ingest:status and matter_status", () => {
  it("shows a run while it goes (done/left, bytes, rate, time left, each worker's activity) and once it is over: failures, kept/skipped", async () => {
    const dir = join(BASE, "going");
    writeCorpus(dir, 8);
    const m = await newMatter("going", BASE);
    const { runId } = await enqueueDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });

    let reached: () => void = () => {};
    const atNote4 = new Promise<void>((r) => (reached = r));
    let go: () => void = () => {};
    const gate = new Promise<void>((r) => (go = r));
    const worker = runWorker({
      runId, tenantId: m.tenantId, name: "status-worker",
      hooks: {
        beforeWrite: async (item) => {
          if (item.file_name === "note-04.txt") {
            reached();
            await gate;
          }
        },
        duringWrite: (item) => {
          if (item.file_name === "note-06.txt") throw new Error("fake parser crash (injected by the test)");
        },
      },
    });
    await atNote4;
    await new Promise((r) => setTimeout(r, 1200)); // at least one heartbeat with the worker's activity
    const during: RunStatus = await getRunStatus({ runId, tenantId: m.tenantId });
    expect(during.state).toBe("running");
    expect(during.top.total).toBe(8);
    expect(during.top.done).toBe(4);
    expect(during.top.left).toBe(4);
    expect(during.bytes.done).toBeGreaterThan(0);
    expect(during.bytes.left).toBeGreaterThan(0);
    expect(during.rate.bytesPerSecond).toBeGreaterThan(0);
    expect(during.etaSeconds).not.toBeNull();
    expect(during.workers).toEqual([expect.objectContaining({ name: "status-worker", alive: true, activity: expect.stringContaining("note-04.txt") })]);
    expect(during.outcomes.indexed).toBe(4);
    expect(during.outcomes.skipped).toEqual({ "skip-junk:junk-name": 1 });
    const text = formatRunStatus(during);
    for (const s of ["running", "Files", "4 of 8 done", "left", "Bytes", "Rate", "Time left", "status-worker", "note-04.txt", "skip-junk"]) expect(text).toContain(s);

    const whileGoing = await matterStatus(m);
    expect(whileGoing.ingest_run).toEqual(expect.objectContaining({ run_id: runId, state: "running", done: 4, left: 4, failed: 0 }));

    // The command itself, while the run is held: the same numbers.
    const cli = execFileSync(process.execPath, ["--import", "tsx", join(REPO, "tools", "ingest-cli", "src", "status.ts"), "--run", runId], {
      cwd: REPO, encoding: "utf8", env: { ...process.env, DATABASE_URL: getDbUrl(), MATTER_TENANT_ID: m.tenantId, NODE_ENV: "development", VITEST: "" },
    });
    expect(cli).toContain("4 of 8 done");
    expect(cli).toContain("status-worker");

    go();
    await worker;
    const after = await getRunStatus({ runId, tenantId: m.tenantId });
    expect(after.state).toBe("finished-with-failures");
    expect(after.top).toEqual(expect.objectContaining({ total: 8, done: 7, failed: 1, left: 0 }));
    expect(after.failed).toEqual([expect.objectContaining({ path: join(dir, "notes", "note-06.txt"), attempts: 3, error: expect.stringContaining("fake parser crash") })]);
    expect(after.outcomes.indexed).toBe(7);
    expect(after.etaSeconds).toBe(0);
    expect(after.workers).toEqual([expect.objectContaining({ name: "status-worker", alive: false })]);
    expect(formatRunStatus(after)).toContain("fake parser crash");
    const afterStatus = await matterStatus(m);
    expect(afterStatus.ingest_run).toEqual(expect.objectContaining({ run_id: runId, state: "finished-with-failures", done: 7, left: 0, failed: 1 }));
  });

  it("matter_status has no ingest_run block once a run has finished cleanly", async () => {
    const dir = join(BASE, "clean");
    writeCorpus(dir, 3);
    const m = await newMatter("clean-status", BASE);
    const s = await ingestDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    expect((await getRunStatus({ runId: s.runId, tenantId: m.tenantId })).state).toBe("finished");
    const status = await matterStatus(m);
    expect(Object.keys(status)).toEqual(["investigation", "sources", "storage_capabilities", "search_capabilities"]);
  });
});
