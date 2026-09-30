/**
 * GUARDRAIL: reserved buckets are refused, and the template names none.
 *
 * `pnpm matter:check` refuses a matter's .env that points at a bucket no matter may use (Check 10). Which buckets
 * those are is local knowledge (for example another deployment's), so it is set at run time, outside the
 * repository: CASEFILE_RESERVED_BUCKETS (comma-separated names). The template holds no list, no names and no
 * hashes of them. Check 12 already keeps a matter on its own casefile-<slug>-* buckets and those listed in
 * ingestBuckets.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as config from "../matter.config.js";
import { matterConfig } from "../matter.config.js";
import { isReservedBucket } from "../scripts/matter-check.js";

describe("GUARDRAIL: reserved buckets are refused at run time, and the template names none", () => {
  afterEach(() => {
    delete process.env.CASEFILE_RESERVED_BUCKETS;
  });

  it("matter.config.ts exports no list of reserved buckets", () => {
    expect(Object.keys(config).filter((k) => /RESERVED/i.test(k))).toEqual([]);
  });

  it("a bucket named in CASEFILE_RESERVED_BUCKETS is refused; a matter's own buckets are not", () => {
    process.env.CASEFILE_RESERVED_BUCKETS = "casefile-reserved-synthetic-sources, casefile-reserved-synthetic-exports";
    expect(isReservedBucket("casefile-reserved-synthetic-sources")).toBe(true);
    expect(isReservedBucket("casefile-reserved-synthetic-exports")).toBe(true);
    expect(isReservedBucket(matterConfig.buckets.sources)).toBe(false);
    expect(isReservedBucket("casefile-acme-sources")).toBe(false);
  });

  it("without CASEFILE_RESERVED_BUCKETS, no bucket is reserved", () => {
    expect(isReservedBucket("casefile-reserved-synthetic-sources")).toBe(false);
    expect(isReservedBucket("casefile-localtest-sources")).toBe(false);
  });
});
