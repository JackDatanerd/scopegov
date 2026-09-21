# Postgres replay tests

`tests/pg-replay.test.ts` replays every migration in `supabase/migrations/` against a real
Postgres and then attacks the result as `anon` / `authenticated` (the roles reachable with the
public anon key) and races the SQL functions. `tests/rls-contract.test.ts` only scans migration
TEXT; this checks what the database actually does.

It is skipped unless `PG_REPLAY_URL` is set, to a **superuser** connection on a **disposable**
server (roles are created cluster-wide; each run creates and drops its own database):

    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pw pgvector/pgvector:pg16
    PG_REPLAY_URL=postgres://postgres:pw@localhost:5433/postgres npx vitest run tests/pg-replay.test.ts

(PowerShell: `$env:PG_REPLAY_URL="postgres://postgres:pw@localhost:5433/postgres"`.)

`supabase-shim.sql` stands in for the parts of Supabase the migrations depend on (`auth`/`storage`
schemas, `auth.uid()`, the roles, Supabase's default privileges). It is NOT GoTrue or PostgREST —
row-level behaviour is exercised by switching role and setting `request.jwt.claims`.
