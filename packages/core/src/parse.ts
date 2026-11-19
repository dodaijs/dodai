import { normalizeToken, tokenize, unquote, type Token } from "./tokenize.js";

export interface Column {
  name: string;
  key: string;
  /** Normalized definition tokens after the column name. */
  def: string[];
  text: string;
  generated: boolean;
  renamedFrom?: string;
}

export interface Table {
  kind: "table";
  name: string;
  key: string;
  columns: Column[];
  /** Normalized table constraints, one token list each. */
  constraints: string[][];
  /** Normalized table options after the closing parenthesis (WITHOUT ROWID, STRICT). */
  options: string[];
  /** Keys of the tables this one names in REFERENCES clauses. */
  references: string[];
  text: string;
  /** `text` with the table name replaced by a placeholder for rebuilds. */
  textWithName: (name: string) => string;
  renamedFrom?: string;
}

export interface Dependent {
  kind: "index" | "trigger" | "view";
  name: string;
  key: string;
  /** Key of the table an index or trigger is attached to. */
  table?: string;
  /** Normalized statement tokens, without IF NOT EXISTS. */
  norm: string[];
  text: string;
  renamedFrom?: string;
}

export type SchemaObject = Table | Dependent;

export interface Schema {
  tables: Map<string, Table>;
  indexes: Map<string, Dependent>;
  triggers: Map<string, Dependent>;
  views: Map<string, Dependent>;
}

export function emptySchema(): Schema {
  return { tables: new Map(), indexes: new Map(), triggers: new Map(), views: new Map() };
}

export function parseSchema(src: string): Schema {
  const schema = emptySchema();
  for (const statement of splitStatements(tokenize(src))) {
    addObject(schema, parseStatement(src, statement));
  }
  return schema;
}

export function addObject(schema: Schema, object: SchemaObject): void {
  const map =
    object.kind === "table"
      ? schema.tables
      : object.kind === "index"
        ? schema.indexes
        : object.kind === "trigger"
          ? schema.triggers
          : schema.views;
  if (map.has(object.key)) throw new SyntaxError(`duplicate ${object.kind} "${object.name}"`);
  (map as Map<string, SchemaObject>).set(object.key, object);
}

const isCode = (t: Token) => t.kind !== "comment";
const isWord = (t: Token | undefined, word: string) =>
  t !== undefined && t.kind === "word" && t.text.toLowerCase() === word;
const isPunct = (t: Token | undefined, punct: string) =>
  t !== undefined && t.kind === "punct" && t.text === punct;

// A comment on the line that ends a statement belongs to that statement, so
// `CREATE INDEX ...; -- @renamed from=x` annotates the index.
export function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let inTrigger = false;
  let inBody = false;
  let caseDepth = 0;
  let lastEndLine = -1;
  for (const token of tokens) {
    if (!isCode(token) && !current.some(isCode) && token.line === lastEndLine) {
      statements.at(-1)?.push(token);
      continue;
    }
    if (isPunct(token, ";") && !inBody) {
      if (current.some(isCode)) statements.push(current);
      current = [];
      inTrigger = inBody = false;
      caseDepth = 0;
      lastEndLine = token.line;
      continue;
    }
    current.push(token);
    if (token.kind !== "word") continue;
    const word = token.text.toLowerCase();
    if (!inTrigger && word === "trigger") {
      inTrigger = current
        .filter(isCode)
        .slice(0, -1)
        .every((t) => ["create", "temp", "temporary"].includes(t.text.toLowerCase()));
    } else if (inTrigger && !inBody && word === "begin") {
      inBody = true;
    } else if (inBody && word === "case") {
      caseDepth++;
    } else if (inBody && word === "end") {
      if (caseDepth > 0) caseDepth--;
      else inBody = false;
    }
  }
  if (current.some(isCode)) statements.push(current);
  return statements;
}

const RENAMED = /@renamed\s+from=("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^']|'')*'|[^\s*]+)/;

function renamedFrom(comments: Token[]): string | undefined {
  for (const comment of comments) {
    const match = RENAMED.exec(comment.text);
    if (match) return unquote(match[1]!);
  }
  return undefined;
}

export function parseStatement(src: string, statement: Token[]): SchemaObject {
  const code = statement.filter(isCode);
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at line ${code[0]?.line}`);
  };
  if (!isWord(code[0], "create")) fail("only CREATE statements are supported");
  let i = 1;
  if (isWord(code[i], "temp") || isWord(code[i], "temporary"))
    fail("temporary objects are not supported");
  if (isWord(code[i], "unique")) i++;
  if (isWord(code[i], "virtual")) fail("virtual tables are not supported");
  const kind = code[i]?.text.toLowerCase();
  if (kind !== "table" && kind !== "index" && kind !== "trigger" && kind !== "view") {
    return fail(`unsupported statement "CREATE ${code[i]?.text ?? ""}"`);
  }
  const ifNotExists =
    isWord(code[i + 1], "if") && isWord(code[i + 2], "not") && isWord(code[i + 3], "exists");
  i += ifNotExists ? 4 : 1;
  const nameStart = code[i];
  if (nameStart && isPunct(code[i + 1], ".")) {
    if (normalizeToken(nameStart) !== "main") fail("only the main schema is supported");
    i += 2;
  }
  const nameToken = code[i];
  if (!nameStart || !nameToken || (nameToken.kind !== "word" && nameToken.kind !== "ident")) {
    return fail(`missing ${kind} name`);
  }
  const name = unquote(nameToken.text);
  const text = src.slice(code[0]!.start, code.at(-1)!.end);

  if (kind === "table") {
    return parseTable(src, statement, code, i, { name, nameStart, nameToken, text });
  }
  const base = {
    name,
    key: name.toLowerCase(),
    norm: stripIfNotExists(code.map(normalizeToken)),
    text,
    renamedFrom: renamedFrom(statement.filter((t) => !isCode(t))),
  };
  if (kind === "view") return { kind: "view", ...base };
  const on = code.findIndex((t, index) => index > i && isWord(t, "on"));
  const tableToken = code[isPunct(code[on + 2], ".") ? on + 3 : on + 1];
  if (on === -1 || !tableToken) return fail(`missing ON clause for ${kind} "${name}"`);
  return { kind, ...base, table: normalizeToken(tableToken) };
}

function stripIfNotExists(norm: string[]): string[] {
  const at = norm.findIndex(
    (t, index) => t === "if" && norm[index + 1] === "not" && norm[index + 2] === "exists",
  );
  return at === -1 ? norm : [...norm.slice(0, at), ...norm.slice(at + 3)];
}

const CONSTRAINT_KEYWORDS = new Set(["constraint", "primary", "unique", "check", "foreign"]);

function parseTable(
  src: string,
  statement: Token[],
  code: Token[],
  nameIndex: number,
  head: { name: string; nameStart: Token; nameToken: Token; text: string },
): Table {
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} in table "${head.name}" at line ${code[0]?.line}`);
  };
  const open = code[nameIndex + 1];
  if (isWord(open, "as")) fail("CREATE TABLE ... AS SELECT is not supported");
  if (!open || !isPunct(open, "(")) fail("expected (");

  // Walk every token (comments included) between the parentheses, tracking
  // which item each code token belongs to so trailing comments can be
  // attributed to the column they annotate.
  const openAt = statement.indexOf(open!);
  const items: Token[][] = [[]];
  const owner = new Map<Token, number>();
  let depth = 0;
  let closeAt = -1;
  for (let k = openAt + 1; k < statement.length; k++) {
    const t = statement[k]!;
    if (!isCode(t)) continue;
    if (isPunct(t, "(")) depth++;
    if (isPunct(t, ")")) {
      if (depth === 0) {
        closeAt = k;
        break;
      }
      depth--;
    }
    if (depth === 0 && isPunct(t, ",")) {
      owner.set(t, items.length - 1);
      items.push([]);
      continue;
    }
    owner.set(t, items.length - 1);
    items.at(-1)!.push(t);
  }
  if (closeAt === -1) fail("unbalanced parentheses");

  const itemComments = items.map((): Token[] => []);
  const tableComments: Token[] = statement.slice(0, openAt).filter((t) => !isCode(t));
  let previous: Token = open!;
  for (let k = openAt + 1; k < closeAt; k++) {
    const t = statement[k]!;
    if (isCode(t)) {
      previous = t;
      continue;
    }
    if (t.line !== previous.line) continue;
    if (previous === open) tableComments.push(t);
    else itemComments[owner.get(previous)!]!.push(t);
  }

  const columns: Column[] = [];
  const constraints: string[][] = [];
  const references: string[] = [];
  items.forEach((item, index) => {
    if (item.length === 0) fail("empty column definition");
    item.forEach((t, k) => {
      if (isWord(t, "references") && item[k + 1]) references.push(normalizeToken(item[k + 1]!));
    });
    const norm = item.map(normalizeToken);
    if (item[0]!.kind === "word" && CONSTRAINT_KEYWORDS.has(norm[0]!)) {
      constraints.push(norm);
      return;
    }
    const def = norm.slice(1);
    columns.push({
      name: unquote(item[0]!.text),
      key: norm[0]!,
      def,
      text: src.slice(item[0]!.start, item.at(-1)!.end),
      generated: isGenerated(def),
      renamedFrom: renamedFrom(itemComments[index]!),
    });
  });

  const options = code.slice(code.indexOf(statement[closeAt]!) + 1).map(normalizeToken);
  const text = head.text;
  const offset = code[0]!.start;
  return {
    kind: "table",
    name: head.name,
    key: head.name.toLowerCase(),
    columns,
    constraints,
    options,
    references,
    text,
    textWithName: (name) =>
      text.slice(0, head.nameStart.start - offset) + name + text.slice(head.nameToken.end - offset),
    renamedFrom: renamedFrom(tableComments),
  };
}

function isGenerated(def: string[]): boolean {
  let depth = 0;
  for (let k = 0; k < def.length; k++) {
    const t = def[k];
    if (t === "(") depth++;
    else if (t === ")") depth--;
    else if (depth === 0 && (t === "generated" || (t === "as" && def[k + 1] === "("))) return true;
  }
  return false;
}
