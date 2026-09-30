# MCP Tool Candidates Inventory & Omission Rationale

This document inventories every route defined in `apps/api/src/routes/*.ts` to establish the candidate set for MCP exposure, verify real integration test coverage against the live database, and explicitly record why non-exposed candidates were omitted (per Decision D61 and Epic verification discipline).

---

## Candidate Route Inventory

| HTTP Method | Route Path | Service / Handler Function | Integration Test Coverage | Exposed as MCP Tool? | Inclusion / Omission Rationale |
|---|---|---|---|---|---|
| `GET` | `/health`, `/healthz` | `healthRoutes` | `apps/api/test/api.integration.test.ts` | No | Operational infrastructure probe; internal service metadata exposed via `matter_status`. |
| `POST` | `/v1/auth/*` (8 routes) | `authRoutes` / `AuthService` | `apps/api/test/api.integration.test.ts` | No | User authentication and MFA; `/mcp` authenticates each person with an OAuth access token from Casefile's own sign-in (D69, D73). |
| `POST` | `/v1/organizations` | `organizationRoutes` | `apps/api/test/api.integration.test.ts` | No | Tenant lifecycle administration; out of investigative scope. |
| `GET` | `/v1/organizations/:id` | `organizationRoutes` | `apps/api/test/api.integration.test.ts` | No | Tenant metadata; out of investigative scope. |
| `GET` | `/v1/workspaces` | `workspaceRoutes` | `apps/api/test/user-stories.integration.test.ts` | No | Workspace container listing; scoped per matter deployment. |
| `POST` | `/v1/workspaces` | `workspaceRoutes` | `apps/api/test/user-stories.integration.test.ts` | No | Write operation omitted per Decision D61. |
| `GET` | `/v1/investigations` | `investigationRoutes` | `apps/api/test/investigations.integration.test.ts` | **YES (`list_investigations`)** | Core investigation listing scoped to tenant deployment. |
| `GET` | `/v1/investigations/:id` | `investigationRoutes` | `apps/api/test/investigations.integration.test.ts` | **YES (`get_investigation`)** | Core investigation metadata, status, and legal hold. |
| `POST` | `/v1/investigations` | `investigationRoutes` | `apps/api/test/investigation-stories.integration.test.ts` | No | Write operation omitted per Decision D61. |
| `PATCH` | `/v1/investigations/:id` | `investigationRoutes` | `apps/api/test/investigation-stories.integration.test.ts` | No | Write operation omitted per Decision D61. |
| `GET` | `/v1/sources`, `/v1/investigations/:id/sources` | `sourceRoutes` | `apps/api/test/sources.integration.test.ts` | **YES (`list_documents`)** | Primary source/document listing scoped to matter. |
| `GET` | `/v1/sources/:id` | `sourceRoutes` | `apps/api/test/sources.integration.test.ts` | **YES (`get_source`)** | Source document metadata and structural content blocks. |
| `GET` | `/v1/content-documents/:id/pages/:page` | `sourceRoutes` | `apps/api/test/sources.integration.test.ts` | **YES (`get_document_page`)** | Page-level text extraction with bbox coordinate locators. |
| `GET` | `/v1/sources/:id/download` | `sourceRoutes` | `packages/storage/test/storage.integration.test.ts` | **YES (`get_download_link`)** | Presigned GCS download URL with stated TTL (packages/storage). |
| `POST` | `/v1/sources` | `sourceRoutes` | `apps/api/test/live-ingest.integration.test.ts` | No | Ingestion write operation; performed via Ingest CLI. |
| `PATCH` | `/v1/sources/:id/withdraw` | `sourceRoutes` | `apps/api/test/ingestion-stories.integration.test.ts` | No | Mutation operation omitted per Decision D61. |
| `GET` | `/v1/evidence/:id` | `evidenceRoutes` | `apps/api/test/evidence-acceptance.integration.test.ts` | **YES (`get_evidence`)** | Verifiable evidence span, locator, and span hash (Invariant I9). |
| `POST` | `/v1/evidence` | `evidenceRoutes` | `apps/api/test/evidence-stories.integration.test.ts` | No | Evidence creation is a mutating action omitted per Decision D61. |
| `PATCH` | `/v1/evidence/:id` | `evidenceRoutes` | `apps/api/test/evidence-stories.integration.test.ts` | No | Mutation operation omitted per Decision D61. |
| `DELETE` | `/v1/evidence/:id` | `evidenceRoutes` | `apps/api/test/evidence-stories.integration.test.ts` | No | Mutation operation omitted per Decision D61. |
| `POST` | `/v1/investigations/:id/search` | `searchRoutes` / `executeSearch` | `apps/api/test/search-acceptance.integration.test.ts` | **YES (`search`)** | Honest lexical retrieval with transparent signal explanations. |
| `GET` | `/v1/entities`, `/v1/entities/:id` | `entityRoutes` | `apps/api/test/entities.integration.test.ts` | No | Epic E5 has 0 verified requirements in traceability report. |
| `POST` | `/v1/entities`, `/v1/entities/merge` | `entityRoutes` | `apps/api/test/entity-stories.integration.test.ts` | No | Mutating operations & Epic E5 unverified. |
| `GET` | `/v1/relationships` | `relationshipRoutes` | `apps/api/test/entity-stories.integration.test.ts` | No | Epic E5 unverified. |
| `GET` | `/v1/contradictions` | `contradictionRoutes` | `apps/api/test/correlation-acceptance.integration.test.ts` | No | Epic E9 has 0 verified requirements in traceability report. |
| `GET` | `/v1/gaps` | `gapRoutes` | `apps/api/test/correlation-stories.integration.test.ts` | No | Epic E9 has 0 verified requirements in traceability report. |
| `GET` | `/v1/assertions` | `assertionRoutes` | `apps/api/test/assertions.integration.test.ts` | No | Epistemic assertions unverified in core MCP surface. |
| `GET` | `/v1/memory/context` | `memoryRoutes` | `apps/api/test/memory.integration.test.ts` | No | Internal context manifest; operational data covered by `matter_status`. |
| `POST` | `/v1/ai/*` (4 routes) | `aiRoutes` | `apps/api/test/ai-acceptance.integration.test.ts` | No | LLM generation gateway; MCP client is itself the reasoning agent. |
| `GET` | `/v1/audit/events` | `auditRoutes` | `packages/audit/test/audit.integration.test.ts` | No | Audit log inspection; reserved for administrative/compliance CLI. |
| `POST` | `/v1/auth/break-glass` | `breakGlassRoutes` | `apps/api/test/security-stories.integration.test.ts` | No | Emergency administrative bypass; forbidden over MCP. |

---

## Active Exposed Read Tools (Exactly 9)

1. **`matter_status`**: Operational health, source counts, vector availability (`false`), and uncomputed search signals.
2. **`list_investigations`**: Scoped investigation listing (`GET /v1/investigations`).
3. **`get_investigation`**: Detailed investigation metadata (`GET /v1/investigations/:id`).
4. **`list_documents`**: Primary source listing for matter (`GET /v1/investigations/:id/sources`).
5. **`get_source`**: Document structure and text blocks (`GET /v1/sources/:id`).
6. **`get_document_page`**: Exact page text with bbox coordinates (`GET /v1/content-documents/:id/pages/:page`).
7. **`get_download_link`**: Presigned Google Cloud Storage download URL (`GET /v1/sources/:id/download`).
8. **`get_evidence`**: Cryptographically verifiable evidence span (`GET /v1/evidence/:id`).
9. **`search`**: Transparent lexical search with query signal breakdown (`POST /v1/investigations/:id/search`).
