# Casefile Matter Quickstart

Welcome to Casefile. This template provisions and runs an isolated, verifiable investigative workspace with cryptographic audit logging and AI-assisted analysis.

---

### 1. Prerequisites (What You Need Installed)

Before starting, make sure you have:
- **Node.js 22+**: [nodejs.org](https://nodejs.org) (`node -v` must report v22 or higher).
- **pnpm**: Fast package manager (`npm install -g pnpm`). *On Windows PowerShell, use `pnpm.cmd`.*
- **Docker Desktop**: Required for local Postgres, Redis, and storage services. Start Docker Desktop before running tests or local ingestion.

---

### 2. Install Dependencies

From the repository root, install all monorepo workspace dependencies:

```bash
pnpm install
```

---

### 3. Create Your Matter (`pnpm new-matter`)

Run the matter initialization wizard to generate your configuration and environment files:

```bash
pnpm new-matter
```

The wizard prompts for exactly five parameters:
1. **Matter name**: The display name of the matter (e.g. `Acme Corp Dispute`). The slug is automatically derived from this.
2. **GCP project ID**: The Google Cloud project ID (e.g. `gcp-acme-dispute-prod`).
3. **GCP region**: The Google Cloud region for infrastructure (e.g. `europe-west2`).
4. **Supabase project ref**: The 20-character Supabase project reference (e.g. `acmeprodref12345678`).
5. **Supabase region**: The Supabase cloud region (e.g. `eu-west-2`).

*Tip: Add `--dry-run` to preview the generated files and commands without writing anything to disk (`pnpm new-matter --dry-run`).*

---

### 4. Ingest Evidence Documents

Ingest a folder containing evidentiary documents (PDFs, Word documents, spreadsheets, emails, text files, or zip archives):

```bash
pnpm ingest --dir=/path/to/evidence-folder
```

Casefile parses supported text layers, computes SHA-256 hashes, stores unparsed formats safely, and records every admission in the append-only cryptographic audit chain.

---

### 5. Connect Claude (MCP Server, with sign-in)

Each person connects Claude with their **own Casefile account**: email, password and a 6-digit
code from an authenticator app. There is no shared token.

1. **An account for each person.** They need an account on the matter with a role that may use
   Claude (`ws_admin`, `lead_inv`, `investigator`, `analyst`, `reviewer`, `contributor`; not
   `viewer`, `auditor` or `org_admin`). Add a colleague and print their one-time setup link in
   one command:
   ```bash
   pnpm admin:add-user --env <matter env file> --email <their email> --name "<their name>" --role investigator
   ```
   Someone who already has an account (for example the admin made at setup) gets a new link with:
   ```bash
   pnpm admin:reset-link --env <matter env file> --email <their email>
   ```
   The link opens a page where they choose a password and add Casefile to their authenticator
   app: the page shows the secret to type in and an `otpauth://` link to open on the phone (no
   QR code). It works once, for 60 minutes. `pnpm matter:preflight --env <matter env file>`
   lists every account and whether it can use Claude.
2. **The matter's URL.** It is `MCP_PUBLIC_URL`: the deployed Cloud Run URL followed by `/mcp`.
3. **In Claude:** **Settings** → **Connectors** → **Add custom connector**. Paste the URL. Leave
   everything else empty. Click **Add**, then **Connect**.
4. **Sign in on the Casefile page:** email and password, then the 6-digit code, then **Allow**.
5. The tools appear: 9 for a workspace admin or lead investigator, 8 for other roles (no download link).

A matter deployed before sign-in existed (it uses a shared `MCP_TOKEN`) must be upgraded first:
follow [docs/UPGRADE-LIVE-MATTER.md](docs/UPGRADE-LIVE-MATTER.md), step by step.

For development on your own machine only, `/mcp` also has a no-login mode that works only on
`127.0.0.1` (`MCP_AUTH_MODE=local-no-login`, see `docs/PLAN-MCP-AUTH.md` section 5).

---

### 6. What to Do if Something Fails

Casefile enforces strict end-to-end verification. If a command fails:

1. **Verify local Docker containers are running**:
   ```bash
   docker compose -f infra/compose.yml up -d
   ```
2. **Run the 7-stage verification pipeline**:
   ```bash
   pnpm verify
   ```
   This executes all checks in order:
   `lint` → `typecheck` → `test:unit` → `test:integration` → `guardrails` → `audit:verification` → `trace:report`.
   If a stage fails, look at the error output for that specific stage. Every guardrail failure explains the exact invariant violated and how to resolve it.
