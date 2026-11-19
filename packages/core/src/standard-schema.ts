// The Standard Schema v1 interface, https://standardschema.dev — copied as the
// spec intends, so validators work with any consumer without a dependency.
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export type ColumnType = "integer" | "real" | "text" | "blob" | "any";

export interface ColumnSpec {
  readonly type: ColumnType;
  readonly nullable?: boolean;
  /** The only values a `CHECK (col IN (...))` allows. */
  readonly values?: readonly (string | number)[];
}

type BaseValue<T extends ColumnType> = T extends "integer" | "real"
  ? number
  : T extends "text"
    ? string
    : T extends "blob"
      ? ArrayBuffer
      : unknown;

type ColumnValue<C extends ColumnSpec> =
  | (C["values"] extends readonly (infer V)[] ? V : BaseValue<C["type"]>)
  | (C["nullable"] extends true ? null : never);

export type RowOf<Columns extends Record<string, ColumnSpec>> = {
  -readonly [K in keyof Columns]: ColumnValue<Columns[K]>;
};

export type RowSchema<Columns extends Record<string, ColumnSpec>> = StandardSchemaV1<
  unknown,
  RowOf<Columns>
> & { readonly table: string; readonly columns: Columns };

/** The row type a validator from {@link defineRow} accepts. */
export type InferRow<S> = S extends StandardSchemaV1<unknown, infer Row> ? Row : never;

/** A Standard Schema validator for the rows of one table. */
export function defineRow<const Columns extends Record<string, ColumnSpec>>(
  table: string,
  columns: Columns,
): RowSchema<Columns> {
  return {
    table,
    columns,
    "~standard": {
      version: 1,
      vendor: "dodai",
      validate(value) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: `expected a ${table} row` }] };
        }
        const row = value as Record<string, unknown>;
        const issues: StandardSchemaIssue[] = [];
        for (const [key, spec] of Object.entries(columns)) {
          if (!(key in row)) issues.push({ message: "missing column", path: [key] });
          else if (!accepts(spec, row[key])) {
            issues.push({ message: `expected ${expectation(spec)}`, path: [key] });
          }
        }
        return issues.length > 0 ? { issues } : { value: row as RowOf<Columns> };
      },
    },
  };
}

function accepts(spec: ColumnSpec, value: unknown): boolean {
  if (spec.type === "any") return true;
  if (value === null) return spec.nullable === true;
  if (spec.values) return spec.values.includes(value as string | number);
  switch (spec.type) {
    case "integer":
      return Number.isInteger(value);
    case "real":
      return typeof value === "number";
    case "text":
      return typeof value === "string";
    case "blob":
      return value instanceof ArrayBuffer;
  }
}

function expectation(spec: ColumnSpec): string {
  const base = spec.values ? `one of ${JSON.stringify(spec.values)}` : spec.type;
  return spec.nullable ? `${base} or null` : base;
}
