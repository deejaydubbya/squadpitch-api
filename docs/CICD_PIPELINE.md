# CI/CD Pipeline — squadpitch-api

GitHub Actions handles two responsibilities for this repo:

- **CI** (`.github/workflows/ci.yml`) — runs on every pull request and on
  every push to `main` / `master`. Required PR gate.
- **Deploy** (`.github/workflows/deploy.yml`) — runs only on push to the
  default branch (after CI passes). Deploys to Fly.io.

## Required PR gate

Before a PR can merge, CI must be green. CI runs:

1. `npm ci`
2. `npx prisma validate` — catches schema syntax errors
3. `npx prisma generate` — catches generator config errors
4. `npm test` — Vitest unit + integration suite

CI uses a placeholder `DATABASE_URL` (`postgresql://placeholder:...`) — Prisma
generate/validate don't open a connection, so tests that need a DB must mock it.
(They do — see `tests/carSalesInventoryCrawl.test.js` for the pattern.)

## Deploy

`deploy.yml` is triggered via `workflow_run` — it fires only **after** the
`CI` workflow completes successfully on a push to `main` / `master`. A
failing CI run never triggers a deploy, so the "don't deploy if tests
fail" gate holds even for direct pushes that bypass branch protection.
The deploy step uses `superfly/flyctl-actions/setup-flyctl@master` and
runs `flyctl deploy --remote-only`, checked out at the exact SHA that CI
validated.

Schema migrations + backfills run during Fly's release step (see `fly.toml`
→ `[deploy] release_command`) — not from the GitHub Actions runner. That
keeps migrations atomic with the rolling restart.

## Required GitHub repo secrets

| Secret | Source | Purpose |
|---|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy -a squadpitch-api` (output `FlyV1 …`) | Authenticates `flyctl deploy` |

Set it once via `gh secret set FLY_API_TOKEN -a actions` or in the GitHub UI
under **Settings → Secrets and variables → Actions**.

## Manual rollbacks

GitHub Actions doesn't gate rollbacks. To revert to a prior release:

```bash
fly releases -a squadpitch-api          # list
fly deploy --image <prior-image> -a squadpitch-api
```
