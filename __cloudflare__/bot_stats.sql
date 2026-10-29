-- One row per UTC day + bot + page. WITHOUT ROWID keeps each upsert to a single row write.
CREATE TABLE IF NOT EXISTS bot_hits (
  day        TEXT    NOT NULL,   -- 'YYYY-MM-DD' (UTC)
  bot        TEXT    NOT NULL,   -- e.g. 'bingbot', 'googlebot', 'claude-user'
  page       TEXT    NOT NULL,   -- normalised path + identity params, no .html
  hits       INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,   -- epoch ms
  last_seen  INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (day, bot, page)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_hits_page ON bot_hits (page);
