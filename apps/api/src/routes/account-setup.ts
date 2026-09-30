import type { FastifyPluginAsync, FastifyReply } from "fastify";
import "../types.js";
import { AuthError, AuthService } from "../auth/service.js";
import { generateTotpSecret, verifyTotpStep } from "../auth/crypto.js";
import type { OAuthConfig } from "../oauth/config.js";
import { CSRF_COOKIE, csrfCookieHeader, randomToken, readCookie, safeEqual, sha256, signFlow, verifyFlow, type FlowBase } from "../oauth/flow.js";
import { escapeHtml, hidden, sendPage } from "../oauth/pages.js";

/**
 * The admin-issued one-time link (D71): `pnpm admin:reset-link` prints
 * `<issuer>/account/setup#token=<token>`. The page sets the user's password AND enrols TOTP;
 * enrolment counts only once the user has entered a valid code from the new authenticator.
 * It is the only way to enrol TOTP, so a password alone can never add an authenticator.
 *
 * The token travels in the URL FRAGMENT, which browsers never send to a server: it is in no
 * request log, ours or Cloud Run's. A small inline script (allowed by the page's CSP nonce;
 * nothing external) moves it into the form body. Without JavaScript the user pastes it.
 */

export interface AccountSetupRoutesOptions {
  oauth: OAuthConfig | { error: string };
}

const FLOW_SECONDS = 15 * 60;
const MIN_PASSWORD = 12;

interface SetupFlow extends FlowBase {
  purpose: "account-setup";
  tokenHash: string;
  secret: string;
  email: string;
}

const MOVE_FRAGMENT_SCRIPT =
  "(function(){var m=/[#&]token=([^&]+)/.exec(location.hash);if(!m)return;" +
  "document.getElementById('token').value=decodeURIComponent(m[1]);" +
  "history.replaceState(null,'',location.pathname);document.getElementById('start').submit();})();";

function single(body: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (typeof body !== "object" || body === null) return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

export const accountSetupRoutes: FastifyPluginAsync<AccountSetupRoutesOptions> = async (fastify) => {
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const invalidLink = (reply: FastifyReply) =>
    sendPage(reply, {
      title: "Setup link",
      status: 400,
      body: `<h1>This setup link cannot be used</h1>
<p class="error">It is invalid, has already been used, or has expired (links last 60 minutes and work once).</p>
<p class="muted">Ask your Casefile administrator for a new link.</p>`,
    });

  const enrolPage = (reply: FastifyReply, flow: string, csrf: string, token: string, f: SetupFlow, error?: string, status = 200) => {
    const uri = `otpauth://totp/${encodeURIComponent(`Casefile:${f.email}`)}?secret=${f.secret}&issuer=Casefile&algorithm=SHA1&digits=6&period=30`;
    return sendPage(reply, {
      title: "Set up your account",
      status,
      body: `<h1>Set up your account</h1>
<p class="muted">For <strong>${escapeHtml(f.email)}</strong>. Choose a password and add Casefile to your authenticator app.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<dl>
<dt>Authenticator secret (enter it in your app)</dt><dd class="mono">${escapeHtml(f.secret)}</dd>
<dt>Or open this link on the device with your authenticator app</dt><dd class="mono"><a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a></dd>
</dl>
<form method="post" action="/account/setup">
${hidden("action", "complete")}${hidden("flow", flow)}${hidden("csrf", csrf)}${hidden("token", token)}
<label for="password">New password (at least ${MIN_PASSWORD} characters)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
<label for="confirm">Repeat the password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
<label for="code">6-digit code from your authenticator app</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">Finish setup</button>
</form>`,
    });
  };

  fastify.get("/account/setup", { config: { public: true } }, async (_req, reply) => {
    const csrf = randomToken();
    reply.header("set-cookie", csrfCookieHeader(csrf));
    return sendPage(reply, {
      title: "Set up your account",
      script: MOVE_FRAGMENT_SCRIPT,
      body: `<h1>Set up your account</h1>
<p class="muted">Opening your one-time link… If nothing happens, paste the setup code your administrator gave you.</p>
<form id="start" method="post" action="/account/setup">
${hidden("action", "start")}${hidden("csrf", csrf)}
<label for="token">Setup code</label>
<input id="token" name="token" type="text" autocomplete="off" required>
<button type="submit">Continue</button>
</form>`,
    });
  });

  fastify.post("/account/setup", { config: { public: true } }, async (req, reply) => {
    const b = single(req.body);
    const cookie = readCookie(req.headers.cookie, CSRF_COOKIE);
    if (!cookie || !safeEqual(b.csrf, cookie)) {
      return sendPage(reply, { title: "Setup link", status: 403, body: "<h1>This page has expired</h1><p class=\"muted\">Open your setup link again.</p>" });
    }
    const tenantId = process.env.MATTER_TENANT_ID!;
    const token = (b.token ?? "").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) return invalidLink(reply);

    if (b.action === "start") {
      const account = await AuthService.inspectResetToken(req.tx!, { tenantId, token });
      if (!account) return invalidLink(reply);
      const f: SetupFlow = {
        purpose: "account-setup",
        csrf: sha256(cookie),
        exp: Math.floor(Date.now() / 1000) + FLOW_SECONDS,
        tokenHash: sha256(token),
        secret: generateTotpSecret(),
        email: account.email,
      };
      return enrolPage(reply, signFlow(f), cookie, token, f);
    }

    const f = verifyFlow<SetupFlow>(b.flow, "account-setup", cookie);
    if (!f || f.tokenHash !== sha256(token)) return invalidLink(reply);
    const password = b.password ?? "";
    if (password.length < MIN_PASSWORD) return enrolPage(reply, b.flow!, cookie, token, f, `The password must be at least ${MIN_PASSWORD} characters.`, 400);
    if (password !== b.confirm) return enrolPage(reply, b.flow!, cookie, token, f, "The two passwords are different.", 400);
    const totpStep = verifyTotpStep(f.secret, b.code ?? "");
    if (totpStep === null) {
      return enrolPage(reply, b.flow!, cookie, token, f, "That code does not match. Check the time on your device and try the current code.", 400);
    }
    try {
      const done = await AuthService.completeAccountSetup(req.tx!, { tenantId, token, newPassword: password, totpSecret: f.secret, totpStep, requestId: req.id });
      return sendPage(reply, {
        title: "Account ready",
        body: `<h1>Your account is ready</h1>
<p>The password is set and two-step verification is ${done.reenrolled ? "moved to your new authenticator (the old one no longer works)" : "on"}.</p>
<p class="muted">You were signed out everywhere. You can close this page and sign in from Claude.</p>`,
      });
    } catch (err) {
      if (err instanceof AuthError && err.code === "INVALID_RESET_TOKEN") return invalidLink(reply);
      throw err;
    }
  });
};
