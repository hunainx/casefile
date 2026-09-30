import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import { z } from "zod";
import { AuthService, AuthError } from "../auth/service.js";
import { parseRegistrationResponse, parseAuthenticationResponse } from "../auth/webauthn-response.js";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  orgName: z.string().min(1),
});

const TokenSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid().optional(),
});

// D75 (DEV-023): the challenge token from the password step names the account. userId and
// tenantId are optional and, when sent, must match it.
const MfaVerifySchema = z.object({
  challengeToken: z.string().min(1),
  totpCode: z.string().length(6),
  userId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const StepUpSchema = z.object({
  totpCode: z.string().length(6),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PASSWORD_RESET_ACCEPTED = Object.freeze({
  status: "accepted",
  message: "If an account exists for this email address, reset instructions will be sent.",
});

const PasswordResetRequestSchema = z.object({
  email: z.string().email(),
  tenantId: z.string().uuid().optional(),
});

const PasswordResetConfirmSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
  tenantId: z.string().uuid().optional(),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/v1/auth/register",
    { config: { public: true } },
    async (req, reply) => {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const body = req.body as Record<string, unknown>;
      const res = await AuthService.registerRoot(req.tx!, {
        ...parsed.data,
        tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
      });
      reply.status(201);
      return res;
    },
  );

  // §45.2 POST /v1/auth/token
  fastify.post(
    "/v1/auth/token",
    { config: { public: true } },
    async (req, reply) => {
      const parsed = TokenSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const res = await AuthService.login(req.tx!, {
        email: parsed.data.email,
        password: parsed.data.password,
        tenantId: parsed.data.tenantId,
        ipHash: req.ip,
        userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : undefined,
        requestId: req.id,
      });

      if (res.mfaRequired) {
        return reply.status(200).send(res);
      }

      return reply.status(200).send(res.tokens);
    },
  );

  // §45.2 GET /v1/me
  fastify.get(
    "/v1/me",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);

      const rows = await req.tx!<{ id: string; email: string; name: string; tenant_id: string }[]>`
        SELECT id, email, name, tenant_id
        FROM users
        WHERE id = ${req.user.userId} AND tenant_id = ${req.user.tenantId} AND deleted_at IS NULL;
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "User not found",
          request_id: req.id,
        });
      }

      return reply.status(200).send({
        id: rows[0]!.id,
        email: rows[0]!.email,
        name: rows[0]!.name,
        tenantId: rows[0]!.tenant_id,
        roles: req.user.roles,
      });
    },
  );

  // D71: TOTP is enrolled only through the admin-issued one-time link (/account/setup). This
  // route handed a TOTP secret to any password-only session, so a stolen password could add
  // an attacker's authenticator. It stays registered to say where enrolment moved.
  fastify.post(
    "/v1/auth/mfa/setup",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      reply.status(410).header("content-type", "application/problem+json");
      return {
        type: "https://docs.casefile.com/errors/gone",
        title: "Gone",
        status: 410,
        detail:
          "TOTP enrolment is no longer available through the API. Ask an administrator for a one-time setup link (pnpm admin:reset-link).",
        request_id: req.id,
      };
    },
  );

  fastify.post(
    "/v1/auth/mfa/verify",
    { config: { public: true } },
    async (req, reply) => {
      const parsed = MfaVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const res = await AuthService.verifyMfa(req.tx!, {
        challengeToken: parsed.data.challengeToken,
        userId: parsed.data.userId,
        tenantId: parsed.data.tenantId,
        totpCode: parsed.data.totpCode,
        ipHash: req.ip,
        userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : undefined,
      });

      return reply.status(200).send(res);
    },
  );

  fastify.post(
    "/v1/auth/step-up",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const parsed = StepUpSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const res = await AuthService.stepUpMfa(req.tx!, {
        userId: req.user.userId,
        tenantId: req.user.tenantId,
        sessionId: req.user.sessionId,
        totpCode: parsed.data.totpCode,
        requestId: req.id,
      });

      return reply.status(200).send(res);
    },
  );

  // §45.2 POST /v1/auth/refresh
  fastify.post(
    "/v1/auth/refresh",
    { config: { public: true } },
    async (req, reply) => {
      const parsed = RefreshSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const res = await AuthService.rotateRefreshToken(req.tx!, {
        refreshToken: parsed.data.refreshToken,
        requestId: req.id,
      });

      if ("isError" in res) {
        reply.status(res.error.status).header("content-type", "application/problem+json");
        return {
          type: `https://docs.casefile.com/errors/${res.error.code.toLowerCase().replace(/_/g, "-")}`,
          title: "Authentication Failed",
          status: res.error.status,
          detail: res.error.message,
          instance: req.url,
          request_id: req.id,
        };
      }

      return res;
    },
  );

  fastify.post(
    "/v1/auth/logout",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      await AuthService.revokeSession(req.tx!, req.user.sessionId, req.user.tenantId, req.user.userId);
      return reply.status(200).send({ status: "logged_out" });
    },
  );

  fastify.get(
    "/v1/auth/sessions",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const sessions = await AuthService.listSessions(req.tx!, req.user.userId, req.user.tenantId);
      return reply.status(200).send({
        sessions: sessions.map((s) => ({
          ...s,
          isCurrent: s.id === req.user?.sessionId,
        })),
      });
    },
  );

  fastify.delete(
    "/v1/auth/sessions/:id",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const { id } = req.params as { id: string };
      // Only the caller's own sessions (D81). Another user's session, an unknown ID and a
      // malformed one all answer the same 404.
      const revoked = UUID_PATTERN.test(id) && (await AuthService.revokeSession(req.tx!, id, req.user.tenantId, req.user.userId));
      if (!revoked) {
        reply.status(404).header("content-type", "application/problem+json");
        return {
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Session not found",
          request_id: req.id,
        };
      }
      return reply.status(200).send({ status: "revoked" });
    },
  );

  // AUTH-07: Password reset request flow
  fastify.post(
    "/v1/auth/password-reset/request",
    { config: { public: true } },
    async (req, reply) => {
      const parsed = PasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // D65: the same answer for every well-formed request, whether or not the email has an
      // account, and no lookup at all, so neither the body nor the timing tells them apart.
      // There is no email channel yet, so nothing is delivered; an administrator issues reset
      // tokens with scripts/issue-password-reset.ts.
      return reply.status(202).send(PASSWORD_RESET_ACCEPTED);
    },
  );

  // AUTH-07: Password reset confirm flow
  fastify.post(
    "/v1/auth/password-reset/confirm",
    { config: { public: true } },
    async (req, reply) => {
      const parsed = PasswordResetConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const res = await AuthService.confirmPasswordReset(
        req.tx!,
        parsed.data.token,
        parsed.data.newPassword,
        parsed.data.tenantId,
      );

      reply.status(200);
      return res;
    },
  );

  // AUTH-10: Sign-in history
  fastify.get(
    "/v1/auth/history",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const history = await AuthService.listSignInHistory(req.tx!, req.user.userId, req.user.tenantId);
      return reply.status(200).send({ history });
    },
  );

  // AUTH-03: WebAuthn / Passkey registration options
  fastify.post(
    "/v1/auth/webauthn/register/options",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const options = await AuthService.generateWebAuthnRegistrationOptions(
        req.tx!,
        req.user.userId,
        req.user.tenantId,
      );
      return reply.status(200).send(options);
    },
  );

  // AUTH-03: WebAuthn / Passkey registration verification
  fastify.post(
    "/v1/auth/webauthn/register/verify",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const parsed = z
        .object({
          response: z.record(z.unknown()),
          name: z.string().optional(),
        })
        .safeParse(rawBody);

      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const registrationResponse = parseRegistrationResponse(parsed.data.response);
      if (!registrationResponse) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: "response is not a valid WebAuthn RegistrationResponseJSON",
          request_id: req.id,
        });
      }

      const res = await AuthService.verifyWebAuthnRegistration(
        req.tx!,
        req.user.userId,
        req.user.tenantId,
        registrationResponse,
        parsed.data.name,
      );

      return reply.status(200).send(res);
    },
  );

  // AUTH-03: WebAuthn / Passkey authentication options
  fastify.post(
    "/v1/auth/webauthn/authenticate/options",
    { config: { public: true } },
    async (req, reply) => {
      const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const parsed = z
        .object({
          email: z.string().email().optional(),
          tenantId: z.string().uuid().optional(),
        })
        .safeParse(rawBody || {});

      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const options = await AuthService.generateWebAuthnAuthenticationOptions(req.tx!, {
        email: parsed.data.email,
        tenantId: parsed.data.tenantId,
      });

      return reply.status(200).send(options);
    },
  );

  // AUTH-03: WebAuthn / Passkey authentication verification & token exchange
  fastify.post(
    "/v1/auth/webauthn/authenticate/verify",
    { config: { public: true } },
    async (req, reply) => {
      const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const parsed = z
        .object({
          response: z.record(z.unknown()),
          email: z.string().email().optional(),
          tenantId: z.string().uuid().optional(),
        })
        .safeParse(rawBody);

      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const authenticationResponse = parseAuthenticationResponse(parsed.data.response);
      if (!authenticationResponse) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: "response is not a valid WebAuthn AuthenticationResponseJSON",
          request_id: req.id,
        });
      }

      const tokens = await AuthService.verifyWebAuthnAuthentication(req.tx!, {
        response: authenticationResponse,
        email: parsed.data.email,
        tenantId: parsed.data.tenantId,
        ipHash: req.ip,
        userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : undefined,
        requestId: req.id,
      });

      return reply.status(200).send(tokens);
    },
  );
};

