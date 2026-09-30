import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withTenant } from "@casefile/db";
import { AuthService } from "../../src/auth/service.js";
import { nextTotpCode } from "./totp.js";

/** The subset of a Fastify instance the helper drives. */
interface Injectable {
  inject(opts: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    payload?: string;
  }): PromiseLike<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
}

/**
 * Enrols TOTP the only way there is (D71): an admin-issued one-time link, completed on the
 * /account/setup page exactly as a user would — open, set the password, prove the new
 * authenticator with a code. Returns the TOTP secret and the otpauth URI the page showed.
 *
 * The page serves MATTER_TENANT_ID; the helper points it at `tenantId` for the duration.
 */
export async function enrolTotpThroughSetupLink(
  app: Injectable,
  db: postgres.Sql,
  input: { tenantId: string; email: string; password: string },
): Promise<{ secret: string; uri: string }> {
  const issued = await withTenant(
    input.tenantId,
    (tx) => AuthService.issuePasswordResetToken(tx, { tenantId: input.tenantId, email: input.email, issuedBy: "test", requestId: `test-${randomUUID()}` }),
    db,
  );
  return completeSetupLink(app, { tenantId: input.tenantId, token: issued.token, password: input.password });
}

/**
 * Completes a setup link that was already issued (for example printed by `pnpm admin:add-user`):
 * open /account/setup, set the password, prove the new authenticator with a code.
 */
export async function completeSetupLink(
  app: Injectable,
  input: { tenantId: string; token: string; password: string },
): Promise<{ secret: string; uri: string }> {
  const issued = { token: input.token };
  const saved = process.env.MATTER_TENANT_ID;
  process.env.MATTER_TENANT_ID = input.tenantId;
  try {
    const page = await app.inject({ method: "GET", url: "/account/setup" });
    const setCookie = page.headers["set-cookie"];
    const cookie = /__Host-cf_csrf=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie))?.[1];
    if (!cookie) throw new Error("no CSRF cookie from /account/setup");
    const headers = { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` };

    const start = await app.inject({
      method: "POST",
      url: "/account/setup",
      headers,
      payload: new URLSearchParams({ action: "start", csrf: cookie, token: issued.token }).toString(),
    });
    if (start.statusCode !== 200) throw new Error(`setup start failed: ${start.statusCode}\n${start.body}`);
    const secret = /<dd class="mono">([A-Z2-7]{16,})<\/dd>/.exec(start.body)?.[1];
    const uri = /<a href="(otpauth:[^"]+)"/.exec(start.body)?.[1]?.replace(/&amp;/g, "&");
    const flow = /name="flow" value="([^"]+)"/.exec(start.body)?.[1];
    if (!secret || !uri || !flow) throw new Error(`setup page is missing the secret, URI or flow:\n${start.body}`);

    const done = await app.inject({
      method: "POST",
      url: "/account/setup",
      headers,
      payload: new URLSearchParams({
        action: "complete",
        csrf: cookie,
        token: issued.token,
        flow,
        password: input.password,
        confirm: input.password,
        // The enrolment code's time step is recorded (D75); nextTotpCode keeps later sign-ins on later steps.
        code: await nextTotpCode(secret),
      }).toString(),
    });
    if (done.statusCode !== 200) throw new Error(`setup complete failed: ${done.statusCode}\n${done.body}`);
    return { secret, uri };
  } finally {
    if (saved === undefined) delete process.env.MATTER_TENANT_ID;
    else process.env.MATTER_TENANT_ID = saved;
  }
}
