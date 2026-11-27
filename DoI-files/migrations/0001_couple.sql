CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  recovery_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1))
);

CREATE TABLE members (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  space_id TEXT NOT NULL REFERENCES spaces(id)
);
CREATE INDEX members_space ON members(space_id);

CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id),
  expires_at INTEGER NOT NULL
);

CREATE TRIGGER cap_space_members BEFORE INSERT ON members
WHEN (SELECT count(*) FROM members WHERE space_id = NEW.space_id) >= 2
BEGIN
  SELECT RAISE(ABORT, 'space already paired');
END;

CREATE TRIGGER consume_invite AFTER INSERT ON members
WHEN (SELECT count(*) FROM members WHERE space_id = NEW.space_id) = 2
BEGIN
  DELETE FROM invites WHERE space_id = NEW.space_id;
END;

CREATE TABLE shared_records (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  last_operation TEXT NOT NULL,
  record_json TEXT,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE shared_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  FOREIGN KEY (space_id, record_id) REFERENCES shared_records(space_id, id)
);
CREATE INDEX shared_changes_space ON shared_changes(space_id, seq);

CREATE TRIGGER log_shared_insert AFTER INSERT ON shared_records
BEGIN
  INSERT INTO shared_changes (space_id, record_id) VALUES (NEW.space_id, NEW.id);
END;

CREATE TRIGGER log_shared_update AFTER UPDATE OF version ON shared_records
BEGIN
  INSERT INTO shared_changes (space_id, record_id) VALUES (NEW.space_id, NEW.id);
END;
