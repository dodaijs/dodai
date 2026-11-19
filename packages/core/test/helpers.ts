import { DatabaseSync } from "node:sqlite";
import { dodai, nodeSqliteDriver, type Options, type Result } from "../src/index.js";

/** Template tag that strips the common indentation and the surrounding blank lines. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = String.raw({ raw: strings }, ...values).replace(/^\n+|\s+$/g, "");
  const indent = Math.min(
    ...text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.match(/^ */)![0].length),
  );
  return text
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

export function database(...statements: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const statement of statements) db.exec(statement);
  return db;
}

export function converge(
  db: DatabaseSync,
  desired: string,
  options: Options = {},
): { result?: Result; error?: unknown } {
  try {
    return { result: dodai(nodeSqliteDriver(db), desired, options) };
  } catch (error) {
    return { error };
  }
}

/** DDL as the CLI prints it, one statement per line. */
export const ddl = (ddls: string[]) => ddls.map((d) => `${d};`).join("\n");

export const rows = (db: DatabaseSync, query: string) => db.prepare(query).all();
