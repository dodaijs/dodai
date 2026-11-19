import {
  addObject,
  emptySchema,
  parseSchema,
  parseStatement,
  splitStatements,
  type Schema,
} from "./parse.js";
import { plan, REBUILD_PREFIX, type Plan, type PlanOptions } from "./plan.js";
import { quoteIdent, tokenize } from "./tokenize.js";

export type Row = Record<string, unknown>;

export interface Driver {
  query(sql: string): Row[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  foreignKeys(): boolean;
}

/** The subset of `DurableObjectStorage` dodai needs. */
export interface DurableObjectStorageLike {
  sql: { exec(query: string): { toArray(): Row[] } };
  transactionSync<T>(fn: () => T): T;
}

/** The subset of `node:sqlite`'s `DatabaseSync` dodai needs. */
export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}

export interface Options extends Omit<PlanOptions, "foreignKeys"> {
  /** Compute the DDL without running it. */
  dryRun?: boolean;
  /**
   * Refuse to rebuild a table holding more rows than this. A rebuild copies
   * the table inside `blockConcurrencyWhile`, which a large table can outlast.
   */
  maxRebuildRows?: number;
}

export type Result = Plan;

export function durableObjectDriver(storage: DurableObjectStorageLike): Driver {
  return {
    query: (sql) => storage.sql.exec(sql).toArray(),
    exec: (sql) => void storage.sql.exec(sql),
    transaction: (fn) => storage.transactionSync(fn),
    // Durable Objects enforce foreign keys and do not let them be turned off.
    foreignKeys: () => true,
  };
}

export function nodeSqliteDriver(db: DatabaseSyncLike): Driver {
  return {
    query: (sql) => db.prepare(sql).all() as Row[],
    exec: (sql) => db.exec(sql),
    transaction(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    foreignKeys: () => (db.prepare("PRAGMA foreign_keys").all()[0] as Row).foreign_keys === 1,
  };
}

const parsed = new Map<string, Schema>();

function parseDesired(sql: string): Schema {
  let schema = parsed.get(sql);
  if (!schema) {
    schema = parseSchema(sql);
    parsed.set(sql, schema);
  }
  return schema;
}

/**
 * Converge the database to `desired`, the full schema as CREATE statements,
 * in one transaction. Pass a Durable Object's `ctx.storage` or a {@link Driver}.
 */
export function dodai(
  target: DurableObjectStorageLike | Driver,
  desired: string,
  options: Options = {},
): Result {
  const driver = "transactionSync" in target ? durableObjectDriver(target) : target;
  const desiredSchema = parseDesired(desired);
  return driver.transaction(() => {
    const result = plan(readSchema(driver), desiredSchema, {
      ...options,
      foreignKeys: driver.foreignKeys(),
    });
    if (options.maxRebuildRows !== undefined) {
      for (const table of result.rebuilt) {
        const [row] = driver.query(`SELECT count(*) AS n FROM ${quoteIdent(table)}`);
        const rows = Number(row?.n);
        if (rows > options.maxRebuildRows) {
          throw new Error(
            `rebuilding table "${table}" would copy ${rows} rows, more than maxRebuildRows (${options.maxRebuildRows})`,
          );
        }
      }
    }
    if (!options.dryRun) for (const ddl of result.ddls) driver.exec(ddl);
    return result;
  });
}

/**
 * Diff two schema files without touching a database. Foreign keys are assumed
 * enforced, as Durable Objects always enforce them.
 */
export function diff(current: string, desired: string, options: PlanOptions = {}): Result {
  return plan(parseSchema(current), parseDesired(desired), options);
}

/** The current schema as CREATE statements. */
export function exportSchema(target: DurableObjectStorageLike | Driver): string {
  const driver = "transactionSync" in target ? durableObjectDriver(target) : target;
  return schemaRows(driver)
    .map((row) => `${row.sql};\n`)
    .join("\n");
}

const KIND_ORDER = { table: 0, index: 1, trigger: 2, view: 3 } as Record<string, number>;

function schemaRows(driver: Driver): { type: string; name: string; sql: string }[] {
  const rows = driver.query(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid",
  ) as { type: string; name: string; tbl_name: string; sql: string }[];
  const virtual = rows
    .filter((r) => r.type === "table" && /^\s*create\s+virtual\s/i.test(r.sql))
    .map((r) => r.name.toLowerCase());
  // SQLite and Cloudflare keep their own bookkeeping tables in the same
  // database; virtual tables and their shadow tables are left alone.
  const internal = (name: string) => {
    const key = name.toLowerCase();
    return (
      key.startsWith("sqlite_") ||
      key.startsWith("_cf_") ||
      key.startsWith(REBUILD_PREFIX) ||
      virtual.some((v) => key === v || key.startsWith(`${v}_`))
    );
  };
  return rows
    .filter((r) => !internal(r.name) && !internal(r.tbl_name))
    .sort((a, b) => KIND_ORDER[a.type]! - KIND_ORDER[b.type]!);
}

function readSchema(driver: Driver): Schema {
  const schema = emptySchema();
  for (const row of schemaRows(driver)) {
    for (const statement of splitStatements(tokenize(row.sql))) {
      addObject(schema, parseStatement(row.sql, statement));
    }
  }
  return schema;
}
