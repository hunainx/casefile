# CASEFILE DEVIATIONS

Every place the code intentionally differs from `PRD.md`.

`PRD.md` is never edited (the single exception is the one-time rename for public release,
decision D63). When the specification is wrong, impractical, or
underspecified — which will happen — the deviation is recorded here, the corresponding
requirement in `traceability/requirements.yaml` is set to `status: deviated` with the
deviation ID in its `notes`, and it is raised with the user at the next checkpoint.

**A deviation on I1–I10 requires explicit user sign-off in the conversation.** None of
the deviations below touch an invariant.

`deviated` is not `waived`. A waiver means the user has agreed a requirement is out of
scope for now, and requires the user's own words quoted in the requirement's `notes`.

| Field | Meaning |
|---|---|
| Requirement | The `requirements.yaml` id, or `(bootstrap)` for infrastructure decisions predating the database |
| PRD says | What the specification requires |
| We do | What the code does instead |
| Why | The reason, stated so a reviewer can disagree with it |
| Consequence | What is now different, including anything that got worse |
| Raised | Whether the user has seen it |

---

## DEV-001 — Local Postgres is brought up natively when Docker is unavailable

- **Requirement:** (bootstrap) — D36, PRD §44
- **PRD says:** D36 specifies a Docker Compose stack (Postgres 16 + pgvector + pg_trgm,
  MinIO, Redis, mock model provider) as the local environment.
- **We do:** `infra/compose.yml` remains the documented default and is unchanged. In
  addition, `scripts/dev-db.sh` brings up an identical Postgres 16 cluster natively —
  same version, same extensions, same port, same roles, same `DATABASE_URL` — for
  environments without a Docker daemon.
- **Why:** The cloud workspace this repository was bootstrapped in has no Docker daemon,
  and D35 forbids substituting a mock database: tenancy (I7) and the assertion CHECK
  constraints (I2) are properties of a real Postgres, and testing them against a mock
  would make the guardrail suites pass vacuously. Blocking the bootstrap on Docker would
  have meant either no integration tests or fake ones. Both are worse.
- **Consequence:** Two supported ways to reach the same database, which is two things to
  keep in sync. `infra/ci/init-db.sql` is shared between them and is the single place
  roles and extensions are defined, which bounds the drift. MinIO and Redis have no
  native equivalent in the script; work that needs them requires either Docker or a
  remote instance. CI uses the Docker path, so the compose definition stays exercised.
- **Raised:** Session 1.

---

## DEV-002 — `divergence_notices` table added; PRD §59 has no table for it

- **Requirement:** `REQ-KNW-DIV-001` (PRD amendment)
- **PRD says:** §6.3 specifies `DivergenceNotice` as the mechanism by which machine-plane
  recomputation reports a disagreement with a record-plane row without mutating it
  (invariant I3). §59 defines no table for it. The PRD's own consistency audit (§68)
  identifies this gap.
- **We do:** Add the table in E4:
  ```sql
  divergence_notices (id, tenant_id, investigation_id, record_assertion_id,
                      proposed_value JSONB, transform, transform_version,
                      detected_at, status ENUM(open, accepted, dismissed),
                      resolved_by, resolved_at, rationale)
  ```
- **Why:** I3 is unimplementable without somewhere to put the notice. Step 4 of the
  Assertion Service write path returns a divergence notice rather than writing, and a
  returned object that is never persisted is a silent discard of exactly the signal the
  invariant exists to preserve.
- **Consequence:** One table not in the specification. It follows §59.1 conventions and
  is RLS-scoped like every other tenant table, so nothing else changes.
- **Raised:** Session 1 — identified in the handoff brief, not yet built.

---

## DEV-003 — Python 3.11 in the bootstrap environment; D31 specifies 3.12

- **Requirement:** (bootstrap) — D31
- **PRD says:** Not a PRD matter. D31 in `DECISIONS.md` specifies Python 3.12 for the
  worker tier.
- **We do:** `traceability/extract.py` and `evals/harness/run.py` are written to run on
  3.11+ and carry no 3.12-only syntax. CI pins 3.12. Worker code, when it lands in E3,
  targets 3.12.
- **Why:** The bootstrap environment ships 3.11. The two scripts written in session 1 are
  tooling, not worker code, and there is no reason for them to require a newer runtime
  than the environment that has to run them.
- **Consequence:** Tooling is portable across 3.11 and 3.12; the worker tier is not
  affected. If a future tooling script needs 3.12 syntax, this deviation ends and `uv`
  pins the interpreter.
- **Raised:** Session 1.

---

## DEV-004 — Supabase replaces self-hosted Postgres

- **Requirement:** (platform) — D33, D36, D42
- **PRD says:** §44 specifies Postgres for relational, FTS, vector and graph workloads (D12).
  It does not specify who operates it. D33/D36 assumed a self-hosted Postgres 16.
- **We do:** Supabase managed Postgres, with `vector` and `pg_trgm` enabled. Migrations
  remain plain reviewable SQL owned by `packages/db` — Supabase's migration folder is
  where they live, not a replacement for owning them.
- **Why:** The user's choice, and a sound one for a founding team: managed backups, PITR,
  and no cluster to operate. Nothing in §44 or D12 is about self-hosting.
- **Consequence:** Three things change and each is pinned by a decision rather than left
  to care and attention:
  - The secret / `service_role` key carries `BYPASSRLS` and would silently disable tenant
    isolation product-wide if it reached a request path (**D45**, enforced by a guardrail).
  - Connection pooling means session state can outlive a request, so tenant context is set
    with `SET LOCAL` inside a transaction and never at session level (**D44**).
  - Persistent servers use the direct connection on 5432; the transaction pooler on 6543
    does not support prepared statements (**D46**).

  `scripts/dev-db.sh` is retained for offline work and for CI, so the suite still runs with
  no network and no Supabase project. Both paths produce the same `DATABASE_URL` shape.
- **Raised:** Session 2 — the user's decision.

---

## DEV-005 — Google Cloud Storage replaces MinIO/S3

- **Requirement:** (platform) — §44, D36, D43
- **PRD says:** §44 requires content-addressed storage with versioning, WORM semantics for
  evidence (T7), and tenant-prefixed keys. D36 named MinIO for local development.
- **We do:** Google Cloud Storage. Object Versioning for revision history, a **locked**
  bucket retention policy for the evidence bucket, and Object Retention Lock for
  per-object legal hold (§50).
- **Why:** The user's files already live in a GCS bucket. This is also a genuine
  improvement on T7 rather than a lateral move: versioning alone is not WORM, because a
  noncurrent version can be permanently deleted by anyone who can name its generation
  number. A locked retention policy is irreversible and cannot be shortened, which is what
  "insider cannot tamper with evidence" actually requires.
- **Consequence:** Buckets must be configured deliberately, and one of those steps is
  irreversible:
  - Evidence bucket: versioning **on**, retention policy **locked** to the workspace
    retention floor. Locking cannot be undone and the period cannot be reduced, so the
    floor must be settled before locking. Set it too high and objects cannot be deleted
    for that long even if the customer asks.
  - Legal hold (§50) uses Object Retention Lock per object, not a bucket-wide change.
  - Every object key is tenant-prefixed and every signed URL is scoped so it cannot
    traverse the prefix. This is a tenancy guardrail assertion, not a naming convention.
  - Local development against a real bucket needs credentials; `fake-gcs-server` or the
    storage adapter's in-memory implementation is used instead so the suite stays offline.
- **Raised:** Session 2 — the user's decision.

---

## DEV-006 — assertion endpoints added; PRD §45.2 omits them

- **Requirement:** `REQ-M-API-005`, `REQ-M-API-006`
- **PRD says:** §45.4 gives an error example whose `instance` is
  `/v1/investigations/inv_51/assertions`, but §45.2's endpoint map lists no assertion
  endpoints at all.
- **We do:** Add `POST /v1/investigations/{id}/assertions`,
  `GET /v1/investigations/{id}/assertions`, `GET /v1/assertions/{id}`. No PATCH, no
  DELETE (D49).
- **Why:** The error example proves the endpoint was intended. Omitting PATCH is not an
  oversight but a requirement: an editable assertion breaks the supersession chain that
  I3 and D5 depend on.
- **Consequence:** Three endpoints not in the specification. Built in E2/E4 when
  investigations and the Assertion Service exist.
- **Raised:** Session 4.

---

## ⚠ NUMBERING IS FIXED — DEV-001 to DEV-006 ARE HISTORICAL RECORD

The six entries above were written in sessions 1–4 and describe deviations that are
still in force. Two of them carry consequences nothing else records:

- **DEV-002** is a PRD amendment. The `divergence_notices` table does not exist in §59
  and invariant I3 is unimplementable without it. E4 depends on this entry.
- **DEV-005** contains the only warning that locking the GCS retention policy is
  irreversible, and that the retention floor must be settled with the user first.

A later session renumbered DEV-001 onward to describe API scope additions, which
overwrote all six. That is how a hard-won record disappears: not deleted, reused.

**Never reuse a DEV number. Append with the next unused one.** New deviations start at
DEV-008.

---

## DEV-008 — Self-Serve Root Registration Endpoint (`POST /v1/auth/register`)

- **Requirement:** `REQ-AUTH-01`, PRD §45.2
- **PRD says:** §45.2 omits a user registration endpoint, listing only `POST /v1/auth/token`.
- **We do:** Implement `POST /v1/auth/register` allowing initial root tenant and user bootstrap.
- **Why:** Operational requirement for onboarding tenant administrators without manual DB seeding.
- **Consequence:** One public endpoint added to authentication routing.
- **Raised:** Session 8.

---

## DEV-009 — Session Lifecycle Management Endpoints

- **Requirement:** `REQ-AUTH-05`, `REQ-AUTH-06`, PRD §45.2, §40.1
- **PRD says:** §45.2 omits session enumeration and remote revocation endpoints.
- **We do:** Implement `POST /v1/auth/logout`, `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`.
- **Why:** Required to satisfy user stories `AUTH-05` (view active sessions) and `AUTH-06` (remote revocation).
- **Consequence:** Three authenticated routes added.
- **Raised:** Session 8.

---

## DEV-010 — TOTP MFA Enrollment and Step-Up Authentication Endpoints

- **Requirement:** `REQ-AUTH-02`, `REQ-SEC-01`, PRD §45.2, §40.2, D51
- **PRD says:** §45.2 specifies token endpoint MFA challenges, but omits TOTP setup and step-up verification.
- **We do:** Implement `POST /v1/auth/mfa/setup`, `POST /v1/auth/mfa/verify`, `POST /v1/auth/step-up`.
- **Why:** Users must enroll and verify TOTP secrets, and high-risk operations require step-up verification.
- **Consequence:** Three authentication endpoints added.
- **Raised:** Session 8.

---

## DEV-011 — Password Reset Flow Endpoints

- **Requirement:** `REQ-AUTH-07`, PRD §45.2, §40.1
- **PRD says:** §45.2 omits password recovery endpoints.
- **We do:** Implement `POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`.
- **Why:** Necessary self-service account recovery mechanism that verifies expiry and invalidates active sessions.
- **Consequence:** Two public endpoints added with rate limiting and timing enumeration protections.
- **Raised:** Session 8.

---

## DEV-012 — Sign-In History Audit Endpoint (`GET /v1/auth/history`)

- **Requirement:** `REQ-AUTH-10`, PRD §45.2
- **PRD says:** §45.2 omits user sign-in audit history queries.
- **We do:** Implement `GET /v1/auth/history` returning IP, user-agent, and location metadata.
- **Why:** Required to satisfy `AUTH-10` user audit visibility.
- **Consequence:** One authenticated route added backed by RLS-scoped `sign_in_history` table.
- **Raised:** Session 8.

---

## DEV-013 — Ethical Wall Management Endpoint (`POST /v1/workspaces/:id/ethical-walls`)

- **Requirement:** `REQ-WS-07`, PRD §45.2, §38
- **PRD says:** §45.2 specifies workspace policy management but omits matter isolation wall creation.
- **We do:** Implement `POST /v1/workspaces/:id/ethical-walls`.
- **Why:** Enables administrators to configure ethical walls to isolate matters.
- **Consequence:** One workspace policy route added.
- **Raised:** Session 8.

---

## DEV-014 — Realignment of API Route Paths to Verbatim PRD §45.2 Specifications

- **Requirement:** `REQ-API-*`, PRD §45.2
- **PRD says:** §45.2 specifies exact paths: `POST /v1/auth/token`, `GET /v1/me`, `GET /v1/workspaces/{id}/policy`, `PATCH /v1/workspaces/{id}/policy`, `GET /v1/organizations/{id}`.
- **We do:** Realign all endpoints to match §45.2 verbatim paths.
- **Why:** Ensure exact alignment between contracts, routes, and PRD specifications.
- **Consequence:** Route paths are 100% compliant with §45.2.
- **Raised:** Session 8.

---

## DEV-015 — Web UI replaced by Model Context Protocol (MCP) Server Interface

- **Requirement:** PRD §30, §31, §32, §34, §37, §13.7
- **PRD says:** PRD §30, §31, §32, §34 specify dedicated frontend web screens (Dossier, Search/Graph, Timeline, Command Center).
- **We do:** Casefile will have no web UI. Claude is the interface, interacting directly over an MCP server. PRD §37 collaboration and §13.7 memory inspection are NOT dropped — their underlying data models and operations survive as MCP tools. Downstream Epics E10 and E11 are unaffected: they are server-side analysis and report generation engines, not web UI.
- **Why:** Architectural pivot to native AI-native client interface via MCP, reducing frontend surface area while maintaining all strict epistemic, grounding, and traceability guarantees at the tool boundary.
- **Consequence:** Dedicated browser UI screens are omitted in favor of MCP tool definitions. All backend APIs, services, guardrails, and audit trails remain active and normative.
- **Raised:** Session 19.

---

## DEV-016 — Lexical-Only Search Reality and Deferred Vector Embeddings

- **Requirement:** `REQ-M-SRCH-001` through `REQ-M-SRCH-007`, PRD §12.4
- **PRD says:** §12.4 specifies composite multi-signal ranking with 7 weighted components (cross-encoder relevance 0.55, source quality 0.12, entity overlap 0.10, recency fit 0.08, question alignment 0.06, novelty 0.05, interaction signal 0.04), combined with dense vector retrieval, Reciprocal Rank Fusion (RRF), and near-duplicate collapsing.
- **We do:** Search is strictly lexical with exact phrase, keyword, fuzzy OCR token matching, and entity alias expansion. Ranking is computed strictly from real row data (`lexical_match` * 0.70 + `source_quality` * 0.30) with `weights_version: "wt_lex0.70_sq0.30"`. The search explanation payload reports only computed signals, states `score_basis: "lexical_match + source_quality"`, and explicitly lists uncomputed PRD §12.4 signals in `signals_not_computed`. Vector embeddings are deferred per PRD §53.6 line 3738 ("Embeddings | pgvector → dedicated store | Regenerable; not backed up separately") to be generated via dedicated chunk reprocessing.
- **Why:** Fabricating ranking signals using hardcoded constants is a critical violation of investigator transparency. An honest lexical search engine with transparent disclosures provides complete auditability.
- **Consequence:** Dense semantic retrieval and cross-encoder re-ranking are inactive until dedicated embedding pipelines and models are deployed. `retrieval_path` reports `"lexical"`, `"exact"`, or `"entity"`.
- **Raised:** Session 23.



---

## DEV-017 — AI Analysis Capability Is Absent (`POST /v1/investigations/:id/ai/invoke` returns 501)

- **Requirement:** PRD §21, §28, §43, §56.7 (AC-AI-01, AC-AI-02, AC-AI-05, AC-AI-06, AC-AI-07); `REQ-M-AI-*`
- **PRD says:** The AI Gateway assembles a context manifest, invokes a model capability (synthesis, gap analysis, extraction, timeline construction, contradiction detection, report drafting, entity resolution), runs the verification pipeline over the model's output, and persists a grounded, cited, cost-accounted result to `ai_results`.
- **We do:** `invokeAICapability` in `apps/api/src/services/ai-gateway.ts` performs the prompt-injection check (I5) and then throws `AIGatewayError` with HTTP 501. The route returns an RFC 9457 problem of type `…/errors/not-implemented`. Nothing is written to `ai_results`. The verification pipeline (`runVerificationPipeline`), context-manifest assembly, tool execution, and result promotion remain in place and are exercised by their own tests.
- **Why:** Until 2026-09-04 the same function returned a hardcoded narrative about "Meridian Trading Ltd / Kestrel Nominees", attached the investigation's real evidence ids as its citations, fabricated token counts and cost (`1450 / 380 / $0.0036`), and persisted the result. Invoked against a real matter it would have produced fiction cited to real evidence. A query of the sandbox database on 2026-09-04 found `ai_results` empty (count 0, both as the application role scoped to the matter tenant and as the owner role across all tenants), so no fabricated row was ever persisted there. An honest 501 is the only defensible behaviour until a real implementation exists.
- **Consequence:** No AI-generated analysis is available through the API or MCP. Integration tests that previously asserted on the fabricated output (`apps/api/test/ai-acceptance.integration.test.ts`, `apps/api/test/ai-stories.integration.test.ts`) now assert the 501. Requirements REQ-M-AI-* that cited those tests are not verified.
- **What would have to be true to add it:** (1) a provider adapter behind `@casefile/mock-provider`'s interface that makes a real model call with an empty tool registry on content paths (I5), with the arch test in `guardrails/injection.spec.ts:91-93` turned from `it.todo` into executing tests; (2) the output segmented and every segment passed through `runVerificationPipeline` against the evidence actually retrieved for the manifest, with unverified segments dropped, not stored (I9); (3) token counts and cost read from the provider response, never estimated; (4) `epistemic_state` capped at `Supported` by construction (I2); (5) the §61.3 evaluation harness populated — the adversarial corpus has `actual_size: 0` — and its fabrication-rate and injection-resistance gates passing before the 501 is removed.
- **Raised:** 2026-09-04 (post-audit fix session).
- **Addendum (2026-09-04, Fix 7B):** `runVerificationPipeline` in `apps/api/src/services/ai-gateway.ts` has been deleted. It had no callers after the 501 change and still carried canned insufficiency/falsifier strings naming "Meridian Trading Ltd" and a "500,000 USD facility loan". A real verification pass will be written against real model output, not resurrected from this. `grep -n "Meridian\|Kestrel\|signatory powers\|facility loan" apps/api/src/services/ai-gateway.ts` returns nothing.

---

## DEV-018 — Secrets declared in `matter.config.ts` that nothing provisions, and two provisioning defects

- **Requirement:** PRD §40 (security architecture), §44 (storage/secrets), Decision D59; `REQ-M-SEC-017`, `REQ-M-SEC-018`, `REQ-M-SEC-019` (`traceability/manual.yaml`)
- **PRD says:** Each matter deployment carries its own signing, encryption, and audit-integrity secrets, provisioned per matter and mounted only on that matter's runtime.
- **We do:** `matter.config.ts` declares four secret names — `dbUrl`, `jwtSecret`, `encryptionKey`, `auditPepper` — and `guardrails/matter-template.spec.ts` asserts their naming convention. As of 2026-09-04 only `jwtSecret` is real: Fix 7 makes `scripts/deploy-matter.ts --phase=database` generate it once (reusing the existing Secret Manager version on re-runs), grant the matter service account access, mount it on Cloud Run as `JWT_SECRET`, and write it to `.env.<matter>`; the API refuses to boot without it (`apps/api/src/config/required-secrets.ts`, checked in `apps/api/src/server.ts`); `apps/api/src/auth/crypto.ts` has no default value any more.
- **What is still only a name:**
  1. `secrets.encryptionKey` and `secrets.auditPepper` — nothing creates, mounts, or reads either. No field-level encryption and no audit pepper exist in the codebase. `MATTER-SETUP.md` previously told the operator all four were provisioned; it now lists what `deploy-matter.ts` actually creates.
  2. `deploy-matter.ts` creates the database secret as `casefile-<matter>-database-url` while `matterConfig.secrets.dbUrl` is `casefile-<matter>-db-url`. The names diverge. Nothing is renamed: renaming would orphan the secrets that already exist for deployed matters. Recorded, not fixed.
  3. `MCP_TOKEN` is regenerated (`mcp_sec_` + 32 random characters) on every `--phase=database` run and `ensureSecret()` adds it as a new `latest` version, so each re-run rotates the live token and breaks every configured Claude Desktop client for that matter. Recorded, not fixed; the `JWT_SECRET` path deliberately does not copy this.
- **Why:** These are template promises without implementation. Recording them is the honest alternative to a guardrail that asserts four names and a setup guide that implies four features.
- **Consequence:** Operators must not rely on field-level encryption or an audit pepper existing. Re-running `--phase=database` on a live matter rotates its MCP token; treat that as a deliberate rotation and redistribute the client config.
- **Raised:** 2026-09-04 (Fix 7).

---

## DEV-019 — `.msg` parsing drops every To and Cc recipient (resolved)

- **Requirement:** PRD §11 (ingestion formats), §55.4 REQ-ING-12 (email attachments as linked artifacts); communication sources carry their full header set.
- **PRD says:** An ingested email is parsed into its headers (From, To, Cc, Date, Subject, Message-ID), body and attachments, and the headers are preserved as structured provenance.
- **We do:** `parseMsg` in `apps/api/src/services/document-parsers.ts` keeps a recipient as To when `!r.recipType || r.recipType === 1` and as Cc when `r.recipType === 2`. `@kenjiuno/msgreader` does not return the numeric `PR_RECIPIENT_TYPE`; it converts it to the strings `"to"`, `"cc"` and `"bcc"` (`MsgReader.js`, the `key === "recipType"` branch). Every typed recipient therefore fails both filters, `headers.to` and `headers.cc` come back empty, and the `To:`/`Cc:` lines are missing from the indexed header block. `.eml` parsing is not affected.
- **Why:** Not a deliberate deviation — a defect found on 2026-09-25 while building the synthetic `test-corpus/message.msg`, which has one `MAPI_TO` recipient (`Jane Doe <jane.doe@acme-holdings.example>`) and parses with `headers.to === ""`. The 32e tests in `tools/ingest-cli/test/format-parsers.integration.test.ts` assert on From, Subject, Message-ID and the child attachment, never on To or Cc, so the suite stays green.
- **Consequence:** Recipients of Outlook `.msg` emails are not searchable and not shown as provenance; communication-graph and "who received this" questions under-report for `.msg` sources.
- **Fix, not yet applied:** accept both forms (`"to"`/`1`, `"cc"`/`2`) in the two filters, and add an assertion to the 32e `.msg` test that `headers.to` contains `<jane.doe@acme-holdings.example>`.
- **Raised:** 2026-09-25 (public-release preparation). Recorded only; not fixed in that change.
- **Resolved:** 2026-09-26. Bringing `apps/api` under `pnpm typecheck` removed the `@ts-expect-error` on the msgreader import, and the typed `recipType` (`"to" | "cc" | "bcc"`) made the numeric comparison a compile error. `parseMsg` now filters on the string values, and the 32e `.msg` test asserts `headers.to` contains `<jane.doe@acme-holdings.example>` (it failed with `''` before the fix).

---

## DEV-020 — Password reset returned the reset token to the caller (security fix) and has no email delivery

- **Requirement:** PRD §55.1 AUTH-07 (password reset via verified email: single-use, expiring, invalidates sessions).
- **PRD says:** A user resets their password through a verified email link.
- **We did (until 2026-09-26):** `POST /v1/auth/password-reset/request` was a public route that returned `{ resetToken, email }` in the response body, and `"dummy_token"` for unknown addresses. Anyone who knew a user's email and tenant ID could reset that user's password and take over the account. The REQ-AUTH-07 test read the token from the response.
- **We do now (D65):** the request endpoint returns the same `202` body for every well-formed request and does no lookup, so it reveals neither a token nor whether the email exists. Because there is no email channel, self-service reset delivers nothing. An administrator issues a single-use, 60-minute reset token with `pnpm admin:reset-link --email <email>`; it is printed only to their terminal, with the `curl` command to set the password, and the issue is audited. The request and confirm endpoints are rate-limited (D66).
- **Why:** account takeover by anyone who could guess or obtain an email address and tenant ID. Severity: critical. Found while planning MCP sign-in (`docs/PLAN-MCP-AUTH.md`).
- **Consequence:** users cannot reset their own password until an email delivery channel is added; an administrator must issue the link. REQ-AUTH-07 is not "via verified email".
- **Tests:** `apps/api/test/password-reset.integration.test.ts` (no token in the response; identical response for a real and a fake email; no token issued by self-service; the admin command end to end), all failing against the previous code; REQ-AUTH-07 now takes its token from the admin issuer and keeps its assertions.
- **What would have to be true to close this deviation:** an email delivery channel, with the request endpoint queueing the message behind the same constant response.
- **Raised and fixed:** 2026-09-26 (MCP sign-in, Phase 0).

---

## DEV-021 — Passkey registration always fails: its SQL sets a column that does not exist (resolved)

- **Requirement:** PRD §55.1 AUTH-03 (WebAuthn/FIDO2 passkeys).
- **PRD says:** users can register a passkey and sign in with it.
- **We do:** `verifyWebAuthnRegistration` in `apps/api/src/auth/service.ts` stores the credential with `INSERT INTO webauthn_credentials ... ON CONFLICT (id) DO UPDATE SET counter = ..., backed_up = ..., updated_at = NOW()`. `webauthn_credentials` (migration 0009) has no `updated_at` column. Postgres checks column names when it parses the statement, so the INSERT fails on every call (`column "updated_at" of relation "webauthn_credentials" does not exist`), not only on a conflict. No passkey can be registered.
- **Why:** not deliberate — a defect. `apps/api/test/webauthn.integration.test.ts` inserts credentials directly and never runs the registration-verify path, so the suite stays green.
- **Consequence:** passkey sign-in is unavailable. Password + TOTP remains the dependable path, which is already the plan for MCP sign-in (`docs/PLAN-MCP-AUTH.md` section 8).
- **Fix, not yet applied:** drop `updated_at = NOW()` from the `ON CONFLICT` clause (or add the column in a new migration; existing migrations are never edited), and add a test that runs the registration-verify statement.
- **Raised:** 2026-09-26, found by the array-parameter audit in MCP sign-in Phase 1 (D68), whose test runs this statement. Recorded only; not fixed in Phase 1.
- **Resolved:** 2026-09-26 (MCP sign-in Phase 2A). The statement moved into `storeWebAuthnCredential` (called by `verifyWebAuthnRegistration`) and no longer sets `updated_at`. `apps/api/test/auth-hardening.integration.test.ts` stores a credential and stores it again (the conflict path); it failed with the missing-column error before the fix. `packages/db/test/array-params-first-query.integration.test.ts` runs the production function again, verbatim.

---

## DEV-022 — The MFA challenge token is a full access token (resolved)

- **Requirement:** PRD §40.1 (MFA), §55.1 AUTH-02.
- **PRD says:** an account with two-factor authentication is signed in only after both factors.
- **We do:** `AuthService.login` answers a TOTP account's correct password with `challengeToken`, made by `signJwt` with the user's `sub`, `tid` and `roles` (`sid: "mfa_challenge"`, 5 minutes). The REST API's bearer check accepts any valid `signJwt` token, so for 5 minutes the password alone reaches the REST API with the user's roles.
- **Why:** not deliberate — a defect found while building Phase 2A. The MCP sign-in does not use it: the OAuth page keeps its own signed form state with a different key, which never verifies as an access token (D69).
- **Consequence:** REST routes that do not require step-up (D51) are reachable with the password of a TOTP account.
- **Fix, not yet applied:** make the challenge token unusable as an access token (a different key or a `typ` the REST check refuses), and require it at `/v1/auth/mfa/verify` (see DEV-023).
- **Raised:** 2026-09-26 (MCP sign-in Phase 2A). Recorded only; outside the 2A scope.
- **Resolved:** 2026-09-27 (MCP sign-in Phase 2B, D75). The challenge token now carries `aud: "urn:casefile:mfa-challenge"` and no roles; the REST API treats any token with an audience as no credential and `/mcp` accepts only its own audience. `apps/api/test/mfa-refresh-hardening.integration.test.ts` presents it to `GET /v1/me`, `GET /v1/auth/sessions` and `/mcp`: the first two returned `200` before the fix and `401` after.

---

## DEV-023 — `/v1/auth/mfa/verify` signs in with a user ID and a TOTP code alone (resolved)

- **Requirement:** PRD §40.1, §55.1 AUTH-02.
- **PRD says:** the second factor completes a sign-in that the first factor started.
- **We do:** `POST /v1/auth/mfa/verify` is public and takes `{ userId, tenantId, totpCode }`; it does not ask for the `challengeToken` from the password step, so a valid code for a known user ID yields a full session without the password. D66 limits it (10 attempts per account per 15 minutes).
- **Why:** not deliberate — found while building Phase 2A (D71 removed its enrolment side effect only).
- **Consequence:** the password step can be skipped by anyone who can produce the current TOTP code for a known user ID.
- **Fix, not yet applied:** require the challenge token and bind the code to it (together with DEV-022).
- **Raised:** 2026-09-26 (MCP sign-in Phase 2A). Recorded only.
- **Resolved:** 2026-09-27 (MCP sign-in Phase 2B, D75). `/v1/auth/mfa/verify` requires `challengeToken`; the account is the one it names, and a `userId` or `tenantId` sent with it must match. Without it, or with an expired one, one issued to another user, or an ordinary access token, nothing is issued. TOTP codes are now also single-use per account. The tests for each case failed before the fix.

---

## DEV-024 — Group ethical walls are not applied at MCP sign-in

- **Requirement:** PRD §38.4, REQ-M-RBAC-006 (ethical walls).
- **We do:** the MCP sign-in (D69) refuses users named by an ethical wall (`subject_type = 'user'`). `ethical_walls.subject_type` also allows `group`, but there is no group membership table, so a group wall cannot be resolved to users.
- **Consequence:** a wall that names a group does not stop sign-in. No group can be created today, so no such wall can name real members yet.
- **Raised:** 2026-09-26 (MCP sign-in Phase 2A).
- **2026-09-27 (Phase 2B):** still open. The same check (`checkMcpEligibility`) now also runs on every `/mcp` request (D73) and every OAuth refresh (D76), so the same gap applies there.

- **Resolved (safe option):** 2026-09-30 (FIXES-1, D107). A group wall (and a `role` wall, which the database could not store and answered 500 for) is refused with 422. A group wall already in a matter is reported by `pnpm matter:preflight` (NOT READY) and by the MCP `matter_status` tool (`warnings`). `apps/api/test/ethical-walls-groups.integration.test.ts`.
- **Left:** group walls are not applied, because there are no groups: a groups feature (membership, who manages it, audit) is its own step. Also found then: DEV-036 (a workspace-wide wall; refused with a reason since FINAL, D129).
---

## DEV-025 — REST password sign-in does not refuse a suspended account (resolved)

- **Requirement:** PRD §40.1; the Phase 2B aim that disabling a user cuts access.
- **We do:** `AuthService.login` (`POST /v1/auth/token`) looks the user up with `deleted_at IS NULL` but never checks `users.status`, so a `suspended` user with the right password (and TOTP) gets a new REST session. Passkey sign-in (`verifyWebAuthnAuthentication`) does check `status = 'active'`, and the MCP sign-in refuses such a user (D69).
- **Consequence:** since D76 a suspended user's existing REST sessions die at their next refresh, but the user can sign in to the REST API again. `/mcp` is not affected: every request re-checks the user (D73).
- **Fix, not yet applied:** refuse non-`active` users in `login` (and so in `/v1/auth/mfa/verify`), with a test.
- **Raised:** 2026-09-27 (MCP sign-in Phase 2B), found while adding the refresh re-check. Recorded only; outside the 2B scope.
- **Resolved:** 2026-09-27 (MCP sign-in Phase 3, D80). `login` refuses any user who is not active with exactly the wrong-password answer, after the password check and without touching the lockout counters; `/v1/auth/mfa/verify` refuses a user suspended after the password step. `apps/api/test/auth-findings-2b.integration.test.ts` compares the two answers field by field; its 3 DEV-025 tests failed against the 2B code.

---

## DEV-026 — Two MCP tools read other investigations of the same tenant (resolved)

- **Requirement:** plan section 4 ("Claude then sees only that matter"), PRD §38.4 (ethical walls).
- **We do:** `/mcp` decides access against `MATTER_INVESTIGATION_ID` (D73, D74). `list_investigations` lists every investigation of the tenant, and `get_investigation` takes any `investigation_id` in the tenant (`packages/mcp/src/tools.ts`). Both return metadata only (name, objective, stage, sensitivity; `get_investigation` also `legal_hold`), never documents.
- **Consequence:** a deployment holds one matter (plan answer 6), so a tenant normally has one investigation. If it had more, a user allowed on the matter's investigation could read the metadata of the others, including one they are walled from.
- **Fix, not yet applied:** limit both tools to `MATTER_INVESTIGATION_ID`, or check the caller's access to each investigation returned. That changes tool output, which Phase 1 kept byte-identical, so it needs its own decision.
- **Raised:** 2026-09-27 (MCP sign-in Phase 2B). Recorded only.
- **Resolved:** 2026-09-27 (MCP sign-in Phase 3, D79). Both tools return only `MATTER_INVESTIGATION_ID`; any other ID answers exactly like an unknown one. Tested with a second investigation in the tenant (red against 2B).

---

## DEV-027 — `DELETE /v1/auth/sessions/:id` revokes any session in the tenant (resolved)

- **Requirement:** PRD §55.1 AUTH-05/AUTH-06 (a user lists and revokes their own sessions).
- **We do:** `AuthService.revokeSession` runs `UPDATE auth_sessions SET is_revoked = true WHERE id = :id AND tenant_id = :tenant`; it does not check that the session belongs to the caller.
- **Consequence:** a signed-in user who knows another user's session ID (a random UUID, and `GET /v1/auth/sessions` lists only one's own) can sign that session out, including a Claude connection. It cannot read or take over anything.
- **Fix, not yet applied:** add `AND user_id = :caller` (keeping an administrator path, if wanted, as a separate permission-checked route).
- **Raised:** 2026-09-27 (MCP sign-in Phase 2B), found while testing revocation of a Claude connection. Recorded only.
- **Resolved:** 2026-09-27 (MCP sign-in Phase 3, D81). Only the caller's own sessions are revoked; another user's, an unknown or a malformed ID answers 404. No administrator path: the permission matrix has no session-management permission.

---

## DEV-028 — `/mcp` is rate-limited per client address, not per account (resolved)

- **Requirement:** D66; `docs/PLAN-MCP-AUTH.md` section 8 ("per-account limits do the work" for `/oauth/token` and `/mcp`).
- **We do:** `/mcp` falls under the `general` rule, whose per-account key is the REST user (`req.user`). An MCP access token is deliberately not a REST credential, so `/mcp` requests are counted per client address only (300 per minute, D66).
- **Consequence:** Claude reaches `/mcp` from Anthropic's shared egress range, so every Claude user of a matter behind one egress address shares one 300-per-minute budget. At today's scale (a few people per matter) that is far above use.
- **Fix, not yet applied:** key the `general` rule on the MCP token's verified subject for `/mcp`, as `/v1/auth/mfa/verify` is keyed on the challenge token's subject (D75).
- **Raised:** 2026-09-27 (MCP sign-in Phase 2B). Recorded only.
- **Resolved:** 2026-09-27 (MCP sign-in Phase 3, D78). The `/mcp` auth gate counts an identified caller per account and only refused requests per address (a new `mcp` rule).

---

## DEV-029 — `get_document_page` reads pages of other investigations of the same tenant (resolved)

- **Requirement:** plan section 4 ("Claude then sees only that matter"), PRD §38.4 (ethical walls); the same rule as DEV-026.
- **We do:** `get_document_page` (`packages/mcp/src/tools.ts`) selected `content_blocks` by content document ID or source ID and `tenant_id` only, with LEFT JOINs to `content_documents` and `artifacts` and no join to `sources`.
- **Consequence:** anyone allowed on the matter who knew a document ID from another investigation in the same tenant could read its page text through Claude. A deployment normally holds one investigation, so this needed a second one in the tenant.
- **Raised:** 2026-09-28 (independent check of Phase 3).
- **Resolved:** 2026-09-28 (Phase 4A, D82). The page is read through its source, which must belong to `MATTER_INVESTIGATION_ID`; any other answers exactly like an unknown ID. `apps/api/test/cross-investigation-tools.integration.test.ts` calls all 9 tools with a second investigation's IDs and chunk text; before the fix it failed on `get_document_page` only.

---

## DEV-030 — No command adds a person to an existing matter

- **Requirement:** `docs/PLAN-MCP-AUTH.md` section 6 step 1 ("make sure everyone who will use Claude has an account in that matter's tenant").
- **We do:** accounts are created only by the ingest bootstrap (one admin per matter) and by `POST /v1/auth/register`, which creates a new organization. `POST /v1/workspaces/:id/members` and `POST /v1/investigations/:id/members` add an existing user; nothing creates a user inside an existing tenant. `pnpm admin:reset-link` needs the account to exist.
- **Consequence:** on a live matter only the people who already have accounts (usually just the bootstrap admin) can be given Claude access. `docs/UPGRADE-LIVE-MATTER.md` step 2a says to stop and ask if someone is missing, and never to create accounts by hand in the database.
- **Fix, not yet applied:** an admin command that creates a user in the matter's tenant with a chosen role, audited, and then issues the setup link.
- **Raised:** 2026-09-28 (Phase 4A), found while writing the runbook. Recorded only.
- **Resolved:** 2026-09-28 (Phase 4 close, D87). `pnpm admin:add-user --env <file> --email <email> --name <name> --role <role>` creates the user with no password and no TOTP, adds them to the workspace that owns `MATTER_INVESTIGATION_ID` with a role of the policy matrix (anything else refused), writes a `user.create` audit row and prints the one-time setup link, in one transaction; an email that already has an account in the tenant is refused. `apps/api/test/admin-add-user.integration.test.ts` runs the real command, then the link, the setup page, OAuth sign-in and `/mcp`; it failed 4/4 before the command existed.

---

## DEV-031 — JSON columns written by the ingest and the audit writer hold a JSON string, not a JSON object

- **Requirement:** PRD §40 (object model: `sources.metadata`, `audit_events.before` / `after` / `ai_involvement` are JSONB objects).
- **We do:** `tools/ingest-cli/src/ingest.ts` passes `${JSON.stringify(metadata)}::jsonb` and `packages/audit/src/writer.ts` passes `JSON.stringify(input.after)` (and `before`, `ai_involvement`) as parameters. postgres.js serializes a parameter the server types as json/jsonb with `JSON.stringify` itself, so the value is encoded twice: `jsonb_typeof(metadata)` and `jsonb_typeof(after)` are `string`, and `metadata->>'source_path'` is NULL (the text has to be read with `(metadata #>> '{}')::jsonb`).
- **Consequence:** SQL that reads these columns as objects finds nothing; every reader so far parses the string again in JavaScript. The audit chain is not affected (it verifies: `valid: true` in every BIGDATA-2A capture).
- **Also (found in BIGDATA-2B):** the REST upload writes `content_blocks.bbox` the same way (`${JSON.stringify(block.bbox)}::jsonb`), so `GET /v1/investigations/:id/sources/:sourceId` of a PDF uploaded through the API answers 500 (the contract expects an object). Shown on the 2A code: `captures/bigdata2b/rest-pdf-get-on-2A-code.txt`. The ingest CLI writes no bbox, so CLI-ingested sources are not affected.
- **Fix, not yet applied:** pass the object (`${tx.json(obj)}` or the object itself) instead of a string, and decide what to do with the rows already written; the audit rows are hashed and immutable (I8, D52), so this needs its own decision, and the audit writer is not to change before BIGDATA-4 (answer 10).
- **Raised:** 2026-09-29 (BIGDATA-2A, found by the before/after capture). Recorded only.

- **Resolved for the columns named here:** 2026-09-30 (FIXES-1, D104). `sources.metadata`, `audit_events.before` / `after` / `ai_involvement` and `content_blocks.bbox` are written as JSON objects (`jsonb()` in `packages/db/src/json.ts`); every reader takes the old text form too; `GET /sources/:id` of a REST-uploaded PDF answers 200. The audit hash did not change (it hashes the parsed value); old, new and mixed chains verify (`apps/api/test/json-columns.integration.test.ts`; `captures/fixes1/mixed-chain-*.txt`). Old rows are unchanged.
- **Left:** the same `JSON.stringify(x)` pattern writes a JSON string into other jsonb columns (assertions, entities, investigations, memory, relationships, saved searches, workspace policies, AI gateway calls, correlation, evidence locators, sign-in locations, ingestion-job payloads). Their readers already parse the string, so nothing fails today, but SQL cannot read them as objects. Each has its own readers and needs the same both-forms treatment, so they were not changed in this step. The call sites: apps/api/src/auth/service.ts:195, 377, 1460; routes/assertions.ts:259-261, 264, 300, 320, 499-501, 504; routes/entities.ts:201, 239-240, 357-358, 750-751, 1062-1063, 1078; routes/investigations.ts:217, 398-399, 1018-1019, 1088; routes/memory.ts:124-126; routes/relationships.ts:131-133; routes/search.ts:119, 191; routes/sources.ts:221, 257 (`source_ingestion_jobs.dead_letter_payload`); routes/workspaces.ts:554-556; services/ai-gateway.ts:360; services/correlation-engine.ts:374, 422, 446, 627, 629, 672-675, 712, 795; services/evidence-grounding.ts:240; services/investigation-memory.ts:289-291; services/search-engine.ts:402.
---

## DEV-032 — `search` and `list_documents` order by a timestamp that many rows share and that follows a jumping clock

- **Requirement:** none names an order; the working rule since Phase 1 (D67) is that a change that does not touch the 9 tools leaves their output byte-identical, which needs a deterministic order.
- **We do:** `handleSearch` orders chunks by `c.created_at DESC` and `handleListDocuments` sources by `created_at DESC`, with no tie-breaker (`packages/mcp/src/tools.ts`). `created_at` is `NOW()`, the start of the transaction, so every row one top-level file writes (with its zip entries and attachments) has the same value (checked in every BIGDATA-2A capture: 458 files, 458 values). Postgres returns such ties in whatever order it reads them, which follows where the rows sit on disk. Across files, `created_at` follows the database server's clock: on this PC the Docker VM clock jumped back about 100 s three times in one 75-second run (`captures/bigdata2a/clock-jumps-after-B2.txt`), so a later file can sort before an earlier one.
- **Consequence:** the same data can give a different top 20: two runs of the unchanged BIGDATA-1 code on the same corpus differ in 7 of the 27 captured tool outputs (`diff-before-vs-before-2-ignore-labels.txt`). The complete result over every page is the same (checked for every captured search).
- **Fix, not yet applied:** a deterministic order key that does not depend on a clock or on the disk (for example the ingest order) plus a tie-breaker. It changes the tools' output, so it belongs to the search-at-scale track (F7, answer 11), which rewrites `search` anyway. The clock itself needs the Windows Time service running on this PC (owner's decision).
- **Raised:** 2026-09-29 (BIGDATA-2A). Recorded only.
- **Partly fixed:** 2026-09-29 (BIGDATA-2B, D97). With parallel workers the order of ties changed between one call and the next, so offset paging repeated and skipped hits; `search` (MCP and REST) now orders by `created_at DESC, id`. Pages are stable; which order ties come in, and the clock-dependent order across files, stay open for the search track.

---

## DEV-033 — The REST contract did not know the `needs_ocr` status (resolved)

- **Requirement:** migration 0021 (`needs_ocr` added to `sources.status`), PRD §10.2.
- **We do:** `SourceStatusSchema` in `packages/contracts/src/schemas/sources.ts` listed every status but `needs_ocr`.
- **Consequence:** every REST route that returns a source (`normalizeSource`) answered 500 for a scanned PDF the CLI had ingested.
- **Raised:** 2026-09-29 (BIGDATA-2A, found when the upload route started to mark scans `needs_ocr`).
- **Resolved:** 2026-09-29 (BIGDATA-2A, D92). `needs_ocr` added to the enum; `apps/api/test/ocr-honesty.integration.test.ts` uploads a scanned PDF and reads the source back (it answered 500 before).

---

## DEV-034 — `.doc`, HTML and RTF blocks' offsets do not point at their text in the document

- **Requirement:** PRD §10 / §40 (a content block's `char_start` / `char_end` locate it in the document's text).
- **We do:** `parseDoc`, `parseHtml` and `parseRtf` (`apps/api/src/services/document-parsers.ts`) split the text on blank lines, trim each paragraph, and number the offsets as if the paragraphs were joined by one `\n`; the `fullText` they return keeps the original gaps (`\n\n`, and the trimmed spaces). From the second block on, `fullText.slice(char_start, char_end)` is not the block's text (`captures/bigdata2b/text-rebuild-fixtures.txt`). PDF, .docx, .xlsx, .eml and .msg are consistent.
- **Consequence:** for these three formats the text cannot be rebuilt exactly from the blocks, so BIGDATA-2B keeps their `full_text` (two copies). An entity mention found by `/extract` in such a document carries offsets into `full_text`, which do not match the blocks'. Evidence is not affected: it uses offsets inside one block.
- **Fix, not yet applied:** compute the offsets against the text actually returned (or return the joined text), which changes these formats' rows, so it needs its own before/after.
- **Raised:** 2026-09-29 (BIGDATA-2B, found while designing text stored once). Recorded only.

- **Resolved:** 2026-09-30 (FIXES-1, D105). Each block's `char_start` / `char_end` now point at its text in the text the parser returns (the text is unchanged). 2B's rebuild check is EXACT for all 8 fixture formats (it was NOT EXACT for these three), so they store their text once (`full_text` NULL) like the others. Documents ingested before keep their old offsets and their `full_text`. A file whose paragraph gaps hold other whitespace than blank lines keeps `full_text` (exact either way).
---

## DEV-035 — The REST upload's near-duplicate detection is a filename demo

- **Requirement:** PRD §56.2 AC-ING-07 / ING-08 (near-duplicates detected, with a diff).
- **We do:** `POST /v1/investigations/:id/sources` (`apps/api/src/routes/sources.ts`) writes a `near_duplicate_clusters` row with a fixed similarity of 0.94 and an invented diff ("Clause 9.3 ... Net 30 ...") whenever an indexed source's filename contains `v1` and the new one's contains `v2`; the text is never compared. `GET .../sources/:sourceId/diff/:targetSourceId` returns that row, or the same invented diff when there is none.
- **Consequence:** a REST client is shown similarity and differences that were never measured. The ingest CLI does not use that table: its near-duplicates (BIGDATA-3, D101) are measured on the text and recorded in `document_fingerprints`, and nothing reads them from the REST routes yet.
- **Fix, not yet applied:** the upload route computes a fingerprint the way the ingest does (`tools/ingest-cli/src/near-duplicates.ts`), and the diff route reads `document_fingerprints` and says plainly that it has no diff instead of inventing one. It changes a REST response, so it needs its own step with the REST contract.
- **Raised:** 2026-09-29 (BIGDATA-3, found while choosing where near-duplicate groups go). Recorded only.
- **Resolved:** 2026-09-30 (FIXES-1, D106). The upload writes no pair; the diff route compares the two documents' own text (exact Jaccard of 5-word shingles, and real added / removed lines). `near_duplicate_clusters` is no longer read or written; the rows already in it stay as they are. `apps/api/test/near-duplicate-diff.integration.test.ts`.
- **Left:** REST uploads are not fingerprinted into `document_fingerprints`, so the ingest's near-duplicate groups never include them (a REST upload is not part of an ingest run).

---

## DEV-036 — A workspace-wide ethical wall cannot be created (resolved: refused with a reason)

- **Requirement:** PRD §38.4, REQ-M-RBAC-006; the contract (`CreateEthicalWallRequestSchema`: `investigation_id` optional), the MCP access check (`checkMcpEligibility` applies a wall with no investigation to the whole workspace) and the policy evaluator all allow a wall that covers a workspace.
- **We do:** migration 0002 made `ethical_walls.investigation_id` NOT NULL (its comment says a foreign key was to be added later), so `POST /v1/workspaces/:id/ethical-walls` without `investigation_id` fails in the database (`captures/fixes1/workspace-wall-probe.txt`).
- **Consequence:** a wall can only screen one investigation; screening a whole workspace means one wall per investigation.
- **Fix, not yet applied:** a new migration making the column nullable (additive), or the route refusing a workspace-wide wall with a clear reason. Either changes the ethical-wall API, so it needs its own step.
- **Raised:** 2026-09-30 (FIXES-1, found while fixing DEV-024). Recorded only.
- **Resolved (safe option, FINAL, D129):** a request without `investigation_id` is refused with 422 and the reason ("one wall per investigation"), before anything is written; it was a 500 with the database's message. No such wall can already be in a matter (the column is NOT NULL), so nothing needs flagging; a test pins the column. `apps/api/test/ethical-walls-workspace.integration.test.ts`, red then green.
- **Left:** walls over a whole workspace are not supported (a nullable column and the check applied everywhere a wall is checked would be their own step).

---

## DEV-037 — `get_document_page` answers "Page 1 not found" for every document without page numbers

- **Requirement:** PRD §45 MCP tools; the tool is described as returning a page of a document by its content document or source ID.
- **We do:** `get_document_page` (`packages/mcp/src/tools.ts`) selects the document's content blocks with `page = <n>`. Only PDF blocks carry a page number; Word, spreadsheet, HTML, RTF, text and every email (an `.eml`, an `.msg`, and since BIGDATA-3B every message of a PST or MBOX) have `page` NULL, so the tool answers `Page 1 not found` for them. The same on the code before FIXES-1 (checked in the FIXES-1 review) and after BIGDATA-3B (`apps/api/test/mailbox-mcp-tools.integration.test.ts`, test 6, asserts the unchanged answer).
- **Consequence:** Claude cannot read an email or a Word file page by page through this tool; `get_source` (first 100 blocks) and `search` still reach the text.
- **Fix, not yet applied:** for a document without pages, answer page 1 with the document's blocks in order (or page by a fixed number of characters), and say so in the answer. It changes a tool's output, so it belongs to the search-at-scale track (answer 11).
- **Raised:** 2026-09-30 (FIXES-1 review; recorded in BIGDATA-3B as asked). Recorded only.

---

## DEV-038 — A mailbox whose reading is interrupted is not resumed (resolved for runs made from BIGDATA-4 on)

- **Requirement:** plan section 3 (BIGDATA-4: a crashed worker's job is picked up again).
- **We do:** a mailbox is admitted (status `processing`) before its messages are read, each message in its own transaction (D108). If the process stops in the middle (killed, the machine restarts), the messages read so far stay, and the mailbox stays `processing` with no `source.mailbox_read` row. A later run finds the mailbox's bytes already a source of the investigation and skips it as already ingested, so the rest of its messages are not read.
- **Consequence:** an interrupted run must be noticed (a mailbox source left in `processing`; its `mailbox_read` is missing) and the rest read by hand; today that means re-including the mailbox's messages by rule or path is not possible either, since they were never decided.
- **Fix, not yet applied:** BIGDATA-4's work table: a mailbox left `processing` is taken up again from its first message not yet recorded (every message already read is a duplicate of itself by identity, D111, so a resume can also simply re-read the file and skip what is there, without writing those skips as decisions).
- **Raised:** 2026-09-30 (BIGDATA-3B). Recorded only.
- **Resolved (BIGDATA-4, D120):** a mailbox is a head item, parts and a finish item in the run's queue (migration 0031). Each message of a part is written in its own transaction that moves the part's progress from i to i + 1 behind the item's fence, so a stopped part is taken up again by any worker at its first message not written, and `pnpm ingest:resume` finishes the mailbox (its status, `mailbox_read` and `source.mailbox_read` row) once every part is done. Proven by killing every worker process in the middle of a mailbox part, and by killing the Docker stack, then resuming (captures/bigdata4/resume/, plan section 16).
- **Left:** a mailbox left `processing` by a run made **before** BIGDATA-4 (no queue) is still skipped by a new run as already ingested: DEV-044.

---

## DEV-039 — `matter:preflight` does not list migrations 0029 and 0030 as part of an upgrade (resolved)

- **Requirement:** D83 (the preflight says which migrations an upgrade adds and whether the matter is ready).
- **We do:** `UPGRADE_MIGRATIONS` in `scripts/matter-preflight.ts` lists 0025–0028. BIGDATA-3 added 0029 and BIGDATA-3B adds 0030 (both additive) without adding them there, so a matter that has neither is reported with "other" missing migrations (NOT READY) rather than with the two expected ones.
- **Consequence:** none for the current plan (no live matter is being upgraded, 28 Sep decision); an operator upgrading an old matter would see a NOT READY that the runbook does not explain.
- **Fix, not yet applied:** add 0029 and 0030 to `UPGRADE_MIGRATIONS`, the runbook's step 4 and its guardrail, in one step with a preflight test.
- **Raised:** 2026-09-30 (BIGDATA-3B). Recorded only.
- **Resolved (BIGDATA-4, D127):** `UPGRADE_MIGRATIONS` lists 0025 to 0031 (0031 is BIGDATA-4's queue); `docs/UPGRADE-LIVE-MATTER.md` step 4 applies and shows all seven; `guardrails/matter-preflight.spec.ts` fails when any migration numbered 0025 or later is not on the list (red on the old list: 0029 and 0030 missing), so a new migration cannot be missed again.

---

## DEV-040 — OST files are read the same way as PSTs, but no real OST was tested

- **Requirement:** BIGDATA-3B prompt (PST, OST and MBOX files are read message by message).
- **We do:** a `.ost` file goes through the same reader as a `.pst` (D109). pst-extractor reads the 4 KB-page layout Outlook 2013+ writes (used by OSTs, `wVer` 36) and the older layouts. Every fake mailbox is a Unicode PST (the only kind the free writer makes, D114); an OST is made only by Outlook synchronising an Exchange or Microsoft 365 mailbox, which would be a real account's mail.
- **Consequence:** an OST from a real custodian may use parts of the format the tests do not reach (4 KB pages; OST-only properties). If it cannot be opened it is stored and listed with the reason (D113), not dropped.
- **Fix, not yet applied:** test with an OST made from an empty, fake Microsoft 365 test account, if the owner has one.
- **Raised:** 2026-09-30 (BIGDATA-3B). Recorded only.

---

## DEV-041 — Triage holds a whole run's object list in one process's memory

- **Requirement:** BIGDATA-4 prompt C ("memory per worker must stay flat as the case grows").
- **We do:** the workers' memory is flat (one item at a time; the near-duplicate index is in the database, D119). Triage, which runs once per run before the queue exists, still holds every object of the run (one `TriageItem` each) and the investigation's sources by size in one process, as BIGDATA-3 built it (D98-D100).
- **Consequence:** fine at the sizes measured (10 GB: about 60,000 objects); at 1-5 TB (millions of objects) the triage process needs GBs of memory and a long single pass (a bucket listing and the hashing of size collisions).
- **Fix, not yet applied:** triage in pages (by path range), writing decisions and queue items as it goes, and the size index in the database. Before a real 1 TB case.
- **Raised:** 2026-09-30 (BIGDATA-4). Recorded only.

---

## DEV-042 — Two attachments of one email with the same file name share one path

- **Requirement:** D108 / D90 (every object has its own path in the report and for `ingest:include --path`).
- **We do:** an attachment's path is `<email>#attachment:<file name>`. An email with two attachments of the same name (different bytes) gives two sources with the same path; both are ingested and kept (measured: 3 such emails in the 1 GB fake corpus, each attachment its own source). This has been so since the paths were introduced; BIGDATA-4 found it with its "one source per path" check.
- **Consequence:** the report lists both under one path, and `ingest:include --path` of such a path takes the first attachment of that name.
- **Fix, not yet applied:** add the attachment's position when a name repeats (`#attachment:2:<file name>`), with a reader for the old form.
- **Raised:** 2026-09-30 (BIGDATA-4). Recorded only.

---

## DEV-043 — A PST folder whose contents table cannot be listed is reported by each of its parts

- **Requirement:** D113 (an unreadable folder is listed once, with its path).
- **We do:** since BIGDATA-4 a folder's messages are read in parts of 50 (D120). When the folder's contents table itself cannot be read, each part of that folder finds it and lists it (the whole-file walk listed it once). A message the reader cannot load is still listed once, by the part it belongs to.
- **Consequence:** the same folder error can appear several times in a mailbox's `errors` and as several `source.ingest_failed` rows. No fake PST has such a folder (the damaged fake PST's errors are per message).
- **Fix, not yet applied:** record a folder-level error once, by the folder's first part.
- **Raised:** 2026-09-30 (BIGDATA-4). Recorded only.

---

## DEV-044 — A mailbox interrupted under the code before BIGDATA-4 is not taken up again

- **Requirement:** DEV-038.
- **We do:** a run made by the BIGDATA-3B code has no queue. A mailbox it left in status `processing` (no `mailbox_read`) is a source of the investigation, so a new run skips the mailbox file as already ingested.
- **Consequence:** only for a matter that ran BIGDATA-3B code on a mailbox and was stopped in the middle (the live matters in the roadmap run code from before BIGDATA-3, which did not read mailboxes).
- **Fix, not yet applied:** `ingest:include --path <mailbox>` reading the rest of such a mailbox, or a one-off queue for it.
- **Raised:** 2026-09-30 (BIGDATA-4). Recorded only.

---

## DEV-045 — matter_status lists its status counts in no fixed order (resolved)

- **Requirement:** D97 (a tool's output is the same for the same data; the before/after captures compare it byte for byte).
- **We do:** `matter_status` builds `sources.by_status` from `SELECT status, count(*) ... GROUP BY status` with no `ORDER BY` (`packages/mcp/src/tools.ts`), so the keys come in the order Postgres' hash aggregate returns them. The counts are always right; only their order can change from one call to the next (the 100 MB before capture's own two passes differ: `indexed` first in one, last in the other).
- **Consequence:** none for a reader of the counts; a byte-for-byte comparison of two outputs can differ (the BIGDATA-4 before/after capture, explained there).
- **Fix, not yet applied:** `ORDER BY status` (it changes the tool's output once, so it goes in a step that says so).
- **Raised:** 2026-09-30 (BIGDATA-4). Older than BIGDATA-4. Recorded only.
- **Resolved (FINAL, D130):** `ORDER BY status`. `apps/api/test/matter-status-order.integration.test.ts`: red with the hash grouping forced, green.

---

## DEV-046 — A server error sent its own text to the caller (resolved)

- **Requirement:** PRD §45.4 (errors as RFC 9457 problem details) and basic hygiene for a public service: a caller must not learn the database's messages, table names or hosts.
- **We did:** the API's error handler put `error.message` in a 500's `detail`, in every environment (for example "null value in column \"investigation_id\" of relation \"ethical_walls\" violates not-null constraint", seen while fixing DEV-036), and the health checks put the database's connection error in their 503.
- **Consequence:** anyone who could trigger a server error learned internal details (table and column names, constraint names, a database host or port).
- **Raised:** 2026-09-30 (FINAL safety check).
- **Resolved (FINAL, D131):** a 5xx says "An unexpected error occurred. Quote the request ID if you report it." with the request ID; the full error goes to the server log with that ID. 4xx messages are unchanged. The health checks answer "Database round-trip failed" with the request ID. `apps/api/test/error-detail.integration.test.ts`, red then green; no other test depended on the raw text.
- **Left:** `/ready` with the database down answers 500 (generic) rather than 503, as before.
