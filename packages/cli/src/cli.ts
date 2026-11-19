#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  diff,
  dodai,
  exportSchema,
  generateTypes,
  nodeSqliteDriver,
  render,
  type Options,
} from "@dodaijs/core";

const USAGE = `Usage:
  dodai [OPTION]... DB_FILE --export
  dodai [OPTION]... DB_FILE --apply < desired.sql
  dodai [OPTION]... DB_FILE --dry-run < desired.sql
  dodai [OPTION]... current.sql < desired.sql
  dodai [OPTION]... --verify past.sql... < desired.sql
  dodai [OPTION]... --types [--standard-schema] < desired.sql

Application Options:
  -f, --file=FILENAME         Read desired SQL from the file, rather than stdin (default: -)
      --dry-run               Don't run DDLs but just show them
      --check                 Like --dry-run, but exit with code 2 when DDL would be applied
      --apply                 Apply DDLs to the database (default)
      --export                Just dump the current schema to stdout
      --verify                Check that every given past schema converges to the desired one
      --types                 Print a TypeScript row type for every table
      --standard-schema       With --types, print Standard Schema validators and infer the row types from them
      --enable-drop           Enable destructive changes such as DROP for TABLE, COLUMN, INDEX, TRIGGER, VIEW
      --config=PATH           YAML configuration file (can be specified multiple times)
      --config-inline=YAML    YAML configuration as inline string (can be specified multiple times)
      --help                  Show this help
      --version               Show version information
`;

interface Config {
  enable_drop?: boolean;
  target_tables?: string | string[];
  skip_tables?: string | string[];
  skip_views?: string | string[];
  max_rebuild_rows?: number;
}

function patterns(value: string | string[] | undefined): RegExp[] | undefined {
  if (value === undefined) return undefined;
  const lines = Array.isArray(value) ? value : value.split("\n");
  return lines
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^(?:${p})$`));
}

function parseConfig(yaml: string): Config {
  const config: unknown = parseYaml(yaml) ?? {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`configuration must be a YAML mapping: ${yaml}`);
  }
  return config as Config;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f", default: "-" },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
      apply: { type: "boolean" },
      export: { type: "boolean" },
      verify: { type: "boolean" },
      types: { type: "boolean" },
      "standard-schema": { type: "boolean" },
      "enable-drop": { type: "boolean" },
      config: { type: "string", multiple: true },
      "config-inline": { type: "string", multiple: true },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const readDesired = () => readFileSync(values.file === "-" ? 0 : values.file!, "utf8");
  if (values.types) {
    process.stdout.write(
      generateTypes(readDesired(), { standardSchema: values["standard-schema"] }),
    );
    return 0;
  }
  const [target] = positionals;
  if (target === undefined || (positionals.length !== 1 && !values.verify)) {
    process.stderr.write(USAGE);
    return 1;
  }

  const config: Config = Object.assign(
    {},
    ...(values.config ?? []).map((path) => parseConfig(readFileSync(path, "utf8"))),
    ...(values["config-inline"] ?? []).map(parseConfig),
  );
  const dryRun = Boolean(values["dry-run"] || values.check);
  const options: Options = {
    enableDrop: Boolean(values["enable-drop"] || config.enable_drop),
    targetTables: patterns(config.target_tables),
    skipTables: patterns(config.skip_tables),
    skipViews: patterns(config.skip_views),
    maxRebuildRows: config.max_rebuild_rows,
    dryRun,
  };
  if (values.verify) {
    const desired = readDesired();
    let failed = false;
    for (const path of positionals) {
      const problem = verify(readFileSync(path, "utf8"), desired, options);
      failed ||= problem !== undefined;
      process.stdout.write(problem === undefined ? `ok ${path}\n` : `FAIL ${path}: ${problem}\n`);
    }
    return failed ? 1 : 0;
  }
  if (target.endsWith(".sql")) {
    const result = diff(readFileSync(target, "utf8"), readDesired(), options);
    process.stdout.write(render(result, { dryRun: true }));
    return values.check && result.ddls.length > 0 ? 2 : 0;
  }
  const db = new DatabaseSync(target);
  try {
    if (values.export) {
      process.stdout.write(exportSchema(nodeSqliteDriver(db)));
      return 0;
    }
    const result = dodai(nodeSqliteDriver(db), readDesired(), options);
    process.stdout.write(render(result, { dryRun }));
    return values.check && result.ddls.length > 0 ? 2 : 0;
  } finally {
    db.close();
  }
}

// A past schema converges when applying the desired one succeeds, leaves no
// NOT NULL column without a value source, and a second run finds nothing to do.
function verify(past: string, desired: string, options: Options): string | undefined {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(past);
    const driver = nodeSqliteDriver(db);
    const first = dodai(driver, desired, { ...options, dryRun: false });
    if (first.unfilled.length > 0) {
      return `nothing fills NOT NULL column(s) ${first.unfilled.join(", ")} when the table has rows`;
    }
    const second = dodai(driver, desired, { ...options, dryRun: false });
    if (second.ddls.length > 0)
      return `not converged, a second run would apply ${second.ddls.join("; ")}`;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    db.close();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
