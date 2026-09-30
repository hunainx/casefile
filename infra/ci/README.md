# CI

`github-workflow-ci.yml` is a copy of `.github/workflows/ci.yml`.

It exists because the desktop file bridge treats `.github/` as a protected path and will
not write into it remotely. If `.github/workflows/ci.yml` is missing from your checkout,
copy this file there:

```bash
mkdir -p .github/workflows && cp infra/ci/github-workflow-ci.yml .github/workflows/ci.yml
```

The two must stay identical. `init-db.sql` is shared by CI, `infra/compose.yml`, and
`scripts/dev-db.sh` — it is the single place database roles and extensions are defined,
which is what keeps the three environments from drifting.
