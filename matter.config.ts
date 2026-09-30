/**
 * Matter Template Configuration
 *
 * Single source of truth for matter parameters.
 * When copying this repository for a new matter:
 * 1. Edit this file with your matter name and objective.
 * 2. Copy .env.matter.example to .env and fill in the database credentials.
 * 3. Run `pnpm matter:check` to validate template consistency.
 */

export interface MatterConfig {
  /** Display name of the matter */
  matterName: string;
  /** Unique lowercase slug used in bucket names and secret IDs */
  matterSlug: string;
  /** Primary investigation name */
  investigationName: string;
  /** Legal or investigative objective */
  objective: string;
  /** Supabase Project Reference (e.g. <SUPABASE_PROJECT_REF>) */
  supabaseProjectRef: string;
  /** Storage bucket configuration */
  buckets: {
    sources: string;
    artifacts: string;
    exports: string;
  };
  /**
   * Additional buckets this matter is permitted to ingest from in bucket mode
   * (`pnpm ingest --bucket <name>`). Empty unless a bucket is added here deliberately.
   * `pnpm ingest` refuses any --bucket that is not one of `buckets.*` or listed here,
   * and `pnpm matter:check` refuses a .env whose GCS_BUCKET_* values fall outside the
   * same set. This is the only place a foreign bucket can be bound to a matter.
   */
  ingestBuckets: string[];
  /** Secret Manager secret names */
  secrets: {
    dbUrl: string;
    jwtSecret: string;
    encryptionKey: string;
    auditPepper: string;
  };
  /** Google Cloud Project ID (strictly required, no fallbacks) */
  gcpProjectId: string;
  /** Google Cloud Region (strictly required, e.g. europe-west2) */
  gcpRegion: string;
  /** Supabase Region (strictly required, e.g. eu-west-2) */
  supabaseRegion: string;
  /**
   * BIGDATA-4: how many ingest workers (Cloud Run job tasks) share a run's queue when the matter's
   * ingest jobs are defined (`scripts/deploy-matter.ts --phase=workers`; `--workers N` overrides it).
   */
  ingestWorkers: number;
}

export const matterConfig: MatterConfig = {
  matterName: "<MATTER_NAME>",
  matterSlug: "<MATTER_SLUG>",
  investigationName: "<INVESTIGATION_NAME>",
  objective: "<OBJECTIVE>",
  supabaseProjectRef: "<SUPABASE_PROJECT_REF>",
  buckets: {
    sources: "casefile-<MATTER_SLUG>-sources",
    artifacts: "casefile-<MATTER_SLUG>-artifacts",
    exports: "casefile-<MATTER_SLUG>-exports",
  },
  ingestBuckets: [],
  secrets: {
    dbUrl: "casefile-<MATTER_SLUG>-db-url",
    jwtSecret: "casefile-<MATTER_SLUG>-jwt-secret",
    encryptionKey: "casefile-<MATTER_SLUG>-encryption-key",
    auditPepper: "casefile-<MATTER_SLUG>-audit-pepper",
  },
  gcpProjectId: "<GCP_PROJECT_ID>",
  gcpRegion: "<GCP_REGION>",
  supabaseRegion: "<SUPABASE_REGION>",
  ingestWorkers: 8,
};

/**
 * Buckets no matter may use are set at run time, outside the repository: CASEFILE_RESERVED_BUCKETS (comma-separated
 * names), read by `pnpm matter:check` (Check 10). Check 12 already keeps a matter on its own casefile-<slug>-*
 * buckets and those listed in ingestBuckets.
 */

export default matterConfig;
