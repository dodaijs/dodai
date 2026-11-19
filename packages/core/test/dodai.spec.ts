import { describe, expect, it } from "vitest";
import { diff } from "../src/index.js";
import { converge, database, ddl, rows, sql } from "./helpers.js";

describe("converging a SQLite database to a desired schema", () => {
  it("creates every object on an empty database", () => {
    const db = database();
    const desired = sql`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE INDEX users_by_name ON users (name);
    `;

    const { result, error } = converge(db, desired);

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe(desired);
    expect(converge(db, desired).result!.ddls).toEqual([]);
  });

  it("does not count comments, quoting and keyword case as changes", () => {
    const db = database(sql`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE INDEX users_by_name ON users (name);
    `);

    const { result, error } = converge(
      db,
      sql`
        -- The people who sign in.
        create table if not exists "users" (
          id integer primary key, -- rowid alias
          /* shown in the UI */ [name] text not null
        );
        create index if not exists users_by_name on \`users\` (name);
      `,
    );

    expect(error).toBeUndefined();
    expect(result!.ddls).toEqual([]);
  });

  it("adds a nullable column and keeps the rows", () => {
    const db = database(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      "INSERT INTO users (id, name) VALUES (1, 'alice')",
    );
    const desired = sql`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
    `;

    const { result, error } = converge(db, desired);

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe(sql`
      ALTER TABLE "users" ADD COLUMN email TEXT;
      ALTER TABLE "users" ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
    `);
    expect(rows(db, "SELECT id, name, email, active FROM users")).toEqual([
      { id: 1, name: "alice", email: null, active: 1 },
    ]);
    expect(converge(db, desired).result!.ddls).toEqual([]);
  });

  it("rebuilds a table whose CHECK changes, keeping its rows, indexes and triggers", () => {
    const trigger = sql`
      CREATE TRIGGER devices_audit AFTER INSERT ON devices BEGIN
        INSERT INTO audit (id) VALUES (CASE WHEN new.platform = 'ios' THEN 'apple' ELSE new.id END);
      END;
    `;
    const db = database(
      sql`
        CREATE TABLE devices (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL CHECK (platform IN ('ios','android'))
        );
        CREATE INDEX devices_by_platform ON devices (platform);
        CREATE TABLE audit (id TEXT);
      `,
      trigger,
      "INSERT INTO devices (id, platform) VALUES ('d1', 'ios')",
    );
    const desired = [
      sql`
        CREATE TABLE devices (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL CHECK (platform IN ('ios','android','web'))
        );
        CREATE INDEX devices_by_platform ON devices (platform);
        CREATE TABLE audit (id TEXT);
      `,
      trigger,
    ].join("\n");

    const { result, error } = converge(db, desired);

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe(
      [
        sql`
          CREATE TABLE "__dodai_new_devices" (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL CHECK (platform IN ('ios','android','web'))
          );
          INSERT INTO "__dodai_new_devices" ("id", "platform") SELECT "id", "platform" FROM "devices";
          DROP TABLE "devices";
          ALTER TABLE "__dodai_new_devices" RENAME TO "devices";
          CREATE INDEX devices_by_platform ON devices (platform);
        `,
        trigger,
      ].join("\n"),
    );
    expect(rows(db, "SELECT id, platform FROM devices")).toEqual([{ id: "d1", platform: "ios" }]);
    expect(converge(db, desired).result!.ddls).toEqual([]);
  });

  it("leaves the database untouched when a rebuild cannot copy the rows", () => {
    const db = database(
      "CREATE TABLE users (id INTEGER PRIMARY KEY)",
      "INSERT INTO users (id) VALUES (1)",
    );

    const { error } = converge(
      db,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );

    expect(String(error)).toContain("NOT NULL constraint failed");
    expect(rows(db, "SELECT sql FROM sqlite_master WHERE name = 'users'")).toEqual([
      { sql: "CREATE TABLE users (id INTEGER PRIMARY KEY)" },
    ]);
  });

  const withLegacy = sql`
    CREATE TABLE users (id INTEGER PRIMARY KEY, nickname TEXT);
    CREATE INDEX users_by_nickname ON users (nickname);
    CREATE TABLE legacy (id INTEGER);
  `;

  it("skips destructive changes unless drops are enabled", () => {
    const { result, error } = converge(
      database(withLegacy),
      "CREATE TABLE users (id INTEGER PRIMARY KEY)",
    );

    expect(error).toBeUndefined();
    expect(result!.ddls).toEqual([]);
    expect(ddl(result!.skipped)).toBe(sql`
      ALTER TABLE "users" DROP COLUMN "nickname";
      DROP TABLE "legacy";
      DROP INDEX "users_by_nickname";
    `);
  });

  it("runs destructive changes when drops are enabled", () => {
    const db = database(withLegacy);
    const desired = "CREATE TABLE users (id INTEGER PRIMARY KEY)";

    const { result, error } = converge(db, desired, { enableDrop: true });

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe(sql`
      DROP INDEX "users_by_nickname";
      ALTER TABLE "users" DROP COLUMN "nickname";
      DROP TABLE "legacy";
    `);
    expect(converge(db, desired, { enableDrop: true }).result!.ddls).toEqual([]);
  });

  it("refuses a rebuild that would lose a column unless drops are enabled", () => {
    const db = database("CREATE TABLE users (id INTEGER PRIMARY KEY, nickname TEXT, age INTEGER)");

    const { error } = converge(
      db,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0))",
    );

    expect(String(error)).toContain('would drop column(s) "nickname"');
  });

  it("renames tables, columns and indexes annotated with @renamed", () => {
    const db = database(
      sql`
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT);
        CREATE INDEX idx_username ON accounts (username);
      `,
      "INSERT INTO accounts (id, username) VALUES (1, 'alice')",
    );
    const desired = sql`
      CREATE TABLE users ( -- @renamed from=accounts
        id INTEGER PRIMARY KEY,
        user_name TEXT -- @renamed from=username
      );
      CREATE INDEX users_by_user_name ON users (user_name); -- @renamed from=idx_username
    `;

    const { result, error } = converge(db, desired);

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe(sql`
      DROP INDEX "idx_username";
      ALTER TABLE "accounts" RENAME TO "users";
      ALTER TABLE "users" RENAME COLUMN "username" TO "user_name";
      CREATE INDEX users_by_user_name ON users (user_name);
    `);
    expect(rows(db, "SELECT id, user_name FROM users")).toEqual([{ id: 1, user_name: "alice" }]);
    expect(converge(db, desired).result!.ddls).toEqual([]);
  });

  it("recreates views around a table rebuild", () => {
    const db = database(sql`
      CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER);
      CREATE VIEW adults AS SELECT id FROM users WHERE age >= 18;
    `);
    const desired = sql`
      CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0));
      CREATE VIEW adults AS SELECT id FROM users WHERE age >= 18;
    `;

    const { result, error } = converge(db, desired);

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe(sql`
      DROP VIEW "adults";
      CREATE TABLE "__dodai_new_users" (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0));
      INSERT INTO "__dodai_new_users" ("id", "age") SELECT "id", "age" FROM "users";
      DROP TABLE "users";
      ALTER TABLE "__dodai_new_users" RENAME TO "users";
      CREATE VIEW adults AS SELECT id FROM users WHERE age >= 18;
    `);
    expect(converge(db, desired).result!.ddls).toEqual([]);
  });

  it("refuses to rebuild a table other tables reference while foreign keys are enforced", () => {
    const posts =
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE)";
    const db = database("CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)", posts);

    const { error } = converge(
      db,
      `CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0)); ${posts};`,
    );

    expect(String(error)).toContain('cannot rebuild table "users" while foreign keys are enforced');
  });

  it("refuses the same foreign key rebuild when diffing without a database", () => {
    const posts =
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id))";

    expect(() =>
      diff(
        `CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER); ${posts};`,
        `CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0)); ${posts};`,
      ),
    ).toThrow('cannot rebuild table "users" while foreign keys are enforced');
  });

  it("never touches SQLite and Cloudflare bookkeeping tables", () => {
    const seq = "CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT)";
    const db = database("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)", seq);

    const { result, error } = converge(db, seq, { enableDrop: true });

    expect(error).toBeUndefined();
    expect(result!.ddls).toEqual([]);
  });

  it("leaves skipped tables alone", () => {
    const db = database("CREATE TABLE backup_users (id INTEGER)");

    const { result, error } = converge(db, "CREATE TABLE users (id INTEGER PRIMARY KEY);", {
      enableDrop: true,
      skipTables: [/^backup_/],
    });

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe("CREATE TABLE users (id INTEGER PRIMARY KEY);");
  });

  it("refuses a rebuild over the row limit", () => {
    const db = database(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)",
      "INSERT INTO users (id, age) VALUES (1, 20), (2, 30), (3, 40)",
    );

    const { error } = converge(
      db,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0))",
      { maxRebuildRows: 2 },
    );

    expect(String(error)).toContain(
      'rebuilding table "users" would copy 3 rows, more than maxRebuildRows (2)',
    );
    expect(rows(db, "SELECT count(*) AS n FROM users")).toEqual([{ n: 3 }]);
  });
});

describe("rolling back to an older schema", () => {
  it("keeps what the newer schema added when drops are off", () => {
    const db = database(sql`
      CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL, label TEXT);
      CREATE INDEX devices_by_label ON devices (label);
    `);

    const { result, error } = converge(
      db,
      "CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL)",
    );

    expect(error).toBeUndefined();
    expect(result!.ddls).toEqual([]);
    expect(ddl(result!.skipped)).toBe(sql`
      ALTER TABLE "devices" DROP COLUMN "label";
      DROP INDEX "devices_by_label";
    `);
  });

  it("deletes what the newer schema added when drops are enabled", () => {
    const db = database(
      "CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL, label TEXT)",
      "INSERT INTO devices VALUES ('d1', 'ios', 'kitchen')",
    );

    const { result, error } = converge(
      db,
      "CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL)",
      { enableDrop: true },
    );

    expect(error).toBeUndefined();
    expect(ddl(result!.ddls)).toBe('ALTER TABLE "devices" DROP COLUMN "label";');
  });

  it("fails to narrow a widened CHECK while rows use the new values", () => {
    const db = database(
      "CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK (platform IN ('ios','android','web')))",
      "INSERT INTO devices VALUES ('d1', 'web')",
    );

    const { error } = converge(
      db,
      "CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK (platform IN ('ios','android')))",
    );

    expect(String(error)).toContain("CHECK constraint failed");
    expect(rows(db, "SELECT id, platform FROM devices")).toEqual([{ id: "d1", platform: "web" }]);
  });

  it("brings a renamed column's old name back empty", () => {
    const db = database(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, user_name TEXT)",
      "INSERT INTO users VALUES (1, 'alice')",
    );

    const { error } = converge(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)");

    expect(error).toBeUndefined();
    expect(rows(db, "SELECT id, username, user_name FROM users")).toEqual([
      { id: 1, username: null, user_name: "alice" },
    ]);
  });
});
