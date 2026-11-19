import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "./helpers.js";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

describe("the command line", () => {
  let dir: string;
  const write = (name: string, content: string) => writeFileSync(join(dir, name), content);
  const dodai = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodai-cli-"));
    write(
      "current.sql",
      sql`
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE legacy (id INTEGER);
      `,
    );
    write("desired.sql", "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);");
  });

  it("fails the check with exit code 2 when diffing two files finds DDL to run", () => {
    const run = dodai("--check", "-f", "desired.sql", "current.sql");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(2);
    expect(run.stdout.trimEnd()).toBe(sql`
      -- dry run --
      BEGIN;
      ALTER TABLE "users" ADD COLUMN email TEXT;
      COMMIT;
      -- Skipped: DROP TABLE "legacy";
    `);
  });

  it("fails an offline diff that Durable Objects would refuse for a foreign key", () => {
    const posts =
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id));";
    write("current.sql", `CREATE TABLE users (id INTEGER PRIMARY KEY); ${posts}`);
    write("desired.sql", `CREATE TABLE users (id INTEGER PRIMARY KEY CHECK (id > 0)); ${posts}`);

    const run = dodai("--check", "-f", "desired.sql", "current.sql");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cannot rebuild table "users" while foreign keys are enforced');
  });

  it("enables drops from a configuration file", () => {
    write("config.yml", "enable_drop: true\n");

    const run = dodai("current.sql", "-f", "desired.sql", "--config", "config.yml");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe(sql`
      -- dry run --
      BEGIN;
      ALTER TABLE "users" ADD COLUMN email TEXT;
      DROP TABLE "legacy";
      COMMIT;
    `);
  });

  it("rejects a configuration that is not a YAML mapping", () => {
    const run = dodai("current.sql", "-f", "desired.sql", "--config-inline", "enable_drop:true");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("configuration must be a YAML mapping");
  });

  it("applies a schema to a database file", () => {
    const run = dodai("db.sqlite", "-f", "desired.sql");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe(sql`
      -- Apply --
      BEGIN;
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      COMMIT;
    `);
  });

  it("modifies nothing when the same schema is applied again", () => {
    expect(dodai("--apply", "db.sqlite", "-f", "desired.sql").status).toBe(0);

    const run = dodai("db.sqlite", "-f", "desired.sql");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe("-- Nothing is modified --");
  });

  it("exports the current schema", () => {
    expect(dodai("db.sqlite", "-f", "desired.sql").status).toBe(0);

    const run = dodai("db.sqlite", "--export");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);");
  });

  describe("verifying past schemas", () => {
    beforeEach(() => {
      write("v1.sql", "CREATE TABLE users (id INTEGER PRIMARY KEY);");
    });

    it("flags a past schema the desired one cannot be applied to", () => {
      write("v2.sql", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
      write(
        "v3.sql",
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL CHECK (name <> ''));",
      );

      const run = dodai("--verify", "-f", "v3.sql", "v1.sql", "v2.sql");

      expect(run.stderr).toBe("");
      expect(run.status).toBe(1);
      expect(run.stdout.trimEnd()).toBe(sql`
        FAIL v1.sql: nothing fills NOT NULL column(s) users.name when the table has rows
        ok v2.sql
      `);
    });

    it("passes when every past schema converges", () => {
      write(
        "v2.sql",
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');",
      );
      write(
        "v3.sql",
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '' CHECK (name <> 'root'));",
      );

      const run = dodai("--verify", "-f", "v3.sql", "v1.sql", "v2.sql");

      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout.trimEnd()).toBe(sql`
        ok v1.sql
        ok v2.sql
      `);
    });
  });
});
