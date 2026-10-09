-- S0015: Single active Key-JSON configuration document. Keeps existing players & sessions.
CREATE TABLE IF NOT EXISTS server_settings (
  config_key TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
INSERT OR IGNORE INTO server_settings(config_key,settings_json,revision) VALUES ('active', '{"heartbeatMs":1000,"connectionTimeoutMs":3000,"waitingHeartbeatMs":10000,"waitingTimeoutMs":30000,"forwardReserveTicks":0,"receiveMarginTicks":0,"legalWindowPercent":80,"ackGraceTicks":30,"maxClockLagTicks":60,"maxInputFutureTicks":12,"proofTimeoutMs":15000,"prepTicks":900,"lockTicks":90,"probeCount":3,"disconnectObserveMs":1000,"heartbeatAckTimeoutMs":3000,"probeTimeoutMs":10000,"disconnectForfeitAfterSeconds":60}', 1);

-- S0015: audit and exactly-once player result ledger. No battle-tick data here.
CREATE TABLE IF NOT EXISTS matches (
 match_id TEXT PRIMARY KEY,
 blue_player_id TEXT NOT NULL REFERENCES players(player_id),
 red_player_id TEXT NOT NULL REFERENCES players(player_id),
 started_at INTEGER,
 ended_at INTEGER NOT NULL,
 first_disconnect_at INTEGER,
 end_tick INTEGER NOT NULL DEFAULT 0,
 end_reason TEXT NOT NULL,
 responsible_player_id TEXT REFERENCES players(player_id),
 winner_player_id TEXT REFERENCES players(player_id),
 loser_player_id TEXT REFERENCES players(player_id),
 win_stars INTEGER NOT NULL DEFAULT 0 CHECK(win_stars BETWEEN 0 AND 5),
 config_revision INTEGER NOT NULL DEFAULT 0,
 settlement_status TEXT NOT NULL DEFAULT 'pending' CHECK(settlement_status IN ('pending','settled'))
);
CREATE INDEX IF NOT EXISTS idx_matches_blue ON matches(blue_player_id);
CREATE INDEX IF NOT EXISTS idx_matches_red ON matches(red_player_id);
CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at);
