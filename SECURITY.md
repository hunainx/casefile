# Security policy

Casefile holds legal and investigative documents, so a security problem matters. Thank you for reporting one
privately first.

## How to report

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. This reaches the maintainer privately. Please do **not** open a public issue, a pull
request or a discussion for a security problem.

Please include:

- what the problem is and what someone could do with it;
- the steps to reproduce it (with fake data; never send real case documents or real credentials);
- the commit or version you tested;
- whether you think it is being used against someone right now.

## What happens next

- You get an answer within 7 days saying whether the report is confirmed.
- A confirmed problem is fixed in the code, with a test that fails before the fix. The fix is published together
  with a security advisory that credits you, unless you ask not to be named.
- Please give a reasonable time to fix it (90 days by default) before telling anyone else.

## Scope

In scope: this repository's code, its database migrations and row-level security, the MCP server and its sign-in,
the audit log, the ingestion tools, and the deployment scripts.

Out of scope: problems in Google Cloud, Supabase or other third-party services themselves (report those to them),
and deployments run by other people. This project runs no public service of its own.

## Known limitations

Things that are known and not yet built, including security-relevant ones (for example: no field-level encryption,
password reset without email delivery, no external security review), are listed in
[docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md). Reports about them are still welcome if you find a way
they can be abused.

## Supported versions

Only the latest commit on the `master` branch is supported.
