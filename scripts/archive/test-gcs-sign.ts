import { getObjectStore, setObjectStore, type TenantScopedKey } from "../../packages/storage/src/index.js";
import fs from "node:fs";

const envContent = fs.readFileSync(".env", "utf8");
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx !== -1) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

setObjectStore(null);
const store = getObjectStore();
console.log("STORE IS:", store.constructor.name);

async function main() {
  const testKey = "get-object-store-keyless-test.txt" as TenantScopedKey;
  const testBytes = new TextEncoder().encode("Testing getObjectStore keyless signed URL generation");
  await store.put(testKey, testBytes);

  const url = await store.signedUrl(testKey, 900);
  console.log("SUCCESS SIGNED URL:", url);

  const res = await fetch(url);
  console.log("FETCH STATUS:", res.status);
  const text = await res.text();
  console.log("FETCHED TEXT:", text);
}

main();
