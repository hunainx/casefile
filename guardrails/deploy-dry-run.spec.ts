/**
 * `scripts/deploy-matter.ts --dry-run` runs nothing (D84).
 *
 * Every way the script can act on the world is replaced by a spy that records the call and
 * throws: child_process (gcloud, docker, supabase), the postgres driver, the migration runner,
 * the tenant bootstrap, and file writes. A dry run of each phase for a fake matter must record
 * no call at all, print every step (the Cloud Run deploy command included), mask every secret
 * value of the env file, and leave the env file byte-identical.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", () => {
  const refuse = (name: string) => (...args: unknown[]) => {
    calls.push(`child_process.${name}: ${String(args[0])}`);
    throw new Error(`child_process.${name} called during --dry-run`);
  };
  return {
    execSync: refuse("execSync"), exec: refuse("exec"), execFile: refuse("execFile"),
    execFileSync: refuse("execFileSync"), spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), fork: refuse("fork"),
  };
});
vi.mock("postgres", () => ({
  default: (...args: unknown[]) => {
    calls.push(`postgres(${String(args[0])})`);
    throw new Error("postgres() called during --dry-run");
  },
}));
vi.mock("../packages/db/migrate/index.js", () => ({
  migrate: (...args: unknown[]) => {
    calls.push(`migrate(${JSON.stringify(args)})`);
    throw new Error("migrate() called during --dry-run");
  },
}));
vi.mock("../tools/ingest-cli/src/bootstrap.js", () => ({
  bootstrap: (...args: unknown[]) => {
    calls.push(`bootstrap(${JSON.stringify(args)})`);
    throw new Error("bootstrap() called during --dry-run");
  },
  upsertEnvFile: (...args: unknown[]) => {
    calls.push(`upsertEnvFile(${String(args[0])})`);
    throw new Error("upsertEnvFile() called during --dry-run");
  },
}));

const { deployMatter } = await import("../scripts/deploy-matter.js");

// Fake values only. The secrets are made up and must never be printed. Names derived from the
// matter are built from M, as the deploy script builds them (matter-template.spec.ts Step 13a).
const M = "fakematter";
const SERVICE_URL = `https://${M}-api.casefile.test`;
const FAKE = {
  owner: "fake-owner-pw-6f1c2a",
  app: "fake-app-pw-93b7d0",
  jwt: "fake-jwt-secret-value-0123456789abcdef0123",
  supabaseToken: "sbp_fakefakefakefakefake0000",
};
const ENV_LINES = [
  `DATABASE_URL=postgresql://casefile_app.fakeref:${FAKE.app}@aws-0-europe-west-2.pooler.supabase.com:5432/postgres`,
  `DATABASE_URL_MIGRATIONS=postgresql://postgres.fakeref:${FAKE.owner}@aws-0-europe-west-2.pooler.supabase.com:5432/postgres`,
  `JWT_SECRET=${FAKE.jwt}`,
  `SUPABASE_ACCESS_TOKEN=${FAKE.supabaseToken}`,
  "GCP_PROJECT_ID=casefile-fakematter",
  "GCP_REGION=europe-west2",
  "SUPABASE_REGION=europe-west-2",
  "MATTER_TENANT_ID=11111111-2222-4333-8444-555555555555",
  "MATTER_INVESTIGATION_ID=66666666-7777-4888-9999-000000000000",
  `SERVICE_URL=${SERVICE_URL}`,
  `MCP_PUBLIC_URL=${SERVICE_URL}/mcp`,
  "MCP_OAUTH_TRUSTED_CLIENTS=https://claude.ai/oauth/claude-code-client-metadata,https://claude.ai/oauth/fake-hosted-client-metadata",
  `RP_ID=${M}-api.casefile.test`,
  "TRUST_PROXY_HOPS=1",
];

describe("deploy-matter --dry-run runs no command", () => {
  let dir: string;
  let envFile: string;
  let before: string;
  const saved: Record<string, string | undefined> = {};
  const out: string[] = [];
  const writes: string[] = [];
  const spies: { mockRestore(): void }[] = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "casefile-deploy-dry-run-"));
    envFile = join(dir, ".env.fakematter");
    fs.writeFileSync(envFile, ENV_LINES.join("\n") + "\n");
    before = createHash("sha256").update(fs.readFileSync(envFile)).digest("hex");
    // What runCli() does with --env: the file's values win over the shell.
    for (const line of ENV_LINES) {
      const k = line.slice(0, line.indexOf("="));
      saved[k] = process.env[k];
      process.env[k] = line.slice(line.indexOf("=") + 1);
    }
    const record = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    spies.push(vi.spyOn(console, "log").mockImplementation(record));
    spies.push(vi.spyOn(console, "warn").mockImplementation(record));
    for (const fn of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "copyFileSync"] as const) {
      spies.push(vi.spyOn(fs, fn).mockImplementation(((p: unknown) => { writes.push(`fs.${fn}(${String(p)})`); }) as never));
    }
  });

  afterAll(() => {
    for (const s of spies) s.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const phase of ["service", "all", "database"] as const) {
    it(`phase ${phase}: nothing is run, connected to or written; every step is printed`, async () => {
      calls.length = 0;
      writes.length = 0;
      out.length = 0;
      await deployMatter("fakematter", "fakereffakereffakere", phase, "admin@fakematter.test", { dryRun: true, envFile });
      const printed = out.join("\n");

      expect(calls, "no command, database connection, migration or bootstrap").toEqual([]);
      expect(writes, "no file written").toEqual([]);
      expect(createHash("sha256").update(fs.readFileSync(envFile)).digest("hex")).toBe(before);

      for (const secret of Object.values(FAKE)) expect(printed).not.toContain(secret);
      expect(printed).toMatch(/DRY RUN — NOTHING WILL BE RUN OR WRITTEN/);
      expect(printed).toMatch(new RegExp(`DRY RUN COMPLETE FOR FAKEMATTER \\(PHASE ${phase.toUpperCase()}\\)`));
      if (phase !== "database") {
        expect(printed).toContain("[dry-run] local: docker build --platform=linux/amd64 -t europe-west2-docker.pkg.dev/casefile-fakematter/casefile/casefile-api:fakematter .");
        expect(printed).toContain("[dry-run] artifact registry (write): docker push europe-west2-docker.pkg.dev/casefile-fakematter/casefile/casefile-api:fakematter");
        expect(printed).toContain(`[dry-run] gcloud (write): gcloud.cmd run deploy casefile-${M}-api --image=`);
        expect(printed).toContain("JWT_SECRET=casefile-fakematter-jwt-secret:latest");
        expect(printed).not.toMatch(/MCP_TOKEN=/);
        expect(printed).toContain(`--set-env-vars="^;^MCP_PUBLIC_URL=${SERVICE_URL}/mcp;`);
        expect(printed).toContain(`;MCP_OAUTH_TRUSTED_CLIENTS=https://claude.ai/oauth/claude-code-client-metadata,https://claude.ai/oauth/fake-hosted-client-metadata;RP_ID=${M}-api.casefile.test;TRUST_PROXY_HOPS=1" --port=8080`);
      }
      if (phase !== "service") {
        expect(printed).toMatch(/\[dry-run\] database: connect to DATABASE_URL_MIGRATIONS \(postgresql:\/\/postgres\.fakeref:\*\*\*@/);
        expect(printed).toMatch(/0027_totp_last_step\.sql/);
        expect(printed).toMatch(/gcloud \(write\): gcloud\.cmd secrets versions add casefile-fakematter-database-url --data-file=- .*\(value on stdin: \*\*\*/);
      }
    });
  }

  it("BIGDATA-4: phase workers defines the two Cloud Run jobs in the matter's own project, as its own service account, reaching only its own secret and buckets; nothing is run", async () => {
    calls.length = 0;
    writes.length = 0;
    out.length = 0;
    await deployMatter("fakematter", "fakereffakereffakere", "workers", "", { dryRun: true, envFile, workers: 12 });
    const printed = out.join("\n");
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
    for (const secret of Object.values(FAKE)) expect(printed).not.toContain(secret);
    const jobs = printed.split("\n").filter((l) => l.includes("gcloud.cmd run jobs deploy"));
    expect(jobs).toHaveLength(2);
    const [enqueue, workers] = [jobs.find((l) => l.includes(`casefile-${M}-ingest-enqueue `))!, jobs.find((l) => l.includes(`casefile-${M}-ingest-workers `))!];
    for (const job of [enqueue, workers]) {
      expect(job).toContain("--project=casefile-fakematter");
      expect(job).toContain("--region=europe-west2");
      expect(job).toContain(`--service-account=casefile-${M}-sa@casefile-fakematter.iam.gserviceaccount.com`);
      expect(job).toContain(`--image=europe-west2-docker.pkg.dev/casefile-fakematter/casefile/casefile-api:${M}`);
      expect(job).toContain(`--set-secrets="DATABASE_URL=casefile-${M}-database-url:latest"`);
      expect(job).toContain(`GCS_BUCKET_SOURCES=casefile-${M}-sources`);
      expect(job).toContain("MATTER_TENANT_ID=11111111-2222-4333-8444-555555555555");
      expect(job).toContain("MATTER_INVESTIGATION_ID=66666666-7777-4888-9999-000000000000");
      // Every Casefile resource the job names is this matter's (the image, checked above, is in the
      // matter's own project's registry: its repository name, casefile-api, is the same for every matter).
      const withoutImage = job.replace(/--image=\S+/, "");
      for (const name of withoutImage.match(/casefile-[a-z0-9-]+/g) ?? []) expect(name.startsWith(`casefile-${M}`), name).toBe(true);
    }
    expect(workers).toContain("--tasks=12");
    expect(workers).toContain("--parallelism=12");
    expect(workers).toContain("tools/ingest-cli/src/worker.ts");
    expect(enqueue).toContain("--tasks=1");
    expect(enqueue).toContain("tools/ingest-cli/src/ingest.ts");
    expect(enqueue).toContain("--enqueue-only");
    expect(printed).toMatch(/DRY RUN COMPLETE FOR FAKEMATTER \(PHASE WORKERS\)/);
    // Without --workers, the matter's setting.
    out.length = 0;
    await deployMatter("fakematter", "fakereffakereffakere", "workers", "", { dryRun: true, envFile });
    expect(out.join("\n")).toMatch(/--tasks=8 --parallelism=8/);
  });

  it("--no-build skips the image build and push", async () => {
    calls.length = 0;
    out.length = 0;
    await deployMatter("fakematter", "fakereffakereffakere", "service", "", { dryRun: true, envFile, noBuild: true });
    const printed = out.join("\n");
    expect(calls).toEqual([]);
    expect(printed).not.toMatch(/docker build|docker push/);
    expect(printed).toMatch(/--no-build: redeploying the image already at/);
  });

  it("a dry run missing DATABASE_URL_MIGRATIONS stops with the reason, having run nothing", async () => {
    calls.length = 0;
    delete process.env.DATABASE_URL_MIGRATIONS;
    await expect(deployMatter("fakematter", "fakereffakereffakere", "database", "admin@fakematter.test", { dryRun: true, envFile })).rejects.toThrow(/DATABASE_URL_MIGRATIONS/);
    expect(calls).toEqual([]);
  });
});
