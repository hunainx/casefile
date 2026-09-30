# Casefile Matter Setup & Deployment Guide

This guide walks through configuring, deploying, and operating an isolated Casefile matter instance.

Casefile follows a strict **per-matter infrastructure isolation architecture** (Decisions D58, D59, D60, D62):
- **1 Matter = 1 Dedicated Supabase Project** (Database & Auth)
- **1 Matter = 3 Dedicated Google Cloud Storage Buckets** (`sources`, `artifacts`, `exports`)
- **1 Matter = Dedicated Secret Manager Secrets**, exactly those `scripts/deploy-matter.ts --phase=database` creates: `casefile-<matter>-database-url`, `casefile-<matter>-supabase-url`, `casefile-<matter>-supabase-publishable-key`, `casefile-<matter>-supabase-secret-key` (only if the Supabase CLI returns one; never mounted), and the JWT signing secret named by `matterConfig.secrets.jwtSecret` (generated once, reused on re-runs). Matters deployed before sign-in also have a `casefile-<matter>-mcp-token` secret; nothing creates or reads it any more, and `docs/UPGRADE-LIVE-MATTER.md` step 9 disables it. The `encryption-key` and `audit-pepper` names declared in `matter.config.ts` are not provisioned or read by anything — see `docs/DEVIATIONS.md` DEV-018.
- **1 Matter = 1 Scoped Service Account** with granular bucket & secret access only
- **GCS Immutability Rule (D62)**: Never delete, overwrite, or move an object in any GCS bucket. No `gcloud storage rm`, no `deleteFiles()`, no `file.delete()`. Ingestion reads only. Tests write to isolated prefixes and leave them.

---

## 1. Prerequisites

- **Node.js**: >= 22.0.0
- **pnpm**: >= 10.0.0
- **Supabase CLI**: Authenticated via `supabase login`
- **Google Cloud CLI**: Authenticated with access to Secret Manager and Cloud Storage
- **Claude Desktop**: Installed for AI investigation interface

---

## 2. Setting Up a New Matter

### Step 2.1 — Configure `matter.config.ts`

Edit `matter.config.ts` with the specific parameters for your matter:

```typescript
export const matterConfig: MatterConfig = {
  matterName: "Meridian Insolvency",
  matterSlug: "meridian",
  investigationName: "Beneficial Ownership Investigation",
  objective: "Asset tracing and offshore corporate holding analysis.",
  supabaseProjectRef: "<YOUR_EMPTY_SUPABASE_PROJECT_REF>",
  buckets: {
    sources: "casefile-meridian-sources",
    artifacts: "casefile-meridian-artifacts",
    exports: "casefile-meridian-exports",
  },
  secrets: {
    dbUrl: "casefile-meridian-db-url",
    jwtSecret: "casefile-meridian-jwt-secret",
    encryptionKey: "casefile-meridian-encryption-key",
    auditPepper: "casefile-meridian-audit-pepper",
  },
};
```

### Step 2.2 — Validate Template Integrity

Run the template verification guardrail:

```bash
pnpm matter:check
```

This verifies that all bucket names, secret identifiers, and environment configurations match the single source of truth.

---

## 3. Infrastructure Provisioning & Deployment

Deploy the isolated matter infrastructure:

```bash
pnpm tsx scripts/deploy-matter.ts --matter meridian --project-ref <SUPABASE_PROJECT_REF> --admin-email <ADMIN_LOGIN_EMAIL>
```

`--matter` must be the slug from `matter.config.ts` (`matterSlug`), not the display name: the script strips every character outside `[a-z0-9-]` and builds bucket, secret, and service names from what is left, and `pnpm matter:check` refuses buckets that do not match `matterConfig`. `--admin-email` is required (there is no derived default); `DATABASE_URL_MIGRATIONS` must be set in the deployer's shell for `--phase=database`.

This automated deployment:
1. Enables `vector` and `pg_trgm` extensions on the Supabase project.
2. Applies all database migrations in `packages/db/migrations/` (0001–0021 today) with strict preflight verification.
3. Provisions the 3 dedicated GCS buckets with Object Versioning enabled.
4. Generates cryptographic credentials and creates the Secret Manager secrets listed at the top of this guide (the `JWT_SECRET` is generated once and reused on re-runs).
5. Scopes an isolated service account with granular `objectUser` and `secretAccessor` permissions.
6. Configures IAM Credentials API and `roles/iam.serviceAccountTokenCreator` bindings for keyless V4 signed URLs.
7. Emits the matter-scoped `.env.<matter>` file with unprivileged runtime credentials.

### Step 3.0 — Ingest workers: two Cloud Run jobs (BIGDATA-4)

For a large matter, the ingest runs as Cloud Run **job tasks** in the matter's own project, sharing
one run's queue (a table in the matter's own database; there is no Redis and no shared service
between matters). Define the two jobs once the service phase has built and pushed the image:

```bash
pnpm tsx scripts/deploy-matter.ts --matter meridian --project-ref <SUPABASE_PROJECT_REF> --phase=workers --dry-run    # prints both commands, runs nothing
pnpm tsx scripts/deploy-matter.ts --matter meridian --project-ref <SUPABASE_PROJECT_REF> --phase=workers [--workers 16]
```

- `casefile-<matter>-ingest-enqueue`: one task, triage and queue a prefix of the matter's sources bucket (`--enqueue-only`); it prints the run id.
- `casefile-<matter>-ingest-workers`: `--workers` tasks (default `matterConfig.ingestWorkers`, 8), each one worker of the run given by `INGEST_RUN_ID` at execution.

Both run as the matter's own service account (whose IAM bindings reach only this matter's buckets
and secrets), with `DATABASE_URL` from the matter's own secret, and the sources bucket mounted
read-only at `/mnt/sources` (a PST is read in place by every part's task). Each task uses up to 4
database connections: keep `--workers` × 4 under the Supabase pooler's limit. How to start, watch,
stop and resume a run: `docs/RUNBOOK-INGEST.md` section 4e.

### Step 3.1 — Keyless V4 Signed URL Permissions (IAM Credentials API)

Casefile uses keyless V4 signed URLs via Google Cloud IAM Credentials API (`iamcredentials.googleapis.com`) without storing static private key JSON files on disk:

1. Enable the IAM Credentials API:
   ```bash
   gcloud services enable iamcredentials.googleapis.com --project=<GCP_PROJECT_ID>
   ```

2. Grant `roles/iam.serviceAccountTokenCreator` to the service account on ITSELF (enables Cloud Run to sign URLs via Compute metadata identity):
   ```bash
   gcloud iam service-accounts add-iam-policy-binding casefile-<MATTER_SLUG>-sa@<GCP_PROJECT_ID>.iam.gserviceaccount.com \
     --member="serviceAccount:casefile-<MATTER_SLUG>-sa@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator" \
     --project=<GCP_PROJECT_ID>
   ```

3. Grant `roles/iam.serviceAccountTokenCreator` to the developer/operator account (enables local tests and scripts to sign URLs via ADC impersonation):
   ```bash
   gcloud iam service-accounts add-iam-policy-binding casefile-<MATTER_SLUG>-sa@<GCP_PROJECT_ID>.iam.gserviceaccount.com \
     --member="user:<OPERATOR_EMAIL>" \
     --role="roles/iam.serviceAccountTokenCreator" \
     --project=<GCP_PROJECT_ID>
   ```

---

## 4. Bootstrapping & Ingestion

### Step 4.1 — Bootstrap the Tenant Context

Create the organization, workspace, primary investigation, and lead administrator:

```bash
pnpm ingest:bootstrap --name "Meridian Insolvency" --email <ADMIN_LOGIN_EMAIL> --investigation "Primary Investigation" --matter meridian
```

`--email` is required and has no default. `JWT_SECRET` must already be set in your `.env` (the matter's Secret Manager value) because bootstrap signs the operator token locally; it refuses to run without it. Bootstrap records `MATTER_TENANT_ID`, `MATTER_WORKSPACE_ID`, `MATTER_ADMIN_USER_ID`, `MATTER_INVESTIGATION_ID`, `MATTER_ADMIN_EMAIL` and the randomly generated `MATTER_ADMIN_PASSWORD` in `.env.<matter>` (gitignored); copy the identifiers into your `.env`. Re-running with the same `--matter` and `--email` re-attaches to the recorded tenant instead of creating a second one. (`deploy-matter.ts --phase=database` runs this step for you; use it directly only when bootstrapping by hand.)

### Step 4.2 — Ingest Evidence Documents

Ingest raw documents (PDF, TXT, OCR scans, spreadsheets):

```bash
pnpm ingest --dir /path/to/evidence/files --investigation <MATTER_INVESTIGATION_ID>
```

Add `--workers N` to have N worker processes on this machine share the run's queue (the same copies are kept whatever N is; `docs/RUNBOOK-INGEST.md` section 4e). The tenant is taken from `MATTER_TENANT_ID` in `.env` only; there is no `--tenant` flag and passing one aborts. To ingest from the matter's own bucket instead of a local folder use `pnpm ingest --bucket <bucket> --investigation <id>`; `--bucket` must be one of `matterConfig.buckets` (or a bucket deliberately listed in `matterConfig.ingestBuckets`) or the run aborts. See `docs/RUNBOOK-INGEST.md`.

### Step 4.3 — Check Status & Audit Integrity

Verify that sources are processed and the cryptographic audit chain is intact:

```bash
pnpm ingest:status --investigation <MATTER_INVESTIGATION_ID>
```

---

## 5. Connecting Claude (sign-in)

`/mcp` requires each person to sign in with their own Casefile account (OAuth, D69 and D73):
password plus a 6-digit authenticator code. There is no shared token and no header to paste.
A matter deployed before sign-in (it uses `MCP_TOKEN`) is upgraded with
[docs/UPGRADE-LIVE-MATTER.md](docs/UPGRADE-LIVE-MATTER.md).

### Step 5.1 — Give each person an account and a setup link

`pnpm matter:preflight --env .env.<matter>` lists every account of the matter, its role on the
matter's investigation, whether TOTP is enrolled, and whether it can use Claude. Roles that may
use Claude: `ws_admin`, lead investigator, investigator, analyst, reviewer, contributor; `viewer`,
`auditor` and `org_admin` cannot (docs/PLAN-MCP-AUTH.md section 3).

To add a colleague (D87):

```bash
pnpm admin:add-user --env .env.<matter> --email <their email> --name "<their name>" --role <role>
```

It creates the account with no password and no TOTP, makes it a member of the workspace that
holds the matter's investigation with `<role>` (a role of the policy matrix: `org_admin`,
`ws_admin`, `lead_inv`, `investigator`, `analyst`, `reviewer`, `contributor`, `viewer`,
`auditor`; anything else is refused), records it in the audit log, and prints the person's
one-time setup link. An email that already has an account on the matter is refused. For someone
who already has an account:

```bash
pnpm admin:reset-link --env .env.<matter> --email <their email>
```

The printed link opens `/account/setup`, where they set a password and enrol TOTP: the page
shows the authenticator secret to type into the app and an `otpauth://` link to open on the
phone (there is no QR code). It works once, for 60 minutes. This link is the only way to enrol
TOTP (D71).

### Step 5.2 — Add the connector in Claude

The connector URL is `MCP_PUBLIC_URL` exactly: the Cloud Run URL followed by `/mcp`
(`scripts/deploy-matter.ts` prints it). In Claude: **Settings** → **Connectors** → **Add custom
connector**, paste the URL, **Add**, **Connect**. On the Casefile page: email and password, the
6-digit code, then **Allow**. Claude asks again on every new connection (plan answer 7).

`scripts/deploy-matter.ts` prints the same connector as JSON for Claude Desktop's configuration
file (`pnpm tsx scripts/build-mcp-config.ts` prints it too):

```json
{
  "mcpServers": {
    "casefile-meridian": {
      "type": "http",
      "url": "https://<service-url>/mcp"
    }
  }
}
```

If Casefile answers **This app is not allowed to sign in here**, the Claude app's client ID is
not trusted yet: `docs/UPGRADE-LIVE-MATTER.md` step 8 shows how to find it in the Cloud Run log
and add it to `MCP_OAUTH_TRUSTED_CLIENTS`.

#### Optional Configuration: Local stdio (Development)

For local development running against the local TypeScript CLI. It runs as the real user
`MCP_LOCAL_USER_ID` and refuses to start unless that user may use MCP on the matter (D77):

```json
{
  "mcpServers": {
    "casefile-meridian": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "/absolute/path/to/casefile/packages/mcp/src/cli.ts"
      ],
      "env": {
        "DATABASE_URL": "postgresql://casefile_app.<REF>:<PASS>@aws-0-<SUPABASE_REGION>.pooler.supabase.com:5432/postgres",
        "MATTER_TENANT_ID": "<TENANT_UUID>",
        "MATTER_INVESTIGATION_ID": "<INVESTIGATION_UUID>",
        "MCP_LOCAL_USER_ID": "<YOUR_CASEFILE_USER_ID>"
      }
    }
  }
}
```

The tools Claude shows depend on the signed-in person's role: all 9 for `ws_admin` and lead
investigators, all but `get_download_link` (8) for the other roles that may use Claude.
Every tool sees only the matter's investigation (`MATTER_INVESTIGATION_ID`, D79 and D82):

1. `matter_status`: Operational metadata, source counts, vector availability (`false`), and uncomputed search signals.
2. `list_investigations`: Lists the matter's investigation (only that one).
3. `get_investigation`: Retrieves metadata and status for the matter's investigation.
4. `list_documents`: Lists all ingested source documents for the investigation.
5. `get_source`: Source document metadata, content document structure, and content blocks.
6. `get_document_page`: Exact page text with bounding-box coordinate locators for a document page.
7. `get_download_link`: Time-limited signed Google Cloud Storage download link for a source document.
8. `get_evidence`: Verified evidence record with cited text span, cryptographic span hash, locator, and verification status.
9. `search`: Lexical keyword search with fuzzy OCR matching and entity alias expansion across investigation chunks.

---

## 6. Verification & Standing Rules

Always run full repository verification before and after changes:

```bash
pnpm verify
```

- **Zero Drop/Truncate Rule**: Never run `DROP TABLE`, `TRUNCATE`, or `DISABLE TRIGGER` on any database.
- **Tenancy (Invariant I7)**: Tenant scoping is set with `SET LOCAL` inside transactions only.
- **Ranking Honesty (Decision D60)**: Ranking is computed strictly from real row data (`lexical_match` + `source_quality`). No fabricated constant scores are ever reported.
