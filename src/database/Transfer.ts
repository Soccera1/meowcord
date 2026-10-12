/* SPDX-License-Identifier: AGPL-3.0-only */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import path from "node:path";
import { DataSource, MigrationExecutor, Table, TableColumn, type QueryRunner } from "typeorm";
import { SqliteDataSource } from "./SqliteDataSource";
import { sqlitePath } from "./Sql";

const json = require("json-bigint")({ useNativeBigInt: true });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableName = (table: Table) => table.name.replace(/^public\./, "");
const internalTable = (name: string) => name === "migrations" || name === "typeorm_metadata" || name.startsWith("sqlite_");
const batchSize = 200;
const floatTypes = ["real", "double precision", "float4", "float8"];
type Backend = "postgres" | "sqlite";
type Reader = { query(sql: string, parameters?: unknown[]): Promise<any[]> };
type Column = { name: string; type: string; isArray: boolean };
type Digest = { count: number; sum: bigint };

export function transferBackend(connection: string): Backend {
    if (connection.startsWith("sqlite:")) {
        const filename = sqlitePath(connection);
        if (filename === ":memory:" || filename.startsWith("file:")) throw new Error("Transfer requires a persistent SQLite file");
        return "sqlite";
    }
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Use postgres: or sqlite: connection strings");
    if (!url.pathname || url.pathname === "/") throw new Error("PostgreSQL connection strings must name a database");
    return "postgres";
}

function dataSource(connection: string, backend: Backend) {
    const options = { migrations: [path.join(__dirname, "migration", backend, "*.js")], logging: false as const };
    return backend === "sqlite"
        ? new SqliteDataSource({ ...options, database: sqlitePath(connection) })
        : new DataSource({ ...options, type: "postgres", url: connection, connectTimeoutMS: 10000, poolSize: 1 });
}

function sortedJson(value: any): any {
    if (Array.isArray(value)) return value.map(sortedJson);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortedJson(value[key])]),
        );
    return value;
}

function timestamp(value: string) {
    const fractional = /\.(\d+)/.exec(value)?.[1] ?? "";
    const input = value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
    const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(input) ? input : `${input}Z`);
    if (!Number.isFinite(date.getTime())) throw new Error("Unsupported timestamp in source database");
    const seconds = date.toISOString().slice(0, 19).replace("T", " ");
    const fraction = `${date.getUTCMilliseconds().toString().padStart(3, "0")}${fractional.slice(3)}`.replace(/0+$/, "");
    return `${seconds}${fraction ? `.${fraction}` : ""}`;
}

function canonical(value: string | null, column: Column): string | null {
    if (value === null) return null;
    if (column.isArray) {
        const normalize = (entry: any): any => (Array.isArray(entry) ? entry.map(normalize) : entry === null ? null : String(entry));
        return json.stringify(normalize(json.parse(value)));
    }
    if (["json", "jsonb"].includes(column.type)) return json.stringify(sortedJson(json.parse(value)));
    if (["boolean", "bool"].includes(column.type)) {
        if (!["t", "f", "true", "false", "1", "0"].includes(value)) throw new Error(`Invalid boolean in ${column.name}`);
        return ["t", "true", "1"].includes(value) ? "true" : "false";
    }
    if (["bigint", "integer", "smallint", "int8", "int4", "int2"].includes(column.type)) return BigInt(value).toString();
    if (column.type.startsWith("timestamp")) return timestamp(value);
    if (floatTypes.includes(column.type)) {
        if (!Number.isFinite(Number(value))) throw new Error(`Unsupported floating point value in ${column.name}`);
        return Number(value).toString();
    }
    return value;
}

function digestRow(digest: Digest, values: (string | null)[]) {
    digest.count++;
    digest.sum = (digest.sum + BigInt(`0x${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`)) % (1n << 256n);
}

async function* rows(reader: Reader, backend: Backend, table: Table, columns: Column[]) {
    const keys = table.primaryColumns.map((column) => column.name);
    const physicalKey = backend === "postgres" ? "ctid" : "rowid";
    let cursor: unknown[] | undefined;
    const selected = columns.map((column, index) => {
        const name = quote(column.name);
        return `${backend === "postgres" && column.isArray ? `array_to_json(${name})::text` : backend === "sqlite" && floatTypes.includes(column.type) ? name : `CAST(${name} AS text)`} AS ${quote(`c${index}`)}`;
    });
    while (true) {
        const condition = !cursor
            ? ""
            : keys.length
              ? `WHERE (${keys.map(quote).join(",")}) > (${keys.map((_, index) => `$${index + 1}`).join(",")})`
              : `WHERE ${physicalKey} > $1${backend === "postgres" ? "::tid" : ""}`;
        const selection = keys.length ? selected : [...selected, `${backend === "postgres" ? "ctid::text" : "rowid"} AS _cursor`];
        const ordering = keys.length ? keys.map(quote).join(",") : physicalKey;
        const batch = await reader.query(`SELECT ${selection.join(",")} FROM ${quote(tableName(table))} ${condition} ORDER BY ${ordering} LIMIT ${batchSize}`, cursor);
        if (!batch.length) return;
        yield batch.map((row) => columns.map((_, index) => (row[`c${index}`] === null ? null : String(row[`c${index}`]))));
        const last = batch[batch.length - 1];
        cursor = keys.length ? keys.map((key) => last[`c${columns.findIndex((column) => column.name === key)}`]) : [last._cursor];
        if (cursor.some((value) => value === null)) throw new Error(`Null primary key in ${tableName(table)}`);
    }
}

async function sqliteTables(reader: Reader) {
    const names = await reader.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    return Promise.all(
        names.map(
            async ({ name }) =>
                new Table({
                    name,
                    columns: (await reader.query(`PRAGMA table_info(${quote(name)})`)).map(
                        (column) =>
                            new TableColumn({
                                name: column.name,
                                type: column.type,
                                isPrimary: column.pk > 0,
                                isNullable: !column.notnull,
                            }),
                    ),
                }),
        ),
    );
}

async function postgresTables(runner: QueryRunner) {
    const names = await runner.query(
        "SELECT table_name, table_schema, table_type FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog') AND table_schema NOT LIKE 'pg_%'",
    );
    if (names.some((table: any) => table.table_schema !== "public" || table.table_type !== "BASE TABLE"))
        throw new Error("Only PostgreSQL base tables in the public schema are supported");
    return runner.getTables(names.map((table: any) => `public.${table.table_name}`));
}

async function sourceMigrations(reader: Reader, backend: Backend) {
    const expected = readdirSync(path.join(__dirname, "migration", backend))
        .filter((name) => name.endsWith(".js"))
        .flatMap((name) =>
            Object.values(require(path.join(__dirname, "migration", backend, name)))
                .filter((entry: any) => typeof entry === "function" && entry.prototype.up)
                .map((entry: any) => new entry().name ?? entry.name),
        )
        .sort();
    const actual = (await reader.query("SELECT name FROM migrations")).map(({ name }) => name).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw new Error("Source migrations do not match this build. Update and start the source with this version, stop it, then retry");
}

async function insertBatch(runner: QueryRunner, backend: Backend, table: Table, columns: Column[], batch: (string | null)[][]) {
    const parameters: unknown[] = [];
    const values = batch.map(
        (row) =>
            `(${row
                .map((value, index) => {
                    const column = columns[index];
                    let bound: unknown = value;
                    if (value !== null && column.isArray) bound = backend === "postgres" ? json.parse(value) : value;
                    else if (value !== null && ["boolean", "bool"].includes(column.type)) bound = backend === "postgres" ? value === "true" : value === "true" ? 1 : 0;
                    parameters.push(bound);
                    return `$${parameters.length}`;
                })
                .join(",")})`,
    );
    await runner.query(`INSERT INTO ${quote(tableName(table))} (${columns.map((column) => quote(column.name)).join(",")}) VALUES ${values.join(",")}`, parameters);
}

async function runFreshMigrations(database: DataSource, runner: QueryRunner) {
    const query = runner.query as (sql: string, parameters?: any[], structured?: boolean) => Promise<any>;
    const maintenance = new Set(["COMMIT;", "BEGIN;", "VACUUM (FULL, ANALYZE, VERBOSE) instance_bans;"]);
    runner.query = async (sql: string, parameters?: any[], structured?: boolean) => {
        if (maintenance.has(sql.trim())) return [];
        if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|END|START TRANSACTION)\b/i.test(sql)) throw new Error("A schema migration attempted to leave the transfer transaction");
        return query.call(runner, sql, parameters, structured);
    };
    try {
        await new MigrationExecutor(database, runner).executePendingMigrations();
    } finally {
        runner.query = query;
    }
}

async function closeConnection(runner?: QueryRunner, database?: DataSource) {
    try {
        if (runner?.isTransactionActive) await runner.rollbackTransaction();
    } finally {
        try {
            await runner?.release();
        } finally {
            if (database?.isInitialized) await database.destroy();
        }
    }
}

export async function transferDatabase(source: string, destination: string, progress: (message: string) => void = console.log) {
    const sourceBackend = transferBackend(source);
    const destinationBackend = transferBackend(destination);
    if (sourceBackend === destinationBackend) throw new Error("Source and destination must use different database backends");
    if (sourceBackend === "sqlite" && !existsSync(sqlitePath(source))) throw new Error("Source SQLite file does not exist");
    if (destinationBackend === "sqlite" && existsSync(sqlitePath(destination))) throw new Error("Destination SQLite file already exists. Choose a new path");
    let sourceDatabase: DataSource | undefined;
    let native: { close(): void } | undefined;
    let sourceRunner: QueryRunner | undefined;
    let destinationDatabase: DataSource | undefined;
    let destinationRunner: QueryRunner | undefined;
    let failure: unknown;
    try {
        let reader: Reader;
        let sourceTables: Table[];
        if (sourceBackend === "sqlite") {
            const { Database } = require("bun:sqlite");
            const database = new Database(sqlitePath(source), { readonly: true, create: false, safeIntegers: true });
            native = database;
            database.exec("PRAGMA busy_timeout=30000; BEGIN");
            reader = {
                query: async (sql, parameters = []) => {
                    const bindings: unknown[] = [];
                    const query = sql.replace(/\$(\d+)/g, (_, index) => {
                        bindings.push(parameters[Number(index) - 1]);
                        return "?";
                    });
                    return database.prepare(query).all(...bindings);
                },
            };
            sourceTables = await sqliteTables(reader);
        } else {
            sourceDatabase = dataSource(source, sourceBackend);
            await sourceDatabase.initialize();
            sourceRunner = sourceDatabase.createQueryRunner();
            await sourceRunner.startTransaction("REPEATABLE READ");
            await sourceRunner.query("SET TRANSACTION READ ONLY");
            await sourceRunner.query("SET LOCAL search_path TO public");
            await sourceRunner.query("SET LOCAL TIME ZONE 'UTC'");
            await sourceRunner.query("SET LOCAL DateStyle = 'ISO, YMD'");
            reader = sourceRunner;
            sourceTables = await postgresTables(sourceRunner);
        }
        await sourceMigrations(reader, sourceBackend);
        if (destinationBackend === "sqlite") {
            const filename = sqlitePath(destination);
            mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
            closeSync(openSync(filename, "wx", 0o600));
        }
        destinationDatabase = dataSource(destination, destinationBackend);
        await destinationDatabase.initialize();
        destinationRunner = destinationDatabase.createQueryRunner();
        if (destinationBackend === "sqlite") await destinationRunner.query("PRAGMA foreign_keys=OFF");
        await destinationRunner.startTransaction();
        if (destinationBackend === "postgres") {
            await destinationRunner.query("SET LOCAL lock_timeout='10s'");
            await destinationRunner.query("SET LOCAL search_path TO public");
            await destinationRunner.query("SET LOCAL TIME ZONE 'UTC'");
            await destinationRunner.query("SET LOCAL DateStyle = 'ISO, YMD'");
            await destinationRunner.query("SELECT pg_advisory_xact_lock(1)");
        }
        if (destinationBackend === "postgres") {
            const objects =
                await destinationRunner.query(`SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%' AND (
                EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid) OR
                EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid) OR
                EXISTS(SELECT 1 FROM pg_type t WHERE t.typnamespace=n.oid)) LIMIT 1`);
            if (objects.length) throw new Error("Destination must be an empty database without user objects");
        } else if ((await destinationRunner.getTables()).some((table) => !tableName(table).startsWith("sqlite_")))
            throw new Error("Destination must be an empty database without tables");
        progress(`Creating ${destinationBackend} schema`);
        if (destinationBackend === "postgres") await new (require("./migration/postgres-initial").initial0)().up(destinationRunner);
        await runFreshMigrations(destinationDatabase, destinationRunner);
        const destinationTables = (destinationBackend === "postgres" ? await postgresTables(destinationRunner) : await destinationRunner.getTables()).filter(
            (table) => !internalTable(tableName(table)),
        );
        sourceTables = sourceTables.filter((table) => !internalTable(tableName(table)));
        const sourceNames = sourceTables.map(tableName).sort();
        const destinationNames = destinationTables.map(tableName).sort();
        if (JSON.stringify(sourceNames) !== JSON.stringify(destinationNames)) throw new Error("Source and destination table sets differ; no data was transferred");
        const triggers = destinationBackend === "sqlite" ? await destinationRunner.query("SELECT name, sql FROM sqlite_master WHERE type='trigger'") : [];
        if (destinationBackend === "postgres") for (const table of destinationTables) await destinationRunner.query(`ALTER TABLE ${quote(tableName(table))} DISABLE TRIGGER USER`);
        else for (const trigger of triggers) await destinationRunner.query(`DROP TRIGGER ${quote(trigger.name)}`);
        const foreignKeys = destinationTables.flatMap((table) => table.foreignKeys.map((key) => ({ table, key })));
        if (destinationBackend === "postgres") for (const { table, key } of foreignKeys) await destinationRunner.dropForeignKey(table, key);
        for (const table of destinationTables) await destinationRunner.query(`DELETE FROM ${quote(tableName(table))}`);
        let total = 0;
        for (const name of sourceNames) {
            const from = sourceTables.find((table) => tableName(table) === name)!;
            const to = destinationTables.find((table) => tableName(table) === name)!;
            const columnNames = from.columns.map((column) => column.name).sort();
            if (JSON.stringify(columnNames) !== JSON.stringify(to.columns.map((column) => column.name).sort())) throw new Error(`Column sets differ in ${name}`);
            const pgTable = sourceBackend === "postgres" ? from : to;
            const columns = columnNames.map((name) => pgTable.columns.find((column) => column.name === name)!);
            const expected: Digest = { count: 0, sum: 0n };
            for await (const batch of rows(reader, sourceBackend, from, columns)) {
                const normalized = batch.map((row) => row.map((value, index) => canonical(value, columns[index])));
                for (const row of normalized) digestRow(expected, row);
                await insertBatch(destinationRunner, destinationBackend, to, columns, normalized);
            }
            const actual: Digest = { count: 0, sum: 0n };
            for await (const batch of rows(destinationRunner, destinationBackend, to, columns))
                for (const row of batch)
                    digestRow(
                        actual,
                        row.map((value, index) => canonical(value, columns[index])),
                    );
            if (expected.count !== actual.count || expected.sum !== actual.sum) throw new Error(`Data verification failed for ${name}`);
            total += actual.count;
            progress(`${name}: ${actual.count} rows verified`);
        }
        if (destinationBackend === "postgres") {
            for (const { table, key } of foreignKeys) await destinationRunner.createForeignKey(table, key);
            for (const table of destinationTables)
                for (const column of table.columns.filter((column) => column.isGenerated && ["increment", "identity"].includes(column.generationStrategy ?? ""))) {
                    await destinationRunner.query(
                        `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE(MAX(${quote(column.name)}),1), MAX(${quote(column.name)}) IS NOT NULL) FROM ${quote(tableName(table))}`,
                        [tableName(table), column.name],
                    );
                }
        } else {
            if ((await destinationRunner.query("PRAGMA foreign_key_check")).length) throw new Error("Destination foreign key validation failed");
            const integrity = await destinationRunner.query("PRAGMA integrity_check");
            if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("Destination integrity validation failed");
        }
        if (destinationBackend === "postgres") for (const table of destinationTables) await destinationRunner.query(`ALTER TABLE ${quote(tableName(table))} ENABLE TRIGGER USER`);
        else for (const trigger of triggers) await destinationRunner.query(trigger.sql);
        await destinationRunner.commitTransaction();
        progress(`Transfer complete: ${total} rows across ${sourceNames.length} tables. Set DATABASE to the destination before restarting`);
    } catch (error) {
        failure = error;
    } finally {
        const results = await Promise.allSettled([closeConnection(destinationRunner, destinationDatabase), closeConnection(sourceRunner, sourceDatabase)]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") failure ??= failed.reason;
        try {
            native?.close();
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure !== undefined) throw failure;
}
