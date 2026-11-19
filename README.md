# dodai

Declarative schema management for
[Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) SQLite storage.

Keep only the latest schema in git. Every Durable Object compares its own SQLite
schema with it when it starts and runs the DDL that closes the gap — no numbered
migration files, and objects that have slept through several deploys catch up in
one step.

_dodai_ (土台) is Japanese for "foundation", and stands for
**D**urable **O**bjects **D**esired-state **A**pplied **I**dempotently.

> [!NOTE]
> dodai is pre-1.0. Minor versions may change its API or the DDL it plans;
> read the changelog before upgrading.

## Packages

| Package                          | What it is for                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------- |
| [`@dodaijs/core`](packages/core) | Converging a Durable Object's storage, row types and validators. No dependencies. |
| [`@dodaijs/cli`](packages/cli)   | The `dodai` command: diffs, CI checks, verifying past schemas, row types.         |
| [`@dodaijs/vite`](packages/vite) | Importing `.sql` schemas in Vite, checking them at build time, row types.         |

```sh
npm install @dodaijs/core
npm install -D @dodaijs/cli   # or @dodaijs/vite, or both
```

## Durable Objects

```ts
import { DurableObject } from "cloudflare:workers";
import { dodai } from "@dodaijs/core";

const SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT
  );
  CREATE INDEX users_by_email ON users (email);
`;

export class UserDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      dodai(ctx.storage, SCHEMA);
    });
  }
}
```

`dodai()` reads `sqlite_master`, plans the DDL and runs it in one
`transactionSync`, so a failed change leaves the storage as it was. The parsed
desired schema is cached per isolate; an unchanged object costs one
`sqlite_master` read.

It returns `{ ddls, skipped, rebuilt, unfilled }`: the DDL, the destructive DDL
left out, the tables rebuilt, and NOT NULL columns a rebuild had nothing to fill
with. Options:

| Option           | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `enableDrop`     | Run destructive DDL (DROP TABLE / COLUMN / INDEX / TRIGGER / VIEW) instead of skipping it |
| `targetTables`   | `RegExp[]` — only manage matching tables                                                  |
| `skipTables`     | `RegExp[]` — leave matching tables alone                                                  |
| `skipViews`      | `RegExp[]` — leave matching views alone                                                   |
| `dryRun`         | Plan without running anything                                                             |
| `maxRebuildRows` | Refuse to rebuild a table holding more rows than this                                     |

`diff(currentSql, desiredSql, options)` plans between two schema strings without
a database, and `render(result)` formats a result for printing.

## Deploys and rollbacks

> [!WARNING]
> dodai converges every object to the schema **the running code carries**. It
> keeps no record of the newest schema an object has seen, so when older code
> starts an object that newer code already migrated, dodai migrates it back.

What rolling back does to such an object:

| The newer schema…                                             | Rolling back to the older one                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| added a column, table or index                                | It stays, and its DROP is reported in `skipped`. With `enableDrop`, it is **dropped along with its data**.                                                                                            |
| relaxed a constraint (a wider `CHECK`, a dropped `NOT NULL`…) | The table is rebuilt to the old constraint. If rows use what only the newer schema allows, the rebuild fails and rolls back, and the object throws on every start until newer code is deployed again. |
| renamed a table or column                                     | The old code has no `@renamed` pointing back, so the old name is created again, empty, while the data stays under the new name.                                                                       |

So:

- Make each change safe for the code before it: add first, start using it in a
  later deploy, and treat a deploy that changes the schema as roll-forward only.
- Keep `enableDrop` off in production, or turn it on only for the deploy that
  removes something, once no older code can run again.
- During a gradual deployment, old and new versions run side by side and an
  object can be served by either. The same rules apply.

## Keeping the schema in a `.sql` file

A `.sql` file gives reviewers plain DDL, lets CI read the schema's history, and
is what the CLI and the Vite plugin work with.

**With Vite** (for example through `@cloudflare/vite-plugin`):

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { dodai } from "@dodaijs/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [dodai({ types: { standardSchema: true } }), cloudflare()],
});
```

```ts
/// <reference types="@dodaijs/vite/client" />
import SCHEMA from "./schema.sql";
```

The plugin imports the file as its SQL text, fails the build when dodai cannot
read the schema, and writes its row types to `schema.gen.ts` beside it whenever
they change (`types: false` turns that off). Queried imports such as `?raw` are
left to Vite.

**With Wrangler alone**, import it as text and generate the types with the CLI:

```jsonc
// wrangler.jsonc
"rules": [{ "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }]
```

```ts
declare module "*.sql" {
  const sql: string;
  export default sql;
}
```

## CLI

`@dodaijs/cli` provides the `dodai` command, which works on SQLite files
through `node:sqlite`:

```sh
dodai current.sql < desired.sql            # offline diff, never applies
dodai --check -f desired.sql current.sql   # exit 2 when DDL would run (CI gate)
dodai db.sqlite --dry-run < desired.sql
dodai db.sqlite --apply < desired.sql
dodai db.sqlite --export
dodai db.sqlite --enable-drop --config dodai.yml --config-inline 'skip_tables: backup_.*' < desired.sql
```

Config keys: `enable_drop`, `target_tables`, `skip_tables`, `skip_views`
(patterns one per line, matched against the whole name) and `max_rebuild_rows`.

A useful CI check is to diff the schema on the default branch with the one in a
pull request and post the output, so reviewers see the DDL production will run:

```sh
git show origin/main:src/schema.sql > /tmp/current.sql
npx dodai /tmp/current.sql < src/schema.sql
```

### Verifying every past schema converges

A Durable Object can wake up on any schema it was ever given and jump straight
to the latest. `--verify` builds each past schema in memory, applies the desired
one and checks it succeeds, leaves no NOT NULL column without a value source,
and converges in one run:

```sh
for c in $(git log --format=%h -- src/schema.sql); do
  git show "$c:src/schema.sql" > "/tmp/schema-$c.sql"
done
npx dodai --verify --enable-drop -f src/schema.sql /tmp/schema-*.sql
```

```
FAIL /tmp/schema-1a2b3c.sql: nothing fills NOT NULL column(s) users.name when the table has rows
ok /tmp/schema-4d5e6f.sql
```

Run it in CI with the options production uses.

### Row types

The schema file can also be the source of your row types, so the columns are
not written twice:

```sh
dodai --types < src/schema.sql > src/schema.gen.ts
dodai --types --standard-schema < src/schema.sql > src/schema.gen.ts
```

With `--standard-schema`, each table gets a validator that implements
[Standard Schema](https://standardschema.dev), so it works anywhere zod,
valibot or ArkType schemas do, without depending on any of them:

```ts
// Generated by dodai from the schema. Do not edit.
import { defineRow, type InferRow } from "@dodaijs/core";

export const DevicesRow = defineRow("devices", {
  id: { type: "integer" },
  platform: { type: "text", values: ["ios", "android"] },
  label: { type: "text", nullable: true },
});
export type DevicesRow = InferRow<typeof DevicesRow>;
```

```ts
const result = DevicesRow["~standard"].validate(row);
if (result.issues) throw new Error(result.issues[0].message);
```

- Column types follow SQLite's
  [affinity rules](https://www.sqlite.org/datatype3.html#determination_of_column_affinity):
  `INT` → integer, `CHAR`/`CLOB`/`TEXT` → string, `BLOB` → `ArrayBuffer` (what
  Durable Objects return), no type → `unknown`, anything else → number.
- A column is nullable unless it is `NOT NULL`, an `INTEGER PRIMARY KEY`, or
  part of a `WITHOUT ROWID` table's primary key. Other primary key columns can
  hold NULL in SQLite, and the types say so.
- `CHECK (col IN ('a', 'b'))`, on the column or the table, narrows the column to
  those values.
- Views are not covered.

`generateTypes(sql, { standardSchema })` does the same from code.

## How changes are applied

| Change                                                    | DDL                                                     |
| --------------------------------------------------------- | ------------------------------------------------------- |
| New table / index / trigger / view                        | `CREATE ...`                                            |
| New column that `ADD COLUMN` accepts                      | `ALTER TABLE ... ADD COLUMN`                            |
| Any other column, constraint or table-option change       | table rebuild: create, copy, drop, rename               |
| Changed index / trigger / view                            | `DROP` + `CREATE`                                       |
| Removed column, table, index, trigger or view             | skipped unless `enableDrop`                             |
| Table, column or index annotated with `@renamed from=old` | `RENAME TO` / `RENAME COLUMN` / index `DROP` + `CREATE` |

Comments, whitespace, keyword case and identifier quoting are not changes.
Column order is ignored, since `ADD COLUMN` can only append.

Rebuilds follow SQLite's [12-step procedure](https://www.sqlite.org/lang_altertable.html#otheralter):
the new shape is created as `__dodai_new_<table>`, the shared columns are copied,
the old table is dropped and the new one renamed. The table's indexes and
triggers are recreated, and every view and trigger is recreated around any
rebuild or rename so none is left pointing at a dropped table. A rebuild that
would lose a column requires `enableDrop`.

### Renames

Annotate a table, column or index with `@renamed from=<old name>` to rename it
instead of dropping it and creating a new one:

```sql
CREATE TABLE users ( -- @renamed from=accounts
  id INTEGER PRIMARY KEY,
  user_name TEXT -- @renamed from=username
);
CREATE INDEX users_by_name ON users (user_name); -- @renamed from=idx_username
```

The annotation is a no-op once the rename has happened, so it can stay until
every object has caught up.

Since a Durable Object can sleep through any number of deploys, there is no
point at which every object is known to have migrated. Keep `@renamed`
annotations until you have touched every object, or for good.

### Changing data

dodai manages the schema and never transforms data: a rebuild only
copies columns that keep their name. How to fill a column that replaces others
depends on which schema an object comes from, which a desired schema alone
cannot say. Do it in application code with expand/contract:

1. **Expand.** Add the new column as nullable and keep the old ones.
2. **Backfill.** Fill it right after dodai runs. The `WHERE` keeps it
   idempotent, so every object, however old, converges on its next start:

   ```ts
   ctx.blockConcurrencyWhile(async () => {
     dodai(ctx.storage, SCHEMA);
     ctx.storage.sql.exec(`
       UPDATE reservations
       SET state = CASE WHEN confirmed = 1 THEN 'confirmed' ELSE 'provisional' END
       WHERE state IS NULL
     `);
   });
   ```

3. **Contract, if ever.** An object can wake up on any old schema, so the old
   columns are the backfill's input for as long as such objects may exist.
   Drop them, and tighten the new column to `NOT NULL`, only once every object
   is known to have run the backfill.

## Limitations

- **Foreign keys.** Durable Objects always enforce foreign keys and
  `PRAGMA foreign_keys` cannot change inside a transaction, so dropping the old
  table in a rebuild would fire `ON DELETE` actions. dodai refuses to rebuild or
  drop a table that any table references.
- **Data transformations** are out of scope; see [Changing data](#changing-data).
- **Rollbacks.** Older code migrates objects back to its schema; see
  [Deploys and rollbacks](#deploys-and-rollbacks).
- **Large tables.** A rebuild copies the table inside `blockConcurrencyWhile`
  and briefly doubles its storage.
- Virtual tables, `TEMP` objects, `CREATE TABLE ... AS SELECT` and attached
  schemas are not supported. Tables named `sqlite_*` or `_cf_*`, and existing
  virtual tables with their shadow tables, are never touched.

## Development

```sh
pnpm install
pnpm test        # every package; core also runs its Durable Object specs in workerd
pnpm typecheck
pnpm lint
```

`packages/core/test/oracle.spec.ts` checks the parser against SQLite itself:
every schema in `packages/core/test/corpus/` must read the same as
`PRAGMA table_xinfo` and `sqlite_master` report, converge, and survive a change
to each table. When dodai misreads a schema, add it to the corpus.

## License

MIT
