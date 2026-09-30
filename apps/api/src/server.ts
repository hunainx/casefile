import { createDbClient, getDbUrl } from "@casefile/db";
import { assertRequiredRuntimeSecrets } from "./config/required-secrets.js";
import { assertRequiredRuntimeSettings } from "./config/required-settings.js";
import { assertLocalNoLoginAllowed, assertMcpAuthModeValid } from "./mcp/local-mode.js";
import { buildApp } from "./app.js";

// Boot gate: refuse to start unless every required runtime secret and setting is present.
// This file is the Cloud Run entry point (Dockerfile CMD), so this is the real gate.
assertRequiredRuntimeSecrets();
// D77: an unusable /mcp auth mode refuses to start; so does local no-login mode unless every
// one of its conditions holds (checked against the database, before listening).
assertMcpAuthModeValid();
assertRequiredRuntimeSettings();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const db = createDbClient(getDbUrl());
await assertLocalNoLoginAllowed(process.env, db);

const app = buildApp({ logger: true, db });

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
