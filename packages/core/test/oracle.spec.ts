import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dodai, nodeSqliteDriver } from "../src/index.js";
import { parseSchema, type Table } from "../src/parse.js";
import { tokenize } from "../src/tokenize.js";
import { declaredType, hasNotNull, primaryKeyColumns } from "../src/types.js";
import { converge, database, rows } from "./helpers.js";

// SQLite itself is the reference: every schema in the corpus must read the
// way SQLite reports it and survive changes to each of its tables.
const corpusDir = new URL("corpus/", import.meta.url).pathname;
const corpus = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".sql"))
  .map((file) => ({ file, sql: readFileSync(join(corpusDir, file), "utf8") }));

interface XInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  hidden: number;
}

const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();

// Inserts `addition` just before the table's closing parenthesis.
function withItem(table: Table, addition: string): string {
  let depth = 0;
  for (const t of tokenize(table.text)) {
    if (t.text === "(") depth++;
    if (t.text === ")" && --depth === 0) {
      return `${table.text.slice(0, t.start)}, ${addition}${table.text.slice(t.start)}`;
    }
  }
  throw new Error(`no closing parenthesis in ${table.name}`);
}

describe.each(corpus)("the corpus schema $file", ({ file, sql }) => {
  it("reads every table's columns the way PRAGMA table_xinfo reports them", () => {
    const db = database(sql);
    for (const table of parseSchema(sql).tables.values()) {
      const pk = primaryKeyColumns(table);
      const parsed = table.columns.map((c) => ({
        name: c.key,
        type: compact(declaredType(c)),
        // SQLite reports a WITHOUT ROWID primary key as NOT NULL too.
        notnull: hasNotNull(c.def) || (table.options.includes("rowid") && pk.includes(c.key)),
        pk: pk.includes(c.key),
        generated: c.generated,
      }));
      const info = rows(
        db,
        `SELECT * FROM pragma_table_xinfo('${table.name.replaceAll("'", "''")}')`,
      );
      const actual = (info as unknown as XInfo[]).map((i) => ({
        name: i.name.toLowerCase(),
        type: compact(i.type),
        notnull: i.notnull === 1,
        pk: i.pk > 0,
        generated: i.hidden === 2 || i.hidden === 3,
      }));
      expect(parsed, table.name).toEqual(actual);
    }
  });

  it("attaches every index and trigger to the table sqlite_master names", () => {
    const schema = parseSchema(sql);
    const attached = rows(
      database(sql),
      "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL",
    ) as { type: "index" | "trigger"; name: string; tbl_name: string }[];
    for (const row of attached) {
      const map = row.type === "index" ? schema.indexes : schema.triggers;
      expect(map.get(row.name.toLowerCase())?.table, row.name).toBe(row.tbl_name.toLowerCase());
    }
  });

  it("converges on an empty database and stays converged", () => {
    const db = database();
    expect(converge(db, sql).error).toBeUndefined();
    expect(converge(db, sql).result!.ddls).toEqual([]);
  });

  it("modifies nothing on a database the schema was created on directly", () => {
    expect(converge(database(sql), sql).result!.ddls).toEqual([]);
  });

  it("converges in one run after adding a column to, rebuilding or dropping a column from each table", () => {
    const schema = parseSchema(sql);
    const referenced = new Set([...schema.tables.values()].flatMap((t) => t.references));
    const dependents = [
      ...schema.indexes.values(),
      ...schema.triggers.values(),
      ...schema.views.values(),
    ];
    const failures: string[] = [];
    for (const table of schema.tables.values()) {
      const changes: [string, string, boolean][] = [
        ["add a column", withItem(table, "zz_added TEXT"), false],
        ["rebuild", withItem(table, "CHECK (1)"), referenced.has(table.key)],
      ];
      // Drop a column nothing else in the schema names, so the desired schema
      // stays valid without it.
      const named = (key: string) =>
        dependents.some((d) => d.norm.includes(key)) ||
        table.constraints.some((c) => c.includes(key)) ||
        table.columns.some((c) => c.key !== key && c.def.includes(key));
      const dropped = table.columns.find(
        (c) => !c.generated && !primaryKeyColumns(table).includes(c.key) && !named(c.key),
      );
      if (table.columns.length > 1 && dropped) {
        const without = table.text.replace(`${dropped.text},`, "");
        if (without !== table.text) changes.push(["drop a column", without, false]);
      }
      for (const [change, text, refused] of changes) {
        const desired = sql.replace(table.text, text);
        const db = database(sql);
        const label = `${file}: ${change} on ${table.name}`;
        const { error } = converge(db, desired, { enableDrop: true });
        if (error) {
          if (!(refused && String(error).includes("foreign keys are enforced"))) {
            failures.push(`${label}: ${String(error)}`);
          }
          continue;
        }
        if (refused) failures.push(`${label}: expected a foreign key refusal`);
        const again = converge(db, desired, { enableDrop: true }).result!.ddls;
        if (again.length > 0) failures.push(`${label}: second run ${again.join("; ")}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("adding a column", () => {
  const base = "CREATE TABLE t (id INTEGER PRIMARY KEY)";
  const withColumn = (definition: string) => `${base.slice(0, -1)}, ${definition})`;

  it.each`
    definition                                          | path            | outcome
    ${"x TEXT"}                                         | ${"add column"} | ${"converges"}
    ${"x TEXT NOT NULL DEFAULT ''"}                     | ${"add column"} | ${"converges"}
    ${"x TEXT CONSTRAINT nn NOT NULL DEFAULT 'a'"}      | ${"add column"} | ${"converges"}
    ${"x TEXT COLLATE NOCASE NOT NULL DEFAULT 'a'"}     | ${"add column"} | ${"converges"}
    ${"x INTEGER DEFAULT -1"}                           | ${"add column"} | ${"converges"}
    ${"x TEXT CHECK (x IS NOT NULL OR id > 0)"}         | ${"add column"} | ${"converges"}
    ${"x INTEGER REFERENCES t (id)"}                    | ${"add column"} | ${"converges"}
    ${"x INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL"} | ${"add column"} | ${"converges"}
    ${"\"x y\" TEXT DEFAULT 'a'"}                       | ${"add column"} | ${"converges"}
    ${"x TEXT NOT NULL"}                                | ${"rebuild"}    | ${"fails"}
    ${"x TEXT NOT NULL DEFAULT NULL"}                   | ${"rebuild"}    | ${"fails"}
    ${"x INTEGER DEFAULT (1 + 1)"}                      | ${"rebuild"}    | ${"converges"}
    ${"x TEXT DEFAULT CURRENT_TIMESTAMP"}               | ${"rebuild"}    | ${"converges"}
    ${"x TEXT UNIQUE"}                                  | ${"rebuild"}    | ${"converges"}
    ${"x INTEGER AS (id * 2) STORED"}                   | ${"rebuild"}    | ${"converges"}
  `(
    "$definition takes the $path path exactly when SQLite's own ADD COLUMN agrees, and $outcome",
    ({ definition, path, outcome }: { definition: string; path: string; outcome: string }) => {
      const desired = withColumn(definition);

      const plan = dodai(nodeSqliteDriver(database(base)), desired, { dryRun: true });
      const chose = plan.ddls.some((d) => d.includes("ADD COLUMN")) ? "add column" : "rebuild";
      let sqliteAccepts = true;
      try {
        database(base, "INSERT INTO t (id) VALUES (1)", `ALTER TABLE t ADD COLUMN ${definition}`);
      } catch {
        sqliteAccepts = false;
      }
      expect(chose).toBe(path);
      expect(sqliteAccepts).toBe(path === "add column");

      const db = database(base, "INSERT INTO t (id) VALUES (1)");
      const { error } = converge(db, desired);
      if (outcome === "fails") {
        expect(String(error)).toContain("NOT NULL constraint failed");
      } else {
        expect(error).toBeUndefined();
        expect(converge(db, desired).result!.ddls).toEqual([]);
      }
    },
  );
});
