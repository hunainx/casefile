/**
 * The one-time account setup link as the admin commands print it (D71): `pnpm admin:reset-link`
 * and `pnpm admin:add-user` (D87) print the same block, so a person gets the same instructions
 * whichever command made their link.
 */

/** Origin of the link: --api-url, else MCP_PUBLIC_URL's origin, else CASEFILE_API_URL. */
export function setupLinkOrigin(apiUrlArg: string | undefined): string {
  const publicUrl = process.env.MCP_PUBLIC_URL?.trim();
  return (
    apiUrlArg ??
    (publicUrl ? new URL(publicUrl).origin : undefined) ??
    process.env.CASEFILE_API_URL ??
    "<CASEFILE_API_URL>"
  ).replace(/\/+$/, "");
}

export function setupLinkText(issued: { email: string; token: string; expiresAt: Date }, tenantId: string, apiUrl: string): string {
  return [
    `One-time account setup link issued for ${issued.email} (tenant ${tenantId}).`,
    `Valid until ${issued.expiresAt.toISOString()} (60 minutes). Works once. This is the only place it is shown.`,
    "",
    "Send the user this link. It opens a page where they set a password and enrol",
    "two-step verification (an authenticator app), which connecting Claude requires:",
    "",
    `  ${apiUrl}/account/setup#token=${issued.token}`,
    "",
    "If the page cannot read the link (JavaScript off), they paste this setup code instead:",
    "",
    `  ${issued.token}`,
    "",
    "Completing setup replaces any earlier authenticator and signs the user out everywhere.",
    "The issue and the use are recorded in the audit log.",
    "",
  ].join("\n");
}
