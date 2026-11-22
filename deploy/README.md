# Deploy

One customer, one stack: `api` (server + worker), `postgres` (with `btree_gist`, `pgvector`), `caddy` (TLS, web app, `/api` proxy).

## Start

```sh
cp .env.example .env   # then set the three passwords
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

- Web: <https://localhost> (Caddy local certificate)
- Health: <https://localhost/api/v1/health> → `{"status":"ok","db":"ok"}`

On start the `api` container runs `prisma migrate deploy` as `eve_owner`, then serves as `eve_app`.

## Database roles

Created once by [postgres/init/01-setup.sh](postgres/init/01-setup.sh) (using [postgres/sql/](postgres/sql/), shared with the test harness) on an empty data volume:

| Role        | Used by     | Rights                                                                     |
| ----------- | ----------- | -------------------------------------------------------------------------- |
| `postgres`  | init only   | superuser                                                                  |
| `eve_owner` | migrations  | owns schema and tables                                                     |
| `eve_app`   | running app | DML on tables (append-only tables revoke UPDATE/DELETE in their migration) |

## Internal registry

Set `IMAGE_REGISTRY` in `.env` (e.g. `harbor.internal/proxy/`, trailing slash) and the `registry` line in `.npmrc`.
