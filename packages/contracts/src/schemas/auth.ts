import { z } from "zod";

export const AuthTokenRequestSchema = z.object({
  email: z.string().email().describe("User email address"),
  password: z.string().min(1).describe("User password"),
  tenantId: z.string().uuid().optional().describe("Tenant ID override if known"),
});

export const AuthTokenResponseSchema = z.object({
  accessToken: z.string().describe("JWT access token"),
  refreshToken: z.string().describe("Rotating refresh token"),
  expiresIn: z.number().describe("Access token lifetime in seconds"),
  tokenType: z.literal("Bearer"),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    tenantId: z.string(),
  }),
});

export const AuthRefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).describe("Rotating refresh token"),
});

export const MeResponseSchema = z.object({
  id: z.string().describe("User ID"),
  email: z.string().email().describe("User email"),
  name: z.string().describe("User display name"),
  tenantId: z.string().describe("Tenant ID"),
  roles: z.array(z.string()).describe("Workspace and org roles"),
});

export const WebAuthnRegisterOptionsResponseSchema = z.object({
  challenge: z.string(),
  rp: z.object({
    name: z.string(),
    id: z.string(),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
  }),
  pubKeyCredParams: z.array(
    z.object({
      alg: z.number(),
      type: z.literal("public-key"),
    }),
  ),
  timeout: z.number().optional(),
  attestation: z.string().optional(),
  authenticatorSelection: z.record(z.unknown()).optional(),
});

export const WebAuthnRegisterVerifyRequestSchema = z.object({
  response: z.record(z.unknown()).describe("WebAuthn RegistrationResponseJSON"),
  name: z.string().optional().describe("Optional credential friendly name"),
});

export const WebAuthnAuthOptionsRequestSchema = z.object({
  email: z.string().email().optional().describe("User email if known"),
  tenantId: z.string().uuid().optional(),
});

export const WebAuthnAuthOptionsResponseSchema = z.object({
  challenge: z.string(),
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("public-key"),
        transports: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  userVerification: z.string().optional(),
});

export const WebAuthnAuthVerifyRequestSchema = z.object({
  response: z.record(z.unknown()).describe("WebAuthn AuthenticationResponseJSON"),
  email: z.string().email().optional(),
  tenantId: z.string().uuid().optional(),
});

export type AuthTokenRequest = z.infer<typeof AuthTokenRequestSchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type WebAuthnRegisterOptionsResponse = z.infer<typeof WebAuthnRegisterOptionsResponseSchema>;
export type WebAuthnRegisterVerifyRequest = z.infer<typeof WebAuthnRegisterVerifyRequestSchema>;
export type WebAuthnAuthOptionsRequest = z.infer<typeof WebAuthnAuthOptionsRequestSchema>;
export type WebAuthnAuthOptionsResponse = z.infer<typeof WebAuthnAuthOptionsResponseSchema>;
export type WebAuthnAuthVerifyRequest = z.infer<typeof WebAuthnAuthVerifyRequestSchema>;
