# Plan: sign-in for the MCP connector

**Status:** approved 2026-09-26 with the answers in section 8. Built in phases, each checked before the next.
- **Phase 0 — done:** the password-reset hole is closed (D65, DEV-020) and real rate limits are in place (D66, migration 0025).
- **Phase 1 — done:** `/mcp` runs on the MCP SDK's Streamable HTTP transport, stateless, with the auth gate in front of every method (D67, supersedes D54); postgres.js `sql.array()`, the only API with the first-query array fault, is banned by guardrail (D68). Found on the way: passkey registration is broken (DEV-021).
- **Phase 2A — done:** Casefile is its own OAuth 2.1 authorization server: discovery, CIMD-only clients from an allowlist, the sign-in page (password, TOTP, refusals, consent), the token endpoint (PKCE S256, rotation), TOTP enrolment through the admin one-time link, DEV-021 fixed (D69–D72).
- **Phase 2B — done:** `/mcp` accepts only the OAuth access token, checked against the database on every request (D73); every tool is checked against the caller's role, `tools/list` shows only allowed tools, and every call and denial is audited before the reply (D74); `guardrails/mcp-auth.spec.ts` and the Class E extension (section 7) are in; the static `MCP_TOKEN` is retired from the code, templates and deploy script (the secrets of live matters are disabled by hand in Phase 4, section 6 step 7); D61's wording is fixed. The MFA holes found in 2A are closed: DEV-022 and DEV-023, single-use TOTP codes and 160-bit secrets (D75); refresh re-checks the user and their eligibility and rotates atomically (D76). Still open: DEV-024 (group walls); new findings DEV-025 to DEV-028.
- **Phase 3 — done:** section 5 as written (D77): `MCP_AUTH_MODE` with the local no-login mode, its startup refusals, the per-request loopback + Host guard, a banner, audit rows marked `local-no-login`, all through the same `/mcp` auth gate; the single-reader check in `guardrails/mcp-auth.spec.ts`; the stdio CLI runs as `MCP_LOCAL_USER_ID` with the same checks. The 2B findings are fixed: DEV-025 (D80), DEV-026 (D79), DEV-027 (D81), DEV-028 (D78). The rate-limit recovery test now waits on the database clock. Still open: DEV-024 (group walls).
- **Phase 4A — done:** DEV-029 fixed: `get_document_page` reads only through a source of the matter's investigation, and one test calls all 9 tools with a second investigation's IDs (D82). `pnpm matter:preflight --env <file>` reports migrations, every user and whether they can use Claude, and `MCP_PUBLIC_URL`, with READY / NOT READY, inside READ ONLY transactions (D83). `deploy-matter.ts --dry-run` prints every step and runs none (D84); the service phase now builds and pushes the image, takes `--env`, and passes `MCP_OAUTH_TRUSTED_CLIENTS` (D85). Section 6 is written out for a non-developer as `docs/UPGRADE-LIVE-MATTER.md` (D86); `START-HERE.md` §5 and `MATTER-SETUP.md` §5 describe sign-in. New finding: DEV-030 (no command adds a person to an existing matter). Still open: DEV-024.
- **Phase 4 — done (closed 2026-09-28):** the planned live test on one matter (4B) was dropped: Casefile is now an open-source template (the owner's decision, 28 Sep). The close added `pnpm admin:add-user`, so an administrator can give a colleague an account and their setup link in one command (D87, DEV-030 resolved), and made the runbook say to deploy an existing matter with `--phase=service` only and to compare the service's environment variables with the dry run before deploying; the deploy now also carries the optional settings `RP_ID` and `TRUST_PROXY_HOPS` (D88). **Still unconfirmed:** the hosted Claude app's (claude.ai, Desktop) client ID; Claude does not publish it and it only shows up in a real deploy (`docs/UPGRADE-LIVE-MATTER.md` step 8). Still open: DEV-024 (group walls).

**Goal:** a person adds the matter's `/mcp` URL to Claude as a custom connector, signs in with their
existing Casefile account, and Claude then sees only that matter, with only what their role allows.

---

## 0. What exists today (read this first)

The brief says `/mcp` has no authentication. That is not quite right. Two facts change the plan:

| Today | Where |
|---|---|
| `/mcp` requires **one shared static bearer token** (`MCP_TOKEN`), compared in constant time. Anyone holding that string is "in". | `apps/api/src/routes/mcp.ts`, `mcpAuthPreHandler` |
| The token identifies **nobody**. Every tool call runs as the tenant's *first-created user*, with the role hard-coded to `investigator`, for the tenant and investigation set in env (`MATTER_TENANT_ID`, `MATTER_INVESTIGATION_ID`). | `routes/mcp.ts`, `tools/call` branch |
| The stdio CLI (`packages/mcp/src/cli.ts`) has no auth: it runs locally with the database credentials in its environment. | `packages/mcp/src/cli.ts` |
| The HTTP endpoint is a hand-rolled JSON-RPC handler that answers `initialize` with protocol version `2024-11-05` and returns 404 for anything else it doesn't know (including `notifications/initialized`). | `routes/mcp.ts` |
| The API binds `0.0.0.0` by default, and Cloud Run is deployed with `--allow-unauthenticated`. | `apps/api/src/server.ts`, `scripts/deploy-matter.ts` |

It also conflicts with two recorded decisions:
- **D54** says the MCP server is stdio-only and "never opens a network port". The HTTP `/mcp` route contradicts it. This plan supersedes D54.
- **D55** says every MCP session "carries a token that resolves to an actor, a tenant and a role". The static token resolves to none of those. This plan is what makes D55 true.

**Blocker found while planning — closed in Phase 0:** `POST /v1/auth/password-reset/request` was
public and returned the reset token in the response body, so anyone who knew a user's email and
tenant ID could reset their password. It now returns the same `202` for every request and delivers
nothing; administrators issue one-time reset links with `pnpm admin:reset-link` (D65, DEV-020).

---

## 1. How Claude signs in

### What the spec and Claude require

Sources used (read 2026-09-26):
- MCP authorization spec, revision **2026-07-28** (current "latest"): [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery), [Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), [Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Claude: [Authentication for connectors](https://claude.com/docs/connectors/building/authentication), [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication), [Get started with custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) (updated 2026-08-11)

The points that decide the design:

- **The MCP server is an OAuth 2.1 resource server.** It MUST publish Protected Resource Metadata (RFC 9728). Claude needs a `401` carrying `WWW-Authenticate: Bearer resource_metadata="…"` to start sign-in, and ignores that header on a `200`.
- **Discovery.** Claude reads the resource metadata and uses **only the first** entry in `authorization_servers`. It then fetches RFC 8414 metadata from `/.well-known/oauth-authorization-server`. The metadata's `resource` must equal the URL the user typed, path included.
- **Client registration.** The spec prefers Client ID Metadata Documents (CIMD) and marks Dynamic Client Registration (DCR) **deprecated**. Claude uses CIMD only if our server metadata advertises both `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`; otherwise it falls back to DCR. **We will support CIMD and not DCR.**
- **PKCE.** Required, with S256. We must advertise `code_challenge_methods_supported: ["S256"]`; spec-compliant clients refuse to proceed without it. Claude always sends S256.
- **Resource indicator (RFC 8707).** Clients send `resource=<canonical MCP URL>` on both the authorize and token requests. The server MUST reject tokens not issued for itself, and must never pass tokens through to anything else.
- **Tokens.** Sent only in the `Authorization` header, never in the query string. An invalid or expired token gets `401`; a token with insufficient scope gets `403` with `error="insufficient_scope"`.
- **Refresh.** Rotation is required for public clients (Claude is one). A dead refresh token must return `invalid_grant`. Claude refreshes on `401`, and proactively up to 5 minutes before expiry. The token endpoint must accept `application/x-www-form-urlencoded`.
- **Callback URLs.**
  - The hosted Claude apps (claude.ai, Desktop, mobile) use exactly `https://claude.ai/api/mcp/auth_callback`. Claude's docs say this may move to `https://claude.com/api/mcp/auth_callback`.
  - Claude Code uses a loopback redirect on a random port, which must be matched with the port ignored.
- **Network.** Claude reaches custom connectors from Anthropic's cloud (`160.79.104.0/21`), not from the user's machine. The MCP server and its OAuth endpoints must be publicly reachable over HTTPS. OAuth endpoints get 10 seconds to respond (30 for refresh).
- **Consent screen.** It must show the redirect URI's hostname, and name the host of the `client_id` URL rather than the self-asserted `client_name`.

I did not find the labels "Sign in now" / "Sign in when needed" in the docs above. With this design
every `/mcp` request without a valid token gets a `401`, so Claude asks the user to sign in as soon as
the connector is used, whichever option they pick.

### Flow

```
Claude ──POST /mcp (no token)──────────────▶ API ── 401 + WWW-Authenticate: Bearer
                                                   resource_metadata=".../.well-known/oauth-protected-resource/mcp",
                                                   scope="casefile.read"
Claude ──GET protected-resource metadata───▶ API ── { resource, authorization_servers:[issuer], scopes_supported }
Claude ──GET /.well-known/oauth-authorization-server ▶ API ── { authorize/token endpoints, S256, CIMD, "none" }
Browser ─GET /oauth/authorize?client_id=<Claude CIMD URL>&code_challenge=…&resource=…&redirect_uri=…
         API fetches Claude's CIMD, checks client_id + redirect_uri, shows sign-in, then consent
Browser ◀─302 redirect_uri?code=…&state=…&iss=<issuer>
Claude ──POST /oauth/token (code + code_verifier + resource)─▶ API ── access token (15 min) + refresh token
Claude ──POST /mcp  Authorization: Bearer <token> ──▶ API ── validates, runs tool as that user
```

### Endpoints to add (all on the existing API; it is its own authorization server)

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` | `{ resource: MCP_PUBLIC_URL, authorization_servers: [issuer], scopes_supported: ["casefile.read"], bearer_methods_supported: ["header"] }` |
| `GET /.well-known/oauth-authorization-server` | `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `scopes_supported: ["casefile.read","offline_access"]`, `authorization_response_iss_parameter_supported: true` |
| `GET/POST /oauth/authorize` | Minimal server-rendered sign-in and consent page. The product has no web UI (DEV-015), so this is the one page it needs. |
| `POST /oauth/token` | `authorization_code` (PKCE required) and `refresh_token` grants, form-encoded |

- **Canonical URL:** a new required setting `MCP_PUBLIC_URL`, the full HTTPS URL of `/mcp`. It is used as the `resource` value, as the token audience, and to derive the issuer (its origin).
- **Allowed clients:** CIMD `client_id`s are accepted only from an allowlist, `MCP_OAUTH_TRUSTED_CLIENTS`. It defaults to Claude Code's `https://claude.ai/oauth/claude-code-client-metadata`. **2A (D70):** Claude's docs do not publish the hosted apps' CIMD URL, so it is not a default; add it once confirmed (the Phase 4 live test shows the client_id claude.ai sends, which is logged when refused).
- **Allowed redirect URIs:** both Claude callback hosts, plus port-agnostic loopback for Claude Code. **2A (D70):** Claude's docs now list only `https://claude.ai/api/mcp/auth_callback`; both are kept by decision, and a redirect must also be listed in the client's own document. The `resource` parameter is compared canonically (scheme and host case-insensitive).
- **CIMD fetching:** HTTPS only, 5-second timeout, size cap, no private or loopback IPs (SSRF protection), cached according to HTTP cache headers.

**Transport prerequisite.** Before auth work starts, confirm that a Claude custom connector actually
works against today's hand-rolled `/mcp` handler. It answers with a 2024 protocol version, and 404s
notifications instead of accepting them. The likely fix is to serve `/mcp` through the MCP SDK's
Streamable HTTP transport (the SDK is already a dependency), with the auth gate running in front of it.
**Done in Phase 1 (D67):** `/mcp` now uses the SDK's Streamable HTTP transport, stateless, JSON
responses only; the SDK client test calls every tool over HTTP.

---

## 2. Reusing existing accounts, sessions and roles

No second login system: no new user or password tables, and no separate identity provider.

- **Sign-in:** the authorize page calls the existing `AuthService.login`: password, then TOTP. **TOTP is mandatory for MCP sign-in** (answer 3); a user without TOTP enrolled gets no token and is told why. Passkeys (`verifyWebAuthnAuthentication`) are offered only where `RP_ID` matches the public host. The per-account login lockout and the D66 rate limits apply.
- **Tenant is fixed by the deployment.** One deployment serves one matter, so the page only looks up users in `MATTER_TENANT_ID` and never asks for a tenant.
- **Sessions:** each Claude connection becomes a row in the existing `auth_sessions` table, one session family per connection. A new, additive migration `0026_oauth_mcp.sql` (0025 is Phase 0's rate limits; existing migrations are never edited):
  - adds `oauth_client_id` and `audience` columns to `auth_sessions`;
  - creates `oauth_authorization_codes`, which stores a hash of the code, plus client, redirect URI, PKCE challenge, resource, scope, user and tenant. Codes are single-use and expire in 60 seconds.
- **Access token:** the existing HS256 JWT (`signJwt`), 15 minutes, with three new claims: `aud` = `MCP_PUBLIC_URL`, `scope` = `casefile.read`, and `cid` = the client ID.
- **Refresh token:** issued through the existing rotation logic (`rotateRefreshToken`: new token on every use, and the whole family revoked if an old one is replayed). Errors come back as `invalid_grant`.
- **Refresh session lifetime:** a Claude connection's session expires after **30 days unused** (no refresh within 30 days, measured on `auth_sessions.last_active_at`) and after **90 days at most** from sign-in, whatever its use. The user then signs in again.
- **Consent:** asked on **every new connection** (answer 7); nothing is remembered per client.
- **Checks on every `/mcp` request:** valid signature, not expired, `aud` equals `MCP_PUBLIC_URL`, `tid` equals `MATTER_TENANT_ID`, session not revoked, user still active. These are database checks, so revoking a session or disabling a user takes effect immediately, not after 15 minutes.
- **Keeping REST and MCP tokens apart:** `/mcp` rejects tokens without its `aud`, so REST API tokens don't work there. The REST API rejects tokens that carry an `aud`, so MCP tokens can't call the REST API.
- **Revoking access:** the existing `listSessions` and `revokeSession` endpoints list Claude connections (labelled by client host) and revoke them.
- **Real identity in every tool call:** `MatterContext.userId` and `roles` come from the signed-in user, replacing "first user, investigator".

---

## 3. What each role can do through MCP

Every `tools/call` is checked with the existing `evaluatePermission` against the user's role on this
investigation. Per D48, an investigation role replaces the workspace role. Claude is an external model
reading case material, so every tool also requires `ai.query`.

| Tool | Permissions required |
|---|---|
| `matter_status` | `investigation.read` + `ai.query` |
| `list_investigations` | `investigation.read` + `ai.query` |
| `get_investigation` | `investigation.read` + `ai.query` |
| `list_documents` | `investigation.read` + `source.read` + `ai.query` |
| `get_source` | `investigation.read` + `source.read` + `ai.query` |
| `get_document_page` | `investigation.read` + `source.read` + `ai.query` |
| `get_evidence` | `investigation.read` + `source.read` + `ai.query` |
| `search` | `investigation.read` + `source.read` + `ai.query` |
| `get_download_link` | `investigation.read` + `source.read` + `ai.query` + **`export.create` = allow** (answer 2) |

What the current permission matrix gives for each role:

| Role | MCP access | Why |
|---|---|---|
| `ws_admin`, `lead_inv` | All 9 tools | allowed `investigation.read`, `source.read`, `ai.query` and `export.create` |
| `investigator`, `analyst`, `reviewer`, `contributor` | 8 tools (all except `get_download_link`) | allowed `investigation.read`, `source.read` and `ai.query`; `export.create` is not `allow` (it is `requires_approval` for `investigator` and `reviewer`, `deny` for the others) |
| `viewer` | None (answer 1) | `ai.query` is denied |
| `auditor` | None | `investigation.read` and `source.read` are denied |
| `org_admin` | None | `source.read` is denied (`investigation.read` requires approval) |

- A user whose role allows no tools is told so on the sign-in page and gets no token.
- `tools/list` returns only the tools the caller may use.
- A denied call writes the existing policy-denial audit event.

**Read-only confirmation (PRD §60 Class E):**
- None of the 9 tool names appears in `guardrails/class-e.ts` (`CLASS_E_TOOL_NAMES`).
- The tool handlers in `packages/mcp/src/tools.ts` contain no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER` or `DROP`; every query is a `SELECT`.
- `get_download_link` returns a signed read URL that expires in 15 minutes.
- No tool can verify, approve, publish, export, share, withdraw, purge, merge or delete anything.
- The only new write this plan adds is one row in the append-only `audit_events` per tool call, recording who read what. That is audit data, not case data.

---

## 4. Tenant isolation

Several independent layers each stop a signed-in user from seeing anything outside their own matter:

1. The authorization server only signs in users of `MATTER_TENANT_ID`.
2. `/mcp` rejects a token whose `tid` is not `MATTER_TENANT_ID` (`401`).
3. `/mcp` rejects a token whose `aud` is not this deployment's URL. Each matter also has its own JWT secret (D59), so a token from another matter's deployment fails signature checking as well.
4. The user must be an active member of the workspace that owns `MATTER_INVESTIGATION_ID`, and must not be behind an ethical wall for it.
5. Every query runs inside `withTenant(token.tid)`, so row-level security applies. The tool handlers also filter by `tenant_id` and `investigation_id` themselves.

---

## 5. Local development: explicit no-login mode

- **Setting:** `MCP_AUTH_MODE` = `oauth` (the default, including when unset) or `local-no-login`.
- **At startup,** `local-no-login` is refused, and the process exits with a FATAL message, unless **all** of these hold:
  - `HOST` is `127.0.0.1`, `::1` or `localhost` (the `0.0.0.0` default is refused);
  - `K_SERVICE` is unset (i.e. not on Cloud Run);
  - `NODE_ENV` is not `production`;
  - `MCP_PUBLIC_URL` is unset or loopback;
  - `MCP_LOCAL_USER_ID` names an existing user in `MATTER_TENANT_ID` with an MCP-capable role. Calls still run with a real identity and role.
- **On every request,** even in this mode, the remote address must be loopback **and** the `Host` header must be `localhost` or `127.0.0.1` (this defends against DNS rebinding). Anything else gets `403`.
- **Visibility:** a loud startup banner, and every audit event marks the actor as `local-no-login`.
- **Reach:** Claude's hosted apps can't reach `localhost` (they connect from Anthropic's cloud), so this mode is for Claude Code, MCP Inspector and tests.
- **The stdio CLI stays as it is.** The spec says stdio servers take credentials from the environment rather than use OAuth, and the CLI already needs database credentials to run, so it's an operator-only path. It gains the same real-user `MatterContext` via `MCP_LOCAL_USER_ID`.

---

## 6. Matters already deployed without sign-in

Nothing changes for them until they are redeployed: each keeps running the image it was deployed
with, static token and all. To move one matter over (step by step, for a non-developer, with what
to expect at each step: `docs/UPGRADE-LIVE-MATTER.md`):

1. **Accounts:** make sure everyone who will use Claude has an account in that matter's tenant, with an MCP-capable role (section 3). The ingest bootstrap created one admin with a random password. Give each person a first password with `pnpm admin:reset-link --email <email>` (answer 4), and have them enrol TOTP, which MCP sign-in requires.
2. **Config:** set `MCP_PUBLIC_URL` (and `RP_ID` if you want passkeys) in the matter's deploy settings.
3. **Database:** apply migrations `0025` (rate limits), `0026` (OAuth) and `0027` (single-use TOTP codes) with the normal migration runner (the pre-flight guard applies). All three are additive, so the old code keeps working.
4. **Deploy:** redeploy with `scripts/deploy-matter.ts`.
5. **Check with curl:**
   - `GET /.well-known/oauth-protected-resource/mcp` returns `200`;
   - `POST /mcp` without a token returns `401` with `WWW-Authenticate`;
   - `POST /mcp` with the old `MCP_TOKEN` returns `401`.
6. **In Claude:** remove the old connector entry that uses the static token. Then Customize → Connectors → Add custom connector, enter the URL, and sign in.
7. **Retire the static token:** remove it from the Cloud Run environment and **disable** (don't delete) the `casefile-<matter>-mcp-token` secret version. Update `MATTER-SETUP.md` §5.
8. **Rollback:** route traffic back to the previous Cloud Run revision (re-enable the token's secret versions first if step 7 was done). Migrations `0025`–`0027` don't affect old code.

---

## 7. Tests and guardrails

**Integration tests** (real Postgres, like the rest of the suite):
- `POST /mcp` and `GET /mcp` without a token → `401` with a `WWW-Authenticate` header carrying `resource_metadata` and `scope`.
- Rejected with `401`:
  - bad signature;
  - **expired token**;
  - wrong `aud` (for example a REST API token);
  - revoked session;
  - deactivated user;
  - the old static `MCP_TOKEN`;
  - a token sent in the query string.
- **Tenant A token against tenant B's matter** → `401`, and no tenant B rows are returned by any of the 9 tools. This is tested both with a forged `tid` and with a validly signed token from tenant A.
- A user who isn't a member of the investigation's workspace, or who is behind an ethical wall, → rejected.
- The role matrix: each allowed role can call each tool; `viewer`, `auditor` and `org_admin` get no token; `tools/list` matches the role.
- The OAuth flow end to end:
  - both discovery documents have the required fields;
  - authorize plus token with S256 works;
  - rejected: a wrong `code_verifier`, `plain` PKCE, a reused code, an expired code, a mismatched `redirect_uri`, and a missing or wrong `resource`;
  - the response includes `iss`;
  - refresh rotates the token, and replaying an old refresh token revokes the family and returns `invalid_grant`;
  - the token endpoint accepts form-encoded bodies.
- CIMD: a document whose `client_id` doesn't match its URL, a host not on the allowlist, a private-IP URL, and a non-HTTPS URL are all rejected.
- An audit row is written for each tool call, with the real user as actor.
- Local mode:
  - refuses to start with `HOST=0.0.0.0`, with `K_SERVICE` set, or with `NODE_ENV=production`;
  - rejects a non-loopback remote address or a non-local `Host` header.

**Guardrails:**
- **`guardrails/mcp-auth.spec.ts`:**
  - builds the app in the default mode, enumerates **every registered route under `/mcp` and `/mcp/`**, and injects a request without a token into each; any response other than `401` fails the build;
  - statically checks that `local-no-login` is read in exactly one module, next to its startup refusal checks;
  - checks that no route under `/mcp` is registered with `public: true` unless it goes through the MCP auth gate.
- **Class E:** extend the existing check so that the `/mcp` `tools/list` names never intersect `CLASS_E_TOOL_NAMES`, and so that `packages/mcp/src/tools.ts` contains no data-changing SQL.

---

## 8. Risks and open questions

**Risks**
- **The password-reset hole (section 0):** closed in Phase 0 (D65).
- **A new public login page:** it needs CSRF protection, a strict Content-Security-Policy, rate limiting and careful error messages. It stays deliberately tiny.
- **Phishing through the consent screen:** mitigated by accepting only allowlisted Claude clients and showing the client host and redirect host.
- **Shared signing secret:** REST and MCP tokens share one per matter. If the audience checks were ever skipped, one kind of token would work in the other place. The guardrail and tests cover this.
- **Public exposure:** the service must be reachable from Anthropic's IP range. Real rate limits now cover sign-in, password reset and the future `/oauth/token` (D66); the old hard-coded `x-ratelimit-*` headers are gone. `/oauth/token` and `/mcp` are called from Anthropic's shared egress range, so their per-IP limits are generous and per-account limits do the work.
- **TOTP enrolment without a UI (raised by answer 3):** users must enrol TOTP before they can connect, and the product has no web UI. Enrolment must not be offered to anyone who only has a password, or a stolen password would let an attacker enrol their own authenticator. TOTP enrolment happens only through the admin-issued one-time link (`pnpm admin:reset-link`), which proves the link was received. **Built in Phase 2A (D71)**: `/account/setup` sets the password and enrols TOTP together; `/v1/auth/mfa/setup` returns 410.
- **Passkeys:** they only work if `RP_ID` matches the public host. Registration was broken (DEV-021) and is fixed in 2A. Password + TOTP is the dependable path.
- **Spec churn:** the MCP spec is at 2026-07-28, while Claude's docs cite 2025-11-25. We implement the parts both agree on (PRM, RFC 8414, CIMD, S256, `resource`) and skip deprecated DCR.
- **Audit volume:** one audit row per tool call increases writes.
- **Recorded decisions:** D54 is superseded by D67 (Phase 1). D69–D72 record Phase 2A. D73–D76 record Phase 2B, which also fixed D61's wording (it referred to `MCP_TOKEN`) when `MCP_TOKEN` was retired. D77–D81 record Phase 3. D82–D86 record Phase 4A. D87–D88 record the Phase 4 close.

**Open questions — answered 2026-09-26**

| # | Question | Answer |
|---|---|---|
| 1 | Should `viewer` use Claude? | **No MCP access.** |
| 2 | Restrict `get_download_link`? | **Only roles with `export.create` = allow** (`ws_admin`, `lead_inv`). |
| 3 | TOTP for MCP sign-in? | **Mandatory.** |
| 4 | First password for existing users? | **Admin-issued one-time link for now** (`pnpm admin:reset-link`, built in Phase 0); email later. |
| 5 | Canonical URL? | **The Cloud Run service URL for now.** Passkeys, if used, are tied to that host. |
| 6 | One matter per deployment? | **Yes.** |
| 7 | Remember consent? | **No: asked on every new connection.** |
| — | Refresh sessions | **Expire after 30 days unused and 90 days at most** (section 2). |

**Out of scope:** DCR, "lazy" (mixed) authentication (every tool needs an identity), Enterprise
Managed Auth, and any write tools.
