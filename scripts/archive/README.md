# Scripts Archive (`scripts/archive/`)

This directory archives one-off probe, verification, and historic setup scripts that proved key platform properties during development. They are retained as evidentiary records and reference material, but are not intended for ongoing matter operations.

For active matter operations and deployment tools, see the root `scripts/` directory:
- `scripts/deploy-matter.ts` — Full matter infrastructure deployment orchestrator
- `scripts/matter-check.ts` — Matter pre-flight integrity and configuration validator
- `scripts/bucket-inventory.ts` — GCS bucket inventory and PDF text-layer assessment tool
- `scripts/build-mcp-config.ts` — Claude Desktop & Cursor MCP client configuration generator
- `scripts/test-matter-check-branches.ts` — Preflight check branch coverage test harness
- `scripts/dev-db.sh` — Local PostgreSQL 16 cluster manager

---

## Archived Scripts Inventory

| Script | Date | What It Proved / Historical Purpose |
|---|---|---|
| `apply-sandbox-secrets.ts` | 2026-09-02 | Proved programmatic creation and deployment of runtime secrets to GCP Secret Manager for the sandbox matter. |
| `audit-public-routes.ts` | 2026-09-02 | Proved live Cloud Run route boundary isolation by asserting that unauthenticated access is strictly rejected on protected routes while matching the public route manifest. |
| `check-sandbox-data.ts` | 2026-09-02 | Historic probe verifying live table row counts and initial data seeding in the sandbox Supabase database. |
| `check-sandbox-rls.ts` | 2026-09-02 | Proved live Row-Level Security (RLS) multi-tenant isolation against the remote sandbox Supabase Postgres cluster. |
| `deploy-cloud-run.ts` | 2026-09-02 | Proved standalone Cloud Run container deployment workflow and environment variable binding prior to unified orchestrator. |
| `fetch-sandbox-search.ts` | 2026-09-02 | Historic probe validating live lexical search endpoint responses on the sandbox Cloud Run deployment. |
| `get-sandbox-search-sample.ts` | 2026-09-02 | Historic probe inspecting live search query results and payload formats from the sandbox environment. |
| `migrate-sandbox.ts` | 2026-09-02 | Historic migration trigger applying schema migrations against the remote sandbox Supabase database. |
| `probe-cloudrun-signing.ts` | 2026-09-02 | Proved live keyless V4 signed GCS download URL generation via IAM Credentials API on deployed Cloud Run. |
| `probe-live-mcp.ts` | 2026-09-02 | Proved live HTTP MCP tool dispatch and bearer token authentication against the deployed Cloud Run service. |
| `probe-mcp-routes.ts` | 2026-09-02 | Proved that `/mcp` routes are reachable, properly routed, and enforce authentication headers. |
| `probe-token-rotation.ts` | 2026-09-02 | Proved zero-downtime MCP bearer token rotation by updating Secret Manager secrets without service interruption. |
| `prove-stop-on-failed-migration.ts` | 2026-09-02 | Proved that the migration runner strictly halts execution and fails closed when encountering a failing migration step. |
| `rotate-sandbox-mcp-token.ts` | 2026-09-02 | Historic script that performed the live token rotation in GCP Secret Manager for the sandbox environment. |
| `setup-sandbox-complete.ts` | 2026-09-02 | Historic end-to-end prototype script for provisioning sandbox infrastructure, superseded by `deploy-matter.ts`. |
| `setup-secrets.ts` | 2026-09-02 | Historic prototype script for provisioning initial Secret Manager secret keys for sandbox. |
| `setup-service-account.ts` | 2026-09-02 | Historic prototype script provisioning the granular IAM service account and bucket bindings for sandbox. |
| `test-gcs-sign.ts` | 2026-09-02 | Proved local V4 signed URL generation using ADC credentials and IAM impersonation without static service account key files. |
| `test-kill-and-resume.ts` | 2026-09-02 | Proved SIGINT graceful termination and idempotent resume safety of the ingestion CLI against live GCS buckets. |
| `test-live-mcp-rpc.ts` | 2026-09-02 | Proved JSON-RPC 2.0 protocol compliance for MCP tool listing and tool execution on live endpoints. |
| `verify-image-credentials.ts` | 2026-09-02 | Proved that the deployed Docker container image resolves ADC identity and accesses Secret Manager correctly. |
| `verify-running-revision.ts` | 2026-09-02 | Proved programmatic inspection of active Cloud Run service revisions, image digests, and deployment metadata. |
| `test-guard-local-foreign.ts` | 2026-09-04 | Proved the migration runner's pre-flight guard refuses to run against a database whose `schema_migrations` holds a foreign (another project's) history, using a throwaway local database `casefile_guard_test` that it creates and drops itself — never a remote project. Deleted in the 2026-09-04 cleanup commit `c0e6822`; restored from that commit's parent (blob `9e5a3b9`) on 2026-09-04 with only its relative import path adjusted for the archive location. |
| `verify-migration-20.ts` | 2026-09-04 | Proved migration 0020 had landed on a deployed matter by reading the `sources.status` CHECK constraint and the `geneva_settlement_smoke.txt` smoke-ingest row under tenant RLS. Reads its connection string from `DATABASE_URL` and the tenant from `MATTER_TENANT_ID`. |
