# Prisma Local Validation

Run Prisma validation commands from:

```powershell
D:\repositories\squadpitch\squadpitch-api\prisma
```

From that directory, the correct relative paths are:

- Schema: `schema.prisma`
- Migrations: `migrations`

Do not use `prisma/schema.prisma` or `prisma/migrations` from this directory. Those paths are only correct when the current working directory is the API package root.

## No Database Required

These commands validate local files and generate the local client without opening a database connection:

```powershell
npx --prefix .. --no-install prisma format --schema schema.prisma
npx --prefix .. --no-install prisma validate --schema schema.prisma
npx --prefix .. --no-install prisma generate --schema schema.prisma
```

## Normal Database Required

Commands that inspect or apply migration state need a real target database via `DATABASE_URL`. Use only a local, staging, or otherwise explicitly disposable database for local validation:

```powershell
npx --prefix .. --no-install prisma migrate status --schema schema.prisma
npx --prefix .. --no-install prisma migrate deploy --schema schema.prisma
```

Do not run these against production during local validation.

## Disposable Shadow Database Required

Migration diff checks that replay migrations require a separate throwaway shadow database. The shadow database must not be production and must not be the same database as `DATABASE_URL`.

PowerShell:

```powershell
$env:SHADOW_DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/squadpitch_shadow?schema=public"
npx --prefix .. --no-install prisma migrate diff --from-migrations migrations --to-schema-datamodel schema.prisma --shadow-database-url "$env:SHADOW_DATABASE_URL" --exit-code
```

Git Bash:

```bash
export SHADOW_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/squadpitch_shadow?schema=public"
npx --prefix .. --no-install prisma migrate diff --from-migrations migrations --to-schema-datamodel schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
```

In Git Bash, an unset variable expands to an empty string. Do not run a command like `--shadow-database-url "$SHADOW_DATABASE_URL"` until you have verified that `SHADOW_DATABASE_URL` is set to a valid non-production shadow database URL.

## Safety Rules

- Never use production as a shadow database.
- Never use production for local migration validation.
- Never run `prisma migrate reset` against a shared database.
- Never use `prisma db push` to bypass checked migrations.
- Do not delete or rewrite historical migrations after they may have been deployed.
