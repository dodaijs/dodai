import type { Column, Dependent, Schema, Table } from "./parse.js";
import { quoteIdent as q } from "./tokenize.js";

export interface PlanOptions {
  /** Emit destructive DDL (DROP TABLE, DROP COLUMN, DROP INDEX, ...) instead of skipping it. */
  enableDrop?: boolean;
  /** Only manage tables whose name matches one of these. */
  targetTables?: RegExp[];
  /** Ignore tables whose name matches one of these. */
  skipTables?: RegExp[];
  /** Ignore views whose name matches one of these. */
  skipViews?: RegExp[];
  /**
   * Whether foreign keys are enforced while the DDL runs. Durable Objects
   * always enforce them, and `PRAGMA foreign_keys` is a no-op inside a
   * transaction, so a rebuilt or dropped table must not be referenced.
   */
  foreignKeys?: boolean;
}

export interface Plan {
  ddls: string[];
  /** Destructive DDL that was not emitted because enableDrop is off. */
  skipped: string[];
  /** Tables the DDL rebuilds, by their names before it runs. */
  rebuilt: string[];
  /**
   * `table.column` for NOT NULL columns without a default that a rebuild has
   * nothing to fill with; the rebuild fails if the table has rows.
   */
  unfilled: string[];
}

type DependentKind = Dependent["kind"];

export const REBUILD_PREFIX = "__dodai_new_";

export function plan(current: Schema, desired: Schema, options: PlanOptions = {}): Plan {
  const enableDrop = options.enableDrop ?? false;
  current = scope(current, options);
  desired = scope(desired, options);

  const pre: string[] = [];
  const renames: string[] = [];
  const tables: string[] = [];
  const dropTables: string[] = [];
  const skipped: string[] = [];
  const unfilled: string[] = [];

  const cur = new Map(current.tables);
  const curDeps: Record<DependentKind, Map<string, Dependent>> = {
    index: new Map(current.indexes),
    trigger: new Map(current.triggers),
    view: new Map(current.views),
  };
  const rebuilt = new Set<string>();
  const originalNames = new Map<string, string>();
  const dropped = new Set<string>();
  // Renames, rebuilds and drops can leave views and triggers that name the
  // table pointing at nothing, so they are all recreated around such changes.
  let structural = false;

  const renameInDependents = (table: string | undefined, from: string, to: string) => {
    for (const map of Object.values(curDeps)) {
      for (const [key, dep] of map) {
        if (table !== undefined && dep.table !== table) continue;
        map.set(key, {
          ...dep,
          table: dep.table === from && table === undefined ? to : dep.table,
          norm: subst(dep.norm, from, to),
        });
      }
    }
  };

  for (const d of desired.tables.values()) {
    if (!d.renamedFrom || cur.has(d.key)) continue;
    const from = d.renamedFrom.toLowerCase();
    const old = cur.get(from);
    if (!old) continue;
    renames.push(`ALTER TABLE ${q(old.name)} RENAME TO ${q(d.name)}`);
    originalNames.set(d.key, old.name);
    cur.delete(from);
    cur.set(d.key, {
      ...old,
      name: d.name,
      key: d.key,
      columns: old.columns.map((c) => ({ ...c, def: subst(c.def, from, d.key) })),
      constraints: old.constraints.map((c) => subst(c, from, d.key)),
      references: subst(old.references, from, d.key),
    });
    for (const [key, t] of cur)
      cur.set(key, { ...t, references: subst(t.references, from, d.key) });
    renameInDependents(undefined, from, d.key);
    structural = true;
  }

  for (const d of desired.tables.values()) {
    const c = cur.get(d.key);
    if (!c) {
      tables.push(d.text);
      continue;
    }
    let columns = c.columns;
    let constraints = c.constraints;
    for (const dc of d.columns) {
      if (!dc.renamedFrom || columns.some((x) => x.key === dc.key)) continue;
      const from = dc.renamedFrom.toLowerCase();
      const old = columns.find((x) => x.key === from);
      if (!old) continue;
      renames.push(`ALTER TABLE ${q(d.name)} RENAME COLUMN ${q(old.name)} TO ${q(dc.name)}`);
      columns = columns.map((x) => ({
        ...x,
        ...(x === old ? { name: dc.name, key: dc.key } : {}),
        def: subst(x.def, from, dc.key),
      }));
      constraints = constraints.map((x) => subst(x, from, dc.key));
      renameInDependents(d.key, from, dc.key);
      structural = true;
    }

    const curCols = new Map(columns.map((x) => [x.key, x]));
    const desiredKeys = new Set(d.columns.map((x) => x.key));
    const added = d.columns.filter((x) => !curCols.has(x.key));
    const removed = columns.filter((x) => !desiredKeys.has(x.key));
    const changed =
      d.columns.some((x) => {
        const y = curCols.get(x.key);
        return y !== undefined && !same(x.def, y.def);
      }) ||
      !sameSet(d.constraints, constraints) ||
      !same(d.options, c.options);
    const needsRebuild =
      changed ||
      added.some((x) => !addable(x)) ||
      (enableDrop && removed.some((x) => !droppable(x, constraints)));

    if (needsRebuild) {
      if (removed.length > 0 && !enableDrop) {
        throw new Error(
          `table "${d.name}" must be rebuilt, which would drop column(s) ${removed
            .map((x) => `"${x.name}"`)
            .join(", ")}; enable drop to allow it`,
        );
      }
      tables.push(...rebuild(d, curCols, unfilled));
      rebuilt.add(d.key);
      structural = true;
      continue;
    }
    for (const x of added) tables.push(`ALTER TABLE ${q(d.name)} ADD COLUMN ${x.text}`);
    for (const x of removed) {
      const ddl = `ALTER TABLE ${q(d.name)} DROP COLUMN ${q(x.name)}`;
      if (enableDrop) {
        tables.push(ddl);
        structural = true;
      } else {
        skipped.push(ddl);
      }
    }
  }

  for (const c of cur.values()) {
    if (desired.tables.has(c.key)) continue;
    const ddl = `DROP TABLE ${q(c.name)}`;
    if (enableDrop) {
      dropTables.push(ddl);
      dropped.add(c.key);
      structural = true;
    } else {
      skipped.push(ddl);
    }
  }

  if (options.foreignKeys ?? true) {
    for (const t of [...cur.values(), ...desired.tables.values()]) {
      const ref = t.references.find((r) => rebuilt.has(r) || dropped.has(r));
      if (ref === undefined) continue;
      throw new Error(
        `cannot ${rebuilt.has(ref) ? "rebuild" : "drop"} table "${ref}" while foreign keys are enforced: "${t.name}" references it`,
      );
    }
  }

  const gone = (dep: Dependent) =>
    dep.table !== undefined && (rebuilt.has(dep.table) || dropped.has(dep.table));
  const drop = (dep: Dependent) => `DROP ${dep.kind.toUpperCase()} ${q(dep.name)}`;
  const desiredDeps: Record<DependentKind, Map<string, Dependent>> = {
    index: desired.indexes,
    trigger: desired.triggers,
    view: desired.views,
  };
  const created: Record<DependentKind, string[]> = { index: [], trigger: [], view: [] };
  for (const kind of ["index", "trigger", "view"] as const) {
    const post = created[kind];
    const currentMap = curDeps[kind];
    const desiredMap = desiredDeps[kind];
    const force = kind !== "index" && structural;
    const create = new Set<string>();
    const preserve: Dependent[] = [];
    const replaced = new Set<string>();

    for (const d of desiredMap.values()) {
      if (!d.renamedFrom || currentMap.has(d.key)) continue;
      const old = currentMap.get(d.renamedFrom.toLowerCase());
      if (!old) continue;
      if (!gone(old)) pre.push(drop(old));
      replaced.add(old.key);
    }
    for (const c of currentMap.values()) {
      if (replaced.has(c.key)) continue;
      const d = desiredMap.get(c.key);
      if (d) {
        if (same(d.norm, c.norm) && !gone(c) && !force) continue;
        if (!gone(c)) pre.push(drop(c));
        create.add(d.key);
      } else if (enableDrop) {
        if (!gone(c)) pre.push(drop(c));
      } else {
        skipped.push(drop(c));
        if (gone(c) || force) {
          if (!gone(c)) pre.push(drop(c));
          preserve.push(c);
        }
      }
    }
    for (const d of desiredMap.values()) {
      if (create.has(d.key) || !currentMap.has(d.key)) post.push(d.text);
    }
    post.push(...preserve.map((c) => c.text));
  }

  return {
    // INSTEAD OF triggers name views, so views exist before triggers are created.
    ddls: [
      ...pre,
      ...renames,
      ...tables,
      ...dropTables,
      ...created.index,
      ...created.view,
      ...created.trigger,
    ],
    skipped,
    rebuilt: [...desired.tables.values()]
      .filter((t) => rebuilt.has(t.key))
      .map((t) => originalNames.get(t.key) ?? t.name),
    unfilled,
  };
}

// SQLite's 12-step ALTER TABLE: build the new shape beside the old one, copy
// the surviving columns across, then swap names.
function rebuild(d: Table, current: Map<string, Column>, unfilled: string[]): string[] {
  const tmp = q(REBUILD_PREFIX + d.name);
  const copied: string[] = [];
  for (const x of d.columns) {
    if (x.generated) continue;
    const old = current.get(x.key);
    if (!old) {
      if (requiresValue(x)) unfilled.push(`${d.name}.${x.name}`);
      continue;
    }
    if (!old.generated) copied.push(q(x.name));
  }
  const columns = copied.join(", ");
  return [
    d.textWithName(tmp),
    ...(columns ? [`INSERT INTO ${tmp} (${columns}) SELECT ${columns} FROM ${q(d.name)}`] : []),
    `DROP TABLE ${q(d.name)}`,
    `ALTER TABLE ${tmp} RENAME TO ${q(d.name)}`,
  ];
}

function requiresValue(column: Column): boolean {
  const def = topLevel(column.def);
  return def.some((t, k) => t === "not" && def[k + 1] === "null") && !def.includes("default");
}

// The ALTER TABLE ADD COLUMN restrictions from https://www.sqlite.org/lang_altertable.html
function addable(column: Column): boolean {
  const def = topLevel(column.def);
  if (def.includes("primary") || def.includes("unique") || def.includes("stored")) return false;
  const at = def.indexOf("default");
  const value = at === -1 ? undefined : def[at + 1];
  if (
    value === "(" ||
    value === "current_time" ||
    value === "current_date" ||
    value === "current_timestamp"
  ) {
    return false;
  }
  const notNull = def.some((t, k) => t === "not" && def[k + 1] === "null");
  return !(notNull && (value === undefined || value === "null"));
}

// The ALTER TABLE DROP COLUMN restrictions that can be read off the table
// itself; indexes, views and triggers naming the column are dropped first.
function droppable(column: Column, constraints: string[][]): boolean {
  const def = topLevel(column.def);
  if (def.includes("primary") || def.includes("unique") || column.generated) return false;
  return !constraints.some((c) => c.includes(column.key));
}

export function topLevel(tokens: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t === ")") depth--;
    if (depth === 0) out.push(t);
    if (t === "(") depth++;
  }
  return out;
}

function scope(schema: Schema, options: PlanOptions): Schema {
  const tableIn = (name: string) =>
    (!options.targetTables?.length || options.targetTables.some((p) => p.test(name))) &&
    !options.skipTables?.some((p) => p.test(name));
  const tableName = (key: string) => schema.tables.get(key)?.name ?? key;
  const filter = <T extends Table | Dependent>(map: Map<string, T>, keep: (o: T) => boolean) =>
    new Map([...map].filter(([, o]) => keep(o)));
  return {
    tables: filter(schema.tables, (t) => tableIn(t.name)),
    indexes: filter(schema.indexes, (i) => tableIn(tableName(i.table!))),
    triggers: filter(schema.triggers, (t) => tableIn(tableName(t.table!))),
    views: filter(schema.views, (v) => !options.skipViews?.some((p) => p.test(v.name))),
  };
}

const subst = (tokens: string[], from: string, to: string) =>
  tokens.map((t) => (t === from ? to : t));

const same = (a: string[], b: string[]) => a.length === b.length && a.every((t, k) => t === b[k]);

const sameSet = (a: string[][], b: string[][]) =>
  same(a.map((x) => x.join(" ")).sort(), b.map((x) => x.join(" ")).sort());
