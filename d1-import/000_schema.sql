CREATE TABLE IF NOT EXISTS games (app_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at);
