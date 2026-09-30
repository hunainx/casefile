import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { ingestDirectory } from "../../../tools/ingest-cli/src/ingest.js";
import { claudeCodeCimdTransport, mcpAccessToken, mcpPost, seedMcpPerson } from "./helpers/mcp-oauth.js";

/**
 * BIGDATA-3B: the 9 MCP tools on messages read out of mailbox files (test-corpus/mailbox.mbox and
 * mailbox.pst, ingested with the real ingest), through the real /mcp endpoint with an OAuth token:
 * search finds a message by a word of its body; get_source shows the mailbox, the folder path
 * inside it and the message's headers (Bcc included); the other tools list, count, cite and link
 * the messages as they do any source. get_document_page answers "not found" for an email, as it
 * does for every source without page numbers (the same before this step; DEV-037, search track).
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = join(process.cwd(), ".tmp-test-fixtures", `mailbox_mcp_${Date.now()}`);

describe("BIGDATA-3B: the 9 MCP tools on messages from inside a mailbox", () => {
  let app: ReturnType<typeof buildApp>;
  let sql: postgres.Sql;
  let token: string;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  let p2: { id: string; filename: string; metadata: Record<string, unknown> };
  let evidenceId: string;
  let sourceCount = 0;
  const savedEnv: Record<string, string | undefined> = {};

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcpPost(app, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body).result as { isError?: boolean; content: { text: string }[] };
  };
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID"]) savedEnv[k] = process.env[k];
    process.env.MATTER_TENANT_ID = T;
    process.env.MATTER_INVESTIGATION_ID = INV;
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Mailbox MCP Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Mailbox WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'The Mailbox Matter', 'BIGDATA-3B', 'collecting')`;
    }, sql);
    const person = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, investigationId: INV, label: "mbx3b", wsRole: "ws_admin" });
    token = await mcpAccessToken(app, person);

    mkdirSync(DIR, { recursive: true });
    copyFileSync(join(REPO, "test-corpus", "mailbox.mbox"), join(DIR, "mailbox.mbox"));
    copyFileSync(join(REPO, "test-corpus", "mailbox.pst"), join(DIR, "mailbox.pst"));
    await ingestDirectory({ dir: DIR, investigationId: INV, tenantId: T, userId: person.id, dbUrl: getDbUrl() });

    const rows = await withTenant(T, (tx) => tx<{ id: string; filename: string; metadata: Record<string, unknown> }[]>`
      SELECT id, filename, metadata FROM sources WHERE investigation_id = ${INV}`, sql);
    sourceCount = rows.length;
    const found = rows.find((r) => (r.metadata.headers as { subject?: string } | undefined)?.subject === "Q2 figures (fictional)");
    // Without the message (code that does not read mailboxes) every test below fails on its own assertion.
    p2 = found ?? { id: randomUUID(), filename: "(no such message)", metadata: {} };
    // One evidence record on the message's header block (as the DEV-029 test seeds one).
    evidenceId = randomUUID();
    if (found) await withTenant(T, async (tx) => {
      const [b] = await tx<{ id: string; artifact_id: string; text: string }[]>`
        SELECT b.id, cd.artifact_id, b.text FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${p2.id} AND b.block_type = 'email_header'`;
      const cited = "Q2 figures (fictional)";
      await tx`
        INSERT INTO evidence (id, tenant_id, investigation_id, source_id, artifact_id, content_block_id, cited_text, span_hash, admitted_by)
        VALUES (${evidenceId}, ${T}, ${INV}, ${p2.id}, ${b!.artifact_id}, ${b!.id}, ${cited}, ${createHash("sha256").update(cited).digest("hex")}, ${person.id})`;
    }, sql);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
    rmSync(DIR, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("1 matter_status counts the mailboxes, their messages and the messages' attachments", async () => {
    const body = JSON.parse(text(await call("matter_status", {})));
    expect(body.investigation.id).toBe(INV);
    expect(body.sources.total).toBe(sourceCount);
    expect(sourceCount).toBeGreaterThanOrEqual(2 + 5 + 4);
  });

  it("2 list_investigations returns the matter's investigation", async () => {
    expect(JSON.parse(text(await call("list_investigations", {}))).investigations.map((i: { id: string }) => i.id)).toEqual([INV]);
  });

  it("3 get_investigation returns it", async () => {
    const r = await call("get_investigation", { investigation_id: INV });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain("The Mailbox Matter");
  });

  it("4 list_documents lists the messages as .eml sources", async () => {
    const r = await call("list_documents", { limit: 100 });
    const names = JSON.parse(text(r)).documents.map((d: { filename: string }) => d.filename);
    expect(names).toContain("Q2 figures (fictional).eml");
    expect(names).toContain("Harbour lease_ first draft.eml");
    expect(names).toContain("mailbox.pst");
  });

  it("5 get_source shows the mailbox, the folder path and the headers of a PST message (Bcc included)", async () => {
    const r = await call("get_source", { source_id: p2.id });
    expect(r.isError, text(r)).toBeFalsy();
    const body = JSON.parse(text(r));
    expect(body.source.mailbox.mailbox_file).toBe("mailbox.pst");
    expect(body.source.mailbox.mailbox_format).toBe("pst");
    expect(body.source.mailbox.folder_path).toBe("Inbox/Q1/Q2 Reports");
    expect(body.source.mailbox.message_locator).toMatch(/^nid:0x[0-9a-f]{8}$/);
    expect(body.source.mailbox.headers.from).toContain("john.roe@example.org");
    expect(body.source.mailbox.headers.to).toContain("jane.doe@example.com");
    expect(body.source.mailbox.headers.cc).toContain("richard.roe@example.com");
    expect(body.source.mailbox.headers.bcc).toContain("sam.poe@example.org");
    expect(body.source.mailbox.headers.date).toBe("2021-07-01T09:15:00.000Z");
    expect(body.source.mailbox.headers.message_id).toBe("<q2@example.org>");
    expect(body.content_blocks[0].text).toMatch(/\nBcc: "?Sam Poe"? <sam\.poe@example\.org>\n/);
  });

  it("6 get_document_page answers 'not found' for an email (no page numbers; DEV-037, unchanged)", async () => {
    const r = await call("get_document_page", { document_id: p2.id, page: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not found/);
  });

  it("7 get_download_link gives a link to the message's stored object", async () => {
    const r = await call("get_download_link", { document_id: p2.id });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/https?:\/\//);
  });

  it("8 get_evidence returns evidence cited from a message", async () => {
    const body = JSON.parse(text(await call("get_evidence", { evidence_id: evidenceId })));
    expect(body.evidence.id).toBe(evidenceId);
    expect(body.evidence.source_id ?? body.evidence.source?.id).toBe(p2.id);
  });

  it("9 search finds a PST message and an MBOX message by words of their bodies", async () => {
    const pst = JSON.parse(text(await call("search", { query: "saltmarsh-ledger" })));
    expect(pst.items.map((i: { source_id: string }) => i.source_id)).toContain(p2.id);
    const mbox = JSON.parse(text(await call("search", { query: "quayside-lantern" })));
    expect(mbox.total_hits).toBeGreaterThanOrEqual(1);
    expect(mbox.items.map((i: { source_filename?: string; filename?: string }) => i.source_filename ?? i.filename)).toContain("Harbour lease_ first draft.eml");
  });
});
