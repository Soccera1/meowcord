/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { Database } = require("bun:sqlite");

const id = "9007199254740993";
const command = path.resolve(__dirname, "../ops/database-transfer.mjs");
const run = (args, env = {}) =>
    spawnSync(process.execPath, args, {
        env: { ...process.env, ...env, DB_SYNC: "false", DB_LOGGING: "", APPLY_DB_MIGRATIONS: "true" },
        encoding: "utf8",
        timeout: 90_000,
    });
const transfer = (source, destination) => run([command, "--offline", "TRANSFER_FROM", "TRANSFER_TO"], { TRANSFER_FROM: source, TRANSFER_TO: destination });
const succeeded = (result) => assert.equal(result.status, 0, result.stdout + result.stderr);

if (process.env.TRANSFER_SEED_CHILD === "1") {
    test("seed transfer source", async () => {
        const { initDatabase, closeDatabase } = require("../../dist/database/Database.js");
        try {
            const database = await initDatabase();
            const { User, Guild, Channel, Message } = require("../../dist/database/entities");
            const { Config } = require("../../dist/util/util/Config.js");
            await Config.init();
            const user = await User.register({ username: "transfer_tester", password: "transfer-test-only" });
            await database.query("UPDATE users SET id=$1, rights=$2, pride_badges=$3 WHERE id=$4", [id, "9007199254740993", ["pride", "transgender"], user.id]);
            const guild = await Guild.createGuild({ name: "Transfer guild", owner_id: id, source_guild_id: null });
            const channel = await Channel.findOneByOrFail({ guild_id: guild.id, type: 0 });
            await Message.create({
                id: "9007199254741001",
                channel_id: channel.id,
                author_id: id,
                content: "",
                type: 0,
                timestamp: new Date(),
                tts: false,
                mention_everyone: false,
                embeds: [],
                reactions: [],
                encrypted: { fixture: "opaque ciphertext", nonce: "sealed" },
            }).save();
            await database.query("INSERT INTO e2ee_identities(user_id,public_key,created_at) VALUES($1,$2,$3)", [id, "identity-test-key", "2026-10-12 01:02:03.123456"]);
            await database.query("INSERT INTO e2ee_recovery(user_id,identity_key,backup_public_key,backup_version,encrypted_secret,updated_at) VALUES($1,$2,$3,$4,$5,$6)", [
                id,
                "identity-test-key",
                "backup-key",
                1,
                "sealed-recovery-secret",
                "2026-10-12 01:02:03.123456",
            ]);
            await database.query(
                "INSERT INTO e2ee_key_backups(user_id,version,mode,kdf,salt,wrapped_secret,identity_key,wrapped_identity,backup_public_key,backup_key_signature,wrapped_backup_key,updated_at) VALUES($1,1,'password',$2,'salt','sealed-secret','identity-test-key','sealed-identity','backup-key','signature','sealed-backup-key',$3)",
                [id, '{"name":"argon2id","iterations":3}', "2026-10-12 01:02:03.123456"],
            );
            await database.query("INSERT INTO sessions(session_id,user_id,activities,client_info,client_status,status) VALUES('fixture-session',$1,'[]','{}','{}','online')", [id]);
            await database.query("INSERT INTO attachments(id,filename,size,duration_secs) VALUES($1,'fixture.bin',1,$2)", ["9007199254741002", 0.12345678901234566]);
            await database.query("UPDATE messages SET encrypted=$1 WHERE id=$2", [
                '{"fixture":"opaque ciphertext","nonce":"sealed","integer":9007199254740993}',
                "9007199254741001",
            ]);
            for (let index = 0; index < 405; index++)
                await database.query("INSERT INTO guild_entity_deletes(guild_id,entity_type,entity_id,version) VALUES($1,0,$2,$3)", [guild.id, id, index]);
            await database.query("INSERT INTO config(key,value) VALUES($1,$2)", ["transfer-test", '{"integer":9007199254740993,"nested":{"z":true,"a":null}}']);
            await database.query("INSERT INTO storage_runtime_objects(namespace,path,principal,category,budget_principal,bytes) VALUES($1,$2,$3,$4,$5,$6)", [
                "fixture",
                "fixture.bin",
                id,
                "attachment",
                id,
                "9007199254740993",
            ]);
            for (let index = 0; index < 405; index++)
                await database.query("INSERT INTO rate_limits(id,executor_id,hits,blocked,expires_at) VALUES($1,$2,$3,$4,$5)", [
                    `transfer-${index}`,
                    id,
                    index,
                    index % 2 === 0,
                    "2026-10-12 01:02:03.123456",
                ]);
        } finally {
            await closeDatabase();
        }
    });
} else {
    test("transfer CLI validates its inputs without exposing credentials", async () => {
        const { transferArguments } = await import("../ops/database-transfer.mjs");
        assert.equal(transferArguments(["--help"]), null);
        assert.throws(() => transferArguments(["FROM", "TO"], {}), /Usage/);
        assert.throws(() => transferArguments(["--offline", "postgres://private:secret@localhost/test", "TO"]), /environment variable names/);
        assert.throws(() => transferArguments(["--offline", "FROM", "TO"], { FROM: "sqlite:source.sqlite" }), /Both named/);
        succeeded(run([command, "--help"]));
        const result = transfer("postgres://private:secret@localhost/test", "postgres://other:password@localhost/test");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /different database backends/);
        assert.doesNotMatch(result.stdout + result.stderr, /secret|password/);
    });

    test("database transfers round trip all tables and roll back refused or invalid imports", { skip: !process.env.DATABASE_TEST_ADMIN_URL, timeout: 180_000 }, async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "meowcord-transfer-"));
        const admin = new Client({ connectionString: process.env.DATABASE_TEST_ADMIN_URL });
        const name = `meowcord_transfer_${randomUUID().replaceAll("-", "")}`;
        const url = new URL(process.env.DATABASE_TEST_ADMIN_URL);
        url.pathname = `/${name}`;
        const postgres = url.toString();
        const sqliteFile = path.join(directory, "source.sqlite");
        const sqlite = `sqlite:${sqliteFile}`;
        let client;
        let source;
        await admin.connect();
        try {
            await admin.query(`CREATE DATABASE "${name}"`);
            client = new Client({ connectionString: postgres });
            await client.connect();
            writeFileSync(
                path.join(directory, "config.json"),
                JSON.stringify({
                    general: { serverName: "http://localhost:3001" },
                    api: { endpointPublic: "http://localhost:3001/api/v9" },
                    cdn: { endpointPublic: "http://localhost:3001", endpointPrivate: "http://localhost:3001" },
                    gateway: { endpointPublic: "ws://localhost:3001" },
                }),
            );
            succeeded(run(["test", __filename], { TRANSFER_SEED_CHILD: "1", DATABASE: sqlite, CONFIG_PATH: path.join(directory, "config.json") }));
            source = new Database(sqliteFile, { safeIntegers: true });
            source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            const snapshot = readFileSync(sqliteFile);
            {
                succeeded(transfer(sqlite, postgres));
                const user = (await client.query("SELECT id,rights,pride_badges FROM users WHERE id=$1", [id])).rows[0];
                assert.deepEqual(user, { id, rights: id, pride_badges: ["pride", "transgender"] });
                assert.equal((await client.query("SELECT encrypted_secret FROM e2ee_recovery WHERE user_id=$1", [id])).rows[0].encrypted_secret, "sealed-recovery-secret");
                assert.equal((await client.query("SELECT encrypted FROM messages WHERE id=$1", ["9007199254741001"])).rows[0].encrypted.fixture, "opaque ciphertext");
                assert.equal((await client.query("SELECT bytes FROM storage_runtime_objects")).rows[0].bytes, id);
                assert.equal((await client.query("SELECT created_at::text FROM e2ee_identities")).rows[0].created_at, "2026-10-12 01:02:03.123456+00");
                assert.equal((await client.query("SELECT count(*)::int AS count FROM rate_limits")).rows[0].count, 405);
                assert.deepEqual(readFileSync(sqliteFile), snapshot);
                assert.equal((await client.query("SELECT wrapped_identity FROM e2ee_key_backups")).rows[0].wrapped_identity, "sealed-identity");
                assert.equal((await client.query("SELECT session_id FROM sessions")).rows[0].session_id, "fixture-session");
                assert.equal((await client.query("SELECT duration_secs FROM attachments")).rows[0].duration_secs, 0.12345678901234566);
                assert.match((await client.query("SELECT encrypted::text FROM messages")).rows[0].encrypted, /9007199254740993/);
                const category = (await client.query("INSERT INTO categories(name,localizations,is_primary) VALUES('transfer sequence','{}',false) RETURNING id")).rows[0];
                assert.ok(Number(category.id) > 49);
                await client.query("DELETE FROM categories WHERE id=$1", [category.id]);
                succeeded(run(["-e", 'const d=require("./dist/database/Database.js"); await d.initDatabase(); await d.closeDatabase();'], { DATABASE: postgres }));
            }
            {
                const result = transfer(sqlite, postgres);
                assert.notEqual(result.status, 0);
                assert.match(result.stderr, /empty database/);
                const result2 = transfer(postgres, sqlite);
                assert.notEqual(result2.status, 0);
                assert.match(result2.stderr, /already exists/);
                assert.deepEqual(readFileSync(sqliteFile), snapshot);
            }
            {
                const returnedFile = path.join(directory, "returned.sqlite");
                succeeded(transfer(postgres, `sqlite:${returnedFile}`));
                assert.equal(statSync(returnedFile).mode & 0o777, 0o600);
                const returned = new Database(returnedFile, { readonly: true, safeIntegers: true });
                try {
                    assert.equal(returned.query("SELECT id FROM users").get().id.toString(), id);
                    assert.equal(returned.query("SELECT created_at FROM e2ee_identities").get().created_at, "2026-10-12 01:02:03.123456");
                    assert.equal(returned.query("SELECT encrypted_secret FROM e2ee_recovery").get().encrypted_secret, "sealed-recovery-secret");
                    assert.equal(returned.query("SELECT count(*) AS count FROM rate_limits").get().count, 405n);
                    assert.deepEqual(returned.query("PRAGMA foreign_key_check").all(), []);
                    assert.equal(returned.query("SELECT duration_secs FROM attachments").get().duration_secs, 0.12345678901234566);
                    assert.match(returned.query("SELECT encrypted FROM messages").get().encrypted, /9007199254740993/);
                    assert.equal(
                        returned.query("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger'").get().count,
                        source.query("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger'").get().count,
                    );
                    for (const { name: table } of source.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'migrations'").all()) {
                        const count = (database) => database.query(`SELECT count(*) AS count FROM "${table}"`).get().count;
                        assert.equal(count(returned), count(source), table);
                    }
                } finally {
                    returned.close();
                }
                succeeded(run(["-e", 'const d=require("./dist/database/Database.js"); await d.initDatabase(); await d.closeDatabase();'], { DATABASE: `sqlite:${returnedFile}` }));
            }
            {
                await client.query('ALTER TABLE e2ee_identities DROP CONSTRAINT "FK_e2ee_identity_user_id"');
                await client.query("INSERT INTO e2ee_identities(user_id,public_key,created_at) VALUES(999,'orphan',now())");
                const failedFile = path.join(directory, "failed.sqlite");
                const result = transfer(postgres, `sqlite:${failedFile}`);
                assert.notEqual(result.status, 0);
                assert.match(result.stderr, /foreign key validation/);
                const failed = new Database(failedFile, { readonly: true });
                try {
                    assert.equal(failed.query("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count, 0);
                } finally {
                    failed.close();
                }
                await client.query("DELETE FROM e2ee_identities WHERE user_id=999");
                await client.query('ALTER TABLE e2ee_identities ADD CONSTRAINT "FK_e2ee_identity_user_id" FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE');
            }
            {
                const failedName = `${name}_failed`;
                const failedUrl = new URL(postgres);
                failedUrl.pathname = `/${failedName}`;
                await admin.query(`CREATE DATABASE "${failedName}"`);
                const failed = new Client({ connectionString: failedUrl.toString() });
                await failed.connect();
                try {
                    source.exec("INSERT INTO e2ee_identities(user_id,public_key,created_at) VALUES(999,'orphan','2026-10-12 01:02:03')");
                    const result = transfer(sqlite, failedUrl.toString());
                    assert.notEqual(result.status, 0);
                    assert.match(result.stderr, /Database operation failed/);
                    assert.equal((await failed.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0);
                    source.exec("DELETE FROM e2ee_identities WHERE user_id=999");
                    source.exec("DELETE FROM migrations WHERE name='StickerPackCuration1791950314629'");
                    const outdated = transfer(sqlite, failedUrl.toString());
                    assert.notEqual(outdated.status, 0);
                    assert.match(outdated.stderr, /Source migrations/);
                    assert.equal((await failed.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0);
                } finally {
                    await failed.end();
                    await admin.query(`DROP DATABASE "${failedName}"`);
                }
            }
        } finally {
            source?.close();
            await client?.end();
            await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
            await admin.end();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
