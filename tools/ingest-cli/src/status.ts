import postgres from "postgres";
import { withTenant, getDbUrl } from "@casefile/db";
import { verifyTenantAuditChain } from "@casefile/audit";
import {
  getObjectStore,
  createSourceStorageKey,
  type TenantScopedKey,
} from "@casefile/storage";
import { parseArgs, loadEnv } from "./args.js";
import { getRunStatus, formatRunStatus } from "./run-status.js";

loadEnv();

export interface InvestigationStatusReport {
  investigationId: string;
  investigationName: string;
  tenantId: string;
  workspaceId: string;
  sourceCounts: {
    total: number;
    indexed: number;
    needsOcr: number;
    storedUnparsed: number;
    withdrawn: number;
    quarantined: number;
    other: number;
  };
  contentBlockCount: number;
  chunkCount: number;
  auditChain: {
    valid: boolean;
    verifiedCount: number;
    lastSeq: number;
    lastHash: string;
    breaks: string | null;
  };
  storageVerification: {
    totalSources: number;
    verifiedInBucket: number;
    missingFromBucket: Array<{
      sourceId: string;
      filename: string;
      sha256: string;
      storageUri: string;
    }>;
  };
}

function decodeTokenTenant(token?: string): string | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf-8"));
      return payload.tid || null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function getInvestigationStatus(options: {
  investigationId: string;
  tenantId?: string;
  dbUrl?: string;
}): Promise<InvestigationStatusReport> {
  const dbUrl = options.dbUrl || getDbUrl();
  const db = postgres(dbUrl, { max: 1 });

  const tenantId =
    options.tenantId ||
    process.env.MATTER_TENANT_ID ||
    process.env.CASEFILE_TENANT_ID ||
    decodeTokenTenant(process.env.CASEFILE_TOKEN);

  if (!tenantId) {
    throw new Error(
      `Tenant context is required. Pass --tenant <id> or set MATTER_TENANT_ID in .env`
    );
  }

  try {
    return await withTenant(tenantId, async (tx) => {
      const invRows = await tx<{ id: string; tenant_id: string; workspace_id: string; name: string }[]>`
        SELECT id, tenant_id, workspace_id, name
        FROM investigations
        WHERE id = ${options.investigationId}
          AND tenant_id = ${tenantId}
          AND deleted_at IS NULL
        LIMIT 1;
      `;

      if (invRows.length === 0 || !invRows[0]) {
        throw new Error(`Investigation ${options.investigationId} was not found.`);
      }

      const inv = invRows[0];
      const workspaceId = inv.workspace_id;
      const investigationId = inv.id;

      // 1. Source counts by status
      const sourceStatusRows = await tx<{ status: string; count: string }[]>`
        SELECT status, COUNT(*)::text as count
        FROM sources
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${tenantId}
          AND deleted_at IS NULL
        GROUP BY status;
      `;

      let totalSources = 0;
      let indexed = 0;
      let needsOcr = 0;
      let storedUnparsed = 0;
      let withdrawn = 0;
      let quarantined = 0;
      let other = 0;

      for (const row of sourceStatusRows) {
        const cnt = parseInt(row.count, 10) || 0;
        totalSources += cnt;
        if (row.status === "indexed") indexed += cnt;
        else if (row.status === "needs_ocr") needsOcr += cnt;
        else if (row.status === "stored_unparsed") storedUnparsed += cnt;
        else if (row.status === "withdrawn") withdrawn += cnt;
        else if (row.status === "quarantined") quarantined += cnt;
        else other += cnt;
      }

      // 2. Content block counts
      const blockCountRows = await tx<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM content_blocks cb
        JOIN content_documents cd ON cd.id = cb.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        JOIN sources s ON s.id = a.source_id
        WHERE s.investigation_id = ${investigationId}
          AND s.tenant_id = ${tenantId}
          AND s.deleted_at IS NULL;
      `;
      const contentBlockCount = parseInt(blockCountRows[0]?.count || "0", 10);

      // 3. Chunks count
      const chunkCountRows = await tx<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM chunks
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${tenantId};
      `;
      const chunkCount = parseInt(chunkCountRows[0]?.count || "0", 10);

      // 4. Audit chain validation
      const auditResult = await verifyTenantAuditChain(tx, tenantId);
      const headRows = await tx<{ last_seq: string; last_hash: string }[]>`
        SELECT last_seq::text, last_hash
        FROM audit_chain_heads
        WHERE tenant_id = ${tenantId};
      `;

      const lastSeq = parseInt(headRows[0]?.last_seq || "0", 10);
      const lastHash = headRows[0]?.last_hash || "none";

      // 5. Storage verification: check every source object exists in ObjectStore
      const sourceRows = await tx<{ id: string; filename: string; sha256: string; storage_uri: string }[]>`
        SELECT id, filename, sha256, storage_uri
        FROM sources
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${tenantId}
          AND deleted_at IS NULL;
      `;

      const missing: Array<{ sourceId: string; filename: string; sha256: string; storageUri: string }> = [];
      let verifiedInBucket = 0;

      for (const src of sourceRows) {
        let storageKey: TenantScopedKey;
        if (src.storage_uri && (src.storage_uri.startsWith("gs://") || src.storage_uri.startsWith("gcs://"))) {
          const withoutPrefix = src.storage_uri.replace(/^(?:gs|gcs):\/\/[^/]+\//, "");
          storageKey = withoutPrefix as TenantScopedKey;
        } else {
          storageKey = createSourceStorageKey(tenantId, investigationId, src.sha256);
        }
        try {
          const head = await getObjectStore().head(storageKey);
          if (head && head.sizeBytes > 0) {
            verifiedInBucket++;
          } else {
            missing.push({
              sourceId: src.id,
              filename: src.filename,
              sha256: src.sha256,
              storageUri: src.storage_uri,
            });
          }
        } catch {
          missing.push({
            sourceId: src.id,
            filename: src.filename,
            sha256: src.sha256,
            storageUri: src.storage_uri,
          });
        }
      }

      return {
        investigationId,
        investigationName: inv.name,
        tenantId,
        workspaceId,
        sourceCounts: {
          total: totalSources,
          indexed,
          needsOcr,
          storedUnparsed,
          withdrawn,
          quarantined,
          other,
        },
        contentBlockCount,
        chunkCount,
        auditChain: {
          valid: auditResult.valid,
          verifiedCount: auditResult.verifiedCount,
          lastSeq,
          lastHash,
          breaks: auditResult.break ? JSON.stringify(auditResult.break) : null,
        },
        storageVerification: {
          totalSources: sourceRows.length,
          verifiedInBucket,
          missingFromBucket: missing,
        },
      };
    }, db);
  } finally {
    await db.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI execution
// ─────────────────────────────────────────────────────────────────────────────
async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  // BIGDATA-4: one run's progress (while it goes and after), from the matter's database only.
  if (typeof args["run"] === "string") {
    const runId = args["run"];
    try {
      for (;;) {
        const s = await getRunStatus({ runId });
        console.log(formatRunStatus(s));
        if (!args["watch"] || s.state === "finished" || s.state === "finished-with-failures") break;
        await new Promise((r) => setTimeout(r, 10_000));
      }
    } catch (err: unknown) {
      console.error("Status check failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }
  const investigationId = (args["investigation"] || args["i"] || process.env.MATTER_INVESTIGATION_ID || process.env.CASEFILE_INVESTIGATION_ID || "") as string;
  const tenantId = (args["tenant"] || args["t"] || process.env.MATTER_TENANT_ID || process.env.CASEFILE_TENANT_ID || decodeTokenTenant(process.env.CASEFILE_TOKEN || (args["token"] as string))) as string;

  if (!investigationId) {
    console.error("Error: --investigation <id> is required.");
    console.error("Usage: pnpm ingest:status --investigation <id>");
    console.error("       pnpm ingest:status --run <run id> [--watch]   (one run: done and left, rate, time left, failures, workers)");
    process.exit(1);
  }

  try {
    const report = await getInvestigationStatus({ investigationId, tenantId });

    console.log("================================================================================");
    console.log(`INVESTIGATION STATUS: ${report.investigationName}`);
    console.log("================================================================================");
    console.log(`Investigation ID:      ${report.investigationId}`);
    console.log(`Tenant ID:             ${report.tenantId}`);
    console.log(`Workspace ID:          ${report.workspaceId}`);
    console.log("────────────────────────────────────────────────────────────────────────────────");
    console.log("CORPUS COUNTS:");
    console.log(`  Total Sources:       ${report.sourceCounts.total}`);
    console.log(`    - Indexed/Parsed:  ${report.sourceCounts.indexed}`);
    console.log(`    - Needs OCR:       ${report.sourceCounts.needsOcr}`);
    console.log(`    - Stored-unparsed: ${report.sourceCounts.storedUnparsed}`);
    console.log(`    - Withdrawn:       ${report.sourceCounts.withdrawn}`);
    console.log(`    - Quarantined:     ${report.sourceCounts.quarantined}`);
    console.log(`  Content Blocks:      ${report.contentBlockCount}`);
    console.log(`  Chunks:              ${report.chunkCount}`);
    console.log("────────────────────────────────────────────────────────────────────────────────");
    console.log("AUDIT CHAIN STATUS:");
    console.log(`  Chain Integrity:     ${report.auditChain.valid ? "VERIFIED (0 breaks)" : "BROKEN"}`);
    console.log(`  Audit Head Seq:      ${report.auditChain.lastSeq}`);
    console.log(`  Audit Head Hash:     ${report.auditChain.lastHash}`);
    console.log(`  Verified Events:     ${report.auditChain.verifiedCount}`);
    if (report.auditChain.breaks) {
      console.log(`  Break Detail:        ${report.auditChain.breaks}`);
    }
    console.log("────────────────────────────────────────────────────────────────────────────────");
    console.log("OBJECT STORAGE VERIFICATION:");
    console.log(`  Sources in Bucket:   ${report.storageVerification.verifiedInBucket} / ${report.storageVerification.totalSources} verified`);
    if (report.storageVerification.missingFromBucket.length > 0) {
      console.log(`  WARNING: ${report.storageVerification.missingFromBucket.length} sources missing from bucket:`);
      for (const m of report.storageVerification.missingFromBucket) {
        console.log(`    - ${m.filename} (ID: ${m.sourceId}, SHA: ${m.sha256.slice(0, 12)})`);
      }
    } else {
      console.log("  Status:              ALL source objects verified in storage bucket.");
    }
    console.log("================================================================================");

    if (!report.auditChain.valid || report.storageVerification.missingFromBucket.length > 0) {
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error("Status check failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (/(^|[\\/])status\.(ts|js)$/.test(process.argv[1] ?? "")) {
  runCli();
}
