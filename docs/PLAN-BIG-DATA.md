# Plan: the big-data engine (ingesting a 1–5 TB case)

**Status:** **approved** by the owner on 2026-09-29, with the answers recorded in section 10.
- BIGDATA-1 (commit `4a9c7a0`): measured, plan written, accepted.
- **BIGDATA-2A: done** — batched writes (D89), F1 (D90), F2 (D91), F6 (D92), F5 in part (D93);
  no schema change. Results in section 1 and section 11.
- **BIGDATA-2B: done** — text stored once (D94, migration 0028), no byte-identical artifact copy
  (D95), bucket reads without the listener warning (D96), search paging stable (D97). Design in
  section 12, results in section 13.
- **BIGDATA-3: done** — triage records a decision per object before parsing (D98, migration 0029),
  junk by the listed names and empty files (D99, replaces D91 for empty files), exact duplicates by
  size / CRC32C / SHA-256 (D100), near-duplicates grouped and indexed (D101), the owner's filters per
  run (D102), `ingest:report` and `ingest:include` (D103). Design and results in section 14.
- **FIXES-1: done** (2026-09-30, outside this plan's numbering): JSON columns hold JSON objects (D104,
  DEV-031 for the columns it named), .doc / HTML / RTF offsets and text stored once (D105, DEV-034),
  no invented near-duplicate pairs (D106, DEV-035), group ethical walls refused and flagged (D107,
  DEV-024). It touches the ingest's writes, so 1 GB was measured again: 433.5 s (BIGDATA-3: 470.4 s),
  database 793 MB (794 MB), the same triage and near-duplicate results
  (`captures/fixes1/measure/`).
- **BIGDATA-3B: done** (2026-09-30) — PST, OST and MBOX mailboxes read message by message: every message its own
  source under the mailbox with its folder path and headers (D108), readers pst-extractor (patched, D109, D110) and
  a streaming MBOX reader, exact duplicates by message identity (D111, migration 0030), PST messages stored as a
  marked `.eml` rendering (D112), unreadable mailboxes stored and listed (D113), fake PSTs from free tools (D114),
  filters per message (D115), unnamed attachments kept (D116). Results in section 15.
- **BIGDATA-4: done** (2026-09-30) — many workers, one queue, resume: the work queue in the matter's database with
  leases, a fence, retries and idempotent writes (D117, migration 0031), the copy first in reading order kept
  whatever the number of workers, decided in order and written in parallel (D118), the near-duplicate index in the
  database (D119), big mailboxes split into parts (D120, DEV-038), the audit chain measured under load and its rows
  written last in one step, hashed and ordered as before (D121), create-only bucket writes (D122), `ingest:status`
  and matter_status (D123), Cloud Run jobs written, not deployed (D124), password PSTs read (D125), Bcc in the person
  filters (D126), the preflight's upgrade list and its guardrail (D127, DEV-039). Measured locally: 10 GB in 5,936 s
  with 1 worker and 1,723 s with 8 (6.2 MB/s), the same copies kept for 1, 2, 4 and 8, memory flat at about 500 MB
  a worker; resume after killed workers and after a killed stack, nothing missed or doubled; estimate 1 TB in 17-47
  hours, limited by the sequencer in the database. Design and results in section 16.
- Next: the search-at-scale track (answer 11), then BIGDATA-5.

**Goal:** one matter's 1–5 TB of evidence gets from the client into the matter's own bucket, and
from the bucket into its database: searchable, with junk and duplicates set aside (never deleted,
always listed), scans read by OCR, progress visible, and a spending cap that stops the job before
it costs more than agreed.

**How to read the numbers.** A number marked **measured** comes from the BIGDATA-1 runs on this
PC (evidence in `captures/bigdata1/`). A number marked **estimate** is worked
out from the measurements and stated assumptions; the assumption is next to it. Prices were read
on the date shown, from the page linked.

---

## 0. What exists today (read this first)

### How today's ingestion works

`pnpm ingest --dir` / `--bucket` (`tools/ingest-cli/src/ingest.ts`) walks the files in name order
and, for each one, in **one process, one file at a time**:
1. reads the **whole file into memory** (`readFileSync`, or a full download in bucket mode) and hashes it;
2. opens **one database transaction per file**;
3. skips it if a file with the same SHA-256 is already in the workspace (exact de-duplication);
4. writes the original to the sources bucket and **the same bytes again** to the artifacts bucket;
5. parses it (PDF text layer, Word, Excel, HTML, RTF, email, zip), recursing into zip entries and
   email attachments inside the same transaction;
6. inserts one row per text block into `content_blocks` and one row per block into `chunks`,
   **each with its own `INSERT`**, then the source, acquisition, instance, artifact and audit rows.

There is **no OCR step**: an image-only PDF is marked `needs_ocr` and stops there. Tesseract is
installed on this PC but no ingestion path calls it.

### The fake corpus

`pnpm fake-corpus --size <100MB|1GB|10GB> --seed 42` (`tools/fake-corpus`) writes an invented
corpus outside the repository (default `~/casefile-fake-data/<size>-<seed>/`). Everything is made
up: syllable-built names, `.example` domains. The same seed gives the same bytes, and a manifest
lists every file with its kind and which file it duplicates.
`guardrails/no-fake-corpus-in-repo.spec.ts` fails if any generated file appears in the
repository. It was shown red with a copied email, a renamed photo and the marker file.

| Corpus (seed 42) | Files (top level) | Inside zips / emails | Generation time | Peak memory |
|---|---|---|---|---|
| 100 MB | 624 | 325 zip entries, 167 attachments | 26.4 s | 342 MB |
| 1 GB | 5,914 | 2,358 zip entries, 1,656 attachments | 241.2 s | 397 MB |
| 10 GB | 59,634 | 21,738 zip entries, 16,475 attachments | 2,481.9 s | 433 MB |

(measured; the flat memory shows it streams). The mix by count is 34% email, 14% text PDF, 8%
scanned PDF, 14% Word, 6% Excel, 3% images, 3% zip, 7% exact duplicates, 3% near-duplicates,
7% junk, 1% corrupt. By bytes, emails (with attachments) are 36%, images 27% and scans 15%.
Scanned pages: the 1 GB corpus has **1,775 scanned pages** in top-level PDFs (3.36 pages each).
With the scans inside zips, that is about **2,500 scanned pages per GB** (estimate; real cases
vary widely, from almost none to most of the case).

### Baseline: today's ingestion on the local Docker stack (measured)

Local Postgres and the fake-gcs storage emulator in Docker, one ingest process, a fresh
`docker compose down -v` stack before each run, `pg_stat_statements` loaded. The harness
(`benchmarks/ingest-baseline/`) runs the unchanged `ingestDirectory()` and times the functions it
calls.

| | 100 MB | 1 GB |
|---|---|---|
| Total time | 197.0 s | **1,714.6 s (28.6 min)** |
| Throughput (top-level files) | 3.14 files/s, 0.51 MB/s | 3.43 files/s, **0.60 MB/s** |
| All files incl. zip entries and attachments | 1,097 (5.57/s) | 9,805 (5.72/s) |
| walk / read / hash | 0.0 / 0.5 / 0.1 s | 0.0 / 4.6 / 0.7 s |
| **store** (object writes) | 40.5 s (20.6%), 206 MB written | **363.3 s (21.2%), 2,064 MB written** |
| parse | 7.5 s (3.8%) | 64.5 s (3.8%) |
| OCR | none (no OCR step) | none |
| **database** (transaction time less store, parse, hash) | 148.3 s (75.3%) | **1,280.8 s (74.7%)** |
| Statements run by Postgres (`pg_stat_statements`, incl. foreign-key checks) | 1,029,181, 13.3 s server time | **9,140,161, 118.8 s server time** |
| Peak memory (RSS) | 478 MB | 541 MB |
| Database size after | 119 MB | **958 MB** |
| `content_blocks` / `chunks` rows | 110,096 / 110,096 | 977,930 / 977,930 |
| CPU profile: time idle (waiting) | 85.7% | **87.2%** |

**Where the time goes:**
- **Database round trips.** The process is idle 87% of the time, waiting. Postgres itself spent
  only 118.8 s executing statements, out of the 1,280.8 s the ingest spent in database work.
  The rest is one network round trip per statement. The two statements that dominate are
  `INSERT INTO content_blocks` and `INSERT INTO chunks`: 977,929 calls each, 96.2 s of the
  118.8 s server time. A prototype outside the repository (section 1) measured **0.62 ms per
  single-row statement** on this PC.
- **Storage.** Every file is written twice (sources and artifacts), and zip entries and
  attachments are written again as their own sources: 2,064 MB written for 1,024 MB read.
- **Parsing is small.** 64.5 s per GB. `parsePdfStructure` (pdf.js through `unpdf`) is the
  largest at 43.7 s for 2,680 PDFs (16.3 ms each).
- **Slowest functions by own CPU time:** `writeBuffer` (socket writes, 36.6 s), the postgres
  driver (`Result`, `build`, `stringifyValue`, 42.6 s together), pdf.js (`transform`,
  `buildTextContentItem`, 31.9 s), then xlsx parsing and `insertDocumentBlocksAndChunks` itself.

**What happened to each kind of file (1 GB, measured):**

| Kind (top level) | Result |
|---|---|
| exact duplicates (414) | 227 skipped as already ingested; 187 were ingested because they sorted before their original (then the original was skipped). **Exact de-duplication works**, file by file |
| near-duplicates (177) | **150 indexed + 19 needs_ocr as new documents**; 8 skipped because they were exact copies of each other. Near-duplicates are not detected |
| junk (414) | 282 skipped as byte-identical junk; 93 stored as `stored_unparsed` (Thumbs.db, desktop.ini, temp and lock files); 1 empty file **indexed** as a document; **38 `.DS_Store` files never seen**: the walk skips names starting with `.` without recording them (see finding F1) |
| scanned PDFs (473) | 458 `needs_ocr`, 15 skipped as duplicates. None read |
| corrupt (59) | 46 `stored_unparsed`, 13 `unprocessable` |
| images (178) | 175 `stored_unparsed` |

Totals (1 GB, all files incl. zip entries and attachments): 7,388 indexed, 964 needs_ocr, 743
stored_unparsed, 13 unprocessable, 697 skipped, 0 failed.

**Straight-line extrapolation of today's code (estimate):** 1,714.6 s per GB means about **20 days
per TB on this PC**, where a round trip costs 0.62 ms. Against Supabase the round trip is longer:
from Cloud Run in the same region, perhaps 1–2 ms (assumption); from an operator's laptop in
another country, 50 ms or more. At 2 ms, the database part alone becomes about 70 minutes per GB,
or **7 weeks per TB**. From a laptop far away it would not finish.

**Caveats:** storage times are against the local emulator, not real GCS; the PC's Windows Time
service is stopped (`w32tm-status.txt`) and the Docker VM clock was 108 s and 100 s ahead of
Windows before the two runs (the timings use Node's monotonic clock, so they are not affected,
but database timestamps are).

### Findings (found in BIGDATA-1; status after BIGDATA-2A in each item)

- **F1. Files are silently dropped.** `collectFiles` skips every file and folder whose name starts
  with `.` and records nothing (38 `.DS_Store` files in the 1 GB run). Evidence that disappears
  without a trace breaks "nothing is silently dropped". Fix in BIGDATA-2: every file found is
  either ingested or listed as skipped, with the reason. **Fixed in 2A (D90):** dotfiles, hidden
  and `node_modules` folders are ingested; links, sidecars, duplicates and failures are listed with
  the reason and recorded as `source.skip` / `source.ingest_failed` audit rows.
- **F2. An empty file is indexed** as a text document with empty text. **Fixed in 2A (D91):**
  admitted and listed as `stored_unparsed`, "empty file", no text rows.
- **F3. Every file is stored twice.** The artifact copy of a native file is byte-identical to
  the source, which doubles storage writes and cost. **Fixed in 2B (D95):** the artifact points at the
  source object; object writes per GB fell from 17,557 to 9,146.
- **F4. Text is stored three times.** It is in `content_documents.full_text`, `content_blocks.text`
  and `chunks.text` (one chunk per block). That is why the database (958 MB) is almost as large
  as the corpus. **Fixed in 2B (D94):** the text is kept only in `content_blocks` (and in
  `full_text` only for .doc, .html and .rtf, DEV-034); see section 13 for what the database still holds.
- **F5. The whole file is held in memory.** A multi-GB file (a PST mailbox, a video) would
  exhaust memory. Zip limits (500 MB uncompressed, 10,000 entries, depth 3) refuse large but
  legitimate archives. **Fixed in part in 2A (D93):** files are hashed and stored by streaming;
  above 256 MiB they are not read whole and are listed as "too large to parse in this version"
  (a fake 2 GiB file: stored whole, peak RSS 270 MB). Parsing large files and the zip limits are
  still open.
- **F6. The REST upload route records an OCR engine it never ran.** `apps/api/src/routes/sources.ts`
  labels artifacts `tesseract-5` / `5.3.0` and sets an OCR confidence of 0.42 when the filename
  contains "scanned" (0.98 otherwise), with no OCR performed. **Fixed in 2A (D92):** no row names
  an OCR engine, version or confidence that never ran (the CLI's blocks no longer say 1.0 either);
  a scanned upload is `needs_ocr`.
- **F7. Search reads every chunk.** The MCP `search` tool (`packages/mcp/src/tools.ts`,
  `handleSearch`) loads every chunk of the investigation into memory for each query and matches
  in JavaScript. At 1 GB that is about 1 million chunks per query; at 1 TB it cannot work. This
  is outside ingestion, but a 1 TB case is not usable until it is fixed (question 11). **Open:
  the search-at-scale track, after BIGDATA-4.** 2A also found that its order is not defined
  (DEV-032).
- **F8. PST and MBOX are not parsed.** Only `.eml` and `.msg` are. Large email exports usually
  arrive as PST files (question 6). **Open: its own step after BIGDATA-3.**

---

## 1. Batch database writes

**What to batch:**
- the text rows of each document go in as multi-row `INSERT … VALUES (…), (…)` of 500–1,000 rows
  (or `COPY`), not one row per statement;
- the per-file rows (source, acquisition, instance, artifact, audit) of a batch of small files go
  in one statement per table;
- one transaction still covers one file, or one batch of small files, so an admission and its
  audit row still commit together (D64).

**Measured, on a prototype outside the repository** (`captures/bigdata1/prototype-batch-insert.mts`,
never merged): 20,000 `content_blocks` + 20,000 `chunks` rows into the local Docker Postgres.

| Method | Time | Rows/s | Statements | Speed-up |
|---|---|---|---|---|
| one INSERT per row (today) | 24.65 s | 1,623 | 40,000 | — |
| multi-row, 100 rows each | 4.34 s | 9,212 | 400 | ×5.7 |
| multi-row, 500 rows each | 1.05 s | 38,111 | 80 | **×23.5** |
| multi-row, 1,000 rows each | 0.99 s | 40,583 | 40 | **×25.0** |

**Expected effect on the 1 GB run (estimate):**
- the 1.96 million block and chunk rows at about 40,000 rows/s take about 49 s;
- the per-file statements, about 15 per stored file for 9,108 files at 0.62 ms, take about 85 s,
  or about 10 s if those are batched too;
- so the database stage falls from 1,280.8 s to about **60–135 s (×10–20)**;
- the whole run falls from 1,714.6 s to about 490–560 s (×3–3.5), because storage (363 s) then
  dominates.

**Two related changes:**
- **Text stored once (F4)** means about two thirds less text. The estimate is a 958 MB database
  becoming about 350 MB per GB.
- **No byte-identical artifact copy (F3)** means about half the storage writes.

Both need a schema decision and a new migration (question 7). Existing migrations stay untouched.

**What could fail:**
- Very large statements. Keep batches at about 1,000 rows or 8 MB, whichever comes first.
- postgres.js `sql.array()` is banned (D68). The row helper `sql(rows)` is a different API, but
  the guardrail and the first-query array fault must be checked again.
- The audit chain (next section).

**Built in BIGDATA-2A (D89), measured:**
- multi-row INSERTs with the row helper, at most 1,000 rows or about 8 MB; a batch below 1,000
  rows goes as power-of-two pieces, because every distinct row count is a prepared statement
  Postgres keeps for the connection's life (100 distinct sizes held 151 MB in one backend; the
  11 fixed shapes 5.9 MB);
- the rows are identical to the one-row-per-INSERT code in every column (100 MB corpus);
- the database part fell from 1,280.8 s to 180.1 s per GB (×7.1), less than the ×10–20 estimated
  above: about 7 million per-row foreign-key checks still run inside Postgres per GB, and the
  per-file statements are still one round trip each; the whole run from 1,714.6 s to 614.4 s (×2.8),
  inside the ×3–3.5 estimate. Section 11 has the full table.

---

## 2. Junk removal and de-duplication before ingestion

A **triage pass** runs over the bucket's object list before any parsing. It decides, for every
object, one of: ingest, skip-junk, skip-duplicate, or skip-filter. **Nothing is deleted, moved or
overwritten in the bucket**, and nothing is silently dropped:
- every decision is a row in a new `ingest_decisions` table: object path, size, hash, decision,
  rule and rule version, and the file it duplicates;
- the decisions are listed in a report (CLI, and later the progress screen) and can be counted
  per rule;
- the owner can re-include any skipped object, or a whole rule, before or after ingestion.

**The rules:**
- **Junk:**
  - names: `Thumbs.db`, `.DS_Store`, `desktop.ini`, `~$*` Office lock files, `~WRL*.tmp` and
    other temp files;
  - zero-byte files;
  - optionally, known system-file hashes (NSRL-style lists) (question 3).
- **Exact duplicates:** by SHA-256. To avoid reading an object at all, first compare GCS's stored
  size + CRC32C; only when those match, read it and confirm with SHA-256. Scope is the matter
  (today it is the workspace, which is the same thing for one matter per deployment).
- **Near-duplicates:** by text fingerprint after parsing (and after OCR for scans):
  - normalised text, MinHash of word shingles, and a similarity threshold, for example 0.9
    (question 4);
  - near-duplicates are **grouped, not dropped**: the first is indexed, the rest are linked to it
    and indexed or set aside by the owner's rule;
  - this is the only rule that needs parsing first, so it runs in the worker, not in triage.
- **Date and person filters:** the owner may exclude by email Date/From/To/Cc, or by file date
  (question 5). Filters decide `skip-filter` with the filter recorded, so a later filter change
  can re-include them.

**PRD §60 (Class E):** `delete_anything`, `purge_source` and `withdraw_source` are absent from
every AI tool registry. Triage is deterministic code run by an operator, not an AI tool, and it
only records decisions. It never deletes or withdraws anything, so the Class E list and its CI
test are untouched.

**Expected effect on the 1 GB corpus (measured shares):**
- 697 top-level files skipped as exact duplicates or identical junk;
- a further 93 junk files and 38 dotfiles would be listed as junk instead of stored or dropped;
- near-duplicates (177) would be grouped.

For a real case the share is unknown. Email exports often have 20–40% duplicates (assumption).

**What could fail:**
- CRC32C is missing on objects written by some tools (composite uploads have CRC32C but no MD5),
  so read and hash in those cases.
- A filter set too wide hides relevant evidence. Hence decisions are reversible, listed and
  audited.

---

## 3. Queue and parallel workers

**Recommendation:** Cloud Run **jobs** in the matter's own GCP project, running under the matter's
own service account, with the work list sharded by task index. There is no shared queue service
between matters.
- Triage writes the object list (and the decisions) into the matter's database.
- The job runs N tasks. Task *i* takes every object whose hash, modulo N, equals *i*, or claims
  rows with `FOR UPDATE SKIP LOCKED` from an `ingest_work` table in the matter's own database.
  Either way the queue lives inside the matter's Supabase project, and a crashed task's work is
  simply picked up again.
- Redis is in the local stack, but using it in the cloud means Memorystore: another service to
  run per matter, which must never be shared between matters. The database table does the same
  job with isolation for free. Redis stays optional (question 9).
- A task is idempotent: the same object ingested twice is detected by its hash and skipped (as
  today).

**Isolation:**
- one matter means one GCP project, one set of buckets, one Supabase project, one service
  account;
- a job can only reach its own matter's buckets, secrets and database, because the service
  account's IAM bindings are limited to them, as for the API today (MATTER-SETUP §3);
- no worker image contains another matter's configuration; the job reads its settings from the
  matter's own Secret Manager.

**What limits parallelism (estimate):**
- **Database writes.** With batching, one connection wrote about 40,000 rows/s locally. A Supabase
  Large compute (2 dedicated vCPUs, 8 GB, $110 a month) is assumed to sustain 20,000–50,000
  rows/s across connections. At about 2 million text rows per GB, that is 40–100 s per GB of
  database time, whatever the number of workers.
- **Connections.** The pooler has a connection limit, so each task uses 1–2 connections.
- **The audit chain.** `writeAuditEvent` allocates the next per-tenant sequence number and updates
  `audit_chain_heads` inside each transaction (D52). Parallel transactions of one matter therefore
  queue on that row until each commits. Keep transactions short (write the audit row last, as
  today) and measure it in BIGDATA-4. If it limits throughput, changing the audit design needs its
  own decision (question 10).

**What could fail:**
- a task timeout (Cloud Run jobs allow long tasks, but set a per-object timeout);
- one enormous file blocking a task (F5: stream instead of holding whole files);
- database disk growth (section 7);
- two workers of the same matter both claiming an object (prevented by `SKIP LOCKED` or sharding).

---

## 4. Cloud OCR instead of local Tesseract

**Recommendation:** Google **Document AI Enterprise Document OCR**, in the matter's region.
- **Price:** first 1,000 pages a month free; **$1.50 per 1,000 pages** up to 5,000,000 pages a
  month; **$0.60 per 1,000** above that. Source: <https://cloud.google.com/document-ai/pricing>,
  read 2026-09-28 from the page's own price table. A web-search summary on the same day wrongly
  said $30, which is the Form Parser price. Always read the page itself.
- **Regions:** Enterprise Document OCR is available in `us`, `eu`, `asia-south1`,
  `asia-southeast1`, `australia-southeast1`, `europe-west2`, `europe-west3` and
  `northamerica-northeast1`. Source: <https://docs.cloud.google.com/document-ai/docs/regions>,
  read 2026-09-28. A matter in one of these regions can keep its pages in-region.
- **Alternative:** Cloud Vision Document Text Detection costs the same ($1.50 per 1,000 up to 5
  million, $0.60 above, each PDF page billed as an image). Source:
  <https://cloud.google.com/vision/pricing>, read 2026-09-28. Document AI also returns layout and
  confidence per block, which fits `content_blocks`.
- **Local Tesseract, for comparison (measured):** 0.77 s per A4 page on one core of this PC
  (Tesseract 5.4.0, 150 dpi fake scans). On Cloud Run that would cost less than $0.05 per 1,000
  pages in compute (estimate), but it reads worse. The fake scans came back with errors like
  "BRIMDLEWICK" for "BRINDLEWICK". The prompt chose cloud OCR; local Tesseract stays a possible
  fallback (question 1).

**How it fits:**
- scanned pages go to Document AI batch processing straight from the matter's bucket, with the
  output written to the matter's artifacts bucket, and nothing leaves the matter's project;
- the text lands in `content_blocks` with the engine, its version and its real confidence;
- F6 is fixed at the same time: no row may name an OCR engine that did not run.

**Pages per case (estimate):**
- about 2,500 per GB for the fake mix, which is about **2.6 million per TB**;
- a scan-heavy case could have 10,000 or more per GB, four times as many.

**What could fail:**
- **Quota.** Document AI limits concurrent batch requests and pages per minute, and the defaults
  may be too low for millions of pages. A quota increase must be requested per project (question 2).
- **Poor scans.** They produce low-confidence text, so the confidence is kept and shown.

---

## 5. Progress screen and spending cap

**Progress:** a new `ingest_runs` row per run, holding counters the workers update in their
batches:
- found / triaged / skipped by rule / ingested / needs OCR / OCR done / failed;
- bytes, pages, time started, estimated time left;
- spend so far, by service.

It is shown by `pnpm ingest:status --run <id>` (a watch mode) and by a read-only, sign-in-protected
page on the matter's API (there is no web app yet; the page only reads, as the preflight does).

**Spending cap:**
- **Before the run:** triage estimates the cost of the run (pages × OCR price, CPU seconds,
  storage operations) and the operator sets a cap, which is recorded on the run.
- **During the run:** each worker, before sending a batch to OCR or taking new work, adds the
  batch's known cost (pages × price, which is exact because the price is per page) to the run's
  spend with a conditional `UPDATE … WHERE spend + :batch <= cap`. If it would exceed the cap,
  the run stops taking work and is marked `paused: cap reached`. Nothing already done is lost;
  raising the cap resumes it.
- **Backstop:** Google Cloud budget alerts on the matter's project. They are alerts, and can lag
  by hours, so they are not the cap. Plus a Document AI page quota set per project as a hard ceiling.

**What could fail:**
- costs the counter does not see, such as egress or a misconfigured job, which the budget alert
  catches late;
- the cap stopping a run halfway, which is by design: it resumes when raised.

---

## 6. Getting 1–5 TB into the bucket

**Over the network:**
- `gcloud storage cp --recursive --no-clobber` (parallel, composite uploads for large files) from
  the client's copy.
- It never overwrites (the bucket rule). Size and CRC32C are checked against a local manifest
  after upload.
- Inbound transfer to Cloud Storage is free. Object writes are Class A operations at $0.005 per
  1,000 (Standard storage, single region). Source: <https://cloud.google.com/storage/pricing>,
  read 2026-09-28.

Time depends on the upload link (estimate, sustained rate):

| Size | 100 Mbit/s | 1 Gbit/s |
|---|---|---|
| 1 TB | ≈ 24 h | ≈ 2.4 h |
| 2 TB | ≈ 49 h | ≈ 4.9 h |
| 3 TB | ≈ 73 h | ≈ 7.3 h |
| 5 TB | ≈ 122 h (5 days) | ≈ 12 h |

**Google Transfer Appliance** (a device shipped to the client, filled, shipped back).
Source: <https://cloud.google.com/transfer-appliance/pricing>, read 2026-09-28.

| Appliance | Price | Free days | Each extra day | Round-trip shipping |
|---|---|---|---|---|
| **40 TB** | $300 | 10 weekdays | $30 | about $120 (US), about $350 (Europe) |
| 300 TB | $1,800 | 25 weekdays | $90 | about $180 (US), about $500 (Europe) |

A 1–5 TB case fits one 40 TB appliance: about **$420–$650** plus Cloud Storage costs. Door to door
it takes days to weeks (estimate). It is offered only in some countries (question 8).

**What could fail:**
- **Long paths.** 547 of the 10 GB corpus's paths are over 260 characters, and Windows tools can
  refuse them; upload from a tool that handles long paths.
- **A copy interrupted halfway.** Re-run with `--no-clobber` and compare with the manifest.

---

## 7. Estimates for 1, 2, 3 and 5 TB

All estimates. The assumptions:
- the case looks like the fake mix;
- 2,500 scanned pages per GB;
- after steps 1–4, with 16–32 parallel tasks;
- a Supabase compute large enough not to limit the run.

Prices are those above; storage is **$0.020 per GB-month** for Standard in `us-central1`. That
storage price is from secondary sources (the official page loads its regional table dynamically,
so it could not be read directly). Confirm it in the console, and for the matter's region
(question 12).

| | 1 TB | 2 TB | 3 TB | 5 TB |
|---|---|---|---|---|
| Today's code, one process (this PC) | ≈ 20 days | ≈ 41 days | ≈ 61 days | ≈ 102 days |
| After the plan: database-bound time (40–100 s/GB) | ≈ 11–28 h | ≈ 1–2.4 days | ≈ 1.4–3.5 days | ≈ 2.4–6 days |
| OCR pages (2,500/GB) | ≈ 2.6 M | ≈ 5.1 M | ≈ 7.7 M | ≈ 12.8 M |
| OCR cost, all in one month | ≈ $3,840 | ≈ $7,570 | ≈ $9,110 | ≈ $12,180 |
| Storage per month: originals only | ≈ $20 | ≈ $41 | ≈ $61 | ≈ $102 |
| Storage per month: with today's duplicate artifact copies (F3) | ≈ $41 | ≈ $82 | ≈ $123 | ≈ $205 |
| Object writes (Class A; about 10,000 objects per GB with zip entries and attachments, twice today) | ≈ $50–100 | ≈ $100–200 | ≈ $150–300 | ≈ $250–500 |
| Cloud Run jobs compute (about 200 vCPU-s and 400 GiB-s per GB) | < $10 | < $20 | < $30 | < $50 |
| Supabase disk, not GCP: today (958 MB/GB) | ≈ 0.96 TB, $120/month | ≈ 1.9 TB, $240 | ≈ 2.9 TB, $360 | ≈ 4.8 TB, $600 |
| Supabase disk: text stored once (≈ 350 MB/GB) | ≈ 0.35 TB, $44/month | ≈ $88 | ≈ $131 | ≈ $219 |

How the OCR row is worked out: the first 5 million pages of a month cost $1.50 per 1,000 and the
rest $0.60 per 1,000. Spread over several months, more pages fall in the $1.50 tier. A scan-heavy
case (10,000 pages per GB) costs about four times as much in OCR.

The Cloud Run row uses $0.000018 per vCPU-second and $0.000002 per GiB-second for jobs. Source:
<https://cloud.google.com/run/pricing>, read 2026-09-28. The Supabase rows use Pro disk at
$0.125 per GB beyond 8 GB. Source: <https://supabase.com/pricing>, read 2026-09-28; a larger
compute add-on is extra.

**What could fail, by size:**
- **1 TB:**
  - the database compute is too small, so the run is slower but still finishes;
  - the OCR quota;
  - search (F7) is unusable on the result until fixed.
- **2–3 TB:** all of the above, plus:
  - the OCR crosses the 5-million-page tier in one month;
  - one PST of tens of GB (F5, F8);
  - audit chain contention between parallel workers.
- **5 TB:** all of the above, plus:
  - the database reaches several TB unless text is stored once (Supabase allows up to 16 TB on
    General Purpose disk);
  - indexes on `chunks` take hours to build;
  - the spending cap is essential;
  - upload takes days on a slow link, so use the appliance.

---

## 8. Rules this plan keeps

- **The bucket:** never delete, overwrite or move anything in it. Triage and skips only record
  decisions; uploads use `--no-clobber`; OCR output goes to the artifacts bucket as new objects.
- **One case = its own Supabase project, GCP project and buckets.** Workers, queues, OCR
  processors and budgets exist per matter and are never shared.
- **The AI tool contracts (PRD §60, Class E):** no AI tool can delete, purge or withdraw sources.
  Triage is deterministic, operator-run, audited and reversible.
- **The migrations:** existing files in `packages/db/migrations/` are never edited; schema changes
  (text stored once, `ingest_decisions`, `ingest_runs`, `ingest_work`) are new numbered migrations.
- **Fake data only:** every measurement uses the fake corpus, never client data.

---

## 9. Proposed build order (each step measured on the 100 MB, 1 GB and 10 GB corpora, red first)

1. **BIGDATA-2**, split in two:
   - **2A (done, 2026-09-29, no schema change):** batched writes (D89); F1 (D90), F2 (D91),
     F6 (D92); large files hashed and stored by streaming, not parsed above 256 MiB (D93);
   - **2B (done, 2026-09-29):** text stored once and no byte-identical artifact copy (F3, F4),
     migration 0028 only (D94–D97).
2. **BIGDATA-3 (done, 2026-09-29):** triage with the `ingest_decisions` table (D98-D103, migration 0029):
   - junk (the listed names and empty files, answer 3), exact duplicates by size + CRC32C + SHA-256,
     date and person filters chosen per run by the case owner (answer 5);
   - the skipped-files report (`pnpm ingest:report`; 2A's `source.skip` audit rows are kept and now
     name their decision) and re-include (`pnpm ingest:include`);
   - near-duplicate grouping under the first copy at 0.9 (answer 4), both indexed.
   Then PST / MBOX as its own step (answer 6): **BIGDATA-3B (done, 2026-09-30)**, D108-D116, migration 0030, section 15.
3. **BIGDATA-4 (done, 2026-09-30):** Cloud Run jobs with the work table in the matter's database, the progress
   counters and `ingest:status --run`; the audit chain measured under parallel load (D117-D128, migration 0031,
   section 16).
4. **BIGDATA-5:** Document AI OCR in the matter's region, with the spending cap.
5. **BIGDATA-6:** the upload guide (parallel upload and Transfer Appliance), for a non-developer,
   like `docs/UPGRADE-LIVE-MATTER.md`.

Search at scale (F7) is its own track straight after BIGDATA-4, before any real 1 TB case
(answer 11); PST / MBOX (F8) is its own step after BIGDATA-3 (answer 6).

---

## 10. Open questions for the owner

Answered by the owner on 2026-09-29 (plan approved).

| # | Question | Why it matters | Answer (2026-09-29) |
|---|---|---|---|
| 1 | Document AI OCR as the only engine, or keep local Tesseract as a cheap fallback (for example for drafts, or above the cap)? | Tesseract is about 100× cheaper in compute but reads worse | **Document AI is the default**; local Tesseract stays available as an option for people who run the template without a Google budget. Decided in detail in BIGDATA-5. |
| 2 | Who asks Google for the Document AI quota increase per matter project, and what page rate do we ask for? | The default quota may throttle a multi-million-page run | Part of the **matter setup runbook**, written in BIGDATA-5. |
| 3 | Junk rules: only the names and empty files listed, or also known system-file hash lists (NSRL)? | Lists catch more but must be licensed and updated | **The listed names and empty files only.** No NSRL lists for now. |
| 4 | Near-duplicates: index them grouped under the first copy (recommended), or set them aside unless re-included? And the similarity threshold (0.9 suggested)? | Setting aside saves cost but risks hiding a changed version | **Indexed and grouped under the first copy.** Threshold **0.9**. |
| 5 | Date and person filters: who chooses them, and is a filter set per matter or per run? | Filters change what is reviewed; they must be the owner's decision | Chosen by the **case owner, per run**, recorded on the run. Default: **none**. |
| 6 | Must PST / MBOX mailboxes be supported, and in which step? | Most large email exports arrive as PST; today they would be `stored_unparsed` | **Yes**, as its own step after BIGDATA-3. |
| 7 | May the schema change so text is stored once (new migration), and the byte-identical artifact copy be dropped? | About two thirds less database and half the storage writes | **Yes**, in **BIGDATA-2B** (new migration only). |
| 8 | Which clients' countries must the upload work from? Transfer Appliance is not offered everywhere | Decides whether the appliance is an option | Decided later, in BIGDATA-6. |
| 9 | Queue: the matter's own database table (recommended), or Redis/Memorystore per matter? | A shared Redis would break one-case-one-project | **A table in the matter's own database.** No Redis in the cloud. |
| 10 | If the audit chain limits parallel ingestion, may its design change (for example one audit row per batch instead of per file)? | The chain is an invariant (I8); any change needs its own decision | **Measure it under parallel load first (BIGDATA-4); change nothing until then.** |
| 11 | Search at scale (F7): a separate track before the first 1 TB case, or part of this one? | The current search cannot work on millions of chunks | **Its own track, straight after BIGDATA-4**, before any real 1 TB case. |
| 12 | Default spending cap per run, and in which region's prices (confirm the storage price in the console)? | The cap is only useful with a number | Decided in BIGDATA-5. |

---

## 11. BIGDATA-2A, measured (2026-09-29)

The same harness as the baseline (`benchmarks/ingest-baseline`, extended only to time the new
streaming hash and upload), a wiped local Docker stack before each run, seed 42. The Windows Time
service was still stopped; the Docker VM clock was about 100 s ahead of Windows before each run
(clock checks in the run logs). Timings use Node's monotonic clock.

| | 100 MB: BIGDATA-1 | 100 MB: 2A | 1 GB: BIGDATA-1 | 1 GB: 2A | 10 GB: 2A |
|---|---|---|---|---|---|
| Total time | 197.0 s | 69.6 s | 1714.6 s | 614.4 s | 6331.7 s |
| Top-level files | 618 | 624 | 5,876 | 5,914 | 59,634 |
| All files incl. zip entries and attachments | 1,097 | 1,103 | 9,805 | 9,843 | 97,845 |
| MB read | 100.0 | 100.1 | 1023.9 | 1024.2 | 10240.0 |
| Throughput, MB/s | 0.51 | 1.44 | 0.60 | 1.67 | 1.62 |
| Throughput, files/s (all files) | 5.57 | 15.84 | 5.72 | 16.02 | 15.45 |
| walk | 0.0 s | 0.0 s | 0.0 s | 0.1 s | 0.5 s |
| read | 0.5 s | 0.5 s | 4.6 s | 6.2 s | 73.1 s |
| hash | 0.1 s | 0.1 s | 0.7 s | 0.7 s | 7.0 s |
| store | 40.5 s (20.6%), 1,988 writes | 41.5 s (59.6%), 1,993 writes | 363.3 s (21.2%), 17,520 writes | 366.5 s (59.6%), 17,557 writes | 3706.6 s (58.5%), 173,884 writes |
| parse | 7.5 s (3.8%) | 6.8 s (9.8%) | 64.5 s (3.8%) | 59.5 s (9.7%) | 609.6 s (9.6%) |
| OCR | none (no OCR step) | none (no OCR step) | none (no OCR step) | none (no OCR step) | none (no OCR step) |
| database | 148.3 s (75.3%) | 20.6 s (29.6%) | 1280.8 s (74.7%) | 180.1 s (29.3%) | 1921.0 s (30.3%) |
| Statements run by Postgres (pg_stat_statements) | 1,029,181, 13.3 s server time | 813,115, 4.8 s server time | 9,140,161, 118.8 s server time | 7,221,240, 42.4 s server time | 71,834,188, 502.4 s server time |
| Peak memory (RSS) | 478 MB | 454 MB | 540 MB | 537 MB | 704 MB |
| Database size after | 119 MB | 119 MB | 958 MB | 955 MB | 9440 MB |
| content_blocks / chunks rows | 110,096 / 110,096 | 110,095 / 110,095 | 977,930 / 977,930 | 977,929 / 977,929 | 9,729,971 / 9,729,971 |
| sources / audit_events rows | 1,031 / 1,031 | 1,037 / 1,103 | 9,108 / 9,108 | 9,146 / 9,843 | 90,284 / 97,845 |
| indexed / needs_ocr / stored_unparsed | 837 / 113 / 80 | 836 / 113 / 87 | 7,388 / 964 / 743 | 7,387 / 964 / 782 | 73,623 / 9,379 / 7,126 |
| unprocessable / skipped / failed | 1 / 66 / 0 | 1 / 66 / 0 | 13 / 697 / 0 | 13 / 697 / 0 | 156 / 7,561 / 0 |

**What it shows:**
- **Database round trips are no longer the main cost:** 30% of the run instead of 75%. What is
  left is mostly the per-file statements (about 15 per stored file) and the foreign-key checks
  Postgres runs for every row (most of the 7.2 million statements per GB are those, inside the
  server).
- **Storage is now the main cost: 59–60% of the run.** Half of it is the byte-identical artifact
  copy (F3), which BIGDATA-2B removes.
- **It scales linearly:** 10 GB took 10.3 times as long as 1 GB, with flat throughput
  (1.67 → 1.62 MB/s) and memory (537 → 704 MB).
- **Straight line (estimate):** 6,331.7 s per 10 GB is about **7.5 days per TB** on this PC in one
  process (it was about 20). The parallel workers of BIGDATA-4 are what brings this to hours.
- **Outcome counts** differ from the baseline only by the fixes: 6 / 38 more top-level files
  (the `.DS_Store` files, F1, now `stored_unparsed`); the empty file `stored_unparsed` instead of
  indexed (F2, one fewer block and chunk); one audit row for every skip (F1: 697 at 1 GB).
- The database is still about 940 MB per GB: text is stored three times until BIGDATA-2B.

**Found on the way (recorded, not fixed):**
- DEV-031: `sources.metadata` and the audit rows' `before` / `after` hold a JSON string, not a JSON
  object (encoded twice).
- DEV-032: `search` and `list_documents` order by `created_at` alone; every row of one file shares
  it, and it follows the database clock, which jumped back about 100 s three times in one run
  here. Two runs of the unchanged code gave different top-20s; the complete results are identical.
  For the search-at-scale track.
- DEV-033 (fixed): the REST contract did not know `needs_ocr`.

---

## 12. Text stored once (BIGDATA-2B design, written before the code)

Today every piece of text is stored three times: `content_documents.full_text`,
`content_blocks.text` and `chunks.text` (F4). Checked on the 2A code with the 100 MB corpus
(`captures/bigdata2b/text-rebuild-analysis.txt`): 110,095 chunks hold 19.1 M characters, the
documents 19.2 M, the blocks the same again.

### The one copy: `content_blocks.text`

Evidence, span hashes and citations point at blocks, so the blocks keep the text:
- **I1** (an assertion's evidence must resolve, and its span must still hash to `span_hash`):
  `apps/api/src/routes/assertions.ts` reads `content_blocks.text`. Unchanged.
- **I4** (a citation resolves to a hash-matching span or renders broken):
  `evidence-grounding.ts` verifies against the current block text. Unchanged.
- **I9, evidence side** (a quoted span must match the block text at its offsets):
  `evidence-grounding.ts` reads the block. Unchanged.

### `chunks.text`: empty (NULL) when it is exactly one block

- **Rule for new rows:** a chunk whose `block_ids` is one block, with the same text and offsets
  as that block, is written with `text` NULL. Measured: all 110,095 chunks the ingest writes are
  of that kind, and the REST upload writes the same one-block chunks.
- **Readers** get `COALESCE(c.text, b.text)` from
  `LEFT JOIN content_blocks b ON c.text IS NULL AND b.id = c.block_ids[1]`, a primary-key
  lookup. An old row keeps its text, so it reads as before.
- **Every reader of `chunks.text`, and what changes:**
  - MCP `search` (`packages/mcp/src/tools.ts`, `handleSearch`): the COALESCE;
  - REST search (`apps/api/src/services/search-engine.ts`, the candidate query): the COALESCE;
  - investigation memory, tier 4 (`investigation-memory.ts`): the COALESCE;
  - extraction by chunk (`POST /v1/investigations/:id/extract`, `entities.ts`): the COALESCE;
  - `GET /v1/investigations/:id/sources/:sourceId`, which returns the chunks (`sources.ts`):
    the COALESCE (it selected `*` and would fail the contract on a NULL);
  - counts only, no change: `ingest:status`, the search coverage report and the memory totals.
- **Schema (migration 0028, additive):**
  - `chunks.text` drops its NOT NULL;
  - a CHECK (`NOT VALID`, so existing rows are not rescanned): text is present, or the chunk
    has exactly one block.

### `content_documents.full_text`: empty (NULL) when the blocks give it back exactly

- **Why this is not simply the blocks joined:** I9's extraction check (`/extract` by source)
  reads `full_text` at exact character offsets, and entity mentions store those offsets. So the
  text a reader gets must be exactly the text that would have been stored.
- **The rebuild:** each block in sequence order, placed at its `char_start`, the gaps filled with
  `\n` (`rebuildDocumentText`, one function used by both writer and reader).
- **Rule for new rows:** `full_text` is NULL only when the rebuild equals it exactly, checked
  per document when it is written; otherwise it is stored as today.
- **Measured:**
  - exact for every document of the 100 MB corpus: 288 emails, 190 PDFs, 148 spreadsheets,
    191 Word files (the 113 scans have no blocks and keep `''`);
  - exact on the repository fixtures for PDF, .docx, .xlsx, .eml and .msg;
  - **not exact for .doc, .html and .rtf**, whose parsers count one separator character where
    the text has `\n\n` (a parser offset bug, recorded as DEV-034, not fixed here: fixing it
    changes those rows). Their `full_text` stays stored, so they keep two copies.
- **Its one reader:** `/extract` by source (`entities.ts`) uses `full_text`, or the rebuild when
  it is NULL. Today it falls back to the blocks joined with `\n` when `full_text` is empty, which
  gives the same text when blocks are one `\n` apart.
- No other code reads `full_text`: no MCP tool, no search, no REST response, and not the
  evidence snippet (`full_text_snippet` is built from the evidence row's own context).

### Indexes

There is no text index on any of the three columns today. The only indexes are B-tree indexes on
ids and `(tenant_id, …)`: `chunks_pkey`, `idx_chunks_tenant_investigation`,
`content_blocks_pkey`, `idx_content_blocks_tenant_doc`, `content_documents_pkey` and
`idx_content_docs_tenant_artifact`. They stay where they are. The search-at-scale track's text
index goes on `content_blocks.text`, the kept copy.

### Old and new rows together

Nothing is dropped and no existing row is updated. A matter keeps its old rows (three copies)
and its new rows (one copy), and every reader above handles both:
- the COALESCE for chunks;
- `full_text ?? rebuild` for documents.

A test seeds one old-style and one new-style document and calls every reader.

### No byte-identical artifact copy (F3)

- **Rule for new rows:** the primary artifact of a parsed file is byte-for-byte the source file.
  Its `storage_uri` becomes the source object's URI, and no second object is written. This
  applies to the CLI (directory and bucket mode, zip entries and attachments) and the REST
  upload.
- **Readers:** no code reads `artifacts.storage_uri`. Downloads, `get_source`, evidence and
  `ingest:status` read `sources.storage_uri`. Old artifacts and their objects stay as they are;
  nothing in a bucket is deleted.

### Found while building it

- **Search paging.** The join made the 100 MB search query run with parallel workers, and the
  order of ties (every chunk of one file) then changed between calls, so offset paging repeated and
  skipped hits. Both searches now break ties by chunk id (D97). The before/after capture showed it:
  4,934 hits paged, 4,694 distinct, before the fix; the complete results identical after it.
- **`GET /sources/:id` of a REST-uploaded PDF answers 500** on the 2A code too: its blocks' `bbox`
  is a JSON string (DEV-031, not fixed here).

### What would have stopped this

Keeping the text once needs no rewrite of search (one join per reader) and changes no grounding
check (the blocks keep the text). If the rebuild had not been exact, `full_text` would have had
to stay stored, and it does stay stored for the three formats where it is not exact.

---

## 13. BIGDATA-2B, measured (2026-09-29)

The same harness, a wiped local Docker stack before each run, seed 42, a clock check before each
run (Windows Time service still stopped; the Docker VM clock about 100 s ahead). Columns: BIGDATA-1
("1", commit `4a9c7a0`), 2A (`bd525eb`) and 2B.

| | 100 MB: 1 | 100 MB: 2A | 100 MB: 2B | 1 GB: 1 | 1 GB: 2A | 1 GB: 2B | 10 GB: 2A | 10 GB: 2B |
|---|---|---|---|---|---|---|---|---|
| Total time | 197.0 s | 69.6 s | 50.9 s | 1714.6 s | 614.4 s | 448.1 s | 6331.7 s | 4302.5 s |
| Throughput, MB/s | 0.51 | 1.44 | 1.96 | 0.60 | 1.67 | 2.29 | 1.62 | 2.38 |
| All files (incl. zip entries, attachments) | 1,097 | 1,103 | 1,103 | 9,805 | 9,843 | 9,843 | 97,845 | 97,845 |
| store | 40.5 s (21%) | 41.5 s (60%) | 23.1 s (45%) | 363.3 s (21%) | 366.5 s (60%) | 196.4 s (44%) | 3706.6 s (59%) | 1956.9 s (45%) |
| **Object writes / per GB** | 1,988 / **20,349** | 1,993 / **20,395** | 1,037 / **10,612** | 17,520 / **17,521** | 17,557 / **17,554** | 9,146 / **9,145** | 173,884 / **17,388** | 90,284 / **9,028** |
| **MB written / per GB** | 206 / **2,109** | 206 / **2,108** | 127 / **1,300** | 2,064 / **2,064** | 2,064 / **2,064** | 1,302 / **1,302** | 20,158 / **2,016** | 12,742 / **1,274** |
| parse | 7.5 s (4%) | 6.8 s (10%) | 7.1 s (14%) | 64.5 s (4%) | 59.5 s (10%) | 66.6 s (15%) | 609.6 s (10%) | 589.6 s (14%) |
| database | 148.3 s (75%) | 20.6 s (30%) | 20.1 s (39%) | 1280.8 s (75%) | 180.1 s (29%) | 178.7 s (40%) | 1921.0 s (30%) | 1692.6 s (39%) |
| read / hash / walk | 0.5 s / 0.1 s / 0.0 s | 0.5 s / 0.1 s / 0.0 s | 0.5 s / 0.1 s / 0.0 s | 4.6 s / 0.7 s / 0.0 s | 6.2 s / 0.7 s / 0.1 s | 4.8 s / 0.7 s / 0.0 s | 73.1 s / 7.0 s / 0.5 s | 49.6 s / 6.6 s / 0.0 s |
| OCR | none | none | none | none | none | none | none | none |
| Postgres statements (pg_stat_statements) | 1,029,181, 13.3 s | 813,115, 4.8 s | 813,115, 4.3 s | 9,140,161, 118.8 s | 7,221,240, 42.4 s | 7,221,240, 40.6 s | 71,834,188, 502.4 s | 71,834,184, 429.9 s |
| Peak memory (RSS) | 478 MB | 454 MB | 428 MB | 540 MB | 537 MB | 510 MB | 704 MB | 671 MB |
| **Database size / per GB** | 119 MB / **1,220 MB** | 119 MB / **1,217 MB** | 99 MB / **1,009 MB** | 958 MB / **958 MB** | 955 MB / **955 MB** | 779 MB / **779 MB** | 9,440 MB / **944 MB** | 7,658 MB / **766 MB** |
| content_blocks / chunks rows | 110,096 / 110,096 | 110,095 / 110,095 | 110,095 / 110,095 | 977,930 / 977,930 | 977,929 / 977,929 | 977,929 / 977,929 | 9,729,971 / 9,729,971 | 9,729,971 / 9,729,971 |
| indexed / needs_ocr / stored_unparsed | 837 / 113 / 80 | 836 / 113 / 87 | 836 / 113 / 87 | 7,388 / 964 / 743 | 7,387 / 964 / 782 | 7,387 / 964 / 782 | 73,623 / 9,379 / 7,126 | 73,623 / 9,379 / 7,126 |
| unprocessable / skipped / failed | 1 / 66 / 0 | 1 / 66 / 0 | 1 / 66 / 0 | 13 / 697 / 0 | 13 / 697 / 0 | 13 / 697 / 0 | 156 / 7,561 / 0 | 156 / 7,561 / 0 |

**What it shows:**
- **Object writes halved:** from about 17,500 to about 9,100 per GB, one per source object, since
  the artifact copy is gone (D95). The bytes written fell from 2,064 to 1,302 MB per GB. They are
  still more than the 1,024 MB read, because zip entries and email attachments are stored again
  as source objects of their own.
- **Storage time halved:** 366.5 s to 196.4 s per GB. The whole run is 27–32% faster than 2A:
  1 GB in 448.1 s (2.29 MB/s), 10 GB in 4,302.5 s (2.38 MB/s). Straight line (estimate): about
  5.1 days per TB on this PC in one process (20 in BIGDATA-1, 7.5 in 2A).
- **The database is 18–19% smaller, not two thirds.** At 1 GB, 955 MB became 779 MB:
  - `chunks` fell from 449 to 323 MB;
  - `content_documents` from 52 to 2 MB;
  - `content_blocks`, the one copy, stays at 414 MB.

  The estimate in section 1 (about 350 MB per GB) assumed the text was most of those tables. It is
  not: 978,000 chunk rows per GB still take about 330 bytes each without their text:
  - ids, the block array, `contextual_header` and timestamps;
  - the row header;
  - two indexes.

  A smaller database now means fewer rows (no chunk row that only repeats its block, or no
  `contextual_header` copy). That is a change to how search reads chunks, so it belongs to the
  search-at-scale track, not to 2B.
- **The database stage** is about the same as 2A (179 s per GB). It is now 40% of the run; parse is 14%.
- **Outcomes** are identical to 2A at every size.

---

## 14. BIGDATA-3: triage (what was built, and measured, 2026-09-29)

### What a run does now

1. **Triage, before any parsing** (`tools/ingest-cli/src/triage.ts`). The run gets an `ingest_runs` row
   (source, the owner's filters, rule versions). Every object the walk or the bucket listing finds gets
   one `ingest_decisions` row, in this order of rules:
   - not a regular file (a link, a device) or a pipeline sidecar: `skip-filter` (2A's fixed exclusions);
   - junk (answer 3): the listed names, any case, and 0-byte files: `skip-junk` (D99);
   - the owner's filters for this run (answer 5): email Date / From / To / Cc for `.eml` and `.msg`,
     the file date for everything else: `skip-filter` naming the filter and the value it caught (D102);
   - exact duplicates among what is left, and of what the investigation already holds: `skip-duplicate`
     naming the original (D100).
   Each skip also has its `source.skip` audit row (as in 2A, now naming the decision), and the run's
   `ingest.triaged` audit row comes before its first `source.admit`.
2. **Ingest** of the objects decided `ingest`, as in 2B, one transaction per file. Items inside a zip or
   an email meet the junk, email-filter and duplicate rules when they are reached (stage `ingest`).
3. **Near-duplicates, after parsing** (`near-duplicates.ts`, D101): every parsed document's MinHash
   signature goes into `document_fingerprints`, linked to the first document of its group when the
   estimated similarity to it is at least 0.9. Both are indexed.
4. `pnpm ingest:report --run <id>` lists it; `pnpm ingest:include` brings a skip back as a new decision (D103).

**Nothing in a bucket is deleted, moved, copied or overwritten.** Decisions are append-only for the
application role. A re-include supersedes a decision; it never changes one.

### Schema (migration 0029, additive)

- `ingest_runs`: kind (`ingest` / `include`), folder or bucket and the source, `filters` (`{}` = none),
  `rule_versions`, `counters` (triage counts; ingest outcomes; near-duplicate and triage time),
  `include_of_run`, started / triaged / finished. Kept minimal; BIGDATA-4 extends it for progress and cost.
- `ingest_decisions`: run, stage (`triage` / `ingest` / `include`), path, size, SHA-256 (when triage or the
  ingest computed it), CRC32C and generation (bucket mode), decision, rule and rule version, reason,
  `duplicate_of_path` / `_decision_id` / `_source_id`, `filter`, `supersedes`. CHECKs: a skip names its
  rule and version; a duplicate names what it duplicates; a filtered object names its filter; an include
  supersedes a skip. SELECT and INSERT only for `casefile_app`.
- `document_fingerprints` (near-duplicates): **a table, not a column.** The link is found after parsing,
  in the document's own transaction; the signature must be kept so that a later run compares against
  earlier documents without reading any text again; and the row records its method, version and
  similarity. Nothing in `sources` is updated. The old `near_duplicate_clusters` table (0012) is not
  used: it is a pair table holding the REST upload's filename-based demo pairs (DEV-035).
- All three: RLS enabled and forced, policy `tenant_isolation` with USING and WITH CHECK; the tenancy
  guardrail lists them.

### Keeping near-duplicates fast at 10 GB

No pair is compared unless LSH makes it a candidate: each 256-value signature is cut into 32 bands of 8;
two documents are compared only if one band is identical, which happens with probability
1 - (1 - s^8)^32 at similarity s (above 0.99999 at 0.9, 0.42 at 0.6, 0.002 at 0.4). A candidate is then
compared with its group's first document (one 256-value comparison). The index of the matter's earlier
signatures is loaded from `document_fingerprints` when a run starts (measured: about 5 KB per document
in memory, 376 MB at 10 GB; see below). The signature cost is linear in the text: every shingle is
hashed once and mixed 256 times.

**128 values first, then 256.** With 128 values (16 bands) the 100 MB run caught 13 of the 16
near-duplicates that have text; the 3 it missed were Word copies of PDFs with an exact similarity of
0.925-0.936 (page footers such as "continued" and page numbers differ) but an estimate of 0.875-0.898.
The estimator is not biased (mean error +0.003, standard deviation 0.019 over 400 synthetic pairs); it is
noise, which 256 values roughly halve at 0.93 and which put those 3 at 0.910-0.922
(`captures/bigdata3/near-dup-missed-probe-100MB*.txt`, `minhash-bias-probe.txt`,
`measure/attempt1-k128/`).

### Against the fake-corpus manifest (seed 42; the last decision per top-level file)

Scored by the harness itself (`benchmarks/ingest-baseline`, "Triage and near-duplicates against the
manifest"); "caught" / "missed" / "wrongly flagged" as the manifest defines each kind.

| Manifest kind | 100 MB | 1 GB | 10 GB |
|---|---|---|---|
| junk: caught / missed | 44 / 0 | 414 / 0 | 4,174 / 0 |
| other kinds flagged as junk | 0 | 0 | 0 |
| duplicate: caught / missed | 44 / 0 | 414 / 0 | 4,174 / 0 |
| — of which the copy set aside / the original set aside because its copy sorted first (same bytes) | 24 / 20 | 227 / 187 | 2,205 / 1,969 |
| other kinds set aside as a copy / of those NOT byte-identical to what they name | 20 / 0 | 188 / 0 | 1,976 / 0 |
| near_duplicate in the manifest / scans (no text until OCR, BIGDATA-5) / with text | 19 / 3 / 16 | 177 / 22 / 155 | 1,789 / 238 / 1,551 |
| near_duplicate with text: caught / missed (**recall at 0.9**) | 16 / 0 (**100%**) | 153 / 2 (**98.7%**) | 1,533 / 18 (**98.8%**) |
| near-duplicate links made / inside a manifest family (**precision**) | 16 / 16 (**100%**) | 152 / 152 (**100%**) | 1,526 / 1,526 (**100%**) |
| corrupt (decided ingest; then unprocessable or stored_unparsed as before) | 6 | 59 | 597 |

"Other kinds set aside as a copy" are originals whose byte-identical copy sorted first in path order,
and files the generator's duplicates were made from; every one was checked against the SHA-256 of what
it names. "Caught" near-duplicates can exceed "links made": a near-duplicate that is itself a
byte-identical copy of another is covered by that one's link.

**The misses, measured from the files** (`captures/bigdata3/near-dup-missed-probe-1GB.txt`, `-10GB.txt`;
every one is a Word file generated from a PDF's text, against that PDF):
- 1 GB: 2 missed. One pair's exact similarity is 0.875, below the owner's 0.9, so not grouping it is the
  rule working (a short document, where the PDF's page lines weigh more); the other is 0.904, estimated 0.875.
- 10 GB: 18 missed. 2 are below 0.9 exactly (0.875, 0.881); 16 are between 0.902 and 0.936 and were
  estimated between 0.875 and 0.898: MinHash noise at the threshold, about 1% of the 1,551 pairs. A
  larger signature would narrow it further (512 values: double the cost again); not done.
- The 238 scanned near-duplicates cannot be found before OCR (BIGDATA-5 will give them text).

### Measured (2026-09-29): 2A, 2B and 3 side by side

The same harness as 2A and 2B, extended to time triage (everything inside the triage pass, its hashing and
its transactions included) and the near-duplicate work (signatures, LSH lookups, fingerprint rows) as
stages of their own; a wiped local Docker stack and a clock check before each run (Windows Time service
still stopped; the Docker VM clock about 100 s ahead); seed 42. Evidence: `captures/bigdata3/measure/`
(`side-by-side.md` is this table).

| | 100 MB: 2A | 100 MB: 2B | 100 MB: 3 | 1 GB: 2A | 1 GB: 2B | 1 GB: 3 | 10 GB: 2A | 10 GB: 2B | 10 GB: 3 |
|---|---|---|---|---|---|---|---|---|---|
| **Total time** | 69.6 s | 50.9 s | **51.8 s** | 614.4 s | 448.1 s | **470.4 s** | 6331.7 s | 4302.5 s | **4869.9 s** |
| Throughput, MB/s | 1.44 | 1.96 | 1.93 | 1.67 | 2.29 | 2.18 | 1.62 | 2.38 | 2.10 |
| **triage** (objects hashed) | — | — | **0.5 s** (1%; 96 of 624) | — | — | **3.8 s** (1%; 1,470 of 5,914) | — | — | **58.2 s** (1%; 32,407 of 59,634) |
| **near-duplicates** (documents grouped) | — | — | **2.1 s** (4%; 16) | — | — | **19.2 s** (4%; 152) | — | — | **198.7 s** (4%; 1,526) |
| store | 41.5 s | 23.1 s | 22.4 s | 366.5 s | 196.4 s | 200.1 s | 3706.6 s | 1956.9 s | 2086.1 s |
| Object writes / per GB | 1,993 / 20,395 | 1,037 / 10,612 | 1,015 / 10,387 | 17,557 / 17,554 | 9,146 / 9,145 | 9,014 / 9,013 | 173,884 / 17,388 | 90,284 / 9,028 | 89,490 / 8,949 |
| parse | 6.8 s | 7.1 s | 7.2 s | 59.5 s | 66.6 s | 66.8 s | 609.6 s | 589.6 s | 689.2 s |
| database (less store, parse, hash, near-duplicates) | 20.6 s | 20.1 s | 19.1 s | 180.1 s | 178.7 s | 173.7 s | 1921.0 s | 1692.6 s | 1770.1 s |
| Peak memory (RSS) | 454 MB | 428 MB | 458 MB | 537 MB | 510 MB | 542 MB | 704 MB | 671 MB | **1,134 MB** |
| **Database size / per GB** | 119 MB / 1,217 | 99 MB / 1,009 | **101 MB / 1,031** | 955 MB / 955 | 779 MB / 779 | **794 MB / 794** | 9,440 MB / 944 | 7,658 MB / 766 | **7,800 MB / 780** |
| ingest_decisions / document_fingerprints rows | — | — | 624 / 817 | — | — | 5,914 / 7,210 | — | — | 59,634 / 71,834 |
| sources / audit_events rows | 1,037 / 1,103 | 1,037 / 1,103 | 1,015 / 1,104 | 9,146 / 9,843 | 9,146 / 9,843 | 9,014 / 9,844 | 90,284 / 97,845 | 90,284 / 97,845 | 89,490 / 97,846 |
| indexed / needs_ocr / stored_unparsed | 836 / 113 / 87 | 836 / 113 / 87 | 836 / 113 / 65 | 7,387 / 964 / 782 | 7,387 / 964 / 782 | 7,387 / 964 / 650 | 73,623 / 9,379 / 7,126 | 73,623 / 9,379 / 7,126 | 73,623 / 9,379 / 6,332 |
| unprocessable / skipped / failed | 1 / 66 / 0 | 1 / 66 / 0 | 1 / 88 / 0 | 13 / 697 / 0 | 13 / 697 / 0 | 13 / 829 / 0 | 156 / 7,561 / 0 | 156 / 7,561 / 0 | 156 / 8,355 / 0 |

**What it shows:**
- **Triage is cheap: about 1% of a run** (58 s at 10 GB), because only files that share a size are hashed
  (32,407 of 59,634 at 10 GB; the corpus has many same-size files: empty files, identical junk, copies).
- **Near-duplicates cost about 4%** (199 s at 10 GB for 71,834 documents, about 2.8 ms each), linear in size.
- **Outcomes are 2B's plus triage:** indexed and needs_ocr are identical at every size; stored_unparsed
  fell by the junk that is no longer admitted (22, 132 and 794 sources), skipped rose by as many. The
  sources removed are all junk; no document with text was removed.
- **The database is 2% larger** (780 MB per GB at 10 GB instead of 766): `document_fingerprints` 102 MB
  and `ingest_decisions` 39 MB at 10 GB, less the junk sources that are gone.
- **Total time:** 100 MB and 1 GB are within 2-5% of 2B. At 10 GB the run took 567 s longer than 2B:
  triage and near-duplicates explain 257 s; the other 310 s is in store (+129 s), parse (+100 s) and the
  database (+78 s), where this step adds no work (it stores 794 fewer objects). Not explained further here;
  run-to-run variation on this PC is the likely cause, not established.
- **Memory:** peak RSS at 10 GB rose from 671 MB to 1,134 MB. The near-duplicate index accounts for most
  of it: 376 MB of RSS for 71,834 fingerprints, about 5 KB each, measured on its own
  (`captures/bigdata3/near-dup-index-memory-probe.txt`). At 1 TB (about 7 million documents) that is tens of
  GB: **the index has to move into the matter's database (or be sharded) before BIGDATA-4's parallel
  workers**; recorded here for BIGDATA-4.

### The 9 MCP tools and search, before and after (100 MB)

The 2B capture tools, copied to `captures/bigdata3/` (`capture.mts`, `compare.mts`): a wiped stack, the
2B code (`1b4d863`, clean tree) as "before", this step as "after-2" ("after" is kept: its script left 266
audit ids unlabelled). `diff-before-vs-after-2.txt`:
- **Search: every search's complete result, over every page, is identical** (5 searches; 4,934, 5,173,
  3,126 and 7,619 hits, and none). The junk that is no longer admitted had no text, so no hit changed.
  5 outputs differ only in the order of items that share a `created_at` (DEV-032).
- 19 of 28 outputs byte-identical. The others: `matter_status` counts 1,015 sources instead of 1,037
  (the 22 junk sources); `get_source` of the empty file and of a `.DS_Store` now answers "not found"
  (they are skip-junk decisions, not sources); `list_documents` (limit 100) lists the same sources less
  the junk, but its first 100 differ because it orders by `created_at` across files and the Docker clock
  jumped back about 100 s twice during the before run and not during the after run (DEV-032;
  `list-documents-check.txt`, and the clock lines of both captures' `summary.txt`).
- Rows: identical but for the 22 junk sources (and their instance, acquisition and one artifact), the
  skip audit rows (now naming their decision; one `ingest.triaged` row more), and every later audit row's
  `seq`, which moved because triage writes its skip rows first. The audit chain verifies (`valid: true`).

### Found on the way

- **DEV-035 (recorded, not fixed):** the REST upload's near-duplicates are a filename demo (`v1`/`v2`, a
  fixed 0.94 and an invented diff). The ingest's are measured and live in `document_fingerprints`.
- **The near-duplicate index in memory** (above): fine at 10 GB, not at 1 TB; for BIGDATA-4.
- **`apps/api/test/search-paging.integration.test.ts` (2B) depended on what other test files left in the
  shared test database.** In this step's first verify run its plan check found an index scan instead of a
  parallel plan: with 38,033 chunks of 32 tenants the planner estimated 599 of the test's 3,000 rows. Index
  and bitmap scans are now off for that plan check only (turning them off for the paging tests too made
  those time out); its name now says what it shows, that the query can run in parallel on that data. The
  SQL-order test remains the one that tells the old order from the new (`captures/bigdata3/red-green/09`, `10`).
- **The 2A findings test** changed where this step changes behaviour on purpose: `.DS_Store` and the empty
  file are now skip-junk (D99), and a duplicate's reason names its original.

---

## 15. BIGDATA-3B: PST, OST and MBOX mailboxes (what was built, and measured, 2026-09-30)

### What a run does with a mailbox

1. **Triage** sees the mailbox file like any file (junk rule, exact duplicate by size and SHA-256), but
   never sets it aside by its file date: a mailbox is judged message by message (D115).
2. **Admission**: the file is stored whole by streaming (or stays where it is in bucket mode), never changed,
   and gets its source (status `processing`), acquisition, instance and artifact rows (D108).
3. **Reading**, one message at a time, one transaction per message (D108, D109): PST and OST with pst-extractor
   (patched, D110), MBOX with Casefile's own streaming reader. For each message: the owner's email filters, then
   its **identity** against the investigation (D111): the same message already there is a `skip-duplicate`
   decision (rule `message-duplicate`); otherwise it becomes a source under the mailbox with its folder path and
   headers, parsed, indexed and near-duplicate grouped like an `.eml`, with its attachments as children. A PST
   message's stored object is an `.eml` rendering, marked as such (D112).
4. **What reading found** goes on the mailbox's source, a `source.mailbox_read` audit row, the run's counters, the
   CLI summary and `ingest:report`'s `Mailboxes:` section. A mailbox that cannot be read is stored and listed with
   the reason; a damaged one keeps what could be read and lists every message, folder or attachment that could not
   be, by path (D113).

Readers chosen (the prompt's questions): **pst-extractor 1.12.0**, MIT, maintained (releases through January 2026),
reads by file handle without loading the file; **MBOX: no library** (mbox-reader, MIT, maintained, rewrites line
endings and gives no offsets; the reader here is about 100 lines and streams). Details and alternatives: D109.

### The fake mailboxes (answer: a free way exists, D114)

No real mailbox is used. `pnpm fake-corpus --kind mailboxes` writes the standard set (seed 42, 482 MB, 22 s):
`alice.mbox` (300 messages, CRLF), `bob.mbox` (477: copies of Alice's, messages twice, 15 sent again, 2 that
reuse a Message-ID), `carol.pst` (752 in a folder tree with `Q1/Q2 Reports` and `Case #12`, Bcc, embedded
messages, 40 of Alice's messages, 10 filed twice, a draft twice with no Message-ID) and a byte-identical copy of it,
`archive-2019.mbox` (324 MB, 628 messages with large attachments), and broken ones: a password-protected PST, a
PST whose header says high encryption, a PST with a zeroed middle, a PST cut to 60%, an MBOX cut inside a message,
a file that is not an MBOX. `--kind mbox --size 1GB` / `2GB` and `--kind pst --size ...` write one big mailbox.
Each set has `fake-mailbox-manifest.csv`: every mailbox, message (by the ingest's own path) and attachment, which
copies are one message (group), which were sent again, which reuse a Message-ID. The PSTs are written by a small
C# program on PSTFileFormat (LGPL) and Microsoft's `Empty.pst` (MIT), fetched at pinned commits outside the
repository; Microsoft's own reader (outlook-pst-rs) agrees with the manifest on every readable fake PST
(`captures/bigdata3b/generate/census-*.tsv`).

### Against the manifest

| | standard set | 1 GB MBOX | 2 GB MBOX | 1 GB PST | 2 GB PST |
|---|---|---|---|---|---|
| messages in the manifest | 2,655 | 1,902 | 4,068 | 2,589 | 5,544 |
| a source | 2,258 | 1,858 | 3,962 | 2,522 | 5,399 |
| a `message-duplicate` decision | 137 | 44 | 106 | 67 | 145 |
| listed as unreadable, with its path | 20 | 0 | 0 | 0 | 0 |
| in a mailbox that cannot be read (stored, with the reason) | 240 | 0 | 0 | 0 | 0 |
| **missing** | **0** | **0** | **0** | **0** | **0** |
| attachments of indexed messages found (a source / a decision / listed as unreadable / in the message the file's end cuts) | 2,216 of 2,216 (2,212 / 1 / 2 / 1) | 2,365 of 2,365 (2,365 / 0 / 0 / 0) | 4,911 of 4,911 (4,911 / 0 / 0 / 0) | 3,187 of 3,187 (3,187 / 0 / 0 / 0) | 6,725 of 6,725 (6,725 / 0 / 0 / 0) |
| **attachments missing** | **0** | **0** | **0** | **0** | **0** |
| duplicate copies set aside, of those to set aside; set aside wrongly | 137 of 137; 0 | 44 of 44; 0 | 106 of 106; 0 | 67 of 67; 0 | 145 of 145; 0 |
| messages sent again linked to their original; links outside the manifest's families | 15 of 15; 0 | 37 of 37; 0 | 82 of 82; 0 | 46 of 46; 0 | 105 of 105; 0 |
| messages that reuse another's Message-ID: indexed | 2 of 2 | - | - | - | - |

In the standard set the byte-identical copy of `carol.pst` sorts first (`carol - backup copy.pst`), so it is the
one read and `carol.pst` is the triage duplicate; the scorecard moves the manifest's rows onto the copy. The 20
unreadable messages and 2 unreadable attachments are in the PST zeroed in the middle; each is a
`source.ingest_failed` row with its path (the attachments with their real names, read from the message's
attachment table).

### Measured (local Docker stack, wiped and clock-checked before each run)

| | standard set | 1 GB MBOX | 2 GB MBOX | 1 GB PST | 2 GB PST |
|---|---|---|---|---|---|
| mailbox bytes | 460,239,607 in 10 files | 1,077,274,736 | 2,148,489,298 | 1,109,533,696 | 2,213,970,944 |
| messages read | 2,395 | 1,902 | 4,068 | 2,589 | 5,544 |
| time | 254.8 s | 299.3 s | 618.2 s | 407.3 s | 843.1 s |
| messages per second | 9.4 | 6.4 | 6.6 | 6.4 | 6.6 |
| MB per second | 1.72 | 3.43 | 3.31 | 2.6 | 2.5 |
| peak memory (RSS sampled every 200 ms / maxRSS) | 449 / 450 MB | 479 / 488 MB | 502 / 515 MB | 513 / 513 MB | 524 / 524 MB |
| RSS once 100 messages are read (min-max of the 5 s samples) | 349-441 MB | 337-461 MB | 341-481 MB | 315-475 MB | 327-512 MB |
| database after the run | 119 MB | 199 MB | 410 MB | 263 MB | 560 MB |

**Memory stays flat.** Twice the mailbox, about 20 MB more peak memory (MBOX 479 -> 502 MB, PST 513 -> 524 MB),
and once reading has started RSS moves in the same band for the whole file (last row; one sample every 5 s next to the
messages read by then: `captures/bigdata3b/measure/*.txt`). What does grow is the near-duplicate index BIGDATA-3
keeps in memory (about 5 KB per document; 12,139 documents fingerprinted in the 2 GB PST run, ~60 MB): it must move into
the database before BIGDATA-4 (as recorded in section 14).
The reading is a small share of the time. The readers alone (no database, no storage; `measure/reader-only-*.txt`):
1 GB MBOX 8.4 s to read every message and 21.3 s to parse each one and compute its identity (about 10% of the
299.3 s ingest); 2 GB PST 61.3 s and 56.2 s (about 14% of 843.1 s). The rest is the ingest's usual cost per stored
object: every message and every attachment is its own object and source, with its rows and audit row. One process, as before;
BIGDATA-4 is the parallel workers. The runs before the 2 GB PST's had the fake-PST writer running on one of the
PC's 32 threads; the 2 GB PST run had the machine to itself.

**Before/after (100 MB fake corpus, no mailbox in it):** outcomes identical, every row of every table identical in
every column, every decision and fingerprint identical; MCP 22 of 28 outputs byte-identical, 6 differ only in tie
order (DEV-032) and every search's complete result is identical. The one other difference: each run's
`rule_versions` lists the new rule `message-duplicate`.

### Found on the way

- **pst-extractor lost data silently** in two places (embedded messages always null; an unloadable message skipped
  with a console line): patched (D110).
- **`parseEml` dropped every attachment without a file name** (inline images, forwarded `message/rfc822` parts):
  fixed, red first (D116).
- **The free PST writer is slow for big files** (test data only): the 2 GB PST took 174.6 minutes, its speed falling
  from about 40 MB a minute to about 8 as the file grew (the library searches its allocation maps for each block);
  the 1 GB PST took 49.6 minutes (the two ran side by side). Microsoft's reader agrees with the manifest on both
  (every message by folder, every attachment row).
- **DEV-037** (recorded as asked): `get_document_page` answers "Page 1 not found" for every email and Word file.
- **DEV-038**: an interrupted mailbox is not resumed. **DEV-039**: preflight's upgrade list lacks 0029 and 0030.
  **DEV-040**: no real OST could be tested.
- Two questions for the owner (roadmap): read password-protected PSTs? (the password is only a check); should the
  person filters match Bcc?

---

## 16. BIGDATA-4: many workers, one queue (design, written before the code, 2026-09-30)

Answers 9 and 10: the queue is a table in the matter's own database; the audit chain is measured under load before
anything about it changes. One run can now be worked by many processes on one machine or by Cloud Run job tasks in
the matter's own project; each one takes items from the run's queue, and a stopped run is taken up again where it
stopped.

### The problem the design has to solve: which copy is kept

Until now one process read everything in order, so "the first copy is kept" meant "the first one read". Triage
already decides duplicates between top-level files before anything is read (D100, first in path order), but most
duplicates are only found inside things: a zip entry that is also a file elsewhere, an attachment sent many times, a
message in two mailboxes, two near-identical documents. With many workers, "the first one read" is whoever gets
there first, so the kept copy would change from run to run. A rule that depends on timing cannot be checked later.

**The fixed rule (the keep rule).** The copy that comes first in the run's **reading order** is kept:
- top-level objects in path order, as triage lists them (the order of their triage decisions);
- inside an object: the object itself first, then what it contains, in the container's own order (zip entries as the
  zip lists them, attachments as the email lists them, recursively: a pre-order walk);
- a mailbox's messages in the file's order: folder by folder in the PST's own order (as BIGDATA-3B reads it), by
  offset in an MBOX;
- anything an earlier run (or another investigation of the workspace) already holds comes before everything in a new
  run.
This is exactly the order the one-process ingest read things in, so one worker gives BIGDATA-3B's results, and any
number of workers gives the same. Near-duplicates follow the same order: a document joins the group of the most
similar first document among the documents before it in reading order (D101 unchanged).

**How it is kept whatever the timing: decide in order, write in parallel.**
1. **Discover** (parallel). A worker takes an item, reads it and lists everything the ingest would reach in it: the
   file, each zip entry, attachment and mailbox message, recursively, with its SHA-256, its message identity (D111),
   and what the rules that look only at the item itself decide (junk names, empty files, the owner's filters, too
   large, a mailbox inside a container). No document is parsed here; emails are (their attachments and headers are
   needed), and the parsed email is kept for the write, so nothing is parsed twice. These are `ingest_nodes` rows.
2. **Sequence** (in order, one at a time). The sequencer takes items strictly in reading order, and only once every
   earlier item is discovered. For each node, in pre-order: not reached (inside a skipped container), a skip by its own
   rule, a duplicate of a copy that comes before it (this run's nodes already decided, or a source the matter already
   holds), a link (the bytes are a source of another investigation), or ingest. Each kept node gets its source id
   here. Any worker runs the sequencer when it is waiting for it (a Postgres advisory lock lets one in at a time);
   deciding is a few queries per item, so it is never the slow part.
3. **Write** (parallel). The worker writes its item exactly as the one-process ingest did (the same code, the same
   rows, in the same order inside the item), except that the duplicate lookups are replaced by the sequencer's
   decisions. A duplicate decision names its original's source; if that source belongs to an earlier item still being
   written by another worker, the worker waits for it first (the rows reference it).
4. **Near-duplicates** (in order, after the write). A written document's MinHash signature goes to
   `ingest_signatures`; a near-duplicate pass (one at a time, like the sequencer) assigns groups in reading order, for
   the documents of every item before the first one not finished yet, and writes the `document_fingerprints` row.
   The index is in the database (below), so no worker holds it.

A worker holds one item in memory at a time (a file, or one part of a mailbox). While it waits for the sequencer or
for an earlier item, it gives its item back if an earlier item is waiting for a worker (a stopped worker's item, or
the parts of a mailbox just split), so N workers can never all be waiting for an item nobody is working on.

**Races.** Two copies handled at the same moment by two workers: they are decided one after the other by the
sequencer, in reading order, so one is kept and the other is a duplicate decision naming it. As a backstop the
database refuses a second kept node for the same SHA-256 or message identity in one run (partial unique indexes), so
even two sequencers at once (a broken lock) cannot keep both. Tests force both cases.

**A failure.** An item that fails after it was sequenced gives up its kept nodes; the sequencer goes back to it and
decides the later items that are not written yet again (they may now keep a copy the failed item was going to keep):
the result is what the one-process ingest gave when a file failed. A failed item the owner retries later is judged
against everything the matter holds at that time, like a new run.

### The queue (migration 0031, additive; RLS forced; answer 9)

- `ingest_work`: one row per item: a top-level file, a mailbox (its head), a part of a mailbox, or a mailbox's
  finish; its place in reading order (`top_seq`, `part_no`), state (pending, discovered, sequenced, done, failed),
  lease (worker, token, expiry), attempts, errors, result. Unique per run and place, so the queue can be built again
  from the run's triage decisions without doubling anything.
- `ingest_nodes`: what discovery found in each item and what the sequencer decided.
- `ingest_workers`: one row per worker process, with a heartbeat and what it is doing (for `ingest:status`).
- `ingest_signatures` (written documents waiting for the near-duplicate pass) and `document_lsh` (the near-duplicate
  index: each document's 32 LSH band keys in one `bigint[]` and its group) and `document_lsh_bands` (the lookup:
  one row per band key and group, found by bigint equality on its primary key; D119 says why not a GIN index on
  the array: under row-level security it is never used). Old fingerprints get
  their `document_lsh` row the first time a run needs them, in the order they were written, so their tie-breaking
  order is the one the in-memory index used.
- A partial index on the items not finished yet, in reading order (`idx_ingest_work_open`): the claim, the sequencer
  and the near-duplicate pass read the first of them without sorting every open item of the run.
- `ingest_runs.queued_at` (the queue is complete). Nothing existing is changed; the app role gets SELECT, INSERT,
  UPDATE on the queue tables (no DELETE) and SELECT, INSERT on the index tables.

**Leases.** A worker claims the earliest item it can (`FOR UPDATE SKIP LOCKED`, lowest place first), with a lease of
90 s that its heartbeat renews every 5 s. Lease times use the database clock only (the Docker VM clock jumps, but it
is one clock). A killed worker's lease runs out and the item is taken by another worker. **The fence:** every write
transaction starts by locking the item's row and checking that the lease token is still its own; the same
transaction marks the item done. A worker whose lease was taken over cannot commit, and the row lock keeps the item
from being claimed while its transaction is open.

**Retries.** Each claim is an attempt; an error is recorded on the item (history kept) and the item goes back to the
queue; after 3 attempts it is `failed`, with its last error, a `source.ingest_failed` audit row, and it is listed by
`ingest:status` and `ingest:report`. Nothing is dropped. Errors that cannot change on a retry (a zip bomb, a file
that changed since discovery) fail at once. `pnpm ingest:retry --run <id>` puts failed items back (the case owner's
command), and `ingest:resume` works them.

**Idempotency: doing an item twice creates nothing twice.**
- sources, acquisitions, instances, artifacts, content documents, blocks, chunks, decisions, audit rows: written only
  in the item's write transaction, behind the fence, which also marks the item done; a second execution finds it done.
  A mailbox part writes one message per transaction (as BIGDATA-3B did), and each message's transaction moves the
  part's progress counter from i to i + 1 behind the same fence, so message i is written exactly once.
- the failure audit row: written once, in the transaction that marks the item failed (not once per attempt).
- bucket objects: the key is the SHA-256 (as before) and the write is now create-only (`ifGenerationMatch: 0`); a
  second write of the same key is refused by the bucket and taken as "already stored" after checking that the stored
  object's SHA-256 matches. Nothing in a bucket is overwritten (it used to be, with the same bytes).
- nodes: unique per item and position; a second discovery must find the same nodes, or the item fails.
- fingerprints and LSH rows: unique per content document, written with ON CONFLICT DO NOTHING.
- the queue itself: unique per run and place.

**A big mailbox is split** so one PST of 50 GB does not hold one worker for a day. Its head item stores the file
whole and writes its parts:
- PST/OST: by folder, 50 messages per part (the folder's contents table gives the count without reading a message;
  opening the 2 GB fake PST takes 3 ms and listing its 32 folders 20 ms). A part moves the folder's cursor to its
  first message and reads its 50, with the patched reader's error records (D110) kept for its own range only.
- MBOX: by byte range, 16 MiB per part. A part starts at the first message boundary at or after its start and reads
  the messages that start before its end; the boundary is decided by the same local rule as the whole-file reader (a
  "From " line with a time, at the start of the file or after an empty line), so every message is read by exactly
  one part.
- a mailbox finish item, taken when all its parts are done, writes the mailbox's status, `mailbox_read` summary and
  `source.mailbox_read` audit row, from the parts' results (DEV-038 is this: a stopped mailbox is taken up at the
  first message not yet written).

### The audit chain (answer 10): measured first

`writeAuditEvent` locks the tenant's `audit_chain_heads` row, so the transactions of one matter that write audit rows
take turns from their first audit row to their commit. Today an item's first audit row comes after its first file is
written, so a zip or an email holds the chain while its other entries are parsed and written. The run records, per
worker, the time spent waiting for that lock and the time holding it (instrumentation only: the hash, the row, the
order in which rows are chained are untouched), for 1, 2, 4 and 8 workers. What changes, if anything, is decided
from those numbers; a change to how the chain is hashed or ordered is not made in this step (owner's rule). What the
numbers showed and what was done (rows written last in one step; hash and order unchanged): D121 and "Measured" below.

### Progress, and the case owner's two answers

- `pnpm ingest:status --run <id>`: files and bytes done and left, messages read, rate, an estimate of the time left,
  failed items with their reasons, what each worker is doing, and the kept/skipped counts; while the run goes and
  after. `matter_status` adds a short `ingest_run` block while a run is unfinished or has failed items.
- Answer 1: a password-protected PST is read; the mailbox and every message in it are marked "had a password" (the
  report, `get_source`). High encryption stays stored and listed as unreadable; nothing is ever cracked.
- Answer 2: `--person` and `--exclude-person` also look at Bcc: rules `person` and `exclude-person` version 2. Old
  decisions keep their version and are not changed.

### Cloud Run jobs (written, not deployed)

`scripts/deploy-matter.ts --phase=workers` defines two Cloud Run jobs in the matter's own project, under the
matter's own service account: `casefile-<slug>-ingest-enqueue` (one task: triage and queue a bucket prefix) and
`casefile-<slug>-ingest-workers` (N tasks, N = `matterConfig.ingestWorkers` or `--workers`; each task is one worker
of the run given at execution). They read the database URL from the matter's own secret and the bucket names from the
matter; the service account can reach only this matter's buckets and secrets (MATTER-SETUP §3). The dry run prints
both; nothing is deployed in this step.

### Found on the way: indexes under row-level security (for the search-at-scale track)

The app role works under forced row-level security, and there Postgres uses an index only for conditions built from
leakproof operators (so that a row of another tenant cannot leak through an error or a side effect before the policy
has filtered it). `=` on bigint, uuid and text is leakproof; the array operators (`&&`, `@>`), the full-text match
(`@@`: `ts_match_vq`, `ts_match_tq`), trigram similarity (`%`) and `LIKE`/`ILIKE` are not (checked in `pg_proc`,
local Postgres). So a GIN index on an array, a `tsvector` or a trigram column is never used by the app role: the
near-duplicate lookup read the whole matter's LSH rows until it moved to a band table (D119). Today's search does not
use a GIN index, so nothing is slower now; but the search-at-scale track (F7) cannot rest on a `tsvector` GIN index
queried as the app role without solving this first, and should test its plans as the app role, not as the owner
(the owner is not subject to RLS; that is how this was missed at first).

### Measured (2026-09-30; local Docker stack, one PC with 32 threads; fake data; `captures/bigdata4/measure/`)

Every run on a freshly wiped stack with a clock check first (the Windows Time service is stopped; the Docker VM clock
was 100-102 s ahead; leases use the database clock only). Worker processes are real separate processes
(`pnpm ingest:worker`), started by `measure-parallel.mts`.

**The audit chain first (answer 10), 1 GB, before anything was changed** (`chain-first-*`): the chain became the
bottleneck. Held 19.8% of the time with 1 worker, 74.9% with 8; workers waited on it 0.7% of their time with 1 and
36.4% with 8 (70.6 ms a row). The change (D121: an item's audit rows written last, in one step; the hash, the rows and
their order unchanged) and `withTenant` in one statement (D128), same 1 GB (`chain-after-*`):

| 1 GB (total time) | 1 worker | 2 | 4 | 8 |
|---|---|---|---|---|
| before: time / chain held / workers waiting | 681 s / 19.8% / 0.7% | 409 s / 33.3% / 9.5% | 289 s / 53.3% / 21.1% | 221 s / 74.9% / 36.4% |
| after: time / chain held / workers waiting | 613 s / 4.2% / 0.4% | 339 s / 7.9% / 0.5% | 218 s / 16.3% / 0.6% | 154 s / 24.4% / 0.7% |

The chain verified after every run; the kept/skipped and near-duplicate listings are identical for 1, 2, 4 and 8
workers and before/after (9,843 lines).

**10 GB** (10GB-42, 10,737 MB, 51,279 queued items; `formal-10GB-w*`):

| 10 GB | 1 worker | 2 | 4 | 8 |
|---|---|---|---|---|
| total time (triage and queue 40-48 s of it) | 5,936 s | 3,411 s | 2,219 s | 1,723 s |
| throughput | 1.81 MB/s | 3.15 MB/s | 4.84 MB/s | 6.23 MB/s |
| items / s (top-level) | 8.7 | 15.2 | 23.6 | 30.6 |
| peak memory, the largest worker | 612 MB | 587 MB | 566 MB | 540 MB |
| database after | 8,441 MB | 8,477 MB | 8,487 MB | 8,490 MB |
| chain: workers waiting / held | 0.5% / 4.4% | 0.5% / 8.6% | 0.6% / 17.1% | 0.5% / 24.1% |
| scorecard | 0 missing | 0 missing | 0 missing | 0 missing |

- Every run: kept/skipped listing (97,845 lines) and near-duplicate links (1,526, the same number as BIGDATA-3's
  one-process run) identical to the 1-worker run; audit chain valid (97,848 rows); no item failed; 0 missing from the
  manifest (98,639 rows; 765 zips inside zips read in place, 1,425 files inside containers that were not read). The
  36 paths with two sources are attachments with the same name in one email and other bytes (DEV-042).
- For comparison, BIGDATA-3's one process: 4,870 s (2.10 MB/s), 1,134 MB peak (its near-duplicate index in memory),
  database 7,800 MB. One worker is 22% slower than that process (the queue, the sequencer and the node rows cost
  about 21 ms an item); two are faster.
- **Memory stays flat.** A worker's working set, sampled every 30 s (`rss-samples.tsv`, `rss-by-quarter.txt`),
  median by quarter of the 10 GB run: 490, 516, 524, 516 MB (1 worker); 438-484 MB each with 8. It does not grow with
  the case: the near-duplicate index is in the database, and a worker process keeps no per-item results (it did, and
  grew to 748 MB at 10 GB; fixed, the series was run again).
- The database grows by 641 MB against BIGDATA-3 at 10 GB: `document_lsh_bands` 397 MB, `ingest_signatures` 103 MB,
  `ingest_nodes` 62 MB, `ingest_work` 43 MB.
- Where a worker's time goes (1 worker / 8 workers): writing the item 75% / 76%, waiting for the sequencer 11% / 14%,
  recording the item's nodes 6% / 4%, claiming 5% / 4%, the near-duplicate pass 1.7% / 1.2%. With 8 workers the write
  itself takes 2.3 times as long per item as with one: the database shows 1.8 active backends on average and almost no
  lock waits (0.075), and neither container was busy (Postgres 30%, fake-gcs 27% CPU, median, of 3,200%, during the
  4-worker PST run). What the eight share on this PC (one disk for the corpus, the Docker VM and the workers) was not
  isolated; the cloud does not share it (below).

**Mailboxes** (`formal-pst2GB-*`, `formal-mailboxes-*`):

| | 1 worker | 4 workers |
|---|---|---|
| pst-2GB (one 2 GB PST, 5,544 messages, 115 parts) | 770 s, 2.87 MB/s, 7.2 messages/s, 650 MB | 323 s, 6.85 MB/s, 17.2 messages/s, 639 MB |
| mailboxes-42 (the standard set) | 212 s, 2.38 MB/s, 11.4 messages/s, 535 MB | 90 s, 5.60 MB/s, 26.7 messages/s, 526 MB |

BIGDATA-3B read the same 2 GB PST in one process in 843 s (6.6 messages/s, 2.5 MB/s; one file held one process); the
split lets 4 workers share it (DEV-038). Both mailbox scorecards: 0 missing, 0 failed for the PST; the standard set's 20
unreadable messages (the damaged and cut mailboxes) as in 3B, and 18 attachments more than 3B: the password PST's,
read now (D125). Listings identical for 1 and 4 workers.

**Resume** (`captures/bigdata4/resume/`, leases 20 s):
- A. pst-2GB, 4 workers killed (SIGKILL) 113 s into the run: the head written, 34 parts done, 2 parts half-written
  (their messages part-way), 1 leased. `pnpm ingest:resume --workers 4` in a new process: all 117 items done;
  kept/skipped (14,754 lines) and near-duplicate links (105) identical to the uninterrupted 1-worker run; the
  mailbox scorecard 0 missing, 0 failed; chain valid (14,758 rows).
- B. 1 GB, the whole stack killed (`docker compose kill`, SIGKILL; not `down -v`) 62 s in, with 1,528 items done and
  4 leased; the workers died with it. `docker compose up -d` (Postgres recovered from its WAL), then
  `pnpm ingest:resume --workers 4`: all 5,085 items done; listings identical to the uninterrupted 1 GB run (9,843
  and 152 lines); scorecard 0 missing, nothing doubled; chain valid (9,846 rows).

**Stopped on the way (kept in `measure\dev\formal-attempt1..5-*`):** the first 10 GB runs slowed down as the matter
grew. Attempts 1 and 2: the near-duplicate lookup read every LSH row (a prepared statement's generic plan was
suspected, then a custom plan was seen doing the same). Attempt 3: one lookup per key, no better; the plan as the app
role showed why: under RLS the GIN index cannot be used at all (above; D119). Attempt 4: started without a
notification, stopped at once. Attempt 5: memory grew to 748 MB (the per-item results). The table above is attempt 6,
the code as committed.

**The 100 MB before/after capture** (100MB-42; `captures/bigdata4/diff-before-vs-after*.txt`): outcomes identical;
every row of every captured table identical, column by column; the 9 MCP tools: 21 of 28 outputs byte-identical,
6 differ only in the order inside one file's tie group (list_documents and 5 searches; D97, DEV-032), with every
search's complete result over all pages identical, and matter_status lists the same four status counts in another
key order (a `GROUP BY` without `ORDER BY`, older than this step: the before capture's own two passes differ the same
way; DEV-045). The first after capture stopped on a 60 s MCP time-out that did not come back (one search takes 0.35 s
on this data); kept.

**Estimate: 1 TB and 5 TB with N cloud workers.** An ESTIMATE from the numbers above, not a measurement. Assumptions:
the fake corpus' mix (4.78 top-level items per MB; real cases with bigger files have fewer items per MB and go
faster), no OCR (BIGDATA-5), one Cloud SQL instance, GCS. Per worker: 1.81 MB/s alone (the 1-worker run, nothing
shared) down to 0.78 MB/s (8 workers on one PC). What does not scale with workers is serial and in the database:

| serial stage | cost per item, measured | at most |
|---|---|---|
| the sequencer (decides in reading order, one at a time) | 12.1 ms (1 worker, one item a call: an upper bound) | about 83 items/s = **17 MB/s** |
| the audit chain head | 5.0 ms held (1 worker) to 7.9 ms (8 workers) | 127-200 items/s = 27-42 MB/s |
| the near-duplicate pass | 2.0-3.1 ms | 320-500 items/s = 67-105 MB/s |

| | 8 workers | 16 workers | 32 workers or more |
|---|---|---|---|
| rate | 6.2 MB/s (measured, local) to 14.5 MB/s | 12.5 to 17 MB/s | about 17 MB/s (the sequencer's limit) |
| 1 TB (1,048,576 MB) | 20 to 47 hours | 17 to 23 hours | about 17 hours |
| 5 TB | 4 to 10 days | 3.5 to 5 days | about 3.5 days |

**The bottleneck will be the database, through the sequencer first** (every item is decided there, in order, one
decision at a time), then the audit chain head. Not the bucket (GCS scales with writers), not parsing (it scales with
workers). The sequencer's 12 ms is measured with one item per call; with many workers it decides up to 200 per
transaction, so the real limit may be higher; that has to be measured on a Cloud SQL instance before a 5 TB case is
promised. The database's size is the other limit: 0.79 MB of database per MB of corpus here (content blocks and
chunks), so about 800 GB at 1 TB and 4 TB at 5 TB. That is a sizing and search-at-scale question (answer 11), not a
BIGDATA-4 one.

---

## Evidence

`captures/<step>/`, here and throughout this plan, is that step's capture folder (measurements, probes, red/green
runs). The capture folders are kept outside the repository and are not published; the numbers they hold are the
ones quoted in this plan.

BIGDATA-4: `captures/bigdata4/` (its `README.txt` lists every file).

BIGDATA-3B: `captures/bigdata3b/` (its `README.txt` lists every file).

BIGDATA-3: `captures/bigdata3/` (its `README.txt` lists every file).

BIGDATA-2B: `captures/bigdata2b/` (its `README.txt` lists every file).

BIGDATA-2A: `captures/bigdata2a/` (its `README.txt` lists every file).

BIGDATA-1: `captures/bigdata1/`:
- generator runs: `generate-*.txt`, `manifest-summary-*.json`, `manifest-counts-*.txt`;
- baseline runs: `baseline-run-*.log`, `baseline-*.txt/.json`;
- CPU profiles: `cpuprofile-*.cpuprofile` and `-summary.txt`;
- the batching prototype and its output: `prototype-batch-insert.mts`, `-output.txt`;
- the scanned-page count and local OCR timing: `scanned-pages-and-local-ocr.txt`;
- the Windows Time status: `w32tm-status.txt`;
- red/green captures: `red-green/`.
