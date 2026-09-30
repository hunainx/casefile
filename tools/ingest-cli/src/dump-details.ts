import postgres from "postgres";
import { withTenant } from "@casefile/db/tenant";

/**
 * Debug helper: prints every content block of one investigation.
 *   npx tsx tools/ingest-cli/src/dump-details.ts --tenant <MATTER_TENANT_ID> --investigation <MATTER_INVESTIGATION_ID>
 */
function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} <id> is required`);
  return v;
}

async function main() {
  const tenantId = arg("tenant");
  const investigationId = arg("investigation");
  const db = postgres(process.env.DATABASE_URL!);
  await withTenant(
    tenantId,
    async (tx) => {
      const rows = await tx`
        SELECT 
          s.filename,
          cb.sequence, 
          cb.block_type, 
          cb.page, 
          cb.text 
        FROM content_blocks cb 
        JOIN content_documents cd ON cd.id = cb.content_document_id 
        JOIN artifacts a ON a.id = cd.artifact_id 
        JOIN sources s ON s.id = a.source_id 
        WHERE s.investigation_id = ${investigationId}
        ORDER BY s.filename, cb.sequence
      `;
      console.log("All Content Blocks:", JSON.stringify(rows, null, 2));
    },
    db
  );
  await db.end();
}

main().catch(console.error);
