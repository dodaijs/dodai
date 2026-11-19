import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateTypes } from "@dodaijs/core";
import { build } from "vite";
import { beforeEach, describe, expect, it } from "vitest";
import { dodai, type DodaiPluginOptions } from "../src/index.js";

const SCHEMA = `CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android'))
);
`;

describe("the dodai Vite plugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodai-vite-"));
    writeFileSync(join(dir, "schema.sql"), SCHEMA);
    writeFileSync(
      join(dir, "entry.ts"),
      'import schema from "./schema.sql";\nexport default schema;\n',
    );
  });

  const bundle = (options?: DodaiPluginOptions) =>
    build({
      root: dir,
      logLevel: "silent",
      configFile: false,
      plugins: [dodai(options)],
      build: {
        outDir: join(dir, "dist"),
        lib: { entry: join(dir, "entry.ts"), formats: ["es"], fileName: () => "entry.mjs" },
      },
    });

  it("imports a schema as its SQL text", async () => {
    await bundle();

    const { default: schema } = await import(pathToFileURL(join(dir, "dist/entry.mjs")).href);
    expect(schema).toBe(SCHEMA);
  });

  it("writes the schema's row types next to it", async () => {
    await bundle();

    expect(readFileSync(join(dir, "schema.gen.ts"), "utf8")).toBe(generateTypes(SCHEMA));
  });

  it("writes Standard Schema validators when asked", async () => {
    await bundle({ types: { standardSchema: true } });

    expect(readFileSync(join(dir, "schema.gen.ts"), "utf8")).toBe(
      generateTypes(SCHEMA, { standardSchema: true }),
    );
  });

  it("writes no types when turned off", async () => {
    await bundle({ types: false });

    expect(existsSync(join(dir, "schema.gen.ts"))).toBe(false);
  });

  it("leaves unchanged row types untouched so watchers stay quiet", async () => {
    await bundle();
    const written = statSync(join(dir, "schema.gen.ts")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await bundle();

    expect(statSync(join(dir, "schema.gen.ts")).mtimeMs).toBe(written);
  });

  it("leaves queried imports such as ?raw to Vite", async () => {
    writeFileSync(
      join(dir, "entry.ts"),
      'import schema from "./schema.sql?raw";\nexport default schema;\n',
    );

    await bundle({ include: /\.sql/ });

    const { default: schema } = await import(pathToFileURL(join(dir, "dist/entry.mjs")).href);
    expect(schema).toBe(SCHEMA);
    expect(existsSync(join(dir, "schema.gen.ts"))).toBe(false);
  });

  it("generates the validators first when code imports them before they exist", async () => {
    // Inside the package, so the generated `import "@dodaijs/core"` resolves.
    dir = mkdtempSync(join(import.meta.dirname, ".generated-"));
    writeFileSync(join(dir, "schema.sql"), SCHEMA);
    writeFileSync(
      join(dir, "entry.ts"),
      'import { DevicesRow } from "./schema.gen.js";\nexport default DevicesRow.table;\n',
    );

    try {
      await bundle({ types: { standardSchema: true } });

      const { default: table } = await import(pathToFileURL(join(dir, "dist/entry.mjs")).href);
      expect(table).toBe("devices");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("fails the build on a schema dodai cannot read", async () => {
    writeFileSync(join(dir, "schema.sql"), "CREATE VIRTUAL TABLE docs USING fts5 (body);");

    await expect(bundle()).rejects.toThrow(/schema\.sql: virtual tables are not supported/);
  });
});
