import type { FastifyReply } from "fastify";
import { randomToken } from "./flow.js";

/**
 * The sign-in, consent and account-setup pages: small server-rendered HTML with no external
 * scripts, styles, fonts or images. Every response carries a strict Content-Security-Policy
 * with a per-response nonce, refuses framing, and is never cached.
 *
 * Cross-Origin-Opener-Policy is deliberately not set: Claude opens sign-in in a popup and
 * its callback page needs the opener relationship after our redirect.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PageOptions {
  title: string;
  /** Trusted HTML for the page body. Every interpolated value must go through escapeHtml. */
  body: string;
  status?: number;
  /** Origins a form on this page may post or redirect to, besides 'self'. */
  formActionOrigins?: string[];
  /** Inline script (static text only), allowed by the page's nonce. */
  script?: string;
}

export function sendPage(reply: FastifyReply, page: PageOptions): FastifyReply {
  const nonce = randomToken(16);
  const formAction = ["'self'", ...(page.formActionOrigins ?? [])].join(" ");
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    page.script ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  reply
    .status(page.status ?? 200)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", csp)
    .header("x-frame-options", "DENY")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "no-store")
    .header("pragma", "no-cache");
  const script = page.script ? `<script nonce="${nonce}">${page.script}</script>` : "";
  return reply.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)} · Casefile</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --fg:#1b1f24; --muted:#57606a; --bg:#f6f8fa; --card:#fff; --line:#d0d7de; --accent:#1f4f8f; --warn:#9a6700; --bad:#b42318; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#9da7b3; --bg:#0d1117; --card:#161b22; --line:#30363d; --accent:#6ea8fe; --warn:#d29922; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--fg); background:var(--bg); }
main { max-width: 26rem; margin: 3rem auto; padding: 0 1rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.5rem; }
h1 { font-size:1.2rem; margin:0 0 .25rem; }
.brand { color:var(--muted); font-size:.85rem; margin:0 0 1.25rem; letter-spacing:.02em; }
label { display:block; font-weight:600; margin:1rem 0 .3rem; }
input[type=email], input[type=password], input[type=text] { width:100%; padding:.55rem .65rem; border:1px solid var(--line); border-radius:6px; font:inherit; background:var(--bg); color:var(--fg); }
button { margin-top:1.25rem; padding:.55rem 1rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
button.secondary { background:transparent; color:var(--accent); margin-left:.5rem; }
.muted { color:var(--muted); font-size:.9rem; }
.error { color:var(--bad); font-weight:600; }
.warn { color:var(--warn); border-left:3px solid var(--warn); padding:.25rem .75rem; margin:1rem 0; }
dl { margin:1rem 0; } dt { font-weight:600; margin-top:.6rem; } dd { margin:0; } dd.mono { font-family: ui-monospace, monospace; word-break: break-all; }
code, .mono { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; word-break: break-all; }
</style>
</head>
<body>
<main>
<div class="card">
<p class="brand">CASEFILE</p>
${page.body}
</div>
</main>
${script}
</body>
</html>
`);
}

/** A hidden form field. */
export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
