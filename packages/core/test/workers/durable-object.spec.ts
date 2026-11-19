import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dodai } from "../../src/index.js";

describe("converging a Durable Object's SQLite storage", () => {
  let stub: DurableObjectStub;
  const inObject = <T>(fn: (storage: DurableObjectStorage) => T | Promise<T>) =>
    runInDurableObject(stub, (_, state) => fn(state.storage));
  const query = (sql: string) => inObject((storage) => storage.sql.exec(sql).toArray());

  beforeEach(async () => {
    stub = env.SCHEMA.get(env.SCHEMA.newUniqueId());
    await inObject((storage) => storage.put("greeting", "hello"));
  });

  it("rebuilds a table whose CHECK changes, keeping its rows and the key-value storage", async () => {
    await inObject((storage) => {
      storage.sql.exec(`
        CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK (platform IN ('ios','android')));
        CREATE INDEX devices_by_platform ON devices (platform);
        INSERT INTO devices (id, platform) VALUES ('d1', 'ios');
      `);
    });
    const desired = `
      CREATE TABLE devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK (platform IN ('ios','android','web')), label TEXT);
      CREATE INDEX devices_by_platform ON devices (platform);
    `;

    const result = await inObject((storage) => dodai(storage, desired, { enableDrop: true }));

    expect(result.ddls).toContain('DROP TABLE "devices"');
    expect(await query("SELECT id, platform, label FROM devices")).toEqual([
      { id: "d1", platform: "ios", label: null },
    ]);
    expect(await inObject((storage) => storage.get("greeting"))).toBe("hello");
    expect(await inObject((storage) => dodai(storage, desired, { enableDrop: true }).ddls)).toEqual(
      [],
    );
  });

  it("leaves the storage untouched when a rebuild fails", async () => {
    await inObject((storage) => {
      storage.sql.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        INSERT INTO users (id) VALUES (1);
      `);
    });

    const error = await inObject((storage) => {
      try {
        dodai(storage, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)", {
          enableDrop: true,
        });
      } catch (e) {
        return String(e);
      }
      return undefined;
    });

    expect(error).toContain("NOT NULL constraint failed");
    expect(await query("SELECT sql FROM sqlite_master WHERE name = 'users'")).toEqual([
      { sql: "CREATE TABLE users (id INTEGER PRIMARY KEY)" },
    ]);
  });
});
