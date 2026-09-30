# Casefile Operator Runbook: Matter Ingestion & Preflight Operations (`RUNBOOK-INGEST.md`)

This runbook guides matter operators through ingesting evidence documents into the Casefile platform using the Ingestion CLI tools.

> [!IMPORTANT]
> **Operator Security Boundary**: Operators connect to Supabase using the unprivileged `casefile_app` role via session pooler port 5432. Operators **NEVER** receive or use `DATABASE_URL_MIGRATIONS`.
> *Owner access destroyed a production database once already; ingestion does not need it and an operator must not have it.*

---

## 1. Prerequisites & Environment Setup

Ensure the following tools are installed on your machine:
- **Node.js**: v22.x or later (`node -v`)
- **pnpm**: v9.x or later (`pnpm -v`)
- **Google Cloud SDK**: (`gcloud version`)

### 1.1 Repository Setup
```bash
git clone <repo-url> casefile
cd casefile
pnpm install
```

### 1.2 Google Cloud Authentication (Keyless Workflow)
Authenticate your user credentials for Application Default Credentials (ADC):
```bash
gcloud auth application-default login
```

Grant your Google user account the `roles/iam.serviceAccountTokenCreator` role on the matter's runtime service account:
```bash
gcloud iam service-accounts add-iam-policy-binding casefile-<matter>-sa@<gcp-project-id>.iam.gserviceaccount.com \
  --member="user:your-email@example.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=<gcp-project-id>
```
*(This allows local keyless generation of V4 signed download URLs without downloading service account key files).*

---

## 2. Environment Configuration (`.env`)

You will receive a `.env` file from the matter deployer (or create one from `.env.matter.example`). Place it in the root directory of the repository (`casefile/.env`).

### Variables in Operator `.env`
```ini
# Runtime Application Database (casefile_app role only)
DATABASE_URL=postgresql://casefile_app.<project-ref>:<password>@aws-0-<SUPABASE_REGION>.pooler.supabase.com:5432/postgres
SUPABASE_PROJECT_REF=<project-ref>

# Storage Configuration (Keyless GCS)
GCP_PROJECT_ID=<gcp-project-id>
GCS_SERVICE_ACCOUNT_EMAIL=casefile-<matter>-sa@<gcp-project-id>.iam.gserviceaccount.com
GCS_BUCKET_SOURCES=casefile-<matter>-sources
GCS_BUCKET_ARTIFACTS=casefile-<matter>-artifacts
GCS_BUCKET_EXPORTS=casefile-<matter>-exports
STORAGE_DRIVER=gcs

# Matter & Investigation Identifiers
MATTER_TENANT_ID=<tenant-uuid>
MATTER_WORKSPACE_ID=<workspace-uuid>
MATTER_INVESTIGATION_ID=<investigation-uuid>
MATTER_ADMIN_USER_ID=<admin-user-uuid>
```

> [!CAUTION]
> **No Migration Credentials**: Confirm that `DATABASE_URL_MIGRATIONS` is **absent** from your `.env`. Ingestion operates entirely under Row-Level Security (RLS) and does not need DDL or migration rights.

---

## 3. Preflight Health Verification

Always run the preflight verification check before starting ingestion:
```bash
pnpm matter:check
```

### Clean Run Example
```text
================================================================================
CASEFILE PREFLIGHT CHECK: <MATTER_NAME> (<matter>)
Target Environment: /path/to/casefile/.env
================================================================================

✓ All preflight checks PASSED:
  • All required .env variables defined without placeholders
  • Supabase project ref matches matterConfig.supabaseProjectRef on all connections
  • Zero refused foreign project refs in the environment file
  • Session pooler (port 5432) verified for runtime application
  • Cloud Run runtime service isolated from owner migration credentials
  • Every GCS_BUCKET_* value is bound to this matter's matter.config.ts (buckets / ingestBuckets)
  • Storage buckets exist and are readable with current credentials

Region Topology Report:
  Supabase Database Region: <SUPABASE_REGION> (<CONTINENT>)
  GCS Bucket gs://casefile-<matter>-sources: <REGION> (<CONTINENT>)
```

---

## 4. Ingestion Execution

Source documents are **already stored in the matter GCS bucket**. The ingestion CLI downloads and parses each document in memory, records its existing storage path as `storage_uri` (Option A), and **never re-uploads or copies the source bytes**: the parsed file's artifact points at the source object itself (D95). The text is stored once, in the content blocks (D94).

### Supported Ingestion Formats
- **Plain Text (`.txt`, `.md`)** & **HTML (`.html`, `.htm`)**: Extracted into clean text blocks.
- **Word Documents (`.docx`, `.doc`)**: Structured text extracted via pure-JS parsers.
- **Spreadsheets (`.xlsx`, `.xls`)**: Tabular data extracted per sheet with row coordinates.
- **Rich Text (`.rtf`)**: Formatted RTF parsed into plain text blocks.
- **Emails (`.eml`, `.msg`)**: Parsed with RFC822 headers (Bcc too when the message carries it), message body, and child attachment sources; an attachment without a file name is kept as `attachment_<n>.<ext>` (D116).
- **Mailboxes (`.pst`, `.ost`, `.mbox`, `.mbx`, and in a folder a file with no extension that starts like an mbox)**: stored whole and read message by message; every message is its own source under the mailbox (section 4d).
- **Archives (`.zip`)**: Decompressed in-memory with zip-bomb size/depth guards, ingesting each member.
- **PDF Documents (`.pdf`)**: Text-layer extraction with page coordinates. Scanned PDFs yielding 0 characters are marked `needs_ocr`.
- **Unsupported Formats**: Preserved and admitted as `stored_unparsed` (PRD §10.2).
- **Empty files**: set aside by triage as junk (`skip-junk`, "empty file (0 bytes)"), listed and audited, not stored (D99, which replaced D91's `stored_unparsed`). Re-including one (section 4c) admits it as `stored_unparsed`.
- **Files above 256 MiB**: hashed and stored by streaming, never read whole, and admitted as `stored_unparsed` with the reason "too large to parse in this version" (D93). A mailbox is the exception: it is read message by message whatever its size (section 4d).

### Nothing is silently left out (D90)
- `--dir` walks every file, including dotfiles (`.DS_Store`), hidden folders and `node_modules` folders.
- A symbolic link or junction is not followed; it, anything that is not a regular file, a folder that cannot be read, a pipeline sidecar, junk and a duplicate are listed as `skipped` with the reason. A file that fails is listed as `FAILED` with the reason.
- Every skipped file is a decision of the run (section 4a) and has a `source.skip` audit row; every failed file has a `source.ingest_failed` audit row. The CLI summary counts them by reason, and `pnpm ingest:report --run <id>` lists them (section 4b).

### Ingesting from Bucket
```bash
pnpm ingest --bucket <bucket-name> --investigation <investigation-id>
```

`<bucket-name>` must be one of this matter's buckets from `matter.config.ts` (normally `GCS_BUCKET_SOURCES`) or a bucket deliberately listed in `matterConfig.ingestBuckets`; any other bucket aborts before anything is read. The tenant comes from `MATTER_TENANT_ID` in `.env` only — there is no `--tenant` flag, and passing one aborts. If the matter service account is refused on the bucket, the run fails naming the identity and the bucket; there is no fallback to your own credentials.

To ingest a specific sub-folder/prefix:
```bash
pnpm ingest --bucket <bucket-name> --prefix "<subfolder-path>" --investigation <investigation-id>
```

### Console Output Example
```text
================================================================================
Ingesting documents from GCS Bucket: gs://casefile-<matter>-sources
Investigation ID:                    <INVESTIGATION_ID>
────────────────────────────────────────────────────────────────────────────────
contract_sample.txt                      47 B  sha256:7050a64ccc36  status: indexed (parsed)
financial_filing.pdf                    965 B  sha256:148675874b9c  status: indexed (parsed)
scanned_receipt.pdf                  52,480 B  sha256:3a1b4c9e8f01  status: needs_ocr (0 text layer)
archive.zip                         104,200 B  sha256:a1b2c3d4e5f6  status: indexed (3 members extracted)
records.bin                           2,048 B  sha256:4d8a1c9e3b2f  status: stored_unparsed (unsupported format)
────────────────────────────────────────────────────────────────────────────────
Ingestion Summary:
  Total files found:  5
  Admitted:           5
  Indexed (Parsed):   3
  Needs OCR:          1
  Stored-unparsed:    1
  Skipped/Existing:   0
  Failed:             0
────────────────────────────────────────────────────────────────────────────────
```

---

## 4a. Triage: what is set aside before parsing (BIGDATA-3)

Every `pnpm ingest` run starts with **triage**: before anything is parsed, each file (or bucket object) gets one decision, and the decisions are written to the matter's database under a **run** (`ingest_runs`, one row; `ingest_decisions`, one row per object). The run's id is printed at the end of the ingest (`Run:` in the summary). **Nothing is deleted, moved, copied or overwritten** — not in a bucket, not on disk. A set-aside object is only *not ingested*, and it is listed, audited (`source.skip`), and can be brought back (section 4c).

| Decision | Rule | What it catches |
|---|---|---|
| `skip-junk` | `junk-name` | these file names, in any case: `Thumbs.db`, `.DS_Store`, `desktop.ini`, `~$*` (Office owner/lock files), `~*.tmp` (Office and Windows temp files such as `~WRL0001.tmp`, `~WRD0042.tmp`, `~DF1A2B.tmp`), `.~lock.*#` (LibreOffice lock files). Nothing else: `notes.tmp` or `Thumbs.db.txt` is ingested. |
| `skip-junk` | `junk-empty` | every 0-byte file |
| `skip-duplicate` | `exact-duplicate` | a file with exactly the same bytes (SHA-256) as a file already in this investigation, or as an earlier file of the same run (the first in path order is kept). Only files that share a size are hashed; in a bucket, only objects that share size **and** CRC32C are downloaded to hash them. A copy of a file that is only in *another* investigation is not skipped: it is linked, as before. |
| `skip-filter` | `email-date`, `file-date`, `person`, `exclude-person` | the case owner's filters for this run (below) |
| `skip-filter` | `pipeline-sidecar`, `not-a-file` | pipeline sidecars (`results/...`, unless `--include-sidecars`), and links, junctions and special files (never followed) |
| `ingest` | — | everything else |

Items inside a zip or an email are judged by the same junk, duplicate and email filters when the ingest reaches them (stage `ingest` in the report).

**Near-duplicates are not set aside.** After parsing, a document whose text is at least 0.9 similar to an earlier one (MinHash of 5-word shingles) is **indexed as usual** and linked to the first document of its group (`document_fingerprints`). The report counts them. Scanned PDFs have no text until OCR, so they are not compared yet.

### Filters (chosen by the case owner, per run; default: none)

```bash
pnpm ingest --dir <folder> --investigation <id> --email-date-from 2020-01-01 --email-date-to 2022-12-31
pnpm ingest --dir <folder> --investigation <id> --person "nyra@delta.example" --person "Arlo Venn"
pnpm ingest --bucket <bucket> --investigation <id> --exclude-person "newsletter@" --file-date-from 2019-01-01
```

- `--email-date-from` / `--email-date-to`: an email (`.eml`, `.msg`) by its **Date** header. Whole days in UTC, both ends included.
- `--file-date-from` / `--file-date-to`: any other file by its **file date**: its modification time in a folder; in a bucket, the `goog-reserved-file-mtime` metadata the upload tool may have recorded. Whether your upload tool writes it depends on the tool and its options: check one object with `gcloud storage objects describe gs://<bucket>/<object>` before relying on a file-date filter in bucket mode.
- `--person <text>` (repeatable): keep only emails whose From, To, Cc or Bcc contains the text (an address, a name, or a domain; any case).
- `--exclude-person <text>` (repeatable): skip emails whose From, To, Cc or Bcc contains it.
- Bcc is looked at since BIGDATA-4 (rules `person` and `exclude-person` version 2, the owner's answer). A run made before keeps its version-1 decisions (From, To and Cc only); nothing already decided is changed. The report lists each decision's rule version.
- **What a filter cannot judge is kept**, with the reason in the report: an email without a readable Date, a file without a date, headers that cannot be read.
- The filters are recorded on the run and printed at the start (`Filters (case owner, this run):`). A mistyped date stops the run before anything is recorded.

To see what triage would decide without ingesting anything, add `--triage-only`: the run and its decisions are recorded and nothing is parsed or stored (a later ingest triages again as its own run).

## 4b. Reading the report

```bash
pnpm ingest:report --run <run id>
pnpm ingest:report --run <run id> --csv skipped.csv --near-duplicates-csv near-duplicates.csv
```

It prints:
- the run (folder or bucket, when it started, was triaged and finished), **the filters chosen for it**, and the rule versions;
- **Decisions**, one line per stage, decision and rule with the count, for example:
  ```text
    triage   ingest           -                        536
    triage   skip-duplicate   exact-duplicate v1       44
    triage   skip-junk        junk-empty v1            14
    triage   skip-junk        junk-name v1             30
  ```
- **Skipped objects**: how many, and the CSV they were written to (default `ingest-report-<run id>-skipped.csv` in the current folder), how many were re-included later and how many are still skipped;
- the number of **near-duplicates** found and in how many groups (all of them are indexed);
- the run's outcome counters (indexed, needs OCR, stored-unparsed, failed ...).

The CSV has one line per skipped object: `path, byte_size, decision, rule, rule_version, reason, duplicate_of_path, duplicate_of_source_id, filter, sha256, stage, decision_id, re_included_by`. `duplicate_of_path` is the file it is a copy of; `filter` is the filter that caught it, with the value it had (for example the email's date); `re_included_by` is filled once someone re-includes it. **Read it before the case team starts reviewing**, and check at least the `skip-filter` lines with the case owner.

Failures are not decisions: a file that could not be read or parsed is still a `source.ingest_failed` audit row and a `FAILED` line in the ingest output, and it is counted under the run's `failed`.

## 4c. Bringing skipped files back (re-include)

```bash
pnpm ingest:include --run <run id> --rule junk-name --dry-run
pnpm ingest:include --run <run id> --path "<path exactly as in the CSV>"
pnpm ingest:include --run <run id> --rule email-date
```

- Give exactly one of `--path` (one object, the path exactly as the report's CSV lists it) or `--rule` (every object that rule skipped in that run).
- **Always run it with `--dry-run` first**: it lists what it would ingest and writes nothing.
- Without `--dry-run`, each object is ingested, and a new decision (`include`, rule `reinclude`) supersedes the skip — the skip itself is never changed, so the report still shows what was decided and who brought it back (`re_included_by`). Every re-include has its own `source.reinclude` audit row.
- A re-included **duplicate** is not stored or indexed a second time: it is recorded as another copy (another acquisition) of the source it duplicates.
- An item inside a zip or an email is read out of its container again. In folder mode the file must still be at the path in the report; if it was moved, the include says so and records nothing for it.
- Filters do not apply to a re-include.

## 4d. Mailboxes: PST, OST and MBOX (BIGDATA-3B)

A mailbox file is stored whole in the bucket (never changed) and then read **message by message**, so a 2 GB mailbox uses no more memory than a small one (D108, D109). Each message, in its own transaction:

- is judged by the owner's email filters (its own Date, From, To, Cc) and by **message identity**: the same message the investigation already holds (Message-ID, Date, From, To, Cc, Bcc, Subject, body and attachments all equal; the Received lines may differ) is set aside as `skip-duplicate`, rule `message-duplicate` (D111). The same message twice in one mailbox, or in two custodians' mailboxes, or in an MBOX and a PST, is caught; a message that only reuses another's Message-ID is not;
- otherwise becomes its own source under the mailbox, named by its subject (`<subject>.eml`), with the mailbox's **folder path** (`Inbox/Projects/...`; an MBOX has none) and its **headers** in its metadata, and is parsed, indexed and near-duplicate grouped like an `.eml`. Its attachments (zips, attached emails, a PST's embedded messages) become its children. A PST message's stored object is an `.eml` **rendering** of the message's properties, marked as such (a PST has no per-message original bytes, D112); an MBOX message's is its own bytes.

**Paths.** A message's path, as the report's CSV lists it and `ingest:include --path` takes it, is
`<mailbox file>#mailbox:<folder>/<folder>/.../<locator>`: the locator is `nid:0x00200024` (a PST or OST node id) or `offset:123456` (the byte where an MBOX message starts). A `/`, `#` or `%` in a folder name is written `%2F`, `%23`, `%25`. An attachment of the message follows as `#attachment:<file name>`. In Claude, `get_source` of a message shows the same under `source.mailbox` (mailbox file, folder path, locator, headers).

**In the ingest output**, after the summary, one block per mailbox (a PST of the fake mailbox set):
```text
  Mailboxes (10), read message by message:
    <fake data folder>/mailboxes-42\corpus\Custodian C\carol - backup copy.pst  [pst, indexed]
      752 messages read: 701 admitted, skipped 51 message-duplicate; 0 unreadable; attachments 850 admitted, 0 skipped, 0 failed; 0 near-duplicates; 69.9 s
```
and **in `pnpm ingest:report --run <id>`**, a `Mailboxes:` section. From a real run of the test corpus's fixture mailboxes (`test-corpus/mailbox.mbox`, `mailbox.pst`, and `mailbox-password.pst` renamed `protected.pst`; the export folder's path is shortened to `<export>`):
```text
Mailboxes: 3 (PST, OST and MBOX files, read message by message)
  <export>\Custodian C\mailbox.mbox
    mbox, indexed
    messages read 6, admitted 5, skipped 1 message-duplicate, unreadable 0
    attachments admitted 4, skipped 0, failed 0; near-duplicates 1; folders not read (search folders) 0
  <export>\Custodian C\mailbox.pst
    pst, indexed
    messages read 6, admitted 4, skipped 2 message-duplicate, unreadable 0
    attachments admitted 2, skipped 0, failed 1; near-duplicates 0; folders not read (search folders) 1
    unreadable: <export>\Custodian C\mailbox.pst#mailbox:Sent Items/nid:0x002000a4#attachment:lease.pdf: attachment not read: attach method 2 (a reference or an OLE object): no file content in the PST
  <export>\Custodian C\protected.pst
    pst, indexed, had a password (read: a PST password is a check, not encryption)
    messages read 1, admitted 0, skipped 1 message-duplicate, unreadable 0
```
Every skipped message is a line of the CSV, with its path and the source it duplicates; re-include it with `pnpm ingest:include --run <id> --path "<the message's path>"` or `--rule message-duplicate` (a re-included copy is its own source when its bytes differ, or another copy of the same source when they are the same, D103, D111).

**A mailbox that cannot be read** is stored whole and listed as `stored_unparsed` with the reason, never dropped (D113):

| Reason (`unparsed_reason`) | What it means | What to do |
|---|---|---|
| `encrypted` | a PST with "high" (cyclic) encryption | export it again from Outlook without encryption |
| `not-a-mailbox` | an `.mbox` that does not start with a "From " line, a `.pst` without the PST signature | check the file; it may be misnamed |
| `corrupt` | a PST that does not open (cut short, damaged at its root) | repair a copy with Outlook's Inbox Repair Tool (SCANPST.EXE) and ingest the repaired copy as well |

**A PST with a password is read** (the owner's answer, BIGDATA-4): the password is only a check Outlook makes, not encryption, so nothing is cracked. The mailbox's source and each of its messages say so (`password_protected`, `mailbox_password_protected`); `get_source` shows `mailbox_file: { had_password: true }` for the file and `mailbox_had_password: true` for a message, and the report says `had a password`. A PST with **high** (cyclic) encryption is never read.

A mailbox that opens but is damaged keeps every message that can be read: each message, folder or attachment that cannot be read is a `source.ingest_failed` audit row with its path and is listed under the mailbox (`unreadable:`), and an MBOX whose file ends inside a message keeps that message marked `truncated`, with a `stopped:` line saying where. A mailbox inside a zip or an email is stored but not read: ingest the mailbox file on its own.

A big mailbox is split into parts that different workers read (section 4e): a PST by folder, 50 messages a part; an MBOX by byte range, 16 MiB a part. If a run stops while it reads a mailbox, `pnpm ingest:resume` takes it up again at the first message not written (DEV-038). A mailbox left in status `processing` by a run made **before** BIGDATA-4 is not taken up by a new run (its bytes are already a source): tell the developer.

**Fake mailboxes for testing** (never real mail): `pnpm fake-corpus --kind mailboxes` (a standard set: three MBOX files including one of several hundred MB, a PST with a folder tree, broken mailboxes), `--kind mbox --size 1GB`, `--kind pst --size 1GB` (Windows only: the PST writer fetches its pinned library into `<fake data folder>/.pst-writer\`, D114). Each writes `fake-mailbox-manifest.csv`, one row per mailbox, message and attachment.

---

## 4e. Many workers: start, watch, stop, resume, retry (BIGDATA-4)

A run is **triage** (every object decided, before anything is parsed) and then a **queue** (one item
per object to ingest, one per part of a big mailbox), a table in the matter's own database. Any
number of **workers** take items from it: on this machine, or as Cloud Run job tasks in the matter's
own project. They keep the same copies whatever their number: the copy that comes first in the
run's reading order is kept (top-level objects in path order; inside an object, the object first,
then its zip entries or attachments in the container's own order; a mailbox's messages in the file's
order), and near-duplicates are grouped in that order too (docs/PLAN-BIG-DATA.md section 16).

**Start** (this machine):
```bash
pnpm ingest --dir <folder> --investigation <id> --workers 8          # triage, the queue, 8 worker processes
pnpm ingest --bucket <bucket> --investigation <id> --workers 8
pnpm ingest --dir <folder> --investigation <id>                      # one worker, in this process (as before)
```
Or build the queue here and start workers elsewhere:
```bash
pnpm ingest --bucket <bucket> --investigation <id> --enqueue-only   # prints the run id
pnpm ingest:worker --run <run id>                                    # one worker; start as many as you like, anywhere that reaches the database and the bucket
```
In the cloud (defined by `scripts/deploy-matter.ts --phase=workers`, see MATTER-SETUP):
```bash
gcloud run jobs execute casefile-<matter>-ingest-enqueue --region <region> --project <project> --args=./node_modules/tsx/dist/cli.mjs,tools/ingest-cli/src/ingest.ts,--bucket,casefile-<matter>-sources,--prefix,<prefix>,--enqueue-only
gcloud run jobs execute casefile-<matter>-ingest-workers --region <region> --project <project> --update-env-vars=INGEST_RUN_ID=<run id>
```
Only one ingest run of an investigation can be open at a time: `pnpm ingest` refuses to start while
another run is queued and not finished, and says which one to resume.

**Watch** (while it goes, from any machine that reaches the database, and after):
```bash
pnpm ingest:status --run <run id>            # once
pnpm ingest:status --run <run id> --watch    # every 10 s, until the run is finished
```
It shows the files and bytes done and left, messages read, the rate over the last 5 minutes, an
estimate of the time left, the failed items with their errors, what each worker is doing (and when
it was last seen), and the kept/skipped counts. In Claude, `matter_status` shows a short
`ingest_run` block (state, done, left, failed) while a run is unfinished or has failed items.

**Stop**: stop the worker processes (Ctrl+C, closing the window, a machine that goes down, or
`gcloud run jobs executions cancel` in the cloud). Nothing needs to be cleaned up: what a worker was
writing when it stopped was not committed, and the item goes back to the queue once its lease runs out.

**Resume**:
```bash
pnpm ingest:resume --run <run id> --workers 8
```
A killed worker's items are taken again once their lease runs out (90 s of the database clock;
`INGEST_LEASE_SECONDS`), from where they stopped: a mailbox part from its first message not written.
Nothing that was written is written again (every write checks, in its own transaction, that the
worker still holds the item, and marks it done in the same transaction). In the cloud, execute the
workers job again with the same `INGEST_RUN_ID`.

**Failed items**: an item that fails is tried 3 times, then it is **failed**, with its error, a
`source.ingest_failed` audit row, and it is listed by `ingest:status` and `ingest:report` (never
dropped). Once the cause is fixed:
```bash
pnpm ingest:retry --run <run id>                    # every failed item back in the queue (or --item <item id>)
pnpm ingest:resume --run <run id> --workers 2
```
A retried item is judged against everything the matter holds at the time of the retry, like a new run.
A worker that is killed three times on the same item (for example out of memory) also fails it.

## 5. Resuming Interrupted Ingestion

If ingestion is interrupted at any time (a worker killed, the laptop sleeps, the terminal is closed,
the network drops, the database restarts): **resume the run**, do not start a new one (a new one is
refused while the run is open):
```bash
pnpm ingest:resume --run <run id> --workers <N>
```
The run id is printed at the start (`Run: <id>`) and listed by `pnpm ingest:report`. Section 4e says
what happens to what was in progress. A run stopped **during triage** (before its queue was complete)
has no queue: start the ingest again; that run's decisions stay listed.

---

## 6. Verification & Status Check

After ingestion completes, verify that all sources, content blocks, chunks, and cryptographic audit chains are healthy:
```bash
pnpm ingest:status --investigation <investigation-id>
```

### Healthy Status Output
```text
================================================================================
CASEFILE INVESTIGATION STATUS
================================================================================
Investigation ID: <INVESTIGATION_ID>
Tenant ID:        <TENANT_ID>
────────────────────────────────────────────────────────────────────────────────
Source Documents:
  Total Sources:        5
  Indexed (Parsed):     3
  Needs OCR:            1
  Stored-Unparsed:      1

Extracted Content:
  Content Documents:    3
  Content Blocks:       18
  Searchable Chunks:    18

Audit Trail Integrity:
  Audit Chain Valid:    YES (Valid cryptographic hash chain)
  Verified Events:      5
  Last Hash:            04f9b2c...

Object Storage Verification:
  Verified in Bucket:   5 / 5 (100% verified)
  Missing from Bucket:  0
================================================================================
```

---

## 7. Escalation & Deployment Handoff

- **If `Missing from Bucket` > 0 or `Audit Chain Valid: NO`**: Do not proceed. Copy the terminal output and escalate to the matter deployer.
- **When Ingestion Status is 100% Green**: Notify the matter deployer.
- **Deployer Step**: The deployer (who has owner credentials and GCP deployment privileges) deploys the Cloud Run service:
  ```bash
  pnpm tsx scripts/deploy-matter.ts --matter <matter-name> --project-ref <project-ref> --phase=service
  ```
  *(Operators do not deploy Cloud Run services).*
