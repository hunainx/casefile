# Known limitations

What Casefile does not do, what was never tested for real, and every deviation that is still open. Plain words,
checked against the code on 2026-09-30. The details of each `DEV-` item are in [DEVIATIONS.md](DEVIATIONS.md);
the measurements are in [PLAN-BIG-DATA.md](PLAN-BIG-DATA.md).

## Not built

- **No OCR at all.** A scanned PDF or an image is stored, hashed and marked `needs_ocr`; nothing reads its text,
  so it is not searchable. Cloud OCR (Google Document AI, in the case's own region) and its spending cap are
  planned and costed (PLAN-BIG-DATA section 4), not built. Tesseract is not built in either: it was only timed by
  hand for the plan (about 0.77 s a page on one core; it misreads some names).
- **No AI analysis.** `POST /v1/investigations/:id/ai/invoke` checks the prompt for injection, then answers 501.
  No real model has been called by Casefile; the AI tests use a scripted mock (DEV-017).
- **No semantic or vector search.** Search is lexical: words, phrases and fuzzy matching (DEV-016).
- **Search is not ready for large cases.** One `search` call reads every text chunk of the investigation from the
  database and matches it in memory. That is fine for a small case and impossible at 1 TB. Also:
  - within one file's hits, the order of results depends on random row IDs (DEV-032);
  - `get_document_page` works only for PDFs; for Word, spreadsheets, HTML, RTF, text and every email it answers
    "Page 1 not found" (DEV-037);
  - under row-level security Postgres cannot use a GIN index for array, full-text (`@@`) or trigram (`%`)
    conditions. The near-duplicate index was changed for this (D119); a full-text index for search at scale will
    need the same care, and its plans must be tested as the application's role, not as the database owner.
  Search at scale is its own track, not started.
- **The cloud workers were never deployed.** The Cloud Run jobs for many ingest workers are defined
  (`scripts/deploy-matter.ts --phase=workers`, D124) and checked by the dry-run guardrail. They have never run in
  Google Cloud, so nothing about them was measured there.
- **The 1 TB and 5 TB times are estimates.** They are worked out from runs on one local PC (10 GB with 1 to 8
  workers, the local Docker stack), not measured on a 1 TB case: 1 TB in about 17-47 hours, 5 TB in 3.5-10 days
  with 8-32 workers, limited by the database. The database also grows to about 0.8 times the corpus, so about 800
  GB per TB. See PLAN-BIG-DATA section 16.
- **No email.** Password reset cannot send an email; an administrator issues the reset link (DEV-020).
- **Two declared secrets are not used.** `encryptionKey` and `auditPepper` exist in `matter.config.ts`, but
  nothing provisions or uses them: there is no field-level encryption and no audit pepper (DEV-018).
- **No groups.** An ethical wall can name one person, for one investigation. A wall naming a group (DEV-024) or
  covering a whole workspace (DEV-036) is refused with a reason, because nothing could apply it.
- **No event backbone and no web UI.** The `outbox` table is not used. `apps/workers`, `apps/web` and
  `packages/ai-gateway`, `assertions`, `epistemics`, `retrieval` and `ui` are empty placeholders. The web UI was
  dropped by design: Claude, over MCP, is the interface (DEV-015).
- **The requirement tracker is mostly unverified.** `pnpm trace:report` lists 1,245 requirements from the
  specification; 1 is marked verified. That number measures how much has been formally checked against the
  specification, not how much works.

## Tested only with fake data, or not at all

- **No real OST file was tested.** OST files go through the same reader as PSTs, and every fake mailbox is a PST
  (DEV-040).
- **Every test and measurement used generated fake data** and the local Docker stack (Postgres, fake-gcs).
  Real Cloud Storage and a managed database were not part of these runs.
- **The fake PST writer and the `.doc` fixture generator run on Windows only.** The PST writer uses a library
  fetched outside the repository (THIRD-PARTY-NOTICES.md); the `.doc` generator drives Microsoft Word.

## Open deviations: known gaps

- **DEV-031 (left over).** Several JSON columns still hold a JSON string instead of a JSON object: assertions,
  entities, investigations, memory, relationships, saved searches, workspace policies, AI gateway calls,
  correlation, evidence locators, sign-in locations and ingestion-job payloads. Their readers parse the string, so
  nothing fails, but SQL cannot query inside them. The ingest's and the audit writer's columns were fixed.
- **DEV-035 (left over).** Files uploaded through the REST API are not fingerprinted for near-duplicates, so they
  are never grouped with ingested files.
- **DEV-041.** Triage (the first pass of a run, before the queue exists) holds the whole run's object list in one
  process's memory. Fine at 10 GB (about 60,000 objects); at 1-5 TB it needs gigabytes and one long pass.
- **DEV-042.** Two attachments of one email with the same file name share one path. Both are kept; the report
  lists them under one path.
- **DEV-043.** When a PST folder's contents table cannot be read, each part of that folder reports it, so the
  same error can appear several times.
- **DEV-044.** A mailbox left half-read by a run made before the work queue existed is not picked up again by a
  new run.

## Open deviations: deliberate choices (not defects)

These differ from the original specification on purpose, and each is explained in DEVIATIONS.md:

- **Infrastructure.** Supabase instead of self-hosted Postgres (DEV-004), Google Cloud Storage instead of
  MinIO/S3 (DEV-005), a native local Postgres when Docker is missing (DEV-001), Python 3.11 accepted for tooling
  (DEV-003).
- **Additions to the specification.** An extra `divergence_notices` table (DEV-002), assertion endpoints
  (DEV-006), and endpoints the specification did not list: registration, sessions, MFA, password reset, sign-in
  history, ethical walls (DEV-008 to DEV-013).
- **Route paths** follow the specification's section 45.2 exactly (DEV-014).
- **MCP instead of a web UI** (DEV-015).

## Other notes

- **`/ready` when the database is down** answers 500, not 503. The 500 is the generic "unexpected error" reply
  with a request ID; the health checks `/healthz` answer 503.
- **No external security review** has been done. See [SECURITY.md](../SECURITY.md) for how to report a problem.
- **Dependency alerts.** On 2026-10-01 all 40 open Dependabot alerts were fixed by updating packages (D135);
  none was dismissed. Two things are not watched automatically and need a person:
  - **The spreadsheet reader (SheetJS `xlsx` 0.20.3) is a file in the repository**, `vendor/xlsx-0.20.3.tgz`,
    because SheetJS no longer publishes to npm. Dependabot and `pnpm audit` cannot see it, so nothing will warn
    when SheetJS fixes a new problem. Check SheetJS's own site (cdn.sheetjs.com) now and then; to update, replace
    the file, point both `file:` entries (root and `apps/api` package.json) at it and run the before/after
    capture.
  - **Five indirect packages are held at one exact version** by `overrides` in `pnpm-workspace.yaml`
    (brace-expansion, fast-uri 3 and 4, ip-address, uuid). They stay at that version even when a later one
    exists, so a future fix in them needs the override raised by hand. uuid is held at 11 although gaxios asks for
    9; gaxios only uses `v4()`, which did not change.

## Resolved in the final step (for the record)

- DEV-036: a workspace-wide ethical wall is refused with 422 and the reason (it failed with a 500).
- DEV-045: `matter_status` lists its status counts in a fixed order.
- DEV-046: a server error no longer sends its own text (a database message, a host) to the caller; the caller
  gets a generic message and the request ID, and the full error goes to the server log.
