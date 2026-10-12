/* SPDX-License-Identifier: AGPL-3.0-only */
import { pathToFileURL } from "node:url";

export function transferArguments(args, environment = process.env) {
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) return null;
    if (args.length !== 3 || args[0] !== "--offline") throw new Error("Usage: bun run db:transfer --offline <source-env-name> <destination-env-name>");
    const names = args.slice(1);
    if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Pass environment variable names, not connection strings");
    const connections = names.map((name) => environment[name]);
    if (connections.some((connection) => !connection)) throw new Error("Both named environment variables must contain database connection strings");
    return connections;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        if (!Bun.semver.satisfies(Bun.version, ">=1.4.0")) throw new Error("Database transfer requires Bun 1.4 or newer");
        const connections = transferArguments(process.argv.slice(2));
        if (!connections)
            console.log(
                "Usage: bun run db:transfer --offline <source-env-name> <destination-env-name>\nStop all instance processes and back up the database first. The destination must be empty; SQLite requires a new file. Connection strings are read from the named environment variables.",
            );
        else {
            process.env.DATABASE = connections[1];
            process.env.DB_SYNC = "false";
            process.env.APPLY_DB_MIGRATIONS = "false";
            const { transferDatabase } = await import("../../dist/database/Transfer.js");
            await transferDatabase(...connections);
        }
    } catch (error) {
        const message =
            error?.driverError || error?.code
                ? "Database operation failed; check connectivity, permissions and source data integrity"
                : error instanceof Error
                  ? error.message
                  : "Unknown error";
        console.error(`Database transfer failed: ${message.replace(/(?:postgres(?:ql)?|sqlite):\S+/g, "[database]")}`);
        process.exitCode = 1;
    }
}
