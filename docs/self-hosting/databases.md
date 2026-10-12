# Databases

The server supports PostgreSQL and SQLite. Set `DATABASE` before starting the server. PostgreSQL remains the default in Docker Compose and the development setup script. Existing PostgreSQL installations keep their connection string and migrations.

| Backend | Connection string |
| --- | --- |
| PostgreSQL | `postgres://user:password@localhost:5432/meowcord` |
| SQLite, relative path | `sqlite:db/meowcord.sqlite` |
| SQLite, absolute path | `sqlite:/var/lib/meowcord/meowcord.sqlite` |

SQLite uses Bun's built-in driver. It needs no PostgreSQL service or additional database package. Relative paths resolve from the server's working directory. The parent directory is created on startup. The server enables foreign keys, WAL journaling and a 30 second busy timeout. Keep the database on local storage and run one bundled server process for a SQLite instance.

Both backends apply their own versioned migrations automatically. SQLite creates its schema on first start without `DB_SYNC`. Do not enable `DB_SYNC` for routine operation. SQLite stores arrays and JSON as JSON text and preserves 64-bit account, server, channel and message IDs. Transactions serialize SQLite mutations, including encryption and slowmode checks. PostgreSQL keeps its row locks and advisory locks.

For a local SQLite instance, install dependencies and build as described in [setup.md](setup.md). Set these values in `.env`:

```dotenv
DATABASE=sqlite:db/meowcord.sqlite
CONFIG_PATH=config.json
PORT=3001
THREADS=1
```

For the local example, create `config.json`:

```json
{
    "general": { "serverName": "http://localhost:3001" },
    "api": { "endpointPublic": "http://localhost:3001/api/v9" },
    "cdn": { "endpointPublic": "http://localhost:3001", "endpointPrivate": "http://localhost:3001" },
    "gateway": { "endpointPublic": "ws://localhost:3001" }
}
```

Run `bun start`. Set the URLs to your own instance when hosting publicly. Provision the operator account with `bun scripts/ops/operator.mjs grant <account-id>` on either backend.

Changing `DATABASE` selects another database. To keep existing accounts and messages when changing backends, use the offline transfer command below. The PostgreSQL development setup script still creates and owns a PostgreSQL database.

Stop the server before copying the SQLite database and its `-wal` and `-shm` companion files. Back up the configuration, attachment storage and encryption recovery key too. Keep the file private: it contains account and instance data. SQLite files under `db/`, files ending in `.sqlite` and their journal companions are ignored by Git.

`bun test scripts/tests/sqlite-database.test.cjs` creates and removes its own temporary SQLite database. PostgreSQL tests use the guarded database variables documented in [CONTRIBUTING.MD](../../CONTRIBUTING.MD). Never clear rows on a database you did not create for the test run.

## Transfer between PostgreSQL and SQLite

`bun run db:transfer --offline <source-env-name> <destination-env-name>` copies an existing instance in either direction. Use Bun 1.4 or newer and build with `bun run build:src` first. The command reads connection strings from the named environment variables so database passwords stay out of process arguments. It does not edit `.env` or change `DATABASE` for the running instance.

1. Update the source instance to this build and start it once to apply its migrations. Stop every API, gateway, CDN, voice and background worker process that uses the instance. Keep them stopped until the transfer and configuration change are complete. `--offline` acknowledges this requirement; it does not stop processes for you.
2. Back up the source database, configuration, attachment storage and encryption recovery key. Keep the same configuration and storage when changing backends. Preserve the instance origin and any configured token signing, encryption recovery and attachment signing keys so existing sessions and encrypted history continue to work.
3. Create a new empty PostgreSQL database owned by the transfer user, or choose a SQLite path that does not exist. Do not start a server on the destination first. Existing destination tables or SQLite files are refused, including destinations created by an earlier server startup. PostgreSQL uses the `public` schema and needs permission to create tables and constraints; superuser access is not required.
4. Run the transfer from the checkout with both connection strings available in environment variables. SQLite relative paths resolve from this working directory. Use absolute paths when working from another directory.

SQLite to PostgreSQL:

```sh
export TRANSFER_SOURCE='sqlite:/var/lib/meowcord/meowcord.sqlite'
export TRANSFER_DESTINATION='postgres://user:password@localhost:5432/meowcord_new'
bun run db:transfer --offline TRANSFER_SOURCE TRANSFER_DESTINATION
```

PostgreSQL to SQLite:

```sh
export TRANSFER_SOURCE='postgres://user:password@localhost:5432/meowcord'
export TRANSFER_DESTINATION='sqlite:/var/lib/meowcord/meowcord-new.sqlite'
bun run db:transfer --offline TRANSFER_SOURCE TRANSFER_DESTINATION
```

In Docker, stop the server service and run a one-shot container with the database variables and the destination storage mounted. The image includes `scripts/ops/database-transfer.mjs`; the same package command works there. The PostgreSQL service must remain running. Use connection strings and file paths reachable inside that container.

The source is read through a consistent snapshot and receives no schema or data writes. The destination schema, seeds, copied rows and migration history are created in one transaction. The command transfers every application table, including relationship tables, configuration stored in the database, sessions, rate limits, encrypted messages, devices, sealed backups and recovery records. It converts arrays, JSON, booleans and timestamps, preserves 64-bit IDs, checks row counts and content digests for every table, restores application triggers, validates foreign keys and resets PostgreSQL generated sequences before committing. The destination retains its own backend's migration history. Source migrations, tables and columns must match the current build; mismatches fail rather than skip data.

A failure rolls back destination schema and data changes. A failed SQLite attempt can leave an empty file; inspect it and remove that failed destination file or choose another new path before retrying. The command never overwrites or clears an existing destination. New SQLite files have mode `0600`.

After the command reports completion, set the instance's `DATABASE` to the destination connection string and restart. For SQLite, also use `THREADS=1`. Check login, messages, encrypted history and attachments before retiring the source. Keep the source backup until the new backend has been verified. Attachment files, external object storage, filesystem configuration and encryption recovery keys are not copied by the database command.

`DATABASE_TEST_ADMIN_URL=postgres://user:password@localhost/postgres bun test scripts/tests/database-transfer.test.cjs` verifies both directions using its own temporary SQLite files and randomly named PostgreSQL databases, including exact IDs, arrays, ciphertext, microsecond timestamps, multiple batches, refusal of existing destinations and transaction rollback. The PostgreSQL test role needs permission to create and drop those test databases.
