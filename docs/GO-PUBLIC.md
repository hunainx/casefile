# Going public: the checklist

The steps to make this repository public, and what to check right after. For the repository owner: run them
yourself, in order, from the repository folder, with `gh` signed in as the repository's owner. Set the repository
once, then paste the commands:

```bash
REPO=<owner>/casefile
```

**Making a repository public cannot be fully undone.** Anyone can clone or fork it within minutes, and the
contents may be cached or indexed. Making it private again later does not take back what was copied.

## 1. Before: confirm the state

```bash
git fetch origin
git status
git log --oneline
gh api user --jq .login
gh repo view "$REPO" --json visibility,defaultBranchRef
```

Expect: a clean tree, the commits you mean to publish on `master`, your account, `PRIVATE`.

Scan the whole history for credentials with gitleaks, using this repository's rules (`.gitleaks.toml`: gitleaks'
defaults plus the formats they miss), from the official image with a read-only mount:

```bash
docker run --rm -v "$(pwd):/repo:ro" --entrypoint sh ghcr.io/gitleaks/gitleaks:v8.28.0 -c "git config --global --add safe.directory /repo && gitleaks git /repo --config /repo/.gitleaks.toml --log-opts='--all' --redact=90 -v"
```

Expect only known test values (the `JWT_SECRET` test strings in the test configs and `.env.local.example`).
Anything else: stop, look at it, and revoke it at its source if it is real.

Run the guardrails once more (they include the same credential formats and the denylist of names that must never
appear):

```bash
pnpm guardrails
```

## 2. Before: GitHub settings that matter for a public repository

**Actions.** No Actions secrets or variables, and a read-only default token:

```bash
gh api "repos/$REPO/actions/secrets" --jq .total_count
gh api "repos/$REPO/actions/variables" --jq .total_count
gh api "repos/$REPO/actions/permissions/workflow"
```

Expect `0`, `0` and `"default_workflow_permissions":"read"` (set it under Settings > Actions > General >
Workflow permissions if not). Never add a cloud credential, a database URL or a Supabase key as an Actions
secret of a public repository.

- `.github/workflows/ci.yml` runs on pushes to `master`, on `pull_request` (not `pull_request_target`) and by
  hand, on GitHub's hosted runners, and reads no secrets. A pull request from a fork runs with no access to
  anything private.
- Settings > Actions > General > "Approval for running fork pull request workflows from contributors": choose
  **Require approval for all external contributors**.

**Security features** (free for public repositories): private vulnerability reporting (SECURITY.md relies on it)
and Dependabot alerts:

```bash
gh api -X PUT "repos/$REPO/private-vulnerability-reporting"
gh api -X PUT "repos/$REPO/vulnerability-alerts"
```

Secret scanning and push protection: Settings > Code security: enable **Secret scanning** and **Push protection**
(if the page does not offer them before the repository is public, turn them on right after step 3).

**Branch protection** for `master` (recommended): Settings > Branches > add a rule for `master`: require a pull
request before merging; block force pushes and deletions.

**Other settings:** keep Issues on for bug reports (SECURITY.md sends security reports privately instead); Wiki,
Pages and Discussions as you prefer.

## 3. Make it public

```bash
gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences
```

## 4. Right after

```bash
gh repo view "$REPO" --json visibility,url
gh api "repos/$REPO" --jq '.security_and_analysis'
gh api "repos/$REPO/secret-scanning/alerts" --jq 'length'
```

- `visibility` is `PUBLIC`.
- Secret scanning and push protection show `enabled`.
- Look at every secret scanning alert within the first day. The known test values may be reported; close them as
  "used in tests". Anything else: treat it as real, revoke it at its source first, then decide.
- Open the repository in a private browser window, signed out: the README renders, `LICENSE` is detected as
  AGPL-3.0, and the Security tab offers "Report a vulnerability".
- Settings > Actions > General shows "Require approval for all external contributors" and the read-only token.
- In the next days: watch Issues, pull requests and the Security tab.

## 5. If something real is found after it is public

1. Treat it as exposed: revoke or rotate it at its source first. Removing it from the repository does not
   un-expose it.
2. Make the repository private again if that limits the damage:
   `gh repo edit "$REPO" --visibility private --accept-visibility-change-consequences`.
3. Then decide about the history. That is a separate decision.
