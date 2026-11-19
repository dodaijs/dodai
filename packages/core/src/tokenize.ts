export type TokenKind = "word" | "ident" | "string" | "number" | "punct" | "comment";

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  line: number;
}

const MULTI_CHAR_PUNCT = ["->>", "||", "<=", ">=", "!=", "<>", "==", "<<", ">>", "->"];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    let kind: TokenKind;
    if (c === "-" && src[i + 1] === "-") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      kind = "comment";
    } else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) throw new SyntaxError(`unterminated comment at line ${line}`);
      i = close + 2;
      kind = "comment";
    } else if (c === "'") {
      i = closeQuote(src, i, "'", line);
      kind = "string";
    } else if (c === '"' || c === "`") {
      i = closeQuote(src, i, c, line);
      kind = "ident";
    } else if (c === "[") {
      const close = src.indexOf("]", i);
      if (close === -1) throw new SyntaxError(`unterminated identifier at line ${line}`);
      i = close + 1;
      kind = "ident";
    } else if (/[\p{L}_]/u.test(c)) {
      while (i < src.length && /[\p{L}\p{N}_$]/u.test(src[i]!)) i++;
      kind = "word";
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      while (i < src.length && /[0-9A-Za-z_.]/.test(src[i]!)) {
        // Exponent sign: 1e+5
        if (/[eE]/.test(src[i]!) && /[+-]/.test(src[i + 1] ?? "")) i++;
        i++;
      }
      kind = "number";
    } else {
      const multi = MULTI_CHAR_PUNCT.find((p) => src.startsWith(p, i));
      i += multi ? multi.length : 1;
      kind = "punct";
    }
    const text = src.slice(start, i);
    tokens.push({ kind, text, start, end: i, line });
    line += countNewlines(text);
  }
  return tokens;
}

function closeQuote(src: string, open: number, quote: string, line: number): number {
  let i = open + 1;
  for (;;) {
    const close = src.indexOf(quote, i);
    if (close === -1) throw new SyntaxError(`unterminated ${quote} quote at line ${line}`);
    if (src[close + 1] !== quote) return close + 1;
    i = close + 2;
  }
}

function countNewlines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

export function unquote(text: string): string {
  const first = text[0];
  if (first === '"' || first === "`" || first === "'") {
    return text.slice(1, -1).replaceAll(first + first, first);
  }
  if (first === "[") return text.slice(1, -1);
  return text;
}

// SQLite identifiers and keywords are case-insensitive, and quoting does not
// change which object an identifier names.
export function normalizeToken(token: Token): string {
  switch (token.kind) {
    case "word":
      return token.text.toLowerCase();
    case "ident":
      return unquote(token.text).toLowerCase();
    default:
      return token.text;
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
