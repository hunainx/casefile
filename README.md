# Casefile

Casefile is an investigation system for due-diligence, fraud and litigation work. It takes in a case's documents,
keeps the originals untouched, turns their text into searchable, citable passages, and lets Claude read the case
through an MCP connection, with every answer pointing back to the document and the page it came from. It never
decides on its own that something is true.

Each case ("matter") runs on its own: its own database, its own storage buckets, its own cloud project. Nothing
is shared between cases.

This README was checked against the code on 2026-09-30. What is not built yet is listed plainly in
[docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md); read that before relying on anything.

---

## What it does today

**Ingestion.** `pnpm ingest` reads a folder or a Cloud Storage bucket:

- **Formats.** PDF (with a text layer), Word (`.docx`, `.doc`), Excel (`.xlsx`, `.xls`, `.csv`), email (`.eml`,
  `.msg`), HTML, RTF, text and Markdown, zip archives (recursively), and PST, OST and MBOX mailboxes, read message
  by message.
- **Nothing silently dropped.** Every file becomes a source with its SHA-256, or a recorded, listed decision: junk
  files, exact duplicates, near-duplicates, the case owner's filters, and files that cannot be read (a damaged file, a mailbox with high encryption).
  Formats without a parser are stored and listed as `stored_unparsed`.
- **Many workers.** A run is split into a work queue in the case's database and read by any number of worker
  processes, which can be stopped and resumed without missing or doubling anything. Measured locally: 10 GB in
  about 29 minutes with 8 workers.
- **Status and reports.** `pnpm ingest:status` shows progress while a run goes. `pnpm ingest:report` lists
  everything that was set aside and why. `pnpm ingest:include` brings a skipped file back.

**An audit log that verifies.** Every action is written to a hash-chained, append-only log. The database refuses
the application any change to it, and a verifier detects any edited, deleted or reordered event.

**Tenant isolation in the database.** Row-level security is enabled and forced on every tenant table. The
application's role cannot bypass it.

**Claude as the interface (MCP).** Nine read-only tools: `matter_status`, `list_investigations`,
`get_investigation`, `list_documents`, `get_source`, `get_document_page`, `get_download_link`, `get_evidence`,
`search`. Each person signs in with their own account (OAuth, password and an authenticator code). A no-login mode
exists for local development only and refuses to start anywhere else. There is no web UI; that is by design.

**Accounts and access.** Registration, rotating sessions, TOTP step-up, passkeys, ethical walls (per person, per
investigation), break-glass access with dual approval, and one deny-by-default permission engine.

**Search** is lexical (words, phrases, fuzzy matching). There is no semantic or vector search yet.

## What it does not do yet (short version)

- **No OCR.** A scanned PDF is stored and marked `needs_ocr`; nothing reads its text.
- **No AI analysis endpoint.** It answers 501.
- **Search is not ready for very large cases.**
- **The cloud workers are written but have never been deployed.**

The full list, with every open item: [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

---

## Run it locally, with fake data

You need Node.js 22+, pnpm 10+ and Docker. Everything below runs on your own machine: a local Postgres, a local
imitation of Cloud Storage (fake-gcs), and generated fake documents. No cloud account is needed.

```bash
pnpm install
docker compose -f infra/compose.yml up -d
```

Create the two local databases' tables (the app's, and the tests'):

```bash
DATABASE_URL_MIGRATIONS=postgres://casefile:casefile@127.0.0.1:55432/casefile pnpm exec tsx packages/db/migrate/index.ts --project-ref local
DATABASE_URL_MIGRATIONS=postgres://casefile:casefile@127.0.0.1:55432/casefile_test pnpm exec tsx packages/db/migrate/index.ts --project-ref local
```

Run every check (lint, types, unit, integration, guardrails, and the two traceability reports):

```bash
pnpm verify
```

To ingest fake documents yourself:

1. Copy the local settings:

   ```bash
   cp .env.local.example .env
   ```

   In `.env`, set `STORAGE_DRIVER=gcs` and add `STORAGE_EMULATOR_HOST=http://127.0.0.1:4443`, so files go to the
   local fake-gcs instead of memory.

2. Create a local matter. This writes its IDs to `.env.demo`; copy `MATTER_TENANT_ID` and
   `MATTER_INVESTIGATION_ID` from there into `.env`.

   ```bash
   pnpm ingest:bootstrap --name "Demo Matter" --email you@example.com --investigation "Demo case" --matter demo
   ```

3. Generate 100 MB of fake documents outside the repository, with the same seed every time:

   ```bash
   pnpm fake-corpus --size 100MB --seed 42 --out ../casefile-fake-data/100MB-42
   ```

4. Ingest them with 2 workers, then look at the result:

   ```bash
   pnpm ingest --dir ../casefile-fake-data/100MB-42/corpus --workers 2
   pnpm ingest:status --investigation <MATTER_INVESTIGATION_ID>
   pnpm ingest:report --run <run id printed by pnpm ingest>
   ```

These are the commands the test suite and the measurements use. The whole sequence above was not re-run from a
clean clone for this README. If a step fails, please open an issue.

---

## Documentation

| For | Read |
|---|---|
| What is not built, every open item | [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) |
| Setting up a real case (its own cloud project, database, buckets) | [MATTER-SETUP.md](MATTER-SETUP.md), [START-HERE.md](START-HERE.md) |
| Ingesting documents: start, watch, stop, resume, retry | [docs/RUNBOOK-INGEST.md](docs/RUNBOOK-INGEST.md) |
| Getting 1-5 TB into a case's bucket | [docs/BIG-UPLOADS.md](docs/BIG-UPLOADS.md) |
| Upgrading an existing case | [docs/UPGRADE-LIVE-MATTER.md](docs/UPGRADE-LIVE-MATTER.md) |
| How big cases are handled, with the measurements | [docs/PLAN-BIG-DATA.md](docs/PLAN-BIG-DATA.md) |
| Why things are the way they are | [docs/DECISIONS.md](docs/DECISIONS.md), [docs/DEVIATIONS.md](docs/DEVIATIONS.md) |
| MCP sign-in design | [docs/PLAN-MCP-AUTH.md](docs/PLAN-MCP-AUTH.md) |
| Supabase and Cloud Storage pitfalls | [docs/PLATFORM.md](docs/PLATFORM.md) |
| The original specification (written before the code) | [docs/PRD.md](docs/PRD.md) |
| Reporting a security problem | [SECURITY.md](SECURITY.md) |
| Third-party code and its licences | [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| The steps to publish this repository | [docs/GO-PUBLIC.md](docs/GO-PUBLIC.md) |

## Layout

- `apps/api`: the service (REST and `/mcp`), where most logic lives.
- `packages/`: `db` (migrations, tenant transactions), `audit`, `policy`, `contracts`, `storage`, `mcp`,
  `mock-provider`.
- `tools/ingest-cli`: ingestion, workers, status, reports.
- `tools/fake-corpus`: the fake data generator.
- `guardrails/`: invariant tests that run in `pnpm verify`.
- `traceability/`: requirements and coverage reports.
- `test-corpus/`: small fake fixtures, all generated (see its `SOURCES.md`).
- `apps/workers`, `apps/web`, `packages/ai-gateway`, `assertions`, `epistemics`, `retrieval`, `ui`: empty
  placeholders.

## Licence

Copyright: see [`LICENSE`](LICENSE).

Casefile is free software under the **GNU Affero General Public License v3.0** (AGPL-3.0); the full text is in
[`LICENSE`](LICENSE). If you run a modified version as a network service, you must offer its users the
corresponding source code. Third-party components keep their own licences:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
