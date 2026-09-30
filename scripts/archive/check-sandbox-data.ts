import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const match = envContent.match(/DATABASE_URL=(.+)/);
const dbUrl = match && match[1] ? match[1].trim() : process.env.DATABASE_URL || "";

const sql = postgres(dbUrl, { max: 1 });

async function check() {
  try {
    const orgs = await sql`SELECT * FROM organizations;`;
    console.log("Orgs in sandbox:", orgs);
    const users = await sql`SELECT * FROM users;`;
    console.log("Users in sandbox:", users);
    const invs = await sql`SELECT * FROM investigations;`;
    console.log("Invs in sandbox:", invs);
  } finally {
    await sql.end();
  }
}
check().catch(console.error);
