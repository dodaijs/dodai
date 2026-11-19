import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateTypes } from "@dodaijs/core";
import type { Plugin } from "vite";

export interface DodaiPluginOptions {
  /** Which imported files are schemas. Defaults to every `.sql` file. */
  include?: RegExp;
  /**
   * Write row types next to each schema, `schema.sql` → `schema.gen.ts`.
   * `{ standardSchema: true }` writes Standard Schema validators instead;
   * `false` writes nothing. Defaults to `true`.
   */
  types?: boolean | { standardSchema?: boolean };
}

const GENERATED = /\.gen\.(?:[cm]?js|[cm]?ts)$/;

/** Imports SQLite schemas as strings, checking them and generating their row types. */
export function dodai(options: DodaiPluginOptions = {}): Plugin {
  const include = options.include ?? /\.sql$/;
  const standardSchema = typeof options.types === "object" && options.types.standardSchema === true;
  const typesPath = (schema: string) => schema.replace(/\.[^./]+$/, ".gen.ts");

  return {
    name: "dodai",
    enforce: "pre",
    // Vite resolves imports in parallel, so code importing `schema.gen` can be
    // reached before `schema.sql` is loaded; write the types before it looks.
    resolveId(source, importer) {
      if (options.types === false || !importer || !GENERATED.test(source)) return null;
      const schema = resolve(dirname(importer), source).replace(GENERATED, ".sql");
      if (!include.test(schema) || !existsSync(schema)) return null;
      try {
        writeIfChanged(
          typesPath(schema),
          generateTypes(readFileSync(schema, "utf8"), { standardSchema }),
        );
      } catch (error) {
        this.error(`${schema}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    },
    load(id) {
      // `?raw` and other queried imports keep Vite's own handling.
      if (id.includes("?") || !include.test(id)) return null;
      const sql = readFileSync(id, "utf8");
      let types: string;
      try {
        types = generateTypes(sql, { standardSchema });
      } catch (error) {
        this.error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (options.types !== false) writeIfChanged(typesPath(id), types);
      return { code: `export default ${JSON.stringify(sql)};`, map: null };
    },
  };
}

// Rewriting an unchanged file would wake every watcher that imports it.
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content);
}
