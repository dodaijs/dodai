-- Identifiers that are keywords, quoted every way SQLite allows, or not ASCII.
CREATE TABLE "order" (
  "select" TEXT, -- a keyword as a column
  [group by] INTEGER NOT NULL DEFAULT 0,
  `back tick` REAL,
  "Mixed""Quote" TEXT
);
CREATE TABLE IF NOT EXISTS main.ünïcode_表 (名前 TEXT NOT NULL, ключ INTEGER PRIMARY KEY);

/* Literals that look like syntax. */
CREATE TABLE literals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semi TEXT NOT NULL DEFAULT ';',
  dash TEXT DEFAULT '-- not a comment',
  slash TEXT DEFAULT '/* not a comment */',
  paren TEXT DEFAULT ')(,',
  quote TEXT DEFAULT 'it''s',
  neg INTEGER DEFAULT -1,
  pos REAL DEFAULT +1.5e3,
  hex INTEGER DEFAULT 0x1F,
  blob_default BLOB DEFAULT X'00FF',
  now TEXT DEFAULT CURRENT_TIMESTAMP,
  expr INTEGER DEFAULT (1 + 2),
  CHECK (semi <> 'x;y')
);

CREATE TABLE typed (
  a VARCHAR(255) COLLATE NOCASE NOT NULL,
  b DECIMAL(10, 2),
  c UNSIGNED BIG INT,
  d DOUBLE PRECISION,
  e,
  f TEXT CHECK (f IS NOT NULL OR e IS NULL),
  g TEXT CONSTRAINT g_len CHECK (length(g) < 10),
  h INTEGER GENERATED ALWAYS AS (length(a)) VIRTUAL,
  i TEXT AS (upper(a)) STORED,
  j INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0,
  CONSTRAINT typed_pk PRIMARY KEY (a, b),
  UNIQUE (c, d) ON CONFLICT IGNORE,
  CHECK (b >= 0)
);
CREATE TABLE strict_kv (k TEXT PRIMARY KEY, v ANY) STRICT, WITHOUT ROWID;
CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES parent (id) ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  parent_name TEXT,
  FOREIGN KEY (parent_name) REFERENCES parent (name)
);

CREATE UNIQUE INDEX literals_semi ON literals (semi COLLATE NOCASE DESC);
CREATE INDEX typed_expr ON typed (lower(a), b * 2);
CREATE INDEX typed_partial ON typed (c) WHERE d > 0 AND a <> ';';
CREATE INDEX IF NOT EXISTS "order_select" ON "order" ("select");

CREATE TRIGGER literals_audit AFTER UPDATE OF semi, dash ON literals
FOR EACH ROW WHEN new.semi <> old.semi
BEGIN
  UPDATE literals
  SET dash = CASE WHEN new.semi = ';' THEN 'end;' ELSE (CASE new.neg WHEN 1 THEN 'a' END) END
  WHERE id = new.id;
  DELETE FROM child WHERE parent_name = 'BEGIN END;';
END;
CREATE TRIGGER IF NOT EXISTS typed_guard BEFORE INSERT ON typed
BEGIN
  SELECT RAISE(ABORT, 'no; way') WHERE new.b < 0;
END;

CREATE VIEW typed_summary AS SELECT a, count(*) AS n FROM typed WHERE a <> ')' GROUP BY a;
CREATE VIEW IF NOT EXISTS nested AS
  SELECT * FROM (SELECT a FROM typed_summary) WHERE a IN (SELECT semi FROM literals);
CREATE TRIGGER nested_insert INSTEAD OF INSERT ON nested
BEGIN
  INSERT INTO typed (a, b) VALUES (new.a, 0);
END;
