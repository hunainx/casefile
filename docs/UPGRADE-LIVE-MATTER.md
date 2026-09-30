# Upgrading a live matter to Claude sign-in

This guide moves **one** matter that is already deployed (it still uses the old shared
`MCP_TOKEN`) to the new sign-in, where each person connects Claude with their own Casefile
account, password and authenticator code. It follows `docs/PLAN-MCP-AUTH.md` section 6.

Do one matter at a time. Do every step in order. After each step there is a **You should see**
line. If what you see is different, **stop**: do not guess or improvise. Steps 1 to 4 change
nothing that people use, so stopping there is always safe. After step 5, if anything looks wrong,
go to step 10 (roll back).

> **Two rules for a matter that already exists. Read them before step 1.**
>
> 1. **Deploy with `--phase=service` only.** Never use `--phase=all` (or `--phase=database`) on a
>    matter that already exists. Those phases give the database user `casefile_app` a new
>    password, which stops the old revision working and breaks the rollback in step 10.
> 2. **`--set-env-vars` REPLACES every environment variable on the service.** Anything the
>    service has today that is not in the deploy command is gone after the deploy. Step 5c
>    compares the two lists before the real deploy, and anything missing goes into the env file.

---

## Before you start

You need:

- This repository at the accepted commit, in your clone of the repository. Run every command
  from that folder, in PowerShell.
- **The matter's env file**: the `.env.<matter>` file made when the matter was set up. It must
  contain `DATABASE_URL`, `DATABASE_URL_MIGRATIONS`, `MATTER_TENANT_ID`, `MATTER_INVESTIGATION_ID`,
  `GCP_PROJECT_ID`, `GCP_REGION` and `SUPABASE_REGION`. Below it is called `<env file>`.
- These values, written down (they are in the env file or the Google Cloud console):
  - `<matter>`: the matter's short name, as in its Cloud Run service `casefile-<matter>-api`;
  - `<ref>`: the Supabase project ref (the part after `postgres.` in `DATABASE_URL_MIGRATIONS`);
  - `<project>`: the Google Cloud project ID (`GCP_PROJECT_ID`);
  - `<region>`: the Google Cloud region (`GCP_REGION`).
- `gcloud` signed in to the account that owns `<project>` (`gcloud auth login`), and Docker Desktop running.
- Everyone who will use Claude on this matter needs an authenticator app on their phone
  (Google Authenticator, Microsoft Authenticator, 1Password, and so on).

The tools refuse, on their own, to touch the project they must never touch. Never point any of
them at a project that is not this matter's.

---

## 1. Run the preflight

The preflight only reads. It changes nothing and runs no `gcloud` command.

```powershell
pnpm matter:preflight --env <env file>
```

**You should see** a report with four parts and a result line:

1. **Migrations**: `Applied: 24 of the 31 this code has.` and `MISSING` next to
   `0025_rate_limits.sql`, `0026_oauth_mcp.sql`, `0027_totp_last_step.sql`,
   `0028_text_stored_once.sql`, `0029_ingest_triage.sql`, `0030_mailbox_message_identity.sql` and
   `0031_ingest_work_queue.sql`.
2. **People in the matter's tenant**: one block per account, with its status, its role on the
   matter's investigation, whether TOTP is enrolled, and `Can use Claude after the upgrade:`
   - `YES`: ready;
   - `YES, after the setup link`: needs a one-time setup link (step 2);
   - `NO — <reason>`: this account will not be able to use Claude (for example the `viewer` role,
     a suspended account, or an ethical wall). That is on purpose.
3. **MCP_PUBLIC_URL**: `Not set.`
4. **Ethical walls**: `No wall names a group (walls that name a user are applied).`

and at the end:

```
RESULT: NOT READY
  - MCP_PUBLIC_URL is not set (runbook step 3)
  - migrations 0025, 0026, 0027, 0028, 0029, 0030, 0031 are not applied yet (runbook step 4)
```

Those two reasons are expected at this point. Steps 3 and 4 clear them.

**If you don't:**
- `N ethical wall(s) name a group; they are NOT applied`: a wall that names a group screens nobody,
  because Casefile has no group membership yet (DEV-024). **Stop**, and ask the matter's owner which
  people the wall is meant to screen; each of them needs a wall of their own (a user wall).
- Any other reason in the list (older migrations missing, migrations "this code does not know",
  the investigation not found, no user who can use Claude): **stop** and ask.
- `PREFLIGHT STOPPED: ...`: the env file is missing something or the database cannot be
  reached. Read the message; fix the env file only if the fix is obvious, otherwise stop and ask.
- `cannot tell which migrations are applied`: add `DATABASE_URL_MIGRATIONS` to the env file and run it again.

---

## 2. Give each Claude user an account and a one-time setup link

**2a. Now: check the accounts.** Look at the people list from step 1. Everyone who should use
Claude must be there, `active`, with `YES` or `YES, after the setup link`.

- Someone who should use Claude shows `NO` because of their role: their role must be changed first. Stop and ask.
- Someone is missing from the list: write down their email, full name and role. You add them in
  2b with `pnpm admin:add-user`. Never create accounts by hand in the database.

  Roles that can use Claude: `ws_admin` and `lead_inv` (all 9 tools), `investigator`, `analyst`,
  `reviewer`, `contributor` (8 tools, no download link). `viewer`, `auditor` and `org_admin` get
  an account but cannot connect Claude. No other role name is accepted.

**2b. Later, right after step 6: add the missing people and send the setup links.** The setup
page is part of the new version, so a link made now would open a page that does not exist yet,
and each link lasts only 60 minutes. Step 6 tells you when.

For each person **missing** from the list (this creates the account and prints its link):

```powershell
pnpm admin:add-user --env <env file> --email <their email> --name "<their full name>" --role <role>
```

For each person marked `YES, after the setup link`:

```powershell
pnpm admin:reset-link --env <env file> --email <their email>
```

**You should see** (`admin:add-user` first prints `Added <their email> to the matter as <role>.`
and a line saying whether that role can connect Claude):

```
One-time account setup link issued for <their email> (tenant <tenant id>).
Valid until <time> (60 minutes). Works once. This is the only place it is shown.
...
  https://<service host>/account/setup#token=<long code>
```

Send the person that link (a private message, not a shared channel). When they open it they see
**Set up your account**. There is no QR code on the page: it shows an **Authenticator secret**
(a long code of capital letters and digits) and an `otpauth://` link. They either open the link
on the phone that has the authenticator app, which adds Casefile to the app, or, in the app,
choose "add account" → "enter a setup key" (the wording differs between apps), and type the
secret, time-based. Then they choose a password, type the 6-digit code the app now shows, and
press **Finish setup**. They then see **Your account is ready**.

**If you don't:**
- `Could not add the user: <email> already has an account in this matter`: they are in the step 1
  list after all; use `admin:reset-link` for them instead.
- `Could not add the user: "<role>" is not a role`: use one of the role names above, exactly.
- `Could not issue a reset token: ...`: the email is not an account of this matter; check the spelling against the step 1 list.
- The person sees **This setup link cannot be used**: the link expired or was already used. Make a new one.

People already marked `YES` do not need a link; they can sign in with their existing password and authenticator.

---

## 3. Set MCP_PUBLIC_URL

This is the address people give Claude. It is the service's own address followed by `/mcp`.

Find the service address (this only reads):

```powershell
gcloud run services describe casefile-<matter>-api --region=<region> --project=<project> --format="value(status.url)"
```

**You should see** one line: the service address, starting `https://casefile-<matter>-api-` (below it is called `<service url>`).

Open the env file in Notepad and add this line (the address from above, then `/mcp`, nothing after it):

```
MCP_PUBLIC_URL=<service url>/mcp
```

Save, and run the preflight again (`pnpm matter:preflight --env <env file>`).

**You should see** under **3. MCP_PUBLIC_URL**: `Canonical: yes`, and the reason
`MCP_PUBLIC_URL is not set` gone from the result.

**If you don't:** `Canonical: NO — it ...` says what is wrong (usually a trailing `/`, capital
letters, or `http` instead of `https`). Fix the line exactly as it says. A `Note:` about
`SERVICE_URL` means the env file recorded a different address earlier; use the address from the
command above, and ask if unsure.

---

## 4. Apply migrations 0025 to 0031

These add new tables and columns, and let a chunk's text be empty when it is its one block
(0028, text stored once); 0029 (triage), 0030 (mailbox message identity) and 0031 (the ingest work
queue) only add tables, columns and indexes. They do not change or remove anything the running
version uses, so the matter keeps working while you do this.

Load the owner connection from the env file for this window only, run the migrations, then clear it:

```powershell
$env:DATABASE_URL_MIGRATIONS = (Select-String -Path "<env file>" -Pattern '^DATABASE_URL_MIGRATIONS=(.*)$').Matches[0].Groups[1].Value
npx tsx packages/db/migrate/index.ts --project-ref <ref>
Remove-Item Env:DATABASE_URL_MIGRATIONS
```

**You should see:**

```
=== Pre-flight Migration Guard ===
...
History check:      24 applied migration(s) verified against packages/db/migrations (0 foreign)
Pre-flight check:   PASSED — proceeding with migration.

Applying migration: 0025_rate_limits.sql...
Applying migration: 0026_oauth_mcp.sql...
Applying migration: 0027_totp_last_step.sql...
Applying migration: 0028_text_stored_once.sql...
Applying migration: 0029_ingest_triage.sql...
Applying migration: 0030_mailbox_message_identity.sql...
Applying migration: 0031_ingest_work_queue.sql...
Successfully applied 7 migration(s).
```

Blocks marked `NOTICE` between those lines (for example `policy ... does not exist, skipping`) are normal.

Run the preflight again. **You should see** `Applied: 31 of the 31`, all seven `applied`, and
`RESULT: READY — nothing blocks the upgrade.`

**If you don't:**
- `ABORT: ...` from the guard (project ref mismatch, foreign migrations): nothing was changed. Stop and ask.
- `FAILED to apply migration ...`: that migration was rolled back and nothing after it ran. Stop
  and ask. The running version is not affected.

---

## 5. Deploy (dry run first)

**5a. Check the secrets the new version needs exist** (this only reads):

```powershell
gcloud secrets list --project=<project> --format="value(name)"
```

**You should see** these four among the names: `casefile-<matter>-database-url`,
`casefile-<matter>-supabase-url`, `casefile-<matter>-supabase-publishable-key` and
`casefile-<matter>-jwt-secret`. **If one is missing, stop and ask** (the deploy would fail, and
the JWT secret must not be made up here).

**5b. Write down the revision that is running now** (you need it for step 10):

```powershell
gcloud run revisions list --service=casefile-<matter>-api --region=<region> --project=<project> --limit=3
```

**You should see** a table; the top line (with a tick, or `yes` under ACTIVE) is the running
revision, for example `casefile-<matter>-api-00007-abc`. Write that name down.

**5c. Dry run.** This prints every step and runs none of them:

```powershell
pnpm tsx scripts/deploy-matter.ts --matter <matter> --project-ref <ref> --phase=service --env <env file> --dry-run
```

**You should see** a banner `DRY RUN — NOTHING WILL BE RUN OR WRITTEN`, then lines starting
`[dry-run]`: `docker build`, `docker push`, one long `gcloud.cmd run deploy casefile-<matter>-api ...`
line, and at the end `DRY RUN COMPLETE ... nothing was run, connected to or written.` Check in
the long line:
- `--project=<project>` and `--region=<region>` are this matter's;
- `MCP_PUBLIC_URL=` is exactly the value from step 3;
- `JWT_SECRET=casefile-<matter>-jwt-secret:latest` is there, and `MCP_TOKEN` is **not**;
- passwords show as `***`.

**If you don't:** stop. Nothing has been changed.

**Then compare the environment variables.** `--set-env-vars` REPLACES every environment variable
on the service, so compare what the service has now with the list after `--set-env-vars=` in the
long line. Show the service's settings (this only reads):

```powershell
gcloud run services describe casefile-<matter>-api --region=<region> --project=<project> --format=export
```

**You should see** a long YAML text. Under `env:` there is one `- name: ...` entry per variable.
For **each** name there, find it in the dry run's `--set-env-vars` list (or, for `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `JWT_SECRET`, in `--set-secrets`):

- It is in the dry run: fine.
- `MCP_TOKEN`: expected to be missing. It is the retired shared token (step 9).
- `MCP_OAUTH_TRUSTED_CLIENTS`, `RP_ID` or `TRUST_PROXY_HOPS`: add a line `<NAME>=<its value>` to the
  env file, exactly as the YAML shows the value, and run the dry run again. It must now appear in
  the long line.
- Anything else: **stop and ask**. The deploy only sets the settings this version of Casefile reads.

**5d. The real deploy.** The same command without `--dry-run`:

```powershell
pnpm tsx scripts/deploy-matter.ts --matter <matter> --project-ref <ref> --phase=service --env <env file>
```

It builds the new version, uploads it and deploys it. This takes several minutes.

**You should see**, near the end:

```
✓ Image pushed: <region>-docker.pkg.dev/<project>/casefile/casefile-api:<matter>
✓ Cloud Run Service Deployed: <service url>
MATTER DEPLOYMENT COMPLETE!
```

**If you don't:**
- It stops with `Deployment failed:` before `Cloud Run Service Deployed`: the old version is still
  serving, unchanged. Stop and ask.
- A `WARNING: MCP_PUBLIC_URL (...) is not .../mcp` line: sign-in will fail with this address. Go to step 10, then ask.

---

## 6. The three curl checks

Use `curl.exe` (in PowerShell, plain `curl` is a different command). Replace `<service url>` with
the address from step 3 **without** `/mcp`.

**Check 1: the sign-in information is published.**

```powershell
curl.exe -i <service url>/.well-known/oauth-protected-resource/mcp
```

**You should see** `HTTP/1.1 200 OK` and a line of JSON that starts
`{"resource":"<your MCP_PUBLIC_URL>","authorization_servers":[...`.

**Check 2: without signing in, /mcp says "sign in".**

```powershell
curl.exe -i -X POST <service url>/mcp
```

**You should see** `HTTP/1.1 401 Unauthorized`, a line starting
`www-authenticate: Bearer resource_metadata="...`, and
`"message":"Unauthorized: sign in to use this connector"`.

**Check 3: the old shared token no longer works.** Show the old token (this only reads), then try it:

```powershell
gcloud secrets versions access latest --secret=casefile-<matter>-mcp-token --project=<project>
curl.exe -i -X POST <service url>/mcp -H "authorization: Bearer <the token printed above>"
```

**You should see** `HTTP/1.1 401 Unauthorized` and
`"message":"Unauthorized: The access token is invalid or has expired"`.

**If you don't** see all three: go to step 10 (roll back), then ask. In particular, if check 3
answers `200`, the old token still works: roll back at once.

**Now do step 2b** (add the missing people and send the setup links), then continue with step 7.

---

## 7. In Claude: remove the old connector, add the new one, sign in

1. **Remove the old connector** for this matter, the one that used the shared token. In Claude:
   Settings → Connectors, find this matter's Casefile connector, and remove it. If it was added
   through Claude Desktop's config file instead (`%APPDATA%\Claude\claude_desktop_config.json`,
   an entry with an `Authorization: Bearer` header), delete that entry and restart Claude Desktop.
2. **Add the new one:** Settings → Connectors (in some versions Customize → Connectors) →
   **Add custom connector**. Name: `Casefile <matter>`. URL: your `MCP_PUBLIC_URL`, exactly. Add.
3. **Sign in:** press Connect. A Casefile page opens:
   - **Sign in to connect Claude**: email and password, **Continue**;
   - **Two-step verification**: the 6-digit code from the authenticator app, **Verify**;
   - **Allow access to this matter?**: **Allow**.

   Claude shows the connector as connected.
4. **Try it:** ask Claude "Use the Casefile matter_status tool."

**You should see** the matter's investigation name and its document counts.

**If you don't:**
- The Casefile page says **This app is not allowed to sign in here: client_id is not on the
  trusted client list.** Go to step 8.
- **Incorrect email or password**, or **That code is not valid**: check them; after a few tries
  the account is locked for a while. The person can be given a new setup link (step 2b).
- **Claude cannot be connected** with a reason about the role, the workspace or an ethical wall:
  that account is not allowed on this matter (step 1 said `NO`).
- Anything else: stop and ask. Other people are not affected.

---

## 8. If Claude's app is refused: trust its client_id

Casefile only lets known Claude apps sign in. By default it knows Claude Code's. The claude.ai
and Claude Desktop apps identify themselves with an address that Claude does not publish in
advance, so the first time they try, Casefile refuses them and writes that address to its log.

1. **Find the refused address in the Cloud Run log.** Either:
   - Google Cloud console → **Cloud Run** → `casefile-<matter>-api` → **Logs** tab. In the search
     box type `client refused`. Open the newest line. It looks like this:
     ```
     {"level":40,...,"client_id":"https://claude.ai/oauth/...","reason":"client_id is not on the trusted client list","msg":"oauth: client refused"}
     ```
     The value after `"client_id":` is the address you need.
   - or run (this only reads):
     ```powershell
     gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=casefile-<matter>-api AND jsonPayload.reason:trusted' --project=<project> --limit=5 --format="value(timestamp,jsonPayload.client_id)"
     ```
     **You should see** one line per refusal: a time and an address.
2. **Check it.** It must start with `https://claude.ai/` or `https://claude.com/`, and its time
   must match when you pressed Connect. If not, **stop and ask**: someone else may be trying to sign in.
3. **Add it** to the env file on one line, **keeping Claude Code's address first** (setting this
   line replaces the default list), separated by a comma with no spaces:
   ```
   MCP_OAUTH_TRUSTED_CLIENTS=https://claude.ai/oauth/claude-code-client-metadata,<the refused address>
   ```
4. **Redeploy** with the address list, without rebuilding: run step 5c with `--no-build` added
   (check that `MCP_OAUTH_TRUSTED_CLIENTS=` with both addresses appears in the long line), then 5d
   with `--no-build` added.
5. Run the preflight: `MCP_OAUTH_TRUSTED_CLIENTS:` shows both addresses. Go back to step 7.3.

**You should see** the Casefile sign-in page instead of the refusal.

---

## 9. Retire the old shared token: disable it, never delete it

The new version no longer reads the token (the step 5 deploy replaced the list of secrets it
mounts). Now switch the token itself off. **Disable** keeps it, so it can be switched back on;
never use `destroy` or `delete`.

List its versions (this only reads):

```powershell
gcloud secrets versions list casefile-<matter>-mcp-token --project=<project>
```

**You should see** a table of versions; those that can be used say `enabled` under STATE.

For **each** `enabled` version number `<N>`:

```powershell
gcloud secrets versions disable <N> --secret=casefile-<matter>-mcp-token --project=<project>
```

**You should see** `Disabled version [<N>] of the secret [casefile-<matter>-mcp-token].` List the
versions again: every one now says `disabled`. Run check 3 of step 6 again; it still answers `401`.

**If you don't:** `NOT_FOUND`: the secret has another name. List the secrets with
`gcloud secrets list --project=<project>` and look for one ending in `mcp-token`; ask before
disabling anything else.

---

## 10. Roll back: send traffic back to the previous revision

Use this if anything after step 5 goes wrong. It puts the old version back in a minute. The
migrations from step 4 stay; the old version ignores them. Do not try to undo them.

**If documents were ingested with the new version**, the old version cannot read their text:
the new version stores a chunk's text only in its block (text stored once, D94), and the old
search expects it in the chunk. Roll back only before any ingest with the new version; after
one, fix forward instead, and ask.

1. **If you already did step 9**, switch the old token back on first, or the old version cannot start.
   For each version you disabled:
   ```powershell
   gcloud secrets versions enable <N> --secret=casefile-<matter>-mcp-token --project=<project>
   ```
   **You should see** `Enabled version [<N>] of the secret [casefile-<matter>-mcp-token].`
2. **Send all traffic to the revision you wrote down in step 5b:**
   ```powershell
   gcloud run services update-traffic casefile-<matter>-api --to-revisions=<old revision>=100 --region=<region> --project=<project>
   ```
   **You should see** a traffic table with `100%` next to the old revision.
3. **Check:** run check 2 of step 6 (`curl.exe -i -X POST <service url>/mcp`). The old version
   answers `401` with a message about `MCP_TOKEN` (for example
   `"Unauthorized: MCP_TOKEN Bearer token required"`), not `sign in to use this connector`.
4. In Claude, remove the new connector and add the old one back the way it was.

**If you don't** see 100% on the old revision: in the Google Cloud console → Cloud Run →
`casefile-<matter>-api` → **Revisions** → **Manage traffic**, set the old revision to 100% and save.
Then ask.

---

When the matter works with sign-in and nothing needed rolling back, note the matter, the date and
the new revision name in `CASEFILE-ROADMAP.md`.
