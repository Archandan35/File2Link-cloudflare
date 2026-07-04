CREATE TABLE IF NOT EXISTS files (
    token TEXT PRIMARY KEY,
    file_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    created_at REAL,
    expires_at REAL
);

CREATE TABLE IF NOT EXISTS stats (
    token TEXT PRIMARY KEY,
    downloads INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER
);

INSERT OR IGNORE INTO counter (id, value) VALUES (1, 1);
