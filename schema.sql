-- CX Battle S0014 / D1 initial test accounts; run only on your own D1 database.
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'test',
  account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','suspended','banned')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now')*1000),
  last_seen_at INTEGER,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  disconnect_losses INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 1000
);
CREATE TABLE IF NOT EXISTS player_sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(player_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_player_id ON player_sessions(player_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_expires_at ON player_sessions(expires_at);
INSERT OR IGNORE INTO players(player_id,username,nickname) VALUES('test001','test001','test001');
INSERT OR IGNORE INTO players(player_id,username,nickname) VALUES('test002','test002','test002');
INSERT OR IGNORE INTO players(player_id,username,nickname) VALUES('test003','test003','test003');
INSERT OR IGNORE INTO players(player_id,username,nickname) VALUES('test004','test004','test004');
