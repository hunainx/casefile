import { migrate } from "../../packages/db/migrate/index.js";
import fs from "node:fs";
import path from "node:path";

import { matterConfig } from "../../matter.config.js";

const envPath = path.resolve(process.cwd(), ".env");
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const match = envContent.match(/DATABASE_URL_MIGRATIONS=(.+)/);
const dbUrl = match && match[1] ? match[1].trim() : process.env.DATABASE_URL_MIGRATIONS || "";

async function main() {
  const projectRef = matterConfig.supabaseProjectRef;
  console.log(`=== Running Migration on Matter: ${matterConfig.matterName} (${matterConfig.matterSlug}) ===`);
  console.log(`Project Ref: ${projectRef}`);
  
  await migrate({
    projectRef,
    dbUrl,
  });

  console.log("\n✓ Migration completed successfully!");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
