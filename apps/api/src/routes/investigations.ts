import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  CreateInvestigationRequestSchema,
  UpdateInvestigationRequestSchema,
  TransitionStageRequestSchema,
  InvestigationSchema,
  CreateQuestionRequestSchema,
  UpdateQuestionRequestSchema,
  InvestigationQuestionSchema,
  AddInvestigationMemberRequestSchema,
  InvestigationMemberSchema,
  CreateTemplateRequestSchema,
  InvestigationTemplateSchema,
  CreateNoteRequestSchema,
  NoteSchema,
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  TaskSchema,
  PaginationQuerySchema,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { encodeCursor, decodeCursor } from "../pagination.js";

interface DbInvestigation {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  stage: string;
  sensitivity: string;
  retention_class: string;
  legal_hold: boolean;
  objective: string | null;
  legitimacy_declaration: unknown;
  scope: unknown;
  suspension_reason: string | null;
  reopen_justification: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  deleted_at: Date | null;
}

interface DbQuestion {
  id: string;
  tenant_id: string;
  investigation_id: string;
  sequence: number;
  text: string;
  parent_question_id: string | null;
  materiality: "critical" | "important" | "supporting";
  status: "open" | "partially_answered" | "answered" | "unanswerable";
  unanswerable_rationale: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  deleted_at: Date | null;
}

interface DbTemplate {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  questions: unknown;
  scope_defaults: unknown;
  expected_source_types: unknown;
  collection_checklist: unknown;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

interface DbNote {
  id: string;
  tenant_id: string;
  investigation_id: string;
  target_type: "investigation" | "entity" | "evidence" | "relationship" | "hypothesis" | "finding" | "event";
  target_id: string;
  content: string;
  mentions: unknown;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

interface DbTask {
  id: string;
  tenant_id: string;
  investigation_id: string;
  title: string;
  description: string | null;
  assignee_id: string | null;
  due_date: Date | null;
  status: "todo" | "in_progress" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "urgent";
  target_type: string | null;
  target_id: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

interface DbMember {
  id: string;
  tenant_id: string;
  investigation_id: string;
  user_id: string;
  role: "lead_investigator" | "investigator" | "reviewer" | "auditor" | "viewer";
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function parseJsonField<T = Record<string, unknown>>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  let parsed = val;
  while (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return (typeof parsed === "object" && parsed !== null ? parsed : fallback) as T;
}

function normalizeInvestigation(row: DbInvestigation) {
  return InvestigationSchema.parse({
    ...row,
    legal_hold: Boolean(row.legal_hold),
    scope: parseJsonField(row.scope, {
      subjects: [],
      temporal_bounds: { from: null, to: null },
      jurisdictions: [],
      inclusions: [],
      exclusions: [],
      data_categories_permitted: [],
    }),
    legitimacy_declaration: parseJsonField(row.legitimacy_declaration, null),
  });
}

function normalizeQuestion(row: DbQuestion) {
  return InvestigationQuestionSchema.parse({
    ...row,
    sequence: Number(row.sequence),
  });
}

export const investigationRoutes: FastifyPluginAsync = async (fastify) => {
  // PRD §45.2 / §55.3 INV-01: POST /v1/investigations (under 30s creation, optional template)
  fastify.post(
    "/v1/investigations",
    { config: { permission: "investigation.create" } },
    async (req, reply) => {
      const parsed = CreateInvestigationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const invId = randomUUID();
      let initialScope: Record<string, unknown> = {
        subjects: [],
        temporal_bounds: { from: null, to: null },
        jurisdictions: [],
        inclusions: [],
        exclusions: [],
        data_categories_permitted: [],
      };
      if (parsed.data.scope) {
        initialScope = { ...initialScope, ...parsed.data.scope };
      }
      const initialQuestions: Array<{ text: string; materiality: "critical" | "important" | "supporting"; sequence: number }> = [];

      // If template_id provided (INV-02), fetch and pre-populate
      if (parsed.data.template_id) {
        const tplRows = await req.tx!<DbTemplate[]>`
          SELECT *
          FROM investigation_templates
          WHERE id = ${parsed.data.template_id}
            AND tenant_id = ${req.user!.tenantId};
        `;
        if (tplRows.length > 0) {
          const tpl = tplRows[0]!;
          const scopeDefs = parseJsonField<Record<string, unknown>>(tpl.scope_defaults, {});
          initialScope = { ...initialScope, ...scopeDefs };
          const tplQuestions = parseJsonField<Array<{ text: string; materiality?: "critical" | "important" | "supporting" }>>(tpl.questions, []);
          tplQuestions.forEach((q, idx) => {
            initialQuestions.push({
              text: q.text,
              materiality: q.materiality || "important",
              sequence: idx + 1,
            });
          });
        }
      }

      // 1. Insert investigation in 'draft'
      const rows = await req.tx!<DbInvestigation[]>`
        INSERT INTO investigations (
          id, tenant_id, workspace_id, name, stage, sensitivity,
          retention_class, objective, scope, created_by
        )
        VALUES (
          ${invId}, ${req.user!.tenantId}, ${parsed.data.workspace_id}, ${parsed.data.name},
          'draft', ${parsed.data.sensitivity}, ${parsed.data.retention_class},
          ${parsed.data.objective || null}, ${JSON.stringify(initialScope)}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      // 2. Add creator as lead_investigator (INV-17)
      const memberId = randomUUID();
      await req.tx!`
        INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role, created_by)
        VALUES (${memberId}, ${req.user!.tenantId}, ${invId}, ${req.user!.userId}, 'lead_investigator', ${req.user!.userId});
      `;

      // 3. Pre-seed template questions if any
      for (const q of initialQuestions) {
        const qId = randomUUID();
        await req.tx!`
          INSERT INTO investigation_questions (id, tenant_id, investigation_id, sequence, text, materiality, status, created_by)
          VALUES (${qId}, ${req.user!.tenantId}, ${invId}, ${q.sequence}, ${q.text}, ${q.materiality}, 'open', ${req.user!.userId});
        `;
      }

      // 4. Audit trail emission
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: parsed.data.workspace_id,
        investigationId: invId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "investigation.create",
        objectType: "investigation",
        objectId: invId,
        objectDisplay: parsed.data.name,
        after: {
          name: parsed.data.name,
          workspace_id: parsed.data.workspace_id,
          sensitivity: parsed.data.sensitivity,
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(201);
      return normalizeInvestigation(rows[0]!);
    },
  );

  // PRD §45.2 / INV-15: GET /v1/investigations
  fastify.get(
    "/v1/investigations",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const query = PaginationQuerySchema.parse(req.query);
      const cursor = decodeCursor(query.cursor);

      let rows: DbInvestigation[];
      if (cursor) {
        rows = await req.tx!<DbInvestigation[]>`
          SELECT *
          FROM investigations
          WHERE tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
            AND (created_at, id) < (${new Date(cursor.createdAt)}, ${cursor.id})
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!<DbInvestigation[]>`
          SELECT *
          FROM investigations
          WHERE tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      }

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeCursor({
              id: String(lastItem.id),
              createdAt: new Date(String(lastItem.created_at)).toISOString(),
            })
          : null;

      reply.status(200);
      return {
        items: items.map((r) => normalizeInvestigation(r)),
        nextCursor,
      };
    },
  );

  // PRD §45.2 / GET /v1/investigations/:id
  fastify.get(
    "/v1/investigations/:id",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await req.tx!<DbInvestigation[]>`
        SELECT *
        FROM investigations
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${id} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return normalizeInvestigation(rows[0]);
    },
  );

  // PRD §45.2 / INV-03, 07, 08, 09, 18, AC-DEF-02: PATCH /v1/investigations/:id
  fastify.patch(
    "/v1/investigations/:id",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateInvestigationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const existingRows = await req.tx!<DbInvestigation[]>`
        SELECT *
        FROM investigations
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (existingRows.length === 0 || !existingRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${id} was not found.`,
          request_id: req.id,
        });
      }

      const existing = existingRows[0];

      // PRD §56.1 AC-DEF-02: Validation requirement for private_individual subjects
      if (parsed.data.scope && parsed.data.scope.subjects) {
        for (const s of parsed.data.scope.subjects) {
          if (s.subject_type === "private_individual" && (!s.legitimacy_basis || s.legitimacy_basis.trim() === "")) {
            return reply.status(400).send({
              type: "https://docs.casefile.com/errors/validation-error",
              title: "Validation Error",
              status: 400,
              detail: `Subject '${s.descriptor}' of type 'private_individual' requires a legitimacy_basis per PRD §8.3 / §56.1 (AC-DEF-02).`,
              request_id: req.id,
            });
          }
        }
      }

      const updatedName = parsed.data.name ?? existing.name;
      const updatedSensitivity = parsed.data.sensitivity ?? existing.sensitivity;
      const updatedObjective = parsed.data.objective !== undefined ? parsed.data.objective : existing.objective;
      const updatedLegalHold = parsed.data.legal_hold !== undefined ? parsed.data.legal_hold : existing.legal_hold;
      const updatedScope = parsed.data.scope ? JSON.stringify(parsed.data.scope) : JSON.stringify(parseJsonField(existing.scope, {}));
      const updatedLegitimacy = parsed.data.legitimacy_declaration ? JSON.stringify(parsed.data.legitimacy_declaration) : existing.legitimacy_declaration ? JSON.stringify(parseJsonField(existing.legitimacy_declaration, {})) : null;

      const updatedRows = await req.tx!<DbInvestigation[]>`
        UPDATE investigations
        SET
          name = ${updatedName},
          sensitivity = ${updatedSensitivity},
          objective = ${updatedObjective},
          legal_hold = ${updatedLegalHold},
          scope = ${updatedScope}::jsonb,
          legitimacy_declaration = ${updatedLegitimacy}::jsonb,
          updated_at = NOW()
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      // PRD §56.1 AC-DEF-02: Audit event on legitimacy/subject declaration
      if (parsed.data.scope?.subjects?.some((s) => s.subject_type === "private_individual")) {
        await writeAuditEvent(req.tx!, {
          tenantId: req.user!.tenantId,
          workspaceId: String(existing.workspace_id),
          investigationId: id,
          actorType: "user",
          actorId: req.user!.userId,
          actorDisplay: req.user!.userId,
          action: "legitimacy.declare",
          objectType: "investigation",
          objectId: id,
          objectDisplay: String(updatedName),
          after: {
            private_individuals: parsed.data.scope.subjects.filter((s) => s.subject_type === "private_individual"),
          },
          outcome: "success",
          requestId: req.id,
        });
      }

      reply.status(200);
      return normalizeInvestigation(updatedRows[0]!);
    },
  );

  // PRD §9.3 / §56.1 AC-DEF-01, AC-DEF-03, INV-11, 12, 13, 14: POST /v1/investigations/:id/stage
  fastify.post(
    "/v1/investigations/:id/stage",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = TransitionStageRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const invRows = await req.tx!<DbInvestigation[]>`
        SELECT *
        FROM investigations
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (invRows.length === 0 || !invRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${id} was not found.`,
          request_id: req.id,
        });
      }

      const inv = invRows[0];
      const targetStage = parsed.data.stage;
      const missingElements: string[] = [];

      // ── Gate 1 (PRD §9.2, §9.3, §56.1 AC-DEF-01): DEFINE → COLLECTING (or post-define) ──
      const postDefineStages = ["collecting", "processing", "exploring", "connecting", "analyzing", "challenging", "validating", "concluding", "reporting", "reviewing"];
      if (postDefineStages.includes(targetStage)) {
        if (!inv.objective || String(inv.objective).trim() === "") {
          missingElements.push("objective");
        }

        const qCount = await req.tx!<{ count: string }[]>`
          SELECT COUNT(*)::text as count
          FROM investigation_questions
          WHERE investigation_id = ${id}
            AND tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL;
        `;
        if (Number(qCount[0]?.count ?? 0) < 1) {
          missingElements.push("investigation questions (minimum 1 required)");
        }

        const scope = parseJsonField<{ subjects: Array<{ subject_type: string; legitimacy_basis?: string }> }>(inv.scope, { subjects: [] });
        if (!scope.subjects || scope.subjects.length < 1) {
          missingElements.push("subjects (minimum 1 required)");
        }

        // AC-DEF-02 check
        const invalidSubject = scope.subjects?.find((s) => s.subject_type === "private_individual" && (!s.legitimacy_basis || s.legitimacy_basis.trim() === ""));
        if (invalidSubject) {
          missingElements.push("legitimacy_basis for private_individual subject");
        }

        if (missingElements.length > 0) {
          return reply.status(400).send({
            type: "https://docs.casefile.com/errors/definition-gate-error",
            title: "Definition Gate Error",
            status: 400,
            detail: `Cannot transition to '${targetStage}': missing required elements [${missingElements.join(", ")}] per PRD §9.2 / §56.1 (AC-DEF-01). Investigation remains in '${inv.stage}'.`,
            request_id: req.id,
            missing_elements: missingElements,
          });
        }
      }

      // ── Gate 2 (PRD §8.2, §9.3, §56.1 AC-DEF-03): CONCLUDE requires all critical questions resolved ──
      if (targetStage === "concluding" || targetStage === "reporting" || targetStage === "reviewing" || targetStage === "archived") {
        const openCritical = await req.tx!<{ id: string; text: string; status: string }[]>`
          SELECT id, text, status
          FROM investigation_questions
          WHERE investigation_id = ${id}
            AND tenant_id = ${req.user!.tenantId}
            AND materiality = 'critical'
            AND status NOT IN ('answered', 'unanswerable')
            AND deleted_at IS NULL;
        `;
        if (openCritical.length > 0) {
          return reply.status(400).send({
            type: "https://docs.casefile.com/errors/closure-gate-error",
            title: "Closure Gate Error",
            status: 400,
            detail: `Cannot transition to '${targetStage}': ${openCritical.length} critical question(s) remain open. Every critical question must have a finding or be explicitly marked 'unanswerable' with a rationale per PRD §8.2 / §56.1 (AC-DEF-03).`,
            request_id: req.id,
            open_critical_questions: openCritical.map((q) => q.text),
          });
        }
      }

      // ── State updates & suspension/reopen handling ──
      const suspensionReason = targetStage === "suspended" ? parsed.data.suspension_reason || "Suspended by investigator" : inv.suspension_reason;
      const reopenJustification = inv.stage === "archived" && targetStage !== "archived" ? parsed.data.reopen_justification || "Reopened by lead investigator" : inv.reopen_justification;

      const updatedRows = await req.tx!<DbInvestigation[]>`
        UPDATE investigations
        SET
          stage = ${targetStage},
          suspension_reason = ${suspensionReason},
          reopen_justification = ${reopenJustification},
          updated_at = NOW()
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      // Audit transition
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: String(inv.workspace_id),
        investigationId: id,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: `investigation.stage.${targetStage}`,
        objectType: "investigation",
        objectId: id,
        objectDisplay: String(inv.name),
        before: { stage: inv.stage },
        after: { stage: targetStage, suspension_reason: suspensionReason, reopen_justification: reopenJustification },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);
      return normalizeInvestigation(updatedRows[0]!);
    },
  );

  // ── PRD §8.2 Questions Subroutes ──────────────────────────────────────────

  // GET /v1/investigations/:id/questions
  fastify.get(
    "/v1/investigations/:id/questions",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await req.tx!<DbQuestion[]>`
        SELECT *
        FROM investigation_questions
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL
        ORDER BY sequence ASC, created_at ASC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => normalizeQuestion(r)),
      };
    },
  );

  // POST /v1/investigations/:id/questions (INV-04, 05, 06)
  fastify.post(
    "/v1/investigations/:id/questions",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CreateQuestionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const qId = randomUUID();
      let seq = parsed.data.sequence;
      if (seq === undefined) {
        const countRows = await req.tx!<{ max_seq: number | null }[]>`
          SELECT MAX(sequence) as max_seq
          FROM investigation_questions
          WHERE investigation_id = ${id}
            AND tenant_id = ${req.user!.tenantId};
        `;
        seq = (countRows[0]?.max_seq ?? 0) + 1;
      }

      const rows = await req.tx!<DbQuestion[]>`
        INSERT INTO investigation_questions (
          id, tenant_id, investigation_id, sequence, text,
          parent_question_id, materiality, status, created_by
        )
        VALUES (
          ${qId}, ${req.user!.tenantId}, ${id}, ${seq}, ${parsed.data.text},
          ${parsed.data.parent_question_id || null}, ${parsed.data.materiality}, 'open', ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return normalizeQuestion(rows[0]!);
    },
  );

  // PATCH /v1/investigations/:id/questions/:qid
  fastify.patch(
    "/v1/investigations/:id/questions/:qid",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id, qid } = req.params as { id: string; qid: string };
      const parsed = UpdateQuestionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const existingRows = await req.tx!<DbQuestion[]>`
        SELECT *
        FROM investigation_questions
        WHERE id = ${qid}
          AND investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (existingRows.length === 0 || !existingRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Question Not Found",
          status: 404,
          detail: `Question ${qid} was not found.`,
          request_id: req.id,
        });
      }

      const existing = existingRows[0];
      const updatedText = parsed.data.text ?? existing.text;
      const updatedSeq = parsed.data.sequence ?? existing.sequence;
      const updatedMat = parsed.data.materiality ?? existing.materiality;
      const updatedStatus = parsed.data.status ?? existing.status;
      const updatedRationale = parsed.data.unanswerable_rationale !== undefined ? parsed.data.unanswerable_rationale : existing.unanswerable_rationale;

      const rows = await req.tx!<DbQuestion[]>`
        UPDATE investigation_questions
        SET
          text = ${updatedText},
          sequence = ${updatedSeq},
          materiality = ${updatedMat},
          status = ${updatedStatus},
          unanswerable_rationale = ${updatedRationale},
          updated_at = NOW()
        WHERE id = ${qid}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      reply.status(200);
      return normalizeQuestion(rows[0]!);
    },
  );

  // DELETE /v1/investigations/:id/questions/:qid
  fastify.delete(
    "/v1/investigations/:id/questions/:qid",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id, qid } = req.params as { id: string; qid: string };
      await req.tx!`
        UPDATE investigation_questions
        SET deleted_at = NOW()
        WHERE id = ${qid}
          AND investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return { status: "deleted", id: qid };
    },
  );

  // ── PRD §8.1 / §38.2 / INV-17 Investigation Members Subroutes ─────────────

  // GET /v1/investigations/:id/members
  fastify.get(
    "/v1/investigations/:id/members",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await req.tx!<DbMember[]>`
        SELECT *
        FROM investigation_members
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at ASC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => InvestigationMemberSchema.parse(r)),
      };
    },
  );

  // POST /v1/investigations/:id/members
  fastify.post(
    "/v1/investigations/:id/members",
    { config: { permission: "investigation.members" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = AddInvestigationMemberRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const memId = randomUUID();
      const rows = await req.tx!<DbMember[]>`
        INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role, created_by)
        VALUES (${memId}, ${req.user!.tenantId}, ${id}, ${parsed.data.user_id}, ${parsed.data.role}, ${req.user!.userId})
        ON CONFLICT (investigation_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
        RETURNING *;
      `;

      reply.status(201);
      return InvestigationMemberSchema.parse(rows[0]);
    },
  );

  // DELETE /v1/investigations/:id/members/:uid
  fastify.delete(
    "/v1/investigations/:id/members/:uid",
    { config: { permission: "investigation.members" } },
    async (req, reply) => {
      const { id, uid } = req.params as { id: string; uid: string };
      await req.tx!`
        DELETE FROM investigation_members
        WHERE investigation_id = ${id}
          AND user_id = ${uid}
          AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return { status: "removed", user_id: uid };
    },
  );

  // ── PRD §8.4 / INV-10 Investigation Health ────────────────────────────────
  fastify.get(
    "/v1/investigations/:id/health",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const invRows = await req.tx!<DbInvestigation[]>`
        SELECT *
        FROM investigations
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (invRows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${id} was not found.`,
          request_id: req.id,
        });
      }

      // 1. Question coverage (30% weight)
      const qRows = await req.tx!<{ status: string; materiality: string }[]>`
        SELECT status, materiality
        FROM investigation_questions
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;
      let qScore: number;
      const issues: string[] = [];
      if (qRows.length > 0) {
        const answered = qRows.filter((q) => q.status === "answered" || q.status === "unanswerable").length;
        qScore = Math.round((answered / qRows.length) * 100);
        const openCritical = qRows.filter((q) => q.materiality === "critical" && q.status !== "answered" && q.status !== "unanswerable").length;
        if (openCritical > 0) {
          issues.push(`${openCritical} critical question(s) open`);
        }
      } else {
        qScore = 0;
        issues.push("No questions defined");
      }

      // Default baseline signals for initial core
      const evidenceIntegrity = 100;
      const contradictionPosture = 100;
      const gapPosture = 100;
      const verificationDepth = 100;

      const compositeScore = Math.round(
        qScore * 0.3 +
        evidenceIntegrity * 0.2 +
        contradictionPosture * 0.2 +
        gapPosture * 0.15 +
        verificationDepth * 0.15
      );

      let status: "healthy" | "attention" | "at_risk" | "blocked" = "healthy";
      if (issues.some((i) => i.includes("critical question(s) open"))) {
        status = "attention";
      }
      if (compositeScore < 50) {
        status = "at_risk";
      }

      reply.status(200);
      return {
        status,
        score: compositeScore,
        components: {
          question_coverage: qScore,
          evidence_integrity: evidenceIntegrity,
          contradiction_posture: contradictionPosture,
          gap_posture: gapPosture,
          verification_depth: verificationDepth,
        },
        issues,
      };
    },
  );

  // ── PRD §8.1 / INV-16 Investigation Brief ─────────────────────────────────
  fastify.get(
    "/v1/investigations/:id/brief",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const invRows = await req.tx!<DbInvestigation[]>`
        SELECT *
        FROM investigations
        WHERE id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (invRows.length === 0 || !invRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${id} was not found.`,
          request_id: req.id,
        });
      }

      const inv = invRows[0];
      const qRows = await req.tx!<{ status: string; materiality: string }[]>`
        SELECT status, materiality
        FROM investigation_questions
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;
      const memCount = await req.tx!<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM investigation_members
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId};
      `;

      const totalQ = qRows.length;
      const answeredQ = qRows.filter((q) => q.status === "answered" || q.status === "unanswerable").length;
      const criticalOpen = qRows.filter((q) => q.materiality === "critical" && q.status !== "answered" && q.status !== "unanswerable").length;

      reply.status(200);
      return {
        investigation_id: id,
        name: inv.name,
        stage: inv.stage,
        objective: inv.objective,
        summary: `Investigation '${inv.name}' is currently in stage '${inv.stage}' with ${answeredQ}/${totalQ} questions resolved.`,
        stats: {
          total_questions: totalQ,
          answered_questions: answeredQ,
          critical_questions_open: criticalOpen,
          member_count: Number(memCount[0]?.count ?? 0),
          source_count: 0,
          finding_count: 0,
        },
        health: {
          status: criticalOpen > 0 ? "attention" : "healthy",
          score: totalQ > 0 ? Math.round((answeredQ / totalQ) * 100) : 0,
          components: {
            question_coverage: totalQ > 0 ? Math.round((answeredQ / totalQ) * 100) : 0,
            evidence_integrity: 100,
            contradiction_posture: 100,
            gap_posture: 100,
            verification_depth: 100,
          },
          issues: criticalOpen > 0 ? [`${criticalOpen} critical questions open`] : [],
        },
        generated_at: new Date().toISOString(),
      };
    },
  );

  // ── PRD §8.7 / INV-02 Templates Subroutes ─────────────────────────────────

  // GET /v1/investigation-templates
  fastify.get(
    "/v1/investigation-templates",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const rows = await req.tx!<DbTemplate[]>`
        SELECT *
        FROM investigation_templates
        WHERE tenant_id = ${req.user!.tenantId}
        ORDER BY created_at ASC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => InvestigationTemplateSchema.parse({
          ...r,
          questions: parseJsonField(r.questions, []),
          scope_defaults: parseJsonField(r.scope_defaults, {}),
          expected_source_types: parseJsonField(r.expected_source_types, []),
          collection_checklist: parseJsonField(r.collection_checklist, []),
        })),
      };
    },
  );

  // POST /v1/investigation-templates
  fastify.post(
    "/v1/investigation-templates",
    { config: { permission: "workspace.manage" } },
    async (req, reply) => {
      const parsed = CreateTemplateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const tplId = randomUUID();
      const rows = await req.tx!<DbTemplate[]>`
        INSERT INTO investigation_templates (
          id, tenant_id, workspace_id, name, description,
          questions, scope_defaults, expected_source_types, collection_checklist, created_by
        )
        VALUES (
          ${tplId}, ${req.user!.tenantId}, ${parsed.data.workspace_id || null},
          ${parsed.data.name}, ${parsed.data.description || null},
          ${JSON.stringify(parsed.data.questions)}, ${JSON.stringify(parsed.data.scope_defaults)},
          ${JSON.stringify(parsed.data.expected_source_types)}, ${JSON.stringify(parsed.data.collection_checklist)},
          ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return InvestigationTemplateSchema.parse({
        ...rows[0],
        questions: parseJsonField(rows[0]?.questions, []),
        scope_defaults: parseJsonField(rows[0]?.scope_defaults, {}),
        expected_source_types: parseJsonField(rows[0]?.expected_source_types, []),
        collection_checklist: parseJsonField(rows[0]?.collection_checklist, []),
      });
    },
  );

  // ── PRD §8.5 Notes Subroutes ──────────────────────────────────────────────

  // GET /v1/investigations/:id/notes
  fastify.get(
    "/v1/investigations/:id/notes",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await req.tx!<DbNote[]>`
        SELECT *
        FROM notes
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => NoteSchema.parse({
          ...r,
          mentions: parseJsonField(r.mentions, []),
        })),
      };
    },
  );

  // POST /v1/investigations/:id/notes
  fastify.post(
    "/v1/investigations/:id/notes",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CreateNoteRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const noteId = randomUUID();
      const rows = await req.tx!<DbNote[]>`
        INSERT INTO notes (
          id, tenant_id, investigation_id, target_type, target_id,
          content, mentions, created_by
        )
        VALUES (
          ${noteId}, ${req.user!.tenantId}, ${id}, ${parsed.data.target_type},
          ${parsed.data.target_id}, ${parsed.data.content},
          ${JSON.stringify(parsed.data.mentions || [])}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return NoteSchema.parse({
        ...rows[0],
        mentions: parseJsonField(rows[0]?.mentions, []),
      });
    },
  );

  // ── PRD §8.6 Tasks Subroutes ──────────────────────────────────────────────

  // GET /v1/investigations/:id/tasks
  fastify.get(
    "/v1/investigations/:id/tasks",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await req.tx!<DbTask[]>`
        SELECT *
        FROM tasks
        WHERE investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => TaskSchema.parse(r)),
      };
    },
  );

  // POST /v1/investigations/:id/tasks
  fastify.post(
    "/v1/investigations/:id/tasks",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CreateTaskRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const taskId = randomUUID();
      const rows = await req.tx!<DbTask[]>`
        INSERT INTO tasks (
          id, tenant_id, investigation_id, title, description,
          assignee_id, due_date, priority, target_type, target_id, created_by
        )
        VALUES (
          ${taskId}, ${req.user!.tenantId}, ${id}, ${parsed.data.title},
          ${parsed.data.description || null}, ${parsed.data.assignee_id || null},
          ${parsed.data.due_date ? new Date(parsed.data.due_date) : null},
          ${parsed.data.priority}, ${parsed.data.target_type || null},
          ${parsed.data.target_id || null}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return TaskSchema.parse(rows[0]);
    },
  );

  // PATCH /v1/investigations/:id/tasks/:tid
  fastify.patch(
    "/v1/investigations/:id/tasks/:tid",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id, tid } = req.params as { id: string; tid: string };
      const parsed = UpdateTaskRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const existingRows = await req.tx!<DbTask[]>`
        SELECT *
        FROM tasks
        WHERE id = ${tid}
          AND investigation_id = ${id}
          AND tenant_id = ${req.user!.tenantId};
      `;

      if (existingRows.length === 0 || !existingRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Task Not Found",
          status: 404,
          detail: `Task ${tid} was not found.`,
          request_id: req.id,
        });
      }

      const existing = existingRows[0];
      const updatedTitle = parsed.data.title ?? existing.title;
      const updatedDesc = parsed.data.description !== undefined ? parsed.data.description : existing.description;
      const updatedAssignee = parsed.data.assignee_id !== undefined ? parsed.data.assignee_id : existing.assignee_id;
      const updatedDueDate = parsed.data.due_date !== undefined ? (parsed.data.due_date ? new Date(parsed.data.due_date) : null) : existing.due_date;
      const updatedStatus = parsed.data.status ?? existing.status;
      const updatedPriority = parsed.data.priority ?? existing.priority;

      const rows = await req.tx!<DbTask[]>`
        UPDATE tasks
        SET
          title = ${updatedTitle},
          description = ${updatedDesc},
          assignee_id = ${updatedAssignee},
          due_date = ${updatedDueDate},
          status = ${updatedStatus},
          priority = ${updatedPriority},
          updated_at = NOW()
        WHERE id = ${tid}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      reply.status(200);
      return TaskSchema.parse(rows[0]);
    },
  );
};
