CREATE TABLE album_uploads (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  upload_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, id)
);
