# Database operation

`DATABASE_URL` selects PostgreSQL as the primary store for synthetic runs, evidence, incidents, recovery records, sandbox payments, live website checks, and commerce orders. The server awaits schema initialization before listening. A configured PostgreSQL failure stops startup; it never silently writes to SQLite.

Without `DATABASE_URL`, the backend uses the existing local SQLite store at `DATABASE_PATH` (default `data/bizplus.sqlite` from the backend working directory). Explicit test `databasePath` options force SQLite regardless of process environment. Health reports `cloud` for PostgreSQL, `local` for SQLite, or the configured `temporary` hosted SQLite policy. Cloud/local history is retained; only temporary synthetic history is pruned after 24 hours.

For the offline presentation, build first and use root `npm run start:local`. This intentionally selects `backend/data/bizplus.sqlite` while still loading any Razorpay Test Mode settings. It does not change the normal deployment behavior: `npm start` uses the configured primary database and stops if that configuration fails. The sandbox works offline; real website checks and Razorpay require internet.

All PostgreSQL tables are under the private `bizplus` schema, with RLS enabled as a second boundary and no public policies. Startup revokes schema/table/default privileges from `PUBLIC` and, when present, `anon` and `authenticated`. Keep `bizplus` out of any provider's exposed Data API schemas. The backend connection role owns these tables and can access its own tables; browsers receive no database connection credentials. An existing connection role must have schema creation privileges.

TLS validates the server certificate. `DATABASE_CA_CERT`, when necessary, contains the provider's PEM root certificate (literal newlines or `\n`). URL SSL parameters are removed before configuring strict TLS, so `sslmode=require` cannot override certificate validation. Unencrypted connections are available only through explicit code options for loopback test databases. Pool size is four; connection timeout is ten seconds and statement timeout is fifteen seconds.

Node loads a present root `.local/integrations.env` before app creation. Existing process environment values take precedence. Never commit this file, connection URLs, provider secrets, or database snapshots.

## Preserve and migrate an existing SQLite database

Run these from the repository root with Node 24 and installed workspace dependencies:

```powershell
node --import tsx backend/scripts/export-sqlite.ts --source "backend/data/bizplus.sqlite" --output ".local/bizplus-history.json"
node --import tsx backend/scripts/migrate-sqlite.ts --source "backend/data/bizplus.sqlite"
node --import tsx backend/scripts/migrate-sqlite.ts --source "backend/data/bizplus.sqlite" --apply
```

The exporter opens SQLite read-only and refuses to overwrite an existing output. The migration defaults to a dry run. With `--apply`, it reads one consistent SQLite snapshot, initializes the cloud schema, and copies rows in foreign-key order inside a single PostgreSQL transaction. Existing cloud rows are retained with `ON CONFLICT DO NOTHING`; repeated imports cannot duplicate provider payments or checkout keys. It never deletes or modifies the source file. Inspect reported source and inserted counts after migration; conflicts are retained rather than overwritten. Missing optional tables in older SQLite files are skipped.

Review the idempotent schema in `migrations/001_private_schema.sql`. [node-postgres TLS](https://node-postgres.com/features/ssl) explains why URL SSL options require care; [transactions](https://node-postgres.com/features/transactions) use one checked-out client throughout each transaction.
