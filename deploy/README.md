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

## First administrator

After the first start, set the customer's home jurisdiction and create the first system administrator (the time zone defaults to the jurisdiction's; pass `--time-zone` to override):

```sh
docker compose -f deploy/docker-compose.yml --env-file .env exec   -e EVE_BOOTSTRAP_PASSWORD='choose-a-long-password' api   node dist/cli/bootstrap.js --jurisdiction ir --username admin --contact-address 09120000000
```

R1 delivers one-time login codes only through the stub channel. To see codes in a test environment, set `EVE_STUB_CHANNEL_REVEAL_SECRETS=true` on the `api` service; never in production.

## Database roles

Created once by [postgres/init/01-setup.sh](postgres/init/01-setup.sh) (using [postgres/sql/](postgres/sql/), shared with the test harness) on an empty data volume:

| Role        | Used by     | Rights                                                                     |
| ----------- | ----------- | -------------------------------------------------------------------------- |
| `postgres`  | init only   | superuser                                                                  |
| `eve_owner` | migrations  | owns schema and tables                                                     |
| `eve_app`   | running app | DML on tables (append-only tables revoke UPDATE/DELETE in their migration) |

## Internal registry

Set `IMAGE_REGISTRY` in `.env` (e.g. `harbor.internal/proxy/`, trailing slash) and the `registry` line in `.npmrc`.
