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

## Uploaded files

Import files live on the `eve_files` volume (`/var/lib/eve/files`), named by their SHA-256. Files of committed imports are kept permanently as audit evidence; those of discarded or abandoned imports are deleted after 30 days (setting `platform.import_retention_days`). Back up this volume together with the database.

## Issued documents

Issued PDFs (letters, certificates) are stored on the same `eve_files` volume and never deleted. They are rendered by a headless Chromium baked into the `api` image at build time, so no internet access is needed at run time. Before a company can be issued documents, a system administrator sets its letterhead: upload a PNG or JPEG logo (optional) with `POST /api/v1/platform/documents/letterhead-logo`, then set `platform.documents.letterhead` (`nameFa` required; `nameEn`, `addressFa`, `phone`, `footerFa`, `logoFileRef` optional) customer-wide or per company.

For local development, install the same browser once: `pnpm --filter @eve/api exec playwright-core install chromium-headless-shell`.

## Platform roles

| Role                  | Scope               | Can                                                                                                                               |
| --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `system_admin`        | customer            | settings, users and role grants, companies (and their org profile and unit levels), usage report; proposes rule-parameter changes |
| `auditor`             | customer or company | read-only, including the audit log, people and the organization structure                                                         |
| `rule_approver`       | customer or company | approves rule-parameter changes (cannot approve their own requests)                                                               |
| `people_data_owner`   | customer or company | imports and corrects the person register (HR Ops pack)                                                                            |
| `org_data_owner`      | customer or company | imports and reads the organization structure; works the findings inbox (HR Ops pack)                                              |
| `org_change_approver` | customer or company | approves structure changes and re-imports (HR Ops pack)                                                                           |

## Database roles

Created once by [postgres/init/01-setup.sh](postgres/init/01-setup.sh) (using [postgres/sql/](postgres/sql/), shared with the test harness) on an empty data volume:

| Role        | Used by     | Rights                                                                     |
| ----------- | ----------- | -------------------------------------------------------------------------- |
| `postgres`  | init only   | superuser                                                                  |
| `eve_owner` | migrations  | owns schema and tables                                                     |
| `eve_app`   | running app | DML on tables (append-only tables revoke UPDATE/DELETE in their migration) |

## Internal registry

Set `IMAGE_REGISTRY` in `.env` (e.g. `harbor.internal/proxy/`, trailing slash) and the `registry` line in `.npmrc`.
