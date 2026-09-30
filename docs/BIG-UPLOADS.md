# Big uploads: getting 1-5 TB into a case

How to get a large set of documents (1 to 5 TB) into a case's sources bucket, how long each way takes roughly,
and how to ingest it with many workers afterwards.

**What was tested and what was not** (read this first):

| Part | Status |
|---|---|
| `pnpm ingest --bucket` reading a bucket, with triage, the work queue, many workers, resume and retry | **Tested** against the local fake Cloud Storage (fake-gcs), with fake data. Measured from a local folder: 10 GB with 1 to 8 workers. |
| The three upload methods below (`gcloud storage cp`, Storage Transfer Service, Transfer Appliance) | **Not tested** by this project. They are Google's tools; the steps come from Google's documentation. Check the current documentation before relying on them. |
| The Cloud Run jobs for many workers (`deploy-matter --phase=workers`) | **Written, never deployed** (D124). |
| The times below | **Rough estimates**: network arithmetic for uploads, and PLAN-BIG-DATA section 16 for ingestion (from one local PC). |

The case's bucket is `casefile-<matter>-sources` in the case's own Google Cloud project (MATTER-SETUP.md). Upload
into it and nowhere else: `pnpm ingest --bucket` refuses a bucket that is not one of the case's own or listed in
`ingestBuckets` in `matter.config.ts`. Uploading never changes anything Casefile has already read. Ingestion only
reads the bucket; it never writes to or deletes from it.

## 1. Choosing a way

| Your data is | Use | Rough time for 1 TB / 5 TB |
|---|---|---|
| On a computer or file server with a good connection | `gcloud storage cp` (section 2) | 100 Mbit/s: about 1 day / 5 days. 1 Gbit/s: about 3 hours / 14 hours. 10 Gbit/s: under an hour / about 1.5 hours, if the disks keep up. |
| In another cloud (Amazon S3, Azure), or on many servers, or you want scheduling and automatic retries | Storage Transfer Service (section 3) | Limited by the source's bandwidth, as above. |
| Too big, or the connection too slow (for example 5 TB over 100 Mbit/s would take about 5 days of full use) | Transfer Appliance (section 4) | Usually weeks end to end (ordering, shipping both ways, Google loading it). Check Google's current times. |

The arithmetic: 1 TB is about 8,000,000 megabits, so at 100 Mbit/s it takes about 80,000 s (22 hours) at full
speed, and at 1 Gbit/s about 2.2 hours. Real transfers rarely use the whole connection: allow 20-30% more.

## 2. `gcloud storage cp` (from your own machine or server)

```bash
gcloud auth login
gcloud config set project <GCP_PROJECT_ID>
gcloud storage cp --recursive "/path/to/case-documents" gs://casefile-<matter>-sources/<batch-name>/
```

- `gcloud storage` uploads several files at once and splits big files into parts by itself. For many small
  files, run a few copies in parallel on different folders.
- If it stops, run the same command again with `--no-clobber` (skip files already there):
  `gcloud storage cp --recursive --no-clobber ...`.
- Check what arrived: `gcloud storage du --summarize gs://casefile-<matter>-sources/<batch-name>/`.
- Keep the originals until the ingest report is checked.

## 3. Storage Transfer Service

Google's managed service for large or repeated transfers: from Amazon S3, Azure, an HTTP list of files, or, with
its agents installed on your servers, from a file system. It retries, checks and can run on a schedule. Set it up
in the Cloud Console (Data Transfer), or with `gcloud transfer jobs create`, with the case's sources bucket as
the destination. The agents for file systems need a machine that can see the files and reach Google Cloud.

## 4. Transfer Appliance

A physical storage device Google ships to you. You copy the data onto it, ship it back, and Google loads it into
your bucket. It is ordered from the Cloud Console (Data Transfer, Transfer Appliance), and it has costs and
lead times of its own. Use it when the network would take too long. Ask for the destination to be the case's
sources bucket, in the case's own project and region.

## 5. Ingest it with workers

Once the files are in the bucket:

```bash
pnpm matter:check                                              # the case's settings, buckets and project
pnpm ingest --bucket casefile-<matter>-sources --prefix <batch-name>/ --investigation <id> --workers 8
pnpm ingest:status --run <run id> --watch
```

- Or build the queue once (`--enqueue-only`) and start workers anywhere that reaches the database and the bucket,
  or as Cloud Run job tasks. The Cloud Run jobs have not been deployed yet; see "Not tested" above.
- Stopping, resuming and retrying: RUNBOOK-INGEST.md section 4e. A stopped run is resumed with
  `pnpm ingest:resume --run <run id> --workers 8`; nothing is missed or read twice.
- Rough ingestion time: 8 workers read 6.2 MB/s on one local PC (10 GB in about 29 minutes). The estimate for 1 TB
  is 17-47 hours and for 5 TB 3.5-10 days with 8-32 cloud workers, limited by the database (PLAN-BIG-DATA
  section 16). This is an estimate, not a measurement.
- Scanned documents are stored and marked `needs_ocr`; there is no OCR yet (KNOWN-LIMITATIONS.md).
- Afterwards: `pnpm ingest:report --run <run id>` lists every file set aside and why.

## 6. Checks before and after

- Before: the bucket is in the case's own project and region (`pnpm matter:check`), and nobody else has access to
  it.
- After the upload: the file count and total size in the bucket match the source.
- After the ingest: `pnpm ingest:status --run <run id>` shows 0 left and lists any failed items, with their reasons;
  retry them with `pnpm ingest:retry --run <run id>`.
